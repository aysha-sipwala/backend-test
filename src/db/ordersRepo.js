// Orders repository. It writes a batch of already-validated orders into one shard
// (Section 10, "Batch flush") and reads orders back from one shard (Section 9).
// Every function takes a shardIndex: the caller decides which shard (via
// getShardIndex, or all of them for a scatter query) and, for inserts, how big
// the batch is.
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

// ---------------------------------------------------------------------------
// Reads (Ticket 8). Each function queries exactly the one shard it is given.
// All values go in as $1, $2, ... parameters, never into the SQL text.
// ---------------------------------------------------------------------------

// The columns an order is returned with: all of them except created_at. This is
// the same fixed list as the INSERT, so it holds no user input.
const SELECT_COLUMNS = COLUMNS.join(', ');

// Rounds a money amount to 2 decimals. pg returns numeric values as strings.
function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

// One database row -> the object the API returns. pg gives order_date as a Date
// and order_amount as a string, so both are converted here.
function toOrder(row) {
  return {
    order_id: row.order_id,
    seller_id: row.seller_id,
    marketplace: row.marketplace,
    sku: row.sku,
    quantity: row.quantity,
    customer_id: row.customer_id,
    order_date: row.order_date.toISOString(),
    order_amount: money(row.order_amount),
    status: row.status,
    source_file: row.source_file,
  };
}

// findBySeller(shardIndex, sellerId, limit, offset) -> orders, newest first.
// marketplace and order_id after order_date make the order total, so paging with
// limit/offset never repeats or skips a row when two orders share a timestamp.
async function findBySeller(shardIndex, sellerId, limit, offset) {
  const result = await getPool(shardIndex).query(
    `SELECT ${SELECT_COLUMNS} FROM orders
     WHERE seller_id = $1
     ORDER BY order_date DESC, marketplace, order_id
     LIMIT $2 OFFSET $3`,
    [sellerId, limit, offset]
  );
  return result.rows.map(toOrder);
}

// findOrder(shardIndex, orderId, sellerId?) -> every row with that order_id on
// this shard. The same order number can exist for different sellers or
// marketplaces, so there can be several. With sellerId the rows are narrowed to
// that seller.
async function findOrder(shardIndex, orderId, sellerId) {
  const pool = getPool(shardIndex);
  let result;
  if (sellerId === undefined) {
    result = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM orders
       WHERE order_id = $1
       ORDER BY seller_id, marketplace`,
      [orderId]
    );
  } else {
    result = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM orders
       WHERE order_id = $1 AND seller_id = $2
       ORDER BY seller_id, marketplace`,
      [orderId, sellerId]
    );
  }
  return result.rows.map(toOrder);
}

// sellerSummary(shardIndex, sellerId) -> the Section 9 summary, or null if the
// seller has no rows at all on this shard. Cancelled and returned orders do not
// count as sales. Everything is added up by PostgreSQL (SUM, COUNT, GROUP BY);
// no rows are loaded into JavaScript.
async function sellerSummary(shardIndex, sellerId) {
  const pool = getPool(shardIndex);

  // One pass over the seller's rows. FILTER makes a total count only real sales.
  // rows_all counts every row, so "no rows" (404) can be told apart from "only
  // cancelled or returned rows" (200 with zero totals).
  const totals = await pool.query(
    `SELECT
       COUNT(*) AS rows_all,
       COUNT(*) FILTER (WHERE status NOT IN ('cancelled', 'returned')) AS total_orders,
       COALESCE(SUM(quantity) FILTER (WHERE status NOT IN ('cancelled', 'returned')), 0) AS total_units,
       COALESCE(SUM(order_amount) FILTER (WHERE status NOT IN ('cancelled', 'returned')), 0) AS total_revenue
     FROM orders
     WHERE seller_id = $1`,
    [sellerId]
  );
  const t = totals.rows[0];
  if (Number(t.rows_all) === 0) {
    return null;
  }

  // Top 5 products by units sold. Ties are broken by sku so the answer is stable.
  const productsQuery = pool.query(
    `SELECT sku, SUM(quantity) AS units, SUM(order_amount) AS revenue
     FROM orders
     WHERE seller_id = $1 AND status NOT IN ('cancelled', 'returned')
     GROUP BY sku
     ORDER BY SUM(quantity) DESC, sku
     LIMIT 5`,
    [sellerId]
  );

  // Every marketplace with sales, best revenue first (marketplace breaks ties).
  const marketplacesQuery = pool.query(
    `SELECT marketplace, COUNT(*) AS orders, SUM(quantity) AS units, SUM(order_amount) AS revenue
     FROM orders
     WHERE seller_id = $1 AND status NOT IN ('cancelled', 'returned')
     GROUP BY marketplace
     ORDER BY SUM(order_amount) DESC, marketplace`,
    [sellerId]
  );

  const [products, marketplaces] = await Promise.all([productsQuery, marketplacesQuery]);

  // pg returns COUNT and SUM results as strings, so every number is converted.
  return {
    totalOrders: Number(t.total_orders),
    totalUnits: Number(t.total_units),
    totalRevenue: money(t.total_revenue),
    topProducts: products.rows.map((row) => ({
      sku: row.sku,
      units: Number(row.units),
      revenue: money(row.revenue),
    })),
    byMarketplace: marketplaces.rows.map((row) => ({
      marketplace: row.marketplace,
      orders: Number(row.orders),
      units: Number(row.units),
      revenue: money(row.revenue),
    })),
  };
}

module.exports = { insertBatch, findBySeller, findOrder, sellerSummary };
