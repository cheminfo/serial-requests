'use strict';

const SerialRequests = require('../src/PortManager');

const s = new SerialRequests('/dev/ttyUSB0', {
    baudrate: 9600,
    getIdCommand: '!SHOW HOST_NAME\n',
    getIdResponseParser: function(buffer) {
        var m = /^Host Name = (.*)\r\n$/.exec(buffer);
        if(m && m[1]) {
            return m[1];
        }
        throw new Error('Could not parse id response')
    }
});

s.on('error', err => {
    console.log('received error', err);
});

s.on('ready', arg => {
    console.log('ready', arg);
    s.addRequest(`! 0 90 193 1
VARIABLE DARKNESS 150
PITCH 200
WIDTH 240
TEXT 4 10 0 BCH
BARCODE QR 200 80 4 M=2 A~
~HA,l:BCH~
END`).then(data => {
        console.log('done request:', data);
    }, err => {
        console.log('req error: ', err);
    });
});

s.on('idchange', arg => {
    console.log('idchange', arg);
});

s.on('reinitialized', arg => {
    console.log('reinitialized', arg);
    s.addRequest(`! 0 90 193 1
VARIABLE DARKNESS 150
PITCH 200
WIDTH 240
TEXT 4 10 0 BCH
BARCODE QR 200 80 4 M=2 A~
~HA,l:BCH~
END`).then(data => {
        console.log('done request');
    }, err => {
        console.log('req error: ', err);
    });
});

s.on('statusChanged', status => {
    console.log('statusChanged', JSON.stringify(status));
});

s.on('close', arg => {
    console.log('close', arg);
});