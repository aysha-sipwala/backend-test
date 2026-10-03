// Entry point: takes the app from app.js and starts listening for HTTP requests.
const app = require('./app');
const config = require('./config');
const logger = require('./logger');

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'server_started');
});
