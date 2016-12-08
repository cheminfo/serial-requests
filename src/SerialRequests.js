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
        this._updateStatus(0);
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
                    this.deviceId = parseInt(buffer);
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
        var that = this;
        options = options || {};
        if (!that.ready && (cmd !== that.getIdCommand)) return Promise.reject(new Error('Device is not ready')); //new error is better practice
        if (that.queueLength > that.maxQLength) {
            debug('max Queue length reached for device :', that.deviceId);
            return Promise.reject(new Error('Maximum Queue size exceeded, wait for commands to be processed'));
        }
        that.queueLength++;
        debug('adding request to serialQ for device :', that.deviceId);
        debug('number of requests in Queue :', that.queueLength);
        //add one request to the queue at the beginning or the end
        that.lastRequest = that.lastRequest.then(that._appendRequest(cmd, options.timeout), that._appendRequest(cmd, options.timeout));
        return that.lastRequest;
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
        var that = this;
        switch (that.statusCode) {
            case -1:
                that.statusColor = 'Fuchsia ';
                that.status = 'Serial port Error';
                break;
            case 0:
                that.status = 'Serial port not initialized';
                that.statusColor = 'LightGrey';
                break;
            case 1:
                that.statusColor = 'Yellow';
                that.status = 'Serial port initializing';
                break;
            case 2:
                that.statusColor = 'SpringGreen';
                that.status = 'Serial port initialized';
                break;
            case 3:
                that.statusColor = 'Orange';
                that.status = 'Serial port disconnected';
                break;
            case 4:
                that.statusColor = 'Tomato';
                that.status = 'Serial port closed';
                break;
            case 5:
                that.statusColor = 'Red';
                that.status = 'Unable to find the port.';
                break;
            case 6:
                that.statusColor = 'Tomato';
                that.status = 'Serial port closing';
                break;
            case 7:
                that.statusColor = 'Tomato';
                that.status = 'Init command failed';
                break;
            default:
                that.status = 'Undefined State';
                that.statusColor = 'LightGrey';
                break;
        }
        if (code !== 2) that.ready = true;
        else that.ready = false;
        if(changed) {
            this.emit('statusChanged', {
                code: this.statusCode,
                status: this.status,
                message
            });
        }
    }

    _appendRequest(cmd, timeout) {
        var callId = this.deviceId;
        var that = this;
        timeout = timeout || this.serialResponseTimeout;
        return function () {
            that.currentRequest = new Promise(function (resolve, reject) {
                //attach solvers to the currentRequest object
                that.resolveRequest = resolve;
                that.rejectRequest = reject;
                var bufferSize = 0;
                if (that.deviceId !== null && cmd !== that.getIdCommand) {
                    if (callId !== that.deviceId) {
                        reject(new Error('invalid id'));
                        return;
                    }
                }
                doTimeout(true);
                debug('Sending command:' + cmd);
                that.port.write(cmd + '\n', function (err) {
                    if (err) {
                        that._handleWriteError(err);
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
                        that.timeout = setTimeout(function () {
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
            return that.currentRequest;
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
                this._scheduleInit();
            });

            //handle the SerialPort error events
            this.port.on('error', err => {
                console.log('serial port error');
                this._updateStatus(-1);
                debug(`serialport error on ${this.comName}: ${err.message}`);
                this.emit('error', err);
            });

            //handle the SerialPort disconnect events
            this.port.on('disconnect', err => {
                this._updateStatus(3);
                debug(`serialport disconnect on port ${this.comName}: ${err.message}`);
                this.emit('disconnect', this.deviceId);
            });

            //handle the SerialPort close events and destruct the SerialQueue manager
            this.port.on('close', err => {
                this._updateStatus(4);
                debug(`serialport close on port ${this.comName}: ${err.message}`);
                // delete this.port;
                this.emit('close', err);
                this._reconnectionAttempt();
            });

            //handle the SerialPort data events
            this.port.on('data', (data) => {
                this.buffer += data.toString();     //that or this ???? not clear when using one or the other
                this.emit('data', data);
            });
        }, () => {
            this._updateStatus(5);
            this._tryLater();
        });


    }

    //see if the port that was used is actually connected
    _hasPort() {
        debug('called _hasPort');
        var that = this;
        return new Promise(function (resolve, reject) {
            SerialPort.list(function (err, ports) {
                if (err) {
                    reject(err);
                    return;
                }
                var port = ports.find((port) => {
                    return port.comName === that.comName;
                });
                debug('found Port');
                if (port) {
                    resolve();
                    return;
                }
                reject(new Error(`Port ${that.comName} not found`));
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