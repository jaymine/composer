/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const AdminConnection = require('composer-admin').AdminConnection;
const BusinessNetworkConnection = require('composer-client').BusinessNetworkConnection;
const ConnectionProfileManager = require('composer-common').ConnectionProfileManager;
const Docker = require('dockerode');
const homedir = require('homedir');
const mkdirp = require('mkdirp');
const net = require('net');
const path = require('path');
const sleep = require('sleep-promise');

let client;
let docker = new Docker();
let forceDeploy = false;

/**
 * Trick browserify by making the ID parameter to require dynamic.
 * @param {string} id The module ID.
 * @return {*} The module.
 */
function dynamicRequire(id) {
    return require(id);
}

/**
 * A class containing test utilities for use in BusinessNetworkConnection system tests.
 *
 * @private
 */
class TestUtil {


    /**
     * Check to see if running under a web browser.
     * @return {boolean} True if running under Karma, false if not.
     */
    static isWeb() {
        return global.window && global.window.__karma__;
    }

    /**
     * Check to see if running in embedded mode.
     * @return {boolean} True if running in embedded mode, false if not.
     */
    static isEmbedded() {
        // return true;
        return process.env.npm_lifecycle_event === 'systest:embedded';
    }

    /**
     * Check to see if running in proxy mode.
     * @return {boolean} True if running in proxy mode, false if not.
     */
    static isProxy() {
        return process.env.npm_lifecycle_event === 'systest:proxy';
    }

    /**
     * Check to see if running in Hyperledger Fabric mode.
     * @return {boolean} True if running in Hyperledger Fabric mode, false if not.
     */
    static isHyperledgerFabric() {
        return process.env.SYSTEST && process.env.SYSTEST.match('^hlf.*');
    }

    /**
     * Check to see if running in Hyperledger Fabric mode.
     * @return {boolean} True if running in Hyperledger Fabric mode, false if not.
     */
    static isHyperledgerFabricV1() {
        return process.env.SYSTEST && process.env.SYSTEST.match('^hlfv1.*');
    }

    /**
     * Wait for the specified hostname to start listening on the specified port.
     * @param {string} hostname - the hostname.
     * @param {integer} port - the port.
     * @return {Promise} - a promise that will be resolved when the specified
     * hostname to start listening on the specified port.
     */
    static waitForPort(hostname, port) {
        let waitTime = 30;
        if (process.env.COMPOSER_PORT_WAIT_SECS) {
            waitTime = parseInt(process.env.COMPOSER_PORT_WAIT_SECS);
            console.log('COMPOSER_PORT_WAIT_SECS set, using: ', waitTime);
        }
        return new Promise(function (resolve, reject) {
            let testConnect = function (count) {
                let s = new net.Socket();
                s.on('error', function (error) {
                    if (count > waitTime) {
                        console.error('Port has not started, giving up waiting');
                        return reject(error);
                    } else {
                        console.log('Port has not started, waiting 1 second ...');
                        setTimeout(function () {
                            testConnect(count + 1);
                        }, 1000);
                    }
                });
                s.on('connect', function () {
                    console.log('Port has started');
                    s.end();
                    return resolve();
                });
                console.log('Testing if port ' + port + ' on host ' + hostname + ' has started ...');
                s.connect(port, hostname);
            };
            testConnect(0);
        });
    }

    /**
     * Wait for the peer on the specified hostnabusinessNetworkDefinitionme and port to start listening
     * on the specified port.
     * @return {Promise} - a promise that will be resolved when the peer has
     * started listening on the specified port.
     */
    static waitForPorts() {
        if (!TestUtil.isHyperledgerFabric()) {
            return Promise.resolve();
        }
        // startsWith not available in browser test environment
        if (process.env.SYSTEST.match('^hlfv1')) {
            return Promise.resolve();
        }
        return TestUtil.waitForPort('localhost', 7050)
            .then(() => {
                return TestUtil.waitForPort('localhost', 7051);
            })
            .then(() => {
                return TestUtil.waitForPort('localhost', 7052);
            })
            .then(() => {
                return TestUtil.waitForPort('localhost', 7053);
            })
            .then(() => {
                return TestUtil.waitForPort('localhost', 7054);
            })
            .then(() => {
                return sleep(5000);
            });
    }

