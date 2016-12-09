'use strict';

const DeviceManager = require('../src/DeviceManager');

var d = new DeviceManager({
    optionCreator: function (portInfo) {
        if (portInfo.manufacturer === 'Keyspan') {
            return {
                baudrate: 9600,
                getIdCommand: '!SHOW HOST_NAME\n',
                getIdResponseParser: function (buffer) {
                    var m = /^Host Name = (.*)\r\n$/.exec(buffer);
                    if (m && m[1]) {
                        return m[1];
                    }
                    throw new Error('Could not parse id response')
                },
                checkResponse: function (buffer) {
                    return buffer.endsWith('\n');
                }
            }
        }
    }
});

d.addRequest('blaster_test_epfl', '!SHOW HOST_NAME\n').then(res => {
    console.log(res);
});