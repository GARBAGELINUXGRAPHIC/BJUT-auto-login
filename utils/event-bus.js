// utils/event-bus.js
const EventEmitter = require('events');
const eventBus = new EventEmitter();

let logLevel = 'info';
const logLevels = { error: 0, warn: 1, info: 2, debug: 3 };

eventBus.setLogLevel = (level) => {
    logLevel = level;
};

eventBus.log = (message, level = 'debug') => {
    const currentLevel = logLevels[logLevel] || 3;
    const messageLevel = logLevels[level] || 3;

    if (messageLevel <= currentLevel) {
        eventBus.emit('log', message, level);
    }
};

module.exports = eventBus;