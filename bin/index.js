#!/usr/bin/env node

const yargs = require('yargs');
const Web3 = require('web3');
const ethers = require('ethers');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const firebase = require('../firebase');
const credentials = require('../credentials');
const inquirer = require('../inquirer');
const TruffleConfig = require('@truffle/config');

const options = yargs
    .command('login', 'Login to your Ethernal account', {}, setLogin)
    .command('listen', 'Start listening for transactions', (yargs) => {
        return yargs
            .option('w', { alias: 'workspace', describe: 'Workspace to connect to.', type: 'string', demandOption: false })
            .option('d', { alias: 'dir', type: 'array', describe: 'Project directory to watch', demandOption: false })
            .option('s', { alias: 'server', describe: 'Do not watch for artifacts change - only listen for transactions', demandOption: false })
            .option('l', { alias: 'local', describe: 'Do not listen for transactions - only watch contracts', demandOption: false })
    }, listen)
    .argv;

let web3, user, rpcServer;
let contractAddresses = {};
let db = new firebase.DB();

async function connect() {
    if (options.local) {
        console.log('Local option activated - only watching for contract changes');
        watchDirectories();
        if (options.server) {
            console.warn("You also passed the server option, but it won't be used, transactions won't be watched.");
        }
    }
    else {
        var rpcServer = db.workspace.rpcServer;
        var provider = Web3.providers.WebsocketProvider;
        if (rpcServer.startsWith('http') || rpcServer.startsWith('https')) {
            web3 = new Web3(rpcServer);
        }
        else {
            web3 = new Web3(new provider(rpcServer));    
        }
        
        subscribe();
    }
}

async function subscribe() {
    web3.eth.subscribe('newBlockHeaders')
        .on('connected', onConnected)
        .on('data', onData)
        .on('error', onError);
}

function watchDirectories() {
    var workingDirectories = options.dir ? options.dir : ['.'];
    workingDirectories.forEach((dir) => {
        var projectInfo = getProjectConfig(dir);
        if (projectInfo) {
            if (projectInfo.type == 'Truffle') {
                console.log(`Detected ${projectInfo.type} project for ${projectInfo.config.working_directory}`)
                watchTruffleArtifacts(dir, projectInfo.config);
            }
            if (projectInfo.type == 'Brownie') {
                console.log(`Detected ${projectInfo.type} project for ${dir}`)
                watchBrownieArtifacts(dir);
            }
        }
    });
}

async function catchupBlocks() {
    var ids = [];
    var missing = [];
    db.collection('blocks')
        .orderBy('number', 'asc')
        .get()
        .then(async (snapshot) => {
            var syncLastBlock = false;
            snapshot.forEach((block) => ids.push(block.id));
            var latestBlock = await web3.eth.getBlock('latest');

            if (!ids.length || ids[ids.length - 1] != latestBlock.number) {
                ids.push(latestBlock.number)
            }

            for (var i = 0, targetValue = 1; targetValue <= ids[ids.length - 1]; targetValue++) {
                if (ids[i] != targetValue)
                    missing.push(targetValue);
                else
                    i++;
            }

            for (var j = 0; j < missing.length; j++) {
                web3.eth.getBlock(missing[j], true).then(syncBlock)
            }
        })
}

function onConnected() {
    console.log(`Connected to ${db.workspace.rpcServer}`);
    if (options.server) {
        console.log('Server option activated - only listening to transactions');
    }
    else {
        watchDirectories();
        catchupBlocks();
    }
}

function onData(blockHeader, error) {
    if (error && error.reason) {
        return console.log(`Error while receiving data: ${error.reason}`);
    }

    web3.eth.getBlock(blockHeader.hash, true).then(syncBlock);
}

function onError(error) {
    console.log(error)
    if (error && error.reason) {
        console.log(`Could not connect to ${rpcServer}. Error: ${error.reason}`);
    }
    else {
        console.log(`Could not connect to ${rpcServer}.`);
    }
    console.log('Trying to reconnect in 5s...');
    setTimeout(connect, 5 * 1000);
}

