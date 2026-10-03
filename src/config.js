// Reads every setting from environment variables (loaded from .env locally).
// Rule from Section 6a: validate only what this ticket needs. Later tickets
// add their own checks for SHARD_URLS, GCP_PROJECT_ID and GCS_BUCKET_NAME.

// quiet: true stops newer dotenv versions from printing a banner on startup.
require('dotenv').config({ quiet: true });

// Turns an env value into a positive whole number, or stops the app with a
// clear message. Failing at startup beats failing halfway through an upload.
function readPositiveInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  }
  return value;
}

// Returns the trimmed value, or undefined when the variable is not set yet.
function readOptional(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return raw.trim();
}

const config = {
  PORT: readPositiveInt('PORT', 3000),
  LOG_LEVEL: readOptional('LOG_LEVEL') || 'info',
  BATCH_SIZE: readPositiveInt('BATCH_SIZE', 1000),

  // Optional for now. Validated by the tickets that use them (2 and 7).
  SHARD_URLS: readOptional('SHARD_URLS'),
  GCP_PROJECT_ID: readOptional('GCP_PROJECT_ID'),
  GCS_BUCKET_NAME: readOptional('GCS_BUCKET_NAME'),
};

module.exports = config;
