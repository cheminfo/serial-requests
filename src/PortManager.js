'use strict';


const EventEmitter = require('events');
const SerialPort = require('serialport');
const debug = require('debug')('serial-requests:PortManager');

const defaultOptions = {
    maxQLength: 30,
    serialResponseTimeout: 200,
    getIdResponseParser: function (buffer) {
        return buffer;
    }
};

const enforcedOptions = {
    parser: SerialPort.parsers.raw
};


/**
 * @constructor
 * @param {string} port - The serial port to connect to
 * @param {object|function} options - options
 */
class PortManager extends EventEmitter {
    /**
     * open event
     * The connection to the port was successfully opened. Fires each time the port is reconnected
     *
     * @event PortManager#open
     */

    /**
     * error event
     * The attempt to connect to the port failed. Fires each time a connection attemps fails.
     *
     * @event PortManager#error
     */

    /**
     * ready event
     * The port is initialized, and knows the id of the id it is connected to
     *
     * @event PortManager#ready
     * @type {object}
     * @property {string} id - The id of the ready device
     */

    /**
     * disconnect event
     * The port has disconnected
     *
     * @event PortManager#disconnect
     * @type {object}
     * @property {string} id - The id of the disconnected device
     */

    /**
     * idchange event
     * Upon reconnection, the id of the device connected to the port has changed
     *
     * @event PortManager#idchange
     * @type {object}
     * @property {string} id -  The new device id
     */

    /**
     * reinitialize event
     * Upon reconnection, the id of the device connected to the port is still the same
     *
     * @event PortManager#reinitialize
     * @type {object}
     * @property {string} id -  Device id
     */


    constructor(port, options) {
        super();
        if (typeof options === 'function') {
            this.optionCreator = options;
        } else {
            this.options = Object.assign({}, defaultOptions, options, enforcedOptions);
        }
        this.comName = port;
        this.portInfo = null;
        this.queueLength = 0;
        this.buffer = '';
        this.lastRequest = Promise.resolve(''); // The Last received request
        this.currentRequest = Promise.resolve(''); // The current request being executed
        this._reconnectionAttempt();
    }

    /**
     * Send a request to the port
     * @param {string} cmd - The data to send to the serial port
     * @param {object} [options={}] - Request options
     * @param {object} [options.timeout=200] - Timeout in ms. This is used to know when a request is considered finished.
     * A request is considered finished when the serial port stopped receiving data for more than the given timeout.
     * @return {Promise.<string>} - A promise resolving with response to the request
     */
    addRequest(cmd, options) {
        options = options || {};
        if (!this.ready && (cmd !== this.options.getIdCommand)) return Promise.reject(new Error('Device is not ready'));
        if (this.queueLength > this.options.maxQLength) {
            debug('max Queue length reached for device :', this.deviceId);
            return Promise.reject(new Error('Maximum Queue size exceeded, wait for commands to be processed'));
        }
        this.queueLength++;
        debug('adding request to serialQ for device :', this.deviceId);
        debug('number of requests in Queue :', this.queueLength);
        this.lastRequest = this.lastRequest.then(this._appendRequest(cmd, options.timeout), this._appendRequest(cmd, options.timeout));
        return this.lastRequest;
    }

    _updateOptions() {
        if (this.optionCreator) {
            this.options = this.optionCreator(this.portInfo);
        }
        this.options = Object.assign({}, defaultOptions, this.options, enforcedOptions);
    }

    _serialPortInit() {
        this._updateStatus(1);
        this.addRequest(this.options.getIdCommand)
            .then(buffer => {
                debug(`received init command response: ${JSON.stringify(buffer)}`);
                if (!buffer) {
                    throw new Error('Empty buffer when reading qualifier');
                }
                var deviceId = this.options.getIdResponseParser(buffer);
                if (!deviceId) {
                    throw new Error('Device id parsing returned empty result');
                } else if (this.deviceId && (this.deviceId !== deviceId)) {
                    this.deviceId = deviceId;
                    debug(`Device Id changed to: ${deviceId}`);
                    this.emit('idchange', {id: this.deviceId});
                    this._updateStatus(2);
                } else if (!this.deviceId) {
                    this.deviceId = deviceId;
                    this._updateStatus(2);
                    this.emit('ready', {id: this.deviceId});
                    debug(`Serial port initialized: ${this.deviceId}`);
                } else {
                    this.deviceId = deviceId;
                    this._updateStatus(2);
                    this.emit('reinitialized', {id: this.deviceId});
                    debug(`Serial port re-initialized: ${this.deviceId}`);
                }

            })
            .catch(err => {
                this._updateStatus(7, err.message);
                this._scheduleInit();
            });
    }

    _scheduleInit() {
        if (this.initTimeout) {
            clearTimeout(this.initTimeout);
        }
        this.initTimeout = setTimeout(() => {
            this._serialPortInit();
        }, 2000);
    }

