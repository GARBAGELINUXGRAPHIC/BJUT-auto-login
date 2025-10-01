// utils/event-bus.js
const EventEmitter = require('events');

// Create and export a single instance of the event emitter.
// This acts as a singleton that can be shared across the application.
module.exports = new EventEmitter();
