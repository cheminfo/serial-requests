'use strict';


const EventEmitter = require('events');
const SerialPort = require('serialport');
const debug = require('debug')('serial-requests:main');

class SerialRequests extends EventEmitter { //issue with extends EventEmitter
    constructor(port, options, initialize) {
        super(); // 'this' not defined if constructor super class not called);
        this.portOptions = options;
        this.portParam = port;
        this.initCommand = (initialize.init || 'q');
        this.endString = (initialize.endString || '\n\n');
        this.queueLength = 0;
        this.maxQLength = (initialize.maxQLength || 30);
        this.buffer = '';
        this.lastRequest = Promise.resolve('');      // The Last received request
        this.currentRequest = Promise.resolve(''); // The current request being executed
        this.serialResponseTimeout = (initialize.serialResponseTimeout || 200);//config.serialResponseTimeout || 125;
        //this.ready = false; // True if ready to accept new requests into the queue
        this.statusCode = 0;
        this._updateStatus(0);
        this._reconnectionAttempt(port, options);
    }

    /*****************************************************
     Queue Management Functions
     *****************************************************/


    serialPortInit() {
        var that = this;
        that.statusCode = 1;
        that._updateStatus();
        that.addRequest(that.initCommand, {timeout: 200})
            .then(function (buffer) {
                debug('init command buffer ready ', buffer);
                //manage a change in device Id
                //listener should be defined on other js file to destroy the object in this case
                if (!buffer) {
                    throw new Error('Empty buffer when reading qualifier');
                } else if (!buffer.match(/^\d{1,5}\r\n\r\n$/)) {
                    throw new Error('invalid qualifier');
                } else if (that.deviceId && (that.deviceId !== parseInt(buffer))) {
                    that.deviceId = parseInt(buffer);
                    debug('Device Id changed to:' + buffer);
                    that.emit('idchange', that.deviceId);
                    //to do if device id changed --> reject all promises related to serialQ  --> reinit promise promiseQ
                    that.statusCode = 2;
                    that._updateStatus();
                } else if (!that.deviceId) {
                    that.deviceId = parseInt(buffer);
                    that.statusCode = 2;
                    that._updateStatus();
                    that.ready = true;
                    that.emit('ready', that.deviceId);
                    debug('Serial port initialized:' + parseInt(buffer));
                } else {
                    that.deviceId = parseInt(buffer);
                    that.statusCode = 2;
                    that._updateStatus();
                    that.ready = true;
                    that.emit('reinitialized', that.deviceId);
                    debug('Serial port re-initialized:' + parseInt(buffer));
                }

            })
            .catch(function (err) {
                debug('serial init failed');
                debug(err);
                that._scheduleInit();
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
        this.initTimeout = setTimeout(()=> {
            this.serialPortInit();
        }, 2000);
    }

    addRequest(cmd, options) {
        var that = this;
        options = options || {};
        if (!that.ready && (cmd !== that.initCommand)) return Promise.reject(new Error('Device is not ready yet', that.status)); //new error is better practice
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
    _updateStatus() {
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
            default:
                that.status = 'Undefined State';
                that.statusColor = 'LightGrey';
                break;
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
                if (that.deviceId !== null && cmd !== that.initCommand) {
                    if (callId !== that.deviceId) {
                        reject(new Error('invalid id'));
                        return;
                    }
                }
                doTimeout(true);
                debug('Sending command:' + cmd);
                that.port.write(cmd + '\n', function (err) {
                    if (err) {
                        that._handleError(err);
                        // Just go to the next request
                        debug('write error occurred: ', err);
                        reject(new Error('Error writing to serial port'));
                    }
                });

                function doTimeout(force) {
                    //keeps calling itself recursively as long as the request was not served
                    if (bufferSize < that.buffer.length || force) {
                        //if (force) debug('timeout forced');
                        //else debug('timeout renewed');
                        bufferSize = that.buffer.length;
                        that.timeout = setTimeout(function () {
                            doTimeout();
                        }, timeout);
                    } else {
                        if (!that.buffer.endsWith(that.endString)) {
                            debug('buffer not ending properly, possibly invalid command sent: ' + JSON.stringify(that.buffer));
                            return reject(new Error('buffer not ending properly, possibly invalid command sent: ' + JSON.stringify(that.buffer)));
                        }
                        that._resolve(that.buffer);
                        that.buffer = ''; //empty the buffer
                    }
                }
            });
            return that.currentRequest;
        };
    }

    //reduce the queue once one request was solved, then set the promise as solved
    _resolve() {
        this.queueLength--; //where ctx is the context (that of the constructor)
        this.resolveRequest(arguments[0]);
    }

    //error handler
    _handleError(err) {
        if (!this.ready) return; // Already handling an error
        this.ready = false;
        this.port.close(()=> {
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
        debug('reconnection attempt: ' + this.portParam);
        this._hasPort().then(()=> {
            this.port = new SerialPort(this.portParam, this.portOptions);
            // propagate SerialPort events + handle messages (listeners)
            //handle the SerialPort open events
            this.port.on('open', () => {
                debug('opened port:', this.portParam);
                this.emit('open');
                this.statusCode = 0;
                this._updateStatus();
                this._scheduleInit();
            });

            //handle the SerialPort error events
            this.port.on('error', err => {
                this.statusCode = -1;
                this._updateStatus();
                this.ready = false;
                debug(`serialport error on ${this.portParam}: ${err.message}`);
                this.emit('error', err);
            });

            //handle the SerialPort disconnect events
            this.port.on('disconnect', err => {
                this.statusCode = 3;
                this._updateStatus();
                this.ready = false;
                debug(`serialport disconnect on port ${this.portParam}: ${err.message}`);
                this.emit('disconnect', this.deviceId);
            });

            //handle the SerialPort close events and destruct the SerialQueue manager
            this.port.on('close', err => {
                this.statusCode = 4;
                this._updateStatus();
                debug(`serialport close on port ${this.portParam}: ${err.message}`);
                // delete this.port;
                this.emit('close', err);
                this._reconnectionAttempt();
            });

            //handle the SerialPort data events
            this.port.on('data', (data) => {
                this.buffer += data.toString();     //that or this ???? not clear when using one or the other
                this.emit('data', data);
            });
        }, ()=> {
            this.statusCode = 5;
            this._updateStatus();
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
                var port = ports.find((port)=> {
                    return port.comName === that.portParam;
                });
                debug('found Port');
                if (port) {
                    resolve();
                    return;
                }
                reject(new Error(`Port ${that.portParm} not found`));
            });
        });
    }

    //wait loop
    _tryLater() {
        this.ready = false;
        if (!this.isWarned) debug('Unable to connect to port ', this.portParam, '. Please check if your device is connected or your device configuration. We will retry connecting every 2 seconds');
        this.isWarned = true;
        setTimeout(()=> {
            this._reconnectionAttempt();
        }, 2000);
    }

}

module.exports = SerialRequests;