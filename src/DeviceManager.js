'use strict';

const debug = require('debug');
const EventEmitter = require('events');
const SerialRequests = require('./PortManager');
const SerialPort = require('serialport');
const haveConnectedIds = [];

const defaultOptions = {
    timeout: 5000
};

class DeviceManager extends EventEmitter { //issue with extends EventEmitter
    constructor(options) {
        super();
        this.options = Object.assign({}, defaultOptions, options);
        this.devices = [];
        this.serialQManagers = {};
    }

    addRequest(id, cmd, options) {
        return this._getSerialQ(id).then(s => s.addRequest(cmd, options));
    }
    _getSerialQ(id) {
        var that = this;
        debug('getting serialQ for device', id);
        if (that.devices[id]) {
            return Promise.resolve(that.devices[id]);
        }

        return that.refresh().then(() => {
            return new Promise((resolve, reject) => {
                function deviceReady(readyId) {
                    if (id === readyId) {
                        resolve(that.devices[id]);
                    }
                }

                this.on('new', deviceReady);
                this.on('connect', deviceReady);
                setTimeout(() => {
                    this.removeListener('new', deviceReady);
                    this.removeListener('connect', deviceReady);
                    reject(new Error(`timeout exceeded. Device with ID ${id} is not connected or slow to initialize`));
                }, this.options.timeout);
            });
        });
    }

    refresh() {
        if (this.refreshing) {
            return this.refreshPromise;
        }
        this.refreshPromise = this._updateList();
        return this.refreshPromise;
    }

    // Internal management of the SerialQ Lookup
    _updateList() {
        debug('call to _updateList method');
        var that = this;
        this.refreshing = true;
        return new Promise((resolve, reject) => {
            SerialPort.list(function (err, ports) {
                that.refreshing = false;
                if (err) {
                    debug('Port List failed : ' + err);
                    return reject(err);
                }
                // Pass port info through optionCreator
                // Check if it look like an array
                var selectedPorts = ports.filter(that.options.optionCreator);
                selectedPorts.forEach(function (port) {
                    debug('device with desired specs on port :', port.comName);
                    if (!that.serialQManagers[port.comName]) {
                        //create new serial Queue manager if a new serial device was connected
                        that.serialQManagers[port.comName] = new SerialRequests(port.comName, that.options.optionCreator);
                        debug('instantiated new SerialQ');

                        //on ready event
                        that.serialQManagers[port.comName].on('ready', (id) => {
                            debug('serialQManager ready event, instantiating Device entry:' + id);
                            that._deviceConnected(id, port.comName);
                        });

                        //on reinit event
                        that.serialQManagers[port.comName].on('reinitialized', (id) => {
                            debug('rematching port and device id on reinitialisation:' + id);
                            that._deviceConnected(id, port.comName);
                        });

                        //on idchange event
                        that.serialQManagers[port.comName].on('idchange', (id) => {
                            debug('on deviceId change for port' + port.comName);
                            debug('serialQManager idchangevent event, instantiating Device entry:' + id);
                            that._deviceConnected(id, port.comName);
                        });

                        that.serialQManagers[port.comName].on('disconnect', (id) => {
                            debug('device disconnected on port' + port.comName);
                            debug('closed port for device : ' + id);
                            if (id) delete that.devices[id];
                            that.emit('disconnect', id);
                        });
                    }
                });
                resolve();
            });
        });
    }

    _deviceConnected(id, comName) {
        var hasPreviouslyConnected = haveConnectedIds.includes(id);
        this.devices[id] = this.serialQManagers[comName];
        if (hasPreviouslyConnected) {
            this.emit('connect', id);
        } else {
            haveConnectedIds.push(id);
            this.emit('new', id);
        }
    }
}

module.exports = DeviceManager;