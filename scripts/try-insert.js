// Manual check for insertBatch (not part of the app). Run with: npm run try-insert
// It inserts 3 test orders, inserts the same 3 again (all should be duplicates),
// then deletes the test rows. Needs SHARD_URLS in .env and `npm run migrate` done.
const { getShardIndex, getPool, closeAll } = require('../src/db/shards');
const { insertBatch } = require('../src/db/ordersRepo');
const { validateOrderRow } = require('../src/validation/orderRow');

const TEST_SELLER = 'TEST-S9999';
const SOURCE_FILE = 'try-insert-script';

// Raw rows as the CSV parser would hand them over (all strings).
const rawRows = [
  { order_id: 'TEST-ORDER-1', marketplace: 'amazon', sku: 'KURTI-RED-M', quantity: '1', order_amount: '499.00' },
  { order_id: 'TEST-ORDER-2', marketplace: 'flipkart', sku: 'KURTI-BLU-L', quantity: '2', order_amount: '998.00' },
  { order_id: 'TEST-ORDER-3', marketplace: 'meesho', sku: 'SAREE-GRN-FREE', quantity: '3', order_amount: '2397.50' },
].map((row) => ({
  ...row,
  seller_id: TEST_SELLER,
  customer_id: 'C-TEST',
  order_date: '2026-10-01T10:00:00.000Z',
  status: 'delivered',
}));

// Run the rows through the real validator, so insertBatch gets exactly what it
// will get in the upload pipeline: cleaned orders.
function buildOrders() {
  return rawRows.map((raw) => {
    const result = validateOrderRow(raw);
    if (!result.valid) {
      throw new Error(`Test row ${raw.order_id} is invalid: ${result.reason}`);
    }
    return result.order;
  });
}

async function main() {
  const orders = buildOrders();
  const shardIndex = getShardIndex(TEST_SELLER);
  console.log(`Test seller ${TEST_SELLER} routes to shard ${shardIndex}`);

  try {
    const first = await insertBatch(shardIndex, orders, SOURCE_FILE);
    console.log('First call: ', first);

    const second = await insertBatch(shardIndex, orders, SOURCE_FILE);
    console.log('Second call:', second);
  } finally {
    // Always remove the test rows, even if an insert above failed. Parameterized
    // like every other query: the values are never pasted into the SQL.
    try {
      const deleted = await getPool(shardIndex).query(
        'DELETE FROM orders WHERE seller_id = $1 AND order_id = ANY($2::text[])',
        [TEST_SELLER, orders.map((order) => order.order_id)]
      );
      console.log(`Cleanup: deleted ${deleted.rowCount} test rows from shard ${shardIndex}`);
    } catch (cleanupErr) {
      console.error(`Cleanup failed on shard ${shardIndex}: ${cleanupErr.message}`);
      process.exitCode = 1;
    }
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  // Always close the pools, otherwise Node keeps running with open connections.
  .finally(() => closeAll());
