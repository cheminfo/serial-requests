'use strict';

const debug = require('debug')('serial-requests:DeviceManager');
const EventEmitter = require('events');
const PortManager = require('./PortManager');
const SerialPort = require('serialport');
const haveConnectedIds = [];

const defaultOptions = {
    timeout: 5000
};


/**
 * @constructor
 * @param {object} options
 * @param {function} [options.optionCreator] - A function that will be called on each new discovered serial port. The
 * function will receive an object describing the port. An example can be found in the
 * @link{https://github.com/EmergingTechnologyAdvisors/node-serialport#serialportlistcallback--function node-serialport github page}.
 * The function should return an untruthy value if that port should be disregarded, and an option object such as expected
 * by PortManager otherwise.
 */
class DeviceManager extends EventEmitter {
    /**
     * new event
     *
     * @event DeviceManager#new
     * @type {object}
     * @property {string} id - Device id
     */

    /**
     * connect event
     *
     * @event DeviceManager#connect
     * @type {object}
     * @property {string} id -  Device id
     */

    /**
     * disconnect event
     *
     * @event DeviceManager#disconnect
     * @type {object}
     * @property {string} id -  Device id
     */


    constructor(options) {
        super();
        this.options = Object.assign({}, defaultOptions, options);
        this.devices = [];
        this.serialQManagers = {};
    }

    /**
     * Send a request to a device and get the response. If the device is not found it will attempt a refresh.
     * @param {string} id - id of the device to send a request to
     * @param {string} cmd - command to send to the device
     * @param {object} options - request options
     * @param {number} [options.timeout=200] - Timeout in ms. This is used to know when a request is considered finished.
     * A request is considered finished when the serial port stopped receiving data for more than the given timeout.
     * @return {Promise.<string>} - The response to the request
     */
    addRequest(id, cmd, options) {
        return this._getSerialQ(id).then(s => s.addRequest(cmd, options));
    }

    /**
     * Get the current list of all connected devices
     * @return {Array<string>} An array of ids
     */
    getDeviceIds() {
        // Return the ids of all currently connected devices
        return Object.keys(this.devices);
    }

    /**
     * Will refresh the list of ports. For each new port, will attempt to initialize it  on weather the optionCreator
     * option returns a truthy value. See PortManager
     * @fires DeviceManager#new
     * @fires DeviceManager#connect
     * @return {Promise} A promise that resolves after the list of available ports has been listed
     */
    refresh() {
        if (this.refreshing) {
            return this.refreshPromise;
        }
        this.refreshPromise = this._updateList();
        return this.refreshPromise;
    }

    _getSerialQ(id) {
        var that = this;
        debug('getting serialQ for device', id);
        if (that.devices[id]) {
            return Promise.resolve(that.devices[id]);
        }

        return that.refresh().then(() => {
            return new Promise((resolve, reject) => {
                function deviceReady(data) {
                    if (id === data.id) {
                        resolve(that.devices[id]);
                    }
                }

                this.on('new', deviceReady);
                this.on('connect', deviceReady);
                setTimeout(() => {
                    this.removeListener('new', deviceReady);
                    this.removeListener('connect', deviceReady);
                    reject(new Error(`timeout exceeded. Device with ID ${id} is not connected, failed to init, or is slow to init`));
                }, this.options.timeout);
            });
        });
    }

    _updateList() {
        debug('call to _updateList method');
        var that = this;
        this.refreshing = true;
        return new Promise((resolve, reject) => {
            SerialPort.list(function (err, ports) {
                that.refreshing = false;
                if (err) {
                    debug('Port List failed : ' + err);
                    reject(err);
                    return;
                }
                // Pass port info through optionCreator
                var selectedPorts = ports.filter(that.options.optionCreator);
                selectedPorts.forEach(function (port) {
                    debug('device with desired specs on port :', port.comName);
                    if (!that.serialQManagers[port.comName]) {
                        // if no PortManager exists for this comName, create it
                        that.serialQManagers[port.comName] = new PortManager(port.comName, that.options.optionCreator);
                        debug('instantiated new SerialQ');

                        that.serialQManagers[port.comName].on('ready', data => {
                            debug('serialQManager ready event, instantiating Device entry:' + data.id);
                            that._deviceConnected(data, port.comName);
                        });

                        that.serialQManagers[port.comName].on('reinitialized', data => {
                            debug('rematching port and device id on reinitialisation:' + data.id);
                            that._deviceConnected(data, port.comName);
                        });

                        that.serialQManagers[port.comName].on('idchange', data => {
                            debug('on deviceId change for port' + port.comName);
                            debug('serialQManager idchangevent event, instantiating Device entry:' + data.id);
                            that._deviceConnected(data, port.comName);
                        });

                        that.serialQManagers[port.comName].on('disconnect', data => {
                            debug('device disconnected on port' + port.comName);
                            debug('closed port for device : ' + data.id);
                            delete that.devices[data.id];
                            that.emit('disconnect', {id: data.id});
                        });
                    }
                });
                resolve();
            });
        });
    }

    _deviceConnected(data, comName) {
        var hasPreviouslyConnected = haveConnectedIds.includes(data.id);
        this.devices[data.id] = this.serialQManagers[comName];
        if (hasPreviouslyConnected) {
            this.emit('connect', {id: data.id});
        } else {
            haveConnectedIds.push(data.id);
            this.emit('new', {id: data.id});
        }
    }
}

module.exports = DeviceManager;