    /**
     * Create a new BusinessNetworkConnection object, connect, and deploy the chain-code.
     * @return {Promise} - a promise that wil be resolved with a configured and
     * connected instance of BusinessNetworkConnection.
     */
    static setUp() {
        const adminConnection = new AdminConnection();
        forceDeploy = false;
        return TestUtil.waitForPorts()
            .then(() => {

                // Create all necessary configuration for the web runtime.
                if (TestUtil.isWeb()) {
                    const BrowserFS = require('browserfs');
                    BrowserFS.initialize(new BrowserFS.FileSystem.LocalStorage());
                    ConnectionProfileManager.registerConnectionManager('web', require('composer-connector-web'));
                    console.log('Calling AdminConnection.createProfile() ...');
                    return adminConnection.createProfile('composer-systests', {
                        'x-type': 'web'
                    });

                // Create all necessary configuration for the embedded runtime.
                } else if (TestUtil.isEmbedded()) {
                    console.log('Calling AdminConnection.createProfile() ...');
                    return adminConnection.createProfile('composer-systests', {
                        'x-type': 'embedded'
                    });

                // Create all necessary configuration for the embedded runtime hosted via the connector server.
                } else if (TestUtil.isProxy()) {
                    // A whole bunch of dynamic requires to trick browserify.
                    const ConnectorServer = dynamicRequire('composer-connector-server');
                    const EmbeddedConnectionManager = dynamicRequire('composer-connector-embedded');
                    const FSConnectionProfileStore = dynamicRequire('composer-common').FSConnectionProfileStore;
                    const fs = dynamicRequire('fs');
                    const ProxyConnectionManager = dynamicRequire('composer-connector-proxy');
                    const socketIO = dynamicRequire('socket.io');
                    // We are using the embedded connector, but we configure it to route through the
                    // proxy connector and connector server.
                    const connectionProfileStore = new FSConnectionProfileStore(fs);
                    ConnectionProfileManager.registerConnectionManager('embedded', ProxyConnectionManager);
                    const connectionProfileManager = new ConnectionProfileManager(connectionProfileStore);
                    // Since we're a single process, we have to force the embedded connection manager into
                    // the connection profile manager that the connector server is using.
                    const connectionManager = new EmbeddedConnectionManager(connectionProfileManager);
                    connectionProfileManager.getConnectionManager = () => {
                        return Promise.resolve(connectionManager);
                    };
                    const io = socketIO(15699);
                    io.on('connect', (socket) => {
                        console.log(`Client with ID '${socket.id}' on host '${socket.request.connection.remoteAddress}' connected`);
                        new ConnectorServer(connectionProfileStore, connectionProfileManager, socket);
                    });
                    io.on('disconnect', (socket) => {
                        console.log(`Client with ID '${socket.id}' on host '${socket.request.connection.remoteAddress}' disconnected`);
                    });
                    console.log('Calling AdminConnection.createProfile() ...');
                    return adminConnection.createProfile('composer-systests', {
                        'x-type': 'embedded'
                    });

                // Create all necessary configuration for Hyperledger Fabric v1.0.
                } else if (TestUtil.isHyperledgerFabricV1()) {
                    const keyValStoreOrg1 = path.resolve(homedir(), '.composer-credentials', 'composer-systests-org1');
                    mkdirp.sync(keyValStoreOrg1);
                    const keyValStoreOrg2 = path.resolve(homedir(), '.composer-credentials', 'composer-systests-org2');
                    mkdirp.sync(keyValStoreOrg2);
                    let connectionProfileOrg1, connectionProfileOrg2, connectionProfileOrg1Only;
                    if (process.env.SYSTEST.match('tls$')) {
                        console.log('setting up TLS Connection Profile for HLF V1');
                        // define ORG 1 CCP
                        connectionProfileOrg1 = {
                            'x-type': 'hlfv1',
                            'x-commitTimeout': 300,
                            'version': '1.0.0',
                            'client': {
                                'organization': 'Org1',
                                'connection': {
                                    'timeout': {
                                        'peer': {
                                            'endorser': '300',
                                            'eventHub': '300',
                                            'eventReg': '300'
                                        },
                                        'orderer': '300'
                                    }
                                },
                                'credentialStore': {
                                    'path': keyValStoreOrg1,
                                    'cryptoStore': {
                                        'path': keyValStoreOrg1
                                    }
                                }
                            },
                            'channels': {
                                'composerchannel': {
                                    'orderers': [
                                        'orderer.example.com'
                                    ],
                                    'peers': {
                                        'peer0.org1.example.com': {},
                                        'peer0.org2.example.com': {}
                                    }
                                }
                            },
                            'organizations': {
                                'Org1': {
                                    'mspid': 'Org1MSP',
                                    'peers': [
                                        'peer0.org1.example.com'
                                    ],
                                    'certificateAuthorities': [
                                        'ca.org1.example.com'
                                    ]
                                },
                                'Org2': {
                                    'mspid': 'Org2MSP',
                                    'peers': [
                                        'peer0.org2.example.com'
                                    ],
                                    'certificateAuthorities': [
                                        'ca.org2.example.com'
                                    ]
                                }
                            },
                            'orderers': {
                                'orderer.example.com': {
                                    'url': 'grpcs://localhost:7050',
                                    'grpcOptions': {
                                        'ssl-target-name-override': 'orderer.example.com'
                                    },
                                    'tlsCACerts': {
                                        'path': './hlfv1/crypto-config/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt'
                                    }
                                }
                            },
                            'peers': {
                                'peer0.org1.example.com': {
                                    'url': 'grpcs://localhost:7051',
                                    'eventUrl': 'grpcs://localhost:7053',
                                    'grpcOptions': {
                                        'ssl-target-name-override': 'peer0.org1.example.com',
                                    },
                                    'tlsCACerts': {
                                        'path': './hlfv1/crypto-config/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt'
                                    }
                                },
                                'peer0.org2.example.com': {
                                    'url': 'grpcs://localhost:8051',
                                    'eventUrl': 'grpcs://localhost:8053',
                                    'grpcOptions': {
                                        'ssl-target-name-override': 'peer0.org2.example.com',
                                    },
                                    'tlsCACerts': {
                                        'path': './hlfv1/crypto-config/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt'
                                    }
                                }
                            },
                            'certificateAuthorities': {
                                'ca.org1.example.com': {
                                    'url': 'https://localhost:7054',
                                    'httpOptions': {
                                        'verify' : false
                                    },
                                    'caName': 'ca.org1.example.com'
                                },
                                'ca.org2.example.com': {
                                    'url': 'https://localhost:8054',
                                    'httpOptions': {
                                        'verify' : false
                                    },
                                    'caName': 'ca.org2.example.com'
                                }
                            }
                        };
                        // Define Org2 CCP
                        connectionProfileOrg2 = {};
                        Object.assign(connectionProfileOrg2, connectionProfileOrg1);
                        connectionProfileOrg2.client = {
                            'organization': 'Org2',
                            'connection': {
                                'timeout': {
                                    'peer': {
                                        'endorser': '30s',
                                        'eventHub': '30s',
                                        'eventReg': '30s'
                                    },
                                    'orderer': '30s'
                                }
                            },
                            'credentialStore': {
                                'path': keyValStoreOrg2,
                                'cryptoStore': {
                                    'path': keyValStoreOrg2
                                }
                            }
                        };

                        // define Org1 Only CCP
                        connectionProfileOrg1Only = {
                            'x-type': 'hlfv1',
                            'x-commitTimeout': 300,
                            'version': '1.0.0',
                            'client': {
                                'organization': 'Org1',
                                'connection': {
                                    'timeout': {
                                        'peer': {
                                            'endorser': '30s',
                                            'eventHub': '30s',
                                            'eventReg': '30s'
                                        },
                                        'orderer': '30s'
                                    }
                                },
                                'credentialStore': {
                                    'path': keyValStoreOrg1,
                                    'cryptoStore': {
                                        'path': keyValStoreOrg1
                                    }
                                }
                            },
                            'channels': {
                                'composerchannel': {
                                    'orderers': [
                                        'orderer.example.com'
                                    ],
                                    'peers': {
                                        'peer0.org1.example.com': {}
                                    }
                                }
                            },
                            'organizations': {
                                'Org1': {
                                    'mspid': 'Org1MSP',
                                    'peers': [
                                        'peer0.org1.example.com'
                                    ],
                                    'certificateAuthorities': [
                                        'ca.org1.example.com'
                                    ]
                                }
                            },
                            'orderers': {
                                'orderer.example.com': {
                                    'url': 'grpcs://localhost:7050',
                                    'grpcOptions': {
                                        'ssl-target-name-override': 'orderer.example.com'
                                    },
                                    'tlsCACerts': {
                                        'path': './hlfv1/crypto-config/ordererOrganizations/example.com/orderers/orderer.example.com/tls/ca.crt'
                                    }
                                }
                            },
                            'peers': {
                                'peer0.org1.example.com': {
                                    'url': 'grpcs://localhost:7051',
                                    'eventUrl': 'grpcs://localhost:7053',
                                    'grpcOptions': {
                                        'ssl-target-name-override': 'peer0.org1.example.com',
                                        'request-timeout': 300 * 1000
                                    },
                                    'tlsCACerts': {
                                        'path': './hlfv1/crypto-config/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt'
                                    }
                                }
                            },
                            'certificateAuthorities': {
                                'ca.org1.example.com': {
                                    'url': 'https://localhost:7054',
                                    'caName': 'ca.org1.example.com'
                                }
                            }
                        };


                    } else {
                        console.log('setting up Non-TLS Connection Profile for HLF V1');
                        // define ORG 1 CCP NON-TLS
                        connectionProfileOrg1 = {
                            'x-type': 'hlfv1',
                            'x-commitTimeout': 300,
                            'version': '1.0.0',
                            'client': {
                                'organization': 'Org1',
                                'connection': {
                                    'timeout': {
                                        'peer': {
                                            'endorser': '30s',
                                            'eventHub': '30s',
                                            'eventReg': '30s'
                                        },
                                        'orderer': '30s'
                                    }
                                },
                                'credentialStore': {
                                    'path': keyValStoreOrg1,
                                    'cryptoStore': {
                                        'path': keyValStoreOrg1
                                    }
                                }
                            },
                            'channels': {
                                'composerchannel': {
                                    'orderers': [
                                        'orderer.example.com'
                                    ],
                                    'peers': {
                                        'peer0.org1.example.com': {},
                                        'peer0.org2.example.com': {}
                                    }
                                }
                            },
                            'organizations': {
                                'Org1': {
                                    'mspid': 'Org1MSP',
                                    'peers': [
                                        'peer0.org1.example.com'
                                    ],
                                    'certificateAuthorities': [
                                        'ca.org1.example.com'
                                    ]
                                },
                                'Org2': {
                                    'mspid': 'Org2MSP',
                                    'peers': [
                                        'peer0.org2.example.com'
                                    ],
                                    'certificateAuthorities': [
                                        'ca.org2.example.com'
                                    ]
                                }
                            },
                            'orderers': {
                                'orderer.example.com': {
                                    'url': 'grpc://localhost:7050'
                                }
                            },
                            'peers': {
                                'peer0.org1.example.com': {
                                    'url': 'grpc://localhost:7051',
                                    'eventUrl': 'grpc://localhost:7053',
                                    'grpcOptions': {
                                        'request-timeout': 300 * 1000
                                    }
                                },
                                'peer0.org2.example.com': {
                                    'url': 'grpc://localhost:8051',
                                    'eventUrl': 'grpc://localhost:8053',
                                    'grpcOptions': {
                                        'request-timeout': 300 * 1000
                                    }
                                }
                            },
                            'certificateAuthorities': {
                                'ca.org1.example.com': {
                                    'url': 'http://localhost:7054',
                                    'caName': 'ca.org1.example.com'
                                },
                                'ca.org2.example.com': {
                                    'url': 'http://localhost:8054',
                                    'caName': 'ca.org2.example.com'
                                }
                            }
                        };
                        // Define Org2 CCP
                        connectionProfileOrg2 = {};
                        Object.assign(connectionProfileOrg2, connectionProfileOrg1);
                        connectionProfileOrg2.client = {
                            'organization': 'Org2',
                            'connection': {
                                'timeout': {
                                    'peer': {
                                        'endorser': '30s',
                                        'eventHub': '30s',
                                        'eventReg': '30s'
                                    },
                                    'orderer': '30s'
                                }
                            },
                            'credentialStore': {
                                'path': keyValStoreOrg2,
                                'cryptoStore': {
                                    'path': keyValStoreOrg2
                                }
                            }
                        };

                        // define Org1 Only CCP
                        connectionProfileOrg1Only = {
                            'x-type': 'hlfv1',
                            'x-commitTimeout': 300,
                            'version': '1.0.0',
                            'client': {
                                'organization': 'Org1',
                                'connection': {
                                    'timeout': {
                                        'peer': {
                                            'endorser': '30s',
                                            'eventHub': '30s',
                                            'eventReg': '30s'
                                        },
                                        'orderer': '30s'
                                    }
                                },
                                'credentialStore': {
                                    'path': keyValStoreOrg1,
                                    'cryptoStore': {
                                        'path': keyValStoreOrg1
                                    }
                                }
                            },
                            'channels': {
                                'composerchannel': {
                                    'orderers': [
                                        'orderer.example.com'
                                    ],
                                    'peers': {
                                        'peer0.org1.example.com': {}
                                    }
                                }
                            },
                            'organizations': {
                                'Org1': {
                                    'mspid': 'Org1MSP',
                                    'peers': [
                                        'peer0.org1.example.com'
                                    ],
                                    'certificateAuthorities': [
                                        'ca.org1.example.com'
                                    ]
                                }
                            },
                            'orderers': {
                                'orderer.example.com': {
                                    'url': 'grpc://localhost:7050'
                                }
                            },
                            'peers': {
                                'peer0.org1.example.com': {
                                    'url': 'grpc://localhost:7051',
                                    'eventUrl': 'grpc://localhost:7053',
                                    'grpcOptions': {
                                        'request-timeout': 300 * 1000
                                    }
                                }
                            },
                            'certificateAuthorities': {
                                'ca.org1.example.com': {
                                    'url': 'http://localhost:7054',
                                    'caName': 'ca.org1.example.com'
                                }
                            }
                        };
                    }
                    console.log('Calling AdminConnection.createProfile() ...');
                    return adminConnection.createProfile('composer-systests-org1', connectionProfileOrg1)
                        .then(() => {
                            return adminConnection.createProfile('composer-systests-org2', connectionProfileOrg2);
                        })
                        .then(() => {
                            return adminConnection.createProfile('composer-systests-org1-only', connectionProfileOrg1Only);
                        });
                } else {
                    throw new Error('I do not know what kind of tests you want me to run!');
                }

            })
            .then(() => {
                console.log('Called AdminConnection.createProfile()');
                if (TestUtil.isHyperledgerFabricV1()) {
                    let fs = dynamicRequire('fs');
                    console.log('Calling AdminConnection.importIdentity() ...');
                    const admins = [
                        { org: 'org1', keyFile: 'key.pem' },
                        { org: 'org2', keyFile: 'key.pem' }
                    ];
                    return admins.reduce((promise, admin) => {
                        const org = admin.org;
                        const keyFile = admin.keyFile;
                        return promise.then(() => {
                            let keyPath = path.join(__dirname, `../hlfv1/crypto-config/peerOrganizations/${org}.example.com/users/Admin@${org}.example.com/msp/keystore/${keyFile}`);
                            let certPath = path.join(__dirname, `../hlfv1/crypto-config/peerOrganizations/${org}.example.com/users/Admin@${org}.example.com/msp/signcerts/Admin@${org}.example.com-cert.pem`);
                            let signerCert = fs.readFileSync(certPath).toString();
                            let key = fs.readFileSync(keyPath).toString();
                            return adminConnection.importIdentity(`composer-systests-${org}`, 'PeerAdmin', signerCert, key);
                        });
                    }, Promise.resolve())
                        .then(() => {
                            console.log('Called AdminConnection.importIdentity() ...');
                        });
                }
            });
    }