    _updateStatus(code, message) {
        var changed = false;
        if (this.statusCode !== code) {
            changed = true;
        }
        this.statusCode = code;
        switch (this.statusCode) {
            case -1:
                this.statusColor = 'Fuchsia ';
                this.status = 'serial port Error';
                break;
            case 0:
                this.status = 'serial port open';
                this.statusColor = 'LightGrey';
                break;
            case 1:
                this.statusColor = 'Yellow';
                this.status = 'getting device id';
                break;
            case 2:
                this.statusColor = 'SpringGreen';
                this.status = 'Serial port initialized';
                break;
            case 3:
                this.statusColor = 'Orange';
                this.status = 'Serial port disconnected';
                break;
            case 4:
                this.statusColor = 'Tomato';
                this.status = 'Serial port closed';
                break;
            case 5:
                this.statusColor = 'Red';
                this.status = 'Unable to find the port.';
                break;
            case 6:
                this.statusColor = 'Tomato';
                this.status = 'Serial port closing';
                break;
            case 7:
                this.statusColor = 'Tomato';
                this.status = 'Init command failed';
                break;
            default:
                this.status = 'Undefined State';
                this.statusColor = 'LightGrey';
                break;
        }
        if (code === 2) {
            this.ready = true;
        } else {
            // this.portInfo = null;
            this.ready = false;
        }
        if (changed) {
            this.emit('statusChanged', {
                code: this.statusCode,
                status: this.status,
                message
            });
        }
    }

    _appendRequest(cmd, timeout) {
        var that = this;
        var callId = this.deviceId;
        timeout = timeout || this.options.serialResponseTimeout;
        return () => {
            this.currentRequest = new Promise((resolve, reject) => {
                var bufferSize = 0;
                if (this.deviceId !== null && cmd !== this.options.getIdCommand) {
                    if (callId !== this.deviceId) {
                        _reject(new Error('invalid id'));
                        return;
                    }
                }

                debug('Sending command:' + cmd);
                this.port.write(cmd, err => {
                    if (err) {
                        this._handleWriteError(err);
                        debug('write error occurred: ', err);
                        _reject(new Error('Error writing to serial port'));
                    }
                    doTimeout(true);
                });

                function doTimeout(force) {
                    // keeps calling itself "recursively" as long as the request was not served
                    if (bufferSize < that.buffer.length || force) {
                        // We received something or we force renewal: we wait for another round
                        bufferSize = that.buffer.length;
                        that.timeout = setTimeout(() => {
                            doTimeout();
                        }, timeout);
                    } else {
                        // We haven't received new data, the request is considered to be over
                        // If needed validate the response
                        if (that.options.checkResponse) {
                            if (!that.options.checkResponse(that.buffer)) {
                                debug('The device response to the command did not pass validation', JSON.stringify(that.buffer));
                                _reject(new Error('The device response to the command did not pass validation'));
                                return;
                            }
                        }
                        _resolve(that.buffer);
                        that.buffer = ''; //empty the buffer
                    }
                }

                function _resolve(response) {
                    that.queueLength--;
                    resolve(response);
                }

                function _reject(error) {
                    that.queueLength--;
                    reject(error);
                }
            });
            return this.currentRequest;
        };
    }

    _handleWriteError(err) {
        if (!this.ready) return; // Already handling an error
        this._updateStatus(6);
        this.port.close(() => {
            debug('Connection to serial port failed, closing connection and retrying in 2 seconds' + err);
            if (err) debug('serial port could not be closed');
            else debug('serial port was closed');
        });
    }

    _reconnectionAttempt() {
        debug('reconnection attempt: ' + this.comName);
        this._hasPort().then(() => {
            this._updateOptions();
            this.port = new SerialPort(this.comName, this.options);
            this.port.on('open', () => {
                debug('opened port:', this.comName);
                this._updateStatus(0);
                this.emit('open');
                this._serialPortInit();
            });

            this.port.on('error', err => {
                this._updateStatus(-1);
                debug(`serialport error on ${this.comName}: ${err.message}`);
                this.emit('error', err);
                this._tryLater();

            });

            this.port.on('disconnect', err => {
                this._updateStatus(3);
                debug(`serialport disconnect on port ${this.comName}: ${err.message}`);
                this.emit('disconnect', {id: this.deviceId});
            });

            this.port.on('close', err => {
                this._updateStatus(4);
                debug(`serialport close on port ${this.comName}`);
                this.emit('close', err);
                this._reconnectionAttempt();
            });

            this.port.on('data', data => {
                this.buffer += data.toString();
                this.emit('data', data);
            });
        }, () => {
            this._updateStatus(5);
            this._tryLater();
        });


    }

    _hasPort() {
        debug('called _hasPort');
        return new Promise((resolve, reject) => {
            SerialPort.list((err, ports) => {
                if (err) {
                    reject(err);
                    return;
                }
                var port = ports.find((port) => {
                    return port.comName === this.comName;
                });
                debug('found Port');
                if (port) {
                    this.portInfo = port;
                    resolve();
                    return;
                }
                reject(new Error(`Port ${this.comName} not found`));
            });
        });
    }

    _tryLater() {
        debug('Unable to connect to port ', this.comName, '. Please check if your device is connected or your device configuration. We will retry connecting every 2 seconds');
        setTimeout(() => {
            this._reconnectionAttempt();
        }, 2000);
    }
}

module.exports = PortManager;