function getProjectConfig(dir) {
    if (!dir) {
        console.log('Please specify a directory to check.');
        return;
    }
    var truffleConfigPath = path.format({
        dir: dir
    });

    var hardhatConfigPath = path.format({
        dir: dir,
        base: 'hardhat.config.js'
    });

    var brownieConfigPath = path.format({
        dir: dir,
        base: 'brownie-config.yaml'
    });

    try {
        var isBrownieProject = fs.existsSync(brownieConfigPath);
        if (isBrownieProject) {
            return {
                type: 'Brownie'
            };
        };
        const truffleConfig = TruffleConfig.detect({ workingDirectory: truffleConfigPath });
        if (truffleConfig) {
            return {
                type: 'Truffle',
                config: truffleConfig
            };
        }
    } catch(e) {
        console.log(`${dir} does not appear to be a Truffle or Brownie project, contracts metadata won't be uploaded automatically.`);
        var isHardhatProject = fs.existsSync(hardhatConfigPath);
        if (isHardhatProject) {
            console.log(`${dir} appears to be a Hardhat project, if you are looking to synchronize contracts metadata, please look at our dedicated plugin here: https://github.com/tryethernal/hardhat-ethernal.`);
        }
        return false;
    }
}

function updateContractArtifact(contract) {
    if (!contract) {
        return;
    }
    var storeArtifactPromise = db.contractStorage(`${contract.address}/artifact`).set(contract.artifact);
    var storeDependenciesPromise = db.contractStorage(`${contract.address}/dependencies`).set(contract.dependencies);

    Promise.all([storeArtifactPromise, storeDependenciesPromise]).then(() => {
        db.collection('contracts')
            .doc(contract.address)
            .set({
                name: contract.name,
                address: contract.address,
                abi: contract.abi
            }, { merge: true })
            .then(() => console.log(`Updated artifacts for contract ${contract.name} (${contract.address}), with dependencies: ${Object.entries(contract.dependencies).map(art => art[0]).join(', ')}`));
    });
}

function watchTruffleArtifacts(dir, projectConfig) {
    if (!dir) {
        console.log('Please specify a directory to watch.');
        return;
    }
    
    const artifactsDir = projectConfig.contracts_build_directory;

    const watcher = chokidar.watch('.', { cwd: artifactsDir })
        .on('add', (path) => {
            updateContractArtifact(getTruffleArtifact(artifactsDir, path));
        })
        .on('change', (path) => {
            updateContractArtifact(getTruffleArtifact(artifactsDir, path));
        });
}

function watchBrownieArtifacts(dir) {
    if (!dir) {
        console.log('Please specify a directory to watch.');
        return;
    }
    
    const artifactsDir = `${dir}${path.sep}build${path.sep}contracts`;

    const watcher = chokidar.watch('.', { cwd: artifactsDir })
        .on('add', (path) => {
            updateContractArtifact(getBrownieArtifact(artifactsDir, path));
        })
        .on('change', (path) => {
            updateContractArtifact(getBrownieArtifact(artifactsDir, path));
        });
}

function getTruffleArtifact(artifactsDir, fileName) {
    console.log(`Getting artifact for ${fileName} in ${artifactsDir}`);
    var contract;
    if (fileName != 'Migrations.json') {
        var rawArtifact = fs.readFileSync(path.format({ dir: artifactsDir, base: fileName }), 'utf8');
        var parsedArtifact = JSON.parse(rawArtifact);
        var contractAddress = parsedArtifact.networks[db.workspace.networkId] ? parsedArtifact.networks[db.workspace.networkId].address : null;
        if (contractAddress && contractAddress != contractAddresses[parsedArtifact.contractName]) {
            contractAddresses[parsedArtifact.contractName] = contractAddress;
            var artifactDependencies = getArtifactDependencies(parsedArtifact);
            for (const key in artifactDependencies) {
                var dependencyArtifact =  JSON.parse(fs.readFileSync(path.format({ dir: artifactsDir, base: `${key}.json`}), 'utf8'));
                artifactDependencies[key] = JSON.stringify({
                    contractName: dependencyArtifact.contractName,
                    abi: dependencyArtifact.abi,
                    ast: dependencyArtifact.ast,
                    source: dependencyArtifact.source,
                })
            }
            contract = {
                name: parsedArtifact.contractName,
                address: contractAddress,
                abi: parsedArtifact.abi,
                artifact: JSON.stringify({
                    contractName: parsedArtifact.contractName,
                    abi: parsedArtifact.abi,
                    ast: parsedArtifact.ast,
                    source: parsedArtifact.source,
                }),
                dependencies: artifactDependencies
            }
        }
    }
    return contract;
}

function getBrownieArtifact(artifactsDir, fileName) {
    console.log(`Getting artifact for ${fileName} in ${artifactsDir}`);
    var deploymentMapPath = `${artifactsDir}${path.sep}..${path.sep}deployments`;
    var deploymentMap = fs.readFileSync(path.format({ dir: deploymentMapPath, base: 'map.json' }));
    var parsedDeploymentMap = JSON.parse(deploymentMap);
    var address;
    for (const network in parsedDeploymentMap) {
        var contractName = fileName.split('.')[0];
        if (contractName && parsedDeploymentMap[network][contractName]) {
            address = parsedDeploymentMap[network][contractName][0];
            
            if (address) {
                var rawArtifact = fs.readFileSync(path.format({ dir: artifactsDir, base: fileName }), 'utf8');
                var parsedArtifact = JSON.parse(rawArtifact);
                var artifactDependencies = getArtifactDependencies(parsedArtifact);
                console.log(artifactDependencies)
            }
        }
    }
}

