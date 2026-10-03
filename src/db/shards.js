// The shard layer (Section 11): one connection pool per shard, plus the routing
// function that decides which shard a seller's rows live in.
const crypto = require('crypto');
const { Pool } = require('pg');
const config = require('../config');
const logger = require('../logger');

// Number of shards = number of connection URLs.
const SHARD_COUNT = config.SHARD_URLS.length;

// Pools are created once, when this module is first required. A Pool does not
// open any connection until the first query, so this is cheap.
const pools = config.SHARD_URLS.map((connectionString, index) => {
  const pool = new Pool({
    connectionString,
    // Fail in 5 seconds instead of hanging forever when a shard is down,
    // so /health can answer 503 quickly.
    connectionTimeoutMillis: 5000,
  });

  // Without this handler, an error on an idle connection (for example the
  // database restarting) would crash the whole process.
  pool.on('error', (err) => {
    logger.error({ shard: index, err: err.message }, 'shard_pool_error');
  });

  return pool;
});

// hash(sellerId) % SHARD_COUNT, exactly as described in Section 11.
function getShardIndex(sellerId) {
  // MD5 is used only to spread ids evenly, not for security.
  const hex = crypto.createHash('md5').update(String(sellerId)).digest('hex');
  // First 8 hex characters = a number up to 4,294,967,295, safe in a JS number.
  const hashNumber = parseInt(hex.slice(0, 8), 16);
  return hashNumber % SHARD_COUNT;
}

function getPool(shardIndex) {
  const pool = pools[shardIndex];
  if (!pool) {
    throw new Error(`No shard with index ${shardIndex} (shard count is ${SHARD_COUNT})`);
  }
  return pool;
}

function allPools() {
  return pools;
}

// Ends every pool so the process can exit cleanly (used by scripts and tests).
async function closeAll() {
  await Promise.all(pools.map((pool) => pool.end()));
}

module.exports = { SHARD_COUNT, getShardIndex, getPool, allPools, closeAll };
