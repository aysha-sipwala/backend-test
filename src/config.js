// Reads every setting from environment variables (loaded from .env locally).
// Rule from Section 6a: validate only what the tickets so far need. SHARD_URLS
// is required now; Ticket 7 adds checks for GCP_PROJECT_ID and GCS_BUCKET_NAME.

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

// SHARD_URLS is a comma-separated list, one PostgreSQL URL per shard.
// Required from Ticket 2 on. Error messages mention only the position of a bad
// URL, never its text, because the URL contains the database password.
function readShardUrls() {
  const raw = readOptional('SHARD_URLS');
  if (raw === undefined) {
    throw new Error(
      'SHARD_URLS is required: set a comma-separated list of PostgreSQL URLs in .env, one per shard'
    );
  }
  const urls = raw
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url !== '');
  if (urls.length === 0) {
    throw new Error('SHARD_URLS is set but contains no URLs');
  }
  urls.forEach((url, index) => {
    if (!/^postgres(ql)?:\/\//.test(url)) {
      throw new Error(`SHARD_URLS entry ${index} must start with postgresql:// or postgres://`);
    }
  });
  return urls;
}

const config = {
  PORT: readPositiveInt('PORT', 3000),
  LOG_LEVEL: readOptional('LOG_LEVEL') || 'info',
  BATCH_SIZE: readPositiveInt('BATCH_SIZE', 1000),

  // Array of connection URLs. Its length is SHARD_COUNT (see db/shards.js).
  SHARD_URLS: readShardUrls(),

  // Optional for now. Validated by Ticket 7.
  GCP_PROJECT_ID: readOptional('GCP_PROJECT_ID'),
  GCS_BUCKET_NAME: readOptional('GCS_BUCKET_NAME'),
};

module.exports = config;
