// Orders repository. For now it has one job: write a batch of already-validated
// orders into one shard (Section 10, "Batch flush"). The caller decides which
// shard (via getShardIndex) and how big the batch is.
const { getPool, getShardIndex } = require('./shards');
const logger = require('../logger');

// Column order of the INSERT. Must match the order the values are pushed below.
const COLUMNS = [
  'order_id',
  'seller_id',
  'marketplace',
  'sku',
  'quantity',
  'customer_id',
  'order_date',
  'order_amount',
  'status',
  'source_file',
];

// PostgreSQL allows 65,535 parameters in one statement. Stay safely under it.
const MAX_PARAMETERS = 65000;

const MAX_ATTEMPTS = 2; // the first try plus one retry
const RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Builds ONE multi-row INSERT. The SQL text contains only column names and
// placeholders ($1, $2, ...). Every value travels separately in `values`, so
// nothing from the data is ever pasted into the SQL string.
function buildInsert(rows, sourceFile) {
  const tuples = [];
  const values = [];

  rows.forEach((row, rowIndex) => {
    const first = rowIndex * COLUMNS.length;
    // e.g. row 0 -> ($1, $2, ... $10), row 1 -> ($11, $12, ... $20)
    tuples.push(`(${COLUMNS.map((_, i) => `$${first + i + 1}`).join(', ')})`);
    values.push(
      row.order_id,
      row.seller_id,
      row.marketplace,
      row.sku,
      row.quantity,
      row.customer_id,
      row.order_date,
      row.order_amount,
      row.status,
      sourceFile
    );
  });

  const text =
    `INSERT INTO orders (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')} ` +
    'ON CONFLICT (seller_id, marketplace, order_id) DO NOTHING';

  return { text, values };
}

// One attempt: BEGIN, INSERT, COMMIT on a single client. Returns how many rows
// were really inserted (rows skipped by ON CONFLICT are not counted).
async function runTransaction(pool, statement) {
  // If connecting fails, no client was handed out, so there is nothing to release.
  const client = await pool.connect();
  let discardClient = false;

  try {
    await client.query('BEGIN');
    const result = await client.query(statement);
    await client.query('COMMIT');
    return result.rowCount;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection itself is probably broken. Tell the pool to throw this
      // client away instead of reusing it.
      discardClient = true;
    }
    throw err;
  } finally {
    // Runs on success and on every error path, so a client is never leaked.
    client.release(discardClient);
  }
}

// A short description that is safe to log or put in an error: never row values,
// never a connection string or password. Errors sent by PostgreSQL itself can
// quote the offending value in their message, so only their error code is used.
// Network and pool errors (refused connection, timeout) carry no row data.
function describeError(err) {
  if (err && err.severity) {
    return `PostgreSQL error ${err.code}`;
  }
  return err && err.message ? err.message : 'unknown error';
}

// insertBatch(shardIndex, rows, sourceFile, batchLogger?) -> { inserted, duplicates }
// rows: cleaned orders (the `order` from validateOrderRow). The caller owns the
// batch size (BATCH_SIZE); this function never splits a batch.
// batchLogger: optional. The upload pipeline passes its child logger so the
// batch_retry and batch_flushed lines carry the uploadId. Scripts can omit it.
async function insertBatch(shardIndex, rows, sourceFile, batchLogger) {
  const log = batchLogger || logger;

  if (!Array.isArray(rows)) {
    throw new TypeError('insertBatch: rows must be an array');
  }
  if (rows.length === 0) {
    return { inserted: 0, duplicates: 0 };
  }
  if (rows.length * COLUMNS.length > MAX_PARAMETERS) {
    throw new Error(
      `Batch of ${rows.length} rows needs ${rows.length * COLUMNS.length} parameters, ` +
        `over the limit of ${MAX_PARAMETERS} (PostgreSQL allows 65535). Send smaller batches.`
    );
  }

  // Safety net: every row must belong to this shard. A buffering bug upstream
  // would otherwise write a seller's orders to the wrong database without any
  // error. The message holds shard numbers only, never row data.
  for (const row of rows) {
    const rowShard = getShardIndex(row.seller_id);
    if (rowShard !== shardIndex) {
      throw new Error(
        `Shard routing mismatch: batch for shard ${shardIndex} contains a row that belongs to shard ${rowShard}`
      );
    }
  }

  const pool = getPool(shardIndex); // always the shard the caller routed to
  const statement = buildInsert(rows, sourceFile);

  let inserted;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      inserted = await runTransaction(pool, statement);
      break;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          `Batch insert failed on shard ${shardIndex} (${rows.length} rows) ` +
            `after ${MAX_ATTEMPTS} attempts: ${describeError(err)}`
        );
      }
      log.warn(
        { shard: shardIndex, attempt, rows: rows.length, reason: describeError(err) },
        'batch_retry'
      );
      await sleep(RETRY_DELAY_MS);
    }
  }

  const duplicates = rows.length - inserted;
  log.info({ shard: shardIndex, rows: rows.length, inserted, duplicates }, 'batch_flushed');
  return { inserted, duplicates };
}

module.exports = { insertBatch };
