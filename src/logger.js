// One shared pino logger for the whole app. pino writes one JSON object per
// line, so logs can be searched and filtered by field (for example uploadId).
const pino = require('pino');
const config = require('./config');

const logger = pino({ level: config.LOG_LEVEL });

module.exports = logger;
