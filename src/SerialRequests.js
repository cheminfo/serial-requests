'use strict';


const EventEmitter = require('events');
const SerialPort = require('serialport');
const debug = require('debug')('serial-requests:main');

const defaultSerialPortOptions = {
    parser: SerialPort.parsers.raw
};

class SerialRequests extends EventEmitter {
    constructor(port, serialPortOptions, options) {
        super();
        this.portOptions = Object.assign({}, defaultSerialPortOptions, serialPortOptions);
        this.comName = port;
        this.getIdCommand = (options.getIdCommand);
        this.queueLength = 0;
        this.maxQLength = (options.maxQLength || 30);
        this.buffer = '';
        this.lastRequest = Promise.resolve('');      // The Last received request
        this.currentRequest = Promise.resolve(''); // The current request being executed
        this.serialResponseTimeout = (options.serialResponseTimeout || 200);
        this.parseGetIdResponse = options.getIdResponseParser || function (buffer) {
                return buffer;
            };
        this._reconnectionAttempt();
    }

    /*****************************************************
     Queue Management Functions
     *****************************************************/


    serialPortInit() {
        this._updateStatus(1);
        this.addRequest(this.getIdCommand, {timeout: 200})
            .then(buffer => {
                debug(`received init command response: ${JSON.stringify(buffer)}`);
                //manage a change in device Id
                //listener should be defined on other js file to destroy the object in this case
                if (!buffer) {
                    throw new Error('Empty buffer when reading qualifier');
                }
                var deviceId = this.parseGetIdResponse(buffer);
                if (!deviceId) {
                    throw new Error('Device id parsing returned empty result');
                } else if (this.deviceId && (this.deviceId !== deviceId)) {
                    this.deviceId = deviceId;
                    debug(`Device Id changed to: ${deviceId}`);
                    this.emit('idchange', this.deviceId);
                    //to do if device id changed --> reject all promises related to serialQ  --> reinit promise promiseQ
                    this._updateStatus(2);
                } else if (!this.deviceId) {
                    this.deviceId = deviceId;
                    this._updateStatus(2);
                    this.emit('ready', this.deviceId);
                    debug(`Serial port initialized: ${this.deviceId}`);
                } else {
                    this.deviceId = deviceId;
                    this._updateStatus(2);
                    this.emit('reinitialized', this.deviceId);
                    debug(`Serial port re-initialized: ${this.deviceId}`);
                }

            })
            .catch(err => {
                this._updateStatus(7, err.message);
                this._scheduleInit();
            });
    }

    destroy() {
        if (this.initTimeout) {
            clearTimeout(this.initTimeout); //core of the solution
        }
    }

    //here we clear the timeout if already existing, avoid multiple instances of serialportinit running in parallel
    _scheduleInit() {
        if (this.initTimeout) {
            clearTimeout(this.initTimeout); //core of the solution
        }
        this.initTimeout = setTimeout(() => {
            this.serialPortInit();
        }, 2000);
    }

    addRequest(cmd, options) {
        options = options || {};
        if (!this.ready && (cmd !== this.getIdCommand)) return Promise.reject(new Error('Device is not ready')); //new error is better practice
        if (this.queueLength > this.maxQLength) {
            debug('max Queue length reached for device :', this.deviceId);
            return Promise.reject(new Error('Maximum Queue size exceeded, wait for commands to be processed'));
        }
        this.queueLength++;
        debug('adding request to serialQ for device :', this.deviceId);
        debug('number of requests in Queue :', this.queueLength);
        //add one request to the queue at the beginning or the end
        this.lastRequest = this.lastRequest.then(this._appendRequest(cmd, options.timeout), this._appendRequest(cmd, options.timeout));
        return this.lastRequest;
    }

    /************************************************
     Main Utility function, adds a Request
     To the Serial Queue and return a Promise
     ************************************************/
    _updateStatus(code, message) {
        var changed = false;
        if(this.statusCode !== code) {
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
        if (code === 2) this.ready = true;
        else this.ready = false;
        if(changed) {
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
        timeout = timeout || this.serialResponseTimeout;
        return () => {
            this.currentRequest = new Promise((resolve, reject) => {
                //attach solvers to the currentRequest object
                this.resolveRequest = resolve;
                this.rejectRequest = reject;
                var bufferSize = 0;
                if (this.deviceId !== null && cmd !== this.getIdCommand) {
                    if (callId !== this.deviceId) {
                        reject(new Error('invalid id'));
                        return;
                    }
                }
                doTimeout(true);
                debug('Sending command:' + cmd);
                this.port.write(cmd + '\n', err => {
                    if (err) {
                        this._handleWriteError(err);
                        // Just go to the next request
                        debug('write error occurred: ', err);
                        reject(new Error('Error writing to serial port'));
                    }
                });

                function doTimeout(force) {
                    //keeps calling itself recursively as long as the request was not served
                    if (bufferSize < that.buffer.length || force) {
                        // We received something or we force renewal: we wait for another round
                        bufferSize = that.buffer.length;
                        that.timeout = setTimeout(() => {
                            doTimeout();
                        }, timeout);
                    } else {
                        // We haven't received anything, the request is over
                        // If needed validate the response
                        if (that.checkResponse) {
                            if (!that.checkResponse(that.buffer)) {
                                debug('The device response to the command did not pass validation', JSON.stringify(that.buffer));
                                return reject(new Error('The device response to the command did not pass validation'));
                            }
                        }
                        that._resolve(that.buffer);
                        that.buffer = ''; //empty the buffer
                    }
                }
            });
            return this.currentRequest;
        };
    }

    _resolve(response) {
        this.queueLength--;
        this.resolveRequest(response);
    }

    //error handler
    _handleWriteError(err) {
        if (!this.ready) return; // Already handling an error
        this._updateStatus(6);
        this.port.close(() => {
            debug('Connection to serial port failed, closing connection and retrying in 2 seconds' + err);
            if (err) debug('serial port could not be closed');
            else debug('serial port was closed');
        });
    }

    // Utilities, outside the constructor
    // Should not be called outside of here
    // They handle disconnect/reconnect events
    //reconnection handler
    _reconnectionAttempt() {
        debug('reconnection attempt: ' + this.comName);
        this._hasPort().then(() => {
            this.port = new SerialPort(this.comName, this.portOptions);
            // propagate SerialPort events + handle messages (listeners)
            //handle the SerialPort open events
            this.port.on('open', () => {
                debug('opened port:', this.comName);
                this.emit('open');
                this._updateStatus(0);
                this.serialPortInit();
            });

            //handle the SerialPort error events
            this.port.on('error', err => {
                this._updateStatus(-1);
                debug(`serialport error on ${this.comName}: ${err.message}`);
                this.emit('error', err);
                this._tryLater();

            });

            this.port.on('disconnect', err => {
                this._updateStatus(3);
                debug(`serialport disconnect on port ${this.comName}: ${err.message}`);
                this.emit('disconnect', this.deviceId);
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
                    resolve();
                    return;
                }
                reject(new Error(`Port ${this.comName} not found`));
            });
        });
    }

    //wait loop
    _tryLater() {
        debug('Unable to connect to port ', this.comName, '. Please check if your device is connected or your device configuration. We will retry connecting every 2 seconds');
        setTimeout(() => {
            this._reconnectionAttempt();
        }, 2000);
    }

}

module.exports = SerialRequests;