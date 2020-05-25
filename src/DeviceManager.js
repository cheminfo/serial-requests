"use strict";

const debug = require("debug")("serial-requests:DeviceManager");
const EventEmitter = require("events");
const PortManager = require("./PortManager");
const SerialPort = require("serialport");
const haveConnectedIds = [];

const defaultOptions = {
  timeout: 5000,
};

/**
 * @constructor
 * @param {object} [options=]
 * @param {function} [options.optionCreator] - A function this will be called on each new discovered serial port. The
 * function will receive an object describing the port. An example can be found in the
 * @link{https://github.com/EmergingTechnologyAdvisors/node-serialport#serialportlistcallback--function node-serialport github page}.
 * The function should return an untruthy value if this port should be disregarded, and an option object such as expected
 * by PortManager otherwise.
 */
class DeviceManager extends EventEmitter {
  /**
   * new event
   *
   * @event DeviceManager#new
   * @type {object}
   * @property {string} deviceID - Device deviceID
   */

  /**
   * connect event
   *
   * @event DeviceManager#connect
   * @type {object}
   * @property {string} deviceID -  Device deviceID
   */

  /**
   * disconnect event
   *
   * @event DeviceManager#disconnect
   * @type {object}
   * @property {string} deviceID -  Device deviceID
   */

  constructor(options) {
    super();
    this.options = Object.assign({}, defaultOptions, options);
    this.devices = [];
    this.serialQueueManagers = {};
  }

  /**
   * Send a request to a device and get the response. If the device is not found it will attempt a refresh.
   * @param {string} deviceID - deviceID of the device to send a request to
   * @param {string} cmd - command to send to the device
   * @param {object} options - request options
   * @param {number} [options.timeout=200] - Timeout in ms. This is used to know when a request is considered finished.
   * A request is considered finished when the serial port stopped receiving data for more than the given timeout.
   * @return {Promise.<string>} - The response to the request
   */
  addRequest(deviceID, cmd, options) {
    return this._getSerialQueue(deviceID).then((s) =>
      s.addRequest(cmd, options)
    );
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
   * Will refresh the list of ports. For each new port, will attempt to initialize it on weather the optionCreator
   * option returns a truthy value. See PortManager
   * @fires DeviceManager#new
   * @fires DeviceManager#connect
   * @return {Promise} A promise this resolves after the list of available ports has been listed
   */
  refresh() {
    if (this.refreshing) {
      return this.refreshPromise;
    }
    this.refreshPromise = this._updateList();
    return this.refreshPromise;
  }

  _getSerialQueue(deviceID) {
    debug("getting serialQueue for device", deviceID);
    if (this.devices[deviceID]) {
      return this.devices[deviceID];
    }

    return this.refresh().then(() => {
      return new Promise((resolve, reject) => {
        function deviceReady(data) {
          if (deviceID === data.deviceID) {
            resolve(this.devices[deviceID]);
          }
        }

        this.on("new", deviceReady);
        this.on("connect", deviceReady);
        setTimeout(() => {
          this.removeListener("new", deviceReady);
          this.removeListener("connect", deviceReady);
          reject(
            new Error(
              `timeout exceeded. Device with ID ${deviceID} is not connected, failed to init, or is slow to init`
            )
          );
        }, this.options.timeout);
      });
    });
  }

  async _updateList() {
    debug("call to _updateList method");
    this.refreshing = true;
    let ports = await SerialPort.list().catch((err) => {
      debug("Port List failed : " + err);
      reject(err);
      return;
    });
    this.refreshing = false;

    // Pass port info through optionCreator
    let selectedPorts = ports.filter(this.options.optionCreator);
    selectedPorts.forEach((port) => {
      debug("device with desired specs on port :", port.path);
      if (!this.serialQueueManagers[port.path]) {
        // if no PortManager exists for this path, create it
        this.serialQueueManagers[port.path] = new PortManager(
          port.path,
          this.options.optionCreator
        );
        debug("instantiated new SerialAueue");

        this.serialQueueManagers[port.path].on("ready", (data) => {
          debug(
            "serialQManager ready event, instantiating Device entry:" +
              data.deviceID
          );
          this._deviceConnected(data, port.path);
        });

        this.serialQueueManagers[port.path].on("reinitialized", (data) => {
          debug(
            "rematching port and device deviceID on reinitialisation:" +
              data.deviceID
          );
          this._deviceConnected(data, port.path);
        });

        this.serialQueueManagers[port.path].on("idchange", (data) => {
          debug("on deviceId change for port" + port.path);
          debug(
            "serialQManager idchangevent event, instantiating Device entry:" +
              data.deviceID
          );
          this._deviceConnected(data, port.path);
        });

        this.serialQueueManagers[port.path].on("disconnect", (data) => {
          debug("device disconnected on port" + port.path);
          debug("closed port for device : " + data.deviceID);
          delete this.devices[data.deviceID];
          this.emit("disconnect", { deviceID: data.deviceID });
        });
      }
    });
  }

  _deviceConnected(data, path) {
    var hasPreviouslyConnected = haveConnectedIds.includes(data.deviceID);
    this.devices[data.deviceID] = this.serialQueueManagers[path];
    if (hasPreviouslyConnected) {
      this.emit("connect", { deviceID: data.deviceID });
    } else {
      haveConnectedIds.push(data.deviceID);
      this.emit("new", { deviceID: data.deviceID });
    }
  }
}

module.exports = DeviceManager;