function getArtifactDependencies(parsedArtifact) {
    var dependencies = {}
    Object.entries(parsedArtifact.ast.exportedSymbols)
        .forEach(symbol => {
            if (symbol[0] != parsedArtifact.contractName) {
                dependencies[symbol[0]] = null;
            }
        });    
    return dependencies;
}

function syncBlock(block) {
    var sBlock = sanitize(block);
    db.collection('blocks').doc(sBlock.number.toString()).set(sBlock).then(() => console.log(`Synced block ${sBlock.number}`));

    sBlock.transactions.forEach(transaction => {
        web3.eth.getTransactionReceipt(transaction.hash).then(receipt => syncTransaction(sBlock, transaction, receipt));
    });
}

async function syncTransaction(block, transaction, transactionReceipt) {
    var sTransaction = sanitize(transaction);
    var txSynced = {
        ...sTransaction,
        receipt: transactionReceipt,
        timestamp: block.timestamp
    }

    if (transaction.to && transaction.input && transaction.value) {
        txSynced.functionSignature = await getFunctionSignatureForTransaction(sTransaction);    
    }
    
    db.collection('transactions')
        .doc(sTransaction.hash)
        .set(txSynced)
        .then(() => console.log(`Synced transaction ${sTransaction.hash}`));

    if (!txSynced.to) {
        db.collection('contracts')
            .doc(transactionReceipt.contractAddress)
            .set({ address: transactionReceipt.contractAddress })
            .then(() => console.log(`Synced new contract at ${transactionReceipt.contractAddress}`));
    }
}

async function getFunctionSignatureForTransaction(transaction) {
    var doc = await db.collection('contracts').doc(transaction.to).get();

    if (!doc || !doc.exists) {
        return null;
    }

    var abi = doc.data().abi;

    if (!abi) {
        return null;
    }

    var jsonInterface = new ethers.utils.Interface(abi);

    var parsedTransactionData = jsonInterface.parseTransaction({ data: transaction.input, value: transaction.value });
    var fragment = parsedTransactionData.functionFragment;

    return `${fragment.name}(` + fragment.inputs.map((input) => `${input.type} ${input.name}`).join(', ') + ')'
}

function sanitize(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v != null));
}

async function setLogin() {
    do {
        const newCredentials = await inquirer.login();
        try {
            user = (await firebase.auth().signInWithEmailAndPassword(newCredentials.email, newCredentials.password)).user;
            await credentials.set(newCredentials.email, newCredentials.password);
            console.log('You are now logged in. Run "ethernal listen" to get started.')
            process.exit(0);
        }
        catch(error) {
            console.log(error.message);
        }
    } while (user === undefined);
}

async function login() {
    try {
        var email = await credentials.getEmail();
        if (!email) {
            return console.log('You are not logged in, please run "ethernal login".')
        }
        else {
            var password = await credentials.getPassword(email);
            if (!password) {
                return console.log('You are not logged in, please run "ethernal login".')
            }    
        }

        return (await firebase.auth().signInWithEmailAndPassword(email, password)).user;
    }
    catch(_error) {
        console.log('Error while retrieving your credentials, please run "ethernal login"');
    }
}

async function getDefaultWorkspace() {
    var workspaces = await db.workspaces();
    var currentWorkspace = await db.currentWorkspace();
    var defaultWorkspace = await db.getWorkspace(currentWorkspace);
    return defaultWorkspace;
}

async function setWorkspace() {
    if (options.workspace) {
        currentWorkspace = await db.getWorkspace(options.workspace);
        if (!currentWorkspace) {
            currentWorkspace = await getDefaultWorkspace();
            console.log(`Could not find workspace "${options.workspace}", defaulting to ${currentWorkspace.name}`);
        }
        else {
            console.log(`Using workspace "${currentWorkspace.name}"`);
        }
    }
    else {
        currentWorkspace = await getDefaultWorkspace();
        console.log(`Using default workspace "${currentWorkspace.name}"`);
    }
    db.workspace = currentWorkspace;    
}

async function listen() {
    user = await login();
    if (!user) {
        process.exit(1);
    }
    console.log(`Logged in with ${await credentials.getEmail()}`);

    await setWorkspace();
    connect();
}

