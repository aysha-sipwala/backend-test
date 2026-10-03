// Applies sql/001_create_orders.sql to every shard.
// Run with: npm run migrate
const fs = require('fs');
const path = require('path');
const logger = require('../src/logger');
const { allPools, closeAll } = require('../src/db/shards');

const SQL_FILE = path.join(__dirname, '..', 'sql', '001_create_orders.sql');

async function main() {
  const sql = fs.readFileSync(SQL_FILE, 'utf8');
  const pools = allPools();
  let failedShards = 0;

  // One shard at a time, so the log reads in order. A failure on one shard
  // does not stop the others; the exit code reports it at the end.
  for (let shardIndex = 0; shardIndex < pools.length; shardIndex++) {
    try {
      // No parameters, so pg lets us send both statements in one query.
      await pools[shardIndex].query(sql);
      logger.info({ shard: shardIndex }, 'migration_applied');
    } catch (err) {
      failedShards++;
      // Log only the message: never the connection URL or password.
      logger.error({ shard: shardIndex, err: err.message }, 'migration_failed');
    }
  }

  if (failedShards > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    logger.error({ err: err.message }, 'migration_crashed');
    process.exitCode = 1;
  })
  // Always close the pools, otherwise Node keeps running with open connections.
  .finally(() => closeAll());
