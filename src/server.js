// Entry point: takes the app from app.js and starts listening for HTTP requests.
const app = require('./app');
const config = require('./config');
const logger = require('./logger');

// The Google settings are required to store uploads. They are checked here and
// not in config.js, because the unit tests load config.js and must keep working
// without any Google variables. Only the names are printed, never the values.
const REQUIRED_GOOGLE_SETTINGS = ['GCP_PROJECT_ID', 'GCS_BUCKET_NAME'];
const missing = REQUIRED_GOOGLE_SETTINGS.filter((name) => !config[name]);

if (missing.length > 0) {
  logger.fatal(
    { missing },
    `Missing required environment variable(s): ${missing.join(', ')}. Set them in .env (see .env.example).`
  );
  process.exit(1); // better to stop now than to answer every upload with a 502
}

app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'server_started');
});
