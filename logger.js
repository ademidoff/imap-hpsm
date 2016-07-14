/**
 * Universal logger for info & error messages
 */
'use strict';

const winston = require('winston');

var logger = new (winston.Logger)({
    transports: [
        new (winston.transports.File)({
            name: 'info-file',
            filename: 'logs/imap-info.log',
            level: 'info'
        }),
        new (winston.transports.File)({
            name: 'error-file',
            filename: 'logs/imap-error.log',
            level: 'error'
        })
    ]
});

module.exports = () => logger;