    /**
     * Disconnect the BusinessNetworkConnection object.
     * @return {Promise} - a promise that wil be resolved with a configured and
     * connected instance of BusinessNetworkConnection.
     */
    static tearDown() {
        forceDeploy = false;
        return Promise.resolve();
    }

    /**
     * Get a configured and connected instance of BusinessNetworkConnection.
     * @param {string} network - the identifier of the network to connect to.
     * @param {string} [enrollmentID] - the optional enrollment ID to use.
     * @param {string} [enrollmentSecret] - the optional enrollment secret to use.
     * @return {Promise} - a promise that will be resolved with a configured and
     * connected instance of {@link BusinessNetworkConnection}.
     */
    static getClient(network, enrollmentID, enrollmentSecret) {
        network = network || 'common-network';
        let thisClient;
        return Promise.resolve()
        .then(() => {
            if (enrollmentID) {
                thisClient = new BusinessNetworkConnection();
                process.on('exit', () => {
                    thisClient.disconnect();
                });
            } else if (client) {
                thisClient = client;
                return client.disconnect();
            } else {
                thisClient = client = new BusinessNetworkConnection();
                return;
            }
        })
        .then(() => {
            enrollmentID = enrollmentID || 'admin';
            let password = TestUtil.isHyperledgerFabricV1() ? 'adminpw' : 'Xurw3yU9zI0l';
            enrollmentSecret = enrollmentSecret || password;
            // console.log(`Calling Client.connect('composer-systest', '${network}', '${enrollmentID}', '${enrollmentSecret}') ...`);
            if (TestUtil.isHyperledgerFabricV1() && !forceDeploy) {
                return thisClient.connect('composer-systests-org1', network, enrollmentID, enrollmentSecret);
            } else if (TestUtil.isHyperledgerFabricV1() && forceDeploy) {
                return thisClient.connect('composer-systests-org1-only', network, enrollmentID, enrollmentSecret);
            } else {
                return thisClient.connect('composer-systests', network, enrollmentID, enrollmentSecret);
            }
        })
        .then(() => {
            return thisClient;
        });
    }

    /**
     * Deploy the specified business network definition.
     * @param {BusinessNetworkDefinition} businessNetworkDefinition - the business network definition to deploy.
     * @param {boolean} [forceDeploy_] - force use of the deploy API instead of install and start.
     * @return {Promise} - a promise that will be resolved when complete.
     */
    static deploy(businessNetworkDefinition, forceDeploy_) {
        const adminConnection = new AdminConnection();
        forceDeploy = forceDeploy_;
        const bootstrapTransactions = [
            {
                $class: 'org.hyperledger.composer.system.AddParticipant',
                resources: [
                    {
                        $class: 'org.hyperledger.composer.system.NetworkAdmin',
                        participantId: 'admin'
                    }
                ],
                targetRegistry: 'resource:org.hyperledger.composer.system.ParticipantRegistry#org.hyperledger.composer.system.NetworkAdmin'
            },
            {
                $class: 'org.hyperledger.composer.system.IssueIdentity',
                participant: 'resource:org.hyperledger.composer.system.NetworkAdmin#admin',
                identityName: 'admin',
            }
        ];
        if (TestUtil.isHyperledgerFabricV1() && !forceDeploy) {
            console.log(`Deploying business network ${businessNetworkDefinition.getName()} using install & start ...`);
            return Promise.resolve()
                .then(() => {
                    // Connect and install the runtime onto the peers for org1.
                    return adminConnection.connect('composer-systests-org1', 'PeerAdmin', 'NOTNEEDED');
                })
                .then(() => {
                    return adminConnection.install(businessNetworkDefinition.getName());
                })
                .then(() => {
                    return adminConnection.disconnect();
                })
                .then(() => {
                    // Connect and install the runtime onto the peers for org2.
                    return adminConnection.connect('composer-systests-org2', 'PeerAdmin', 'NOTNEEDED');
                })
                .then(() => {
                    return adminConnection.install(businessNetworkDefinition.getName());
                })
                .then(() => {
                    return adminConnection.disconnect();
                })
                .then(() => {
                    // Connect and start the network on the peers for org1 and org2.
                    return adminConnection.connect('composer-systests-org1', 'PeerAdmin', 'NOTNEEDED');
                })
                .then(() => {
                    return adminConnection.start(businessNetworkDefinition, {
                        bootstrapTransactions,
                        endorsementPolicy: {
                            identities: [
                                {
                                    role: {
                                        name: 'member',
                                        mspId: 'Org1MSP'
                                    }
                                },
                                {
                                    role: {
                                        name: 'member',
                                        mspId: 'Org2MSP'
                                    }
                                }
                            ],
                            policy: {
                                '2-of': [
                                    {
                                        'signed-by': 0
                                    },
                                    {
                                        'signed-by': 1
                                    }
                                ]
                            }
                        }
                    });
                })
                .then(() => {
                    return adminConnection.disconnect();
                });
        } else if (TestUtil.isHyperledgerFabricV1() && forceDeploy) {
            console.log(`Deploying business network ${businessNetworkDefinition.getName()} using deploy ...`);
            // Connect and deploy the network on the peers for org1.
            return adminConnection.connect('composer-systests-org1-only', 'PeerAdmin', 'NOTNEEDED')
                .then(() => {
                    return adminConnection.deploy(businessNetworkDefinition, { bootstrapTransactions });
                })
                .then(() => {
                    return adminConnection.disconnect();
                });
        } else if (!forceDeploy) {
            console.log(`Deploying business network ${businessNetworkDefinition.getName()} using install & start ...`);
            // Connect, install the runtime and start the network.
            return adminConnection.connect('composer-systests', 'admin', 'Xurw3yU9zI0l')
                .then(() => {
                    return adminConnection.install(businessNetworkDefinition.getName());
                })
                .then(() => {
                    return adminConnection.start(businessNetworkDefinition, { bootstrapTransactions });
                })
                .then(() => {
                    return adminConnection.disconnect();
                });
        } else if (forceDeploy) {
            console.log(`Deploying business network ${businessNetworkDefinition.getName()} using deploy ...`);
            // Connect and deploy the network.
            return adminConnection.connect('composer-systests', 'admin', 'Xurw3yU9zI0l')
                .then(() => {
                    return adminConnection.deploy(businessNetworkDefinition, { bootstrapTransactions });
                })
                .then(() => {
                    return adminConnection.disconnect();
                });
        } else {
            throw new Error('I do not know what kind of deploy you want me to run!');
        }
    }

