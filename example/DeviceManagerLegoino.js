'use strict';

const DeviceManager = require('..').DeviceManager;

var deviceManager = new DeviceManager({
  optionCreator: function(portInfo) {
    if (portInfo.manufacturer === 'SparkFun') {
      return {
        baudRate: 9600,
        getIdCommand: 'uq\n',
        getIdResponseParser: function(buffer) {
          return buffer.replace(/[^0-9]/g, '');
        },
        checkResponse: function(buffer) {
          return buffer.endsWith('\n');
        },
        connect: function(connected) {
          console.log('Connecdted', connected);
        }
      };
    }
  }
});

async function queryDevice() {
  let result = await deviceManager.addRequest('16961', 'h\n');
  console.log(result);
  for (let i = 0; i < 26; i++) {
    result = await deviceManager.addRequest(
      '16961',
      String.fromCharCode(i + 65) + '\n'
    );
    console.log(result);
  }
}

queryDevice();