    /**
     * Undeploy the specified business network definition.
     * @param {BusinessNetworkDefiniton} businessNetworkDefinition - the business network definition.
     * @return {Promise} - a promise that will be resolved when complete.
     */
    static undeploy(businessNetworkDefinition) {
        if (!TestUtil.isHyperledgerFabricV1()) {
            return Promise.resolve();
        }
        return docker.listContainers()
            .then((containers) => {
                const matchingContainers = containers.filter((container) => {
                    return container.Image.match(/^dev-/);
                }).map((container) => {
                    return docker.getContainer(container.Id);
                });
                return matchingContainers.reduce((promise, matchingContainer) => {
                    return promise.then(() => {
                        console.log(`Stopping Docker container ${matchingContainer.id} ...`);
                        return matchingContainer.stop();
                    });
                }, Promise.resolve());
            });
    }

    /**
     * Reset the business network to its initial state.
     * @param {String} identifier, business network identifier to reset
     * @return {Promise} - a promise that will be resolved when complete.
     */
    static resetBusinessNetwork(identifier) {
        if (!client) {
            return Promise.resolve();
        }

        if (TestUtil.isHyperledgerFabricV1() && !forceDeploy){
            const adminConnection = new AdminConnection();
            return adminConnection.connect('composer-systests-org1', 'admin', 'NOTNEEDED',identifier)
            .then(() => {
                return adminConnection.reset(identifier);
            })
            .then(() => {
                return adminConnection.disconnect();
            });
        } else if(TestUtil.isHyperledgerFabricV1() && forceDeploy){
            const adminConnection = new AdminConnection();
            return adminConnection.connect('composer-systests-org1-only', 'admin', 'NOTNEEDED',identifier)
            .then(() => {
                return adminConnection.reset(identifier);
            })
            .then(() => {
                return adminConnection.disconnect();
            });
        } else {

            const adminConnection = new AdminConnection();
            return adminConnection.connect('composer-systests', 'admin', 'Xurw3yU9zI0l',identifier)
            .then(() => {
                return adminConnection.reset(identifier);
            })
            .then(() => {
                return adminConnection.disconnect();
            });
        }

    }


    /** Deploy the common systest business network
     *  @return {Promise} - a promise that will be resolved when complete.
     */

}

module.exports = TestUtil;
