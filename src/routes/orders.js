// Read endpoints for orders (Section 9):
//   GET /orders?sellerId=   one seller's orders, newest first (ONE shard)
//   GET /orders/:orderId    one order number (one shard with ?sellerId=, else ALL shards)
const express = require('express');
const logger = require('../logger');
const { getShardIndex, allPools } = require('../db/shards');
const { findBySeller, findOrder } = require('../db/ordersRepo');

const MAX_ID_LENGTH = 64; // same limit the validator puts on order_id and seller_id
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const router = express.Router();

// Reads a whole-number query parameter. Returns the number, or null if the text
// is not a non-negative whole number (so "-1", "2.5", "abc" and "" are all null).
function readWholeNumber(text) {
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

// Checks an id taken from the URL or query string. Query values can also arrive
// as arrays or objects (?sellerId=a&sellerId=b), so the type is checked first.
function isValidId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

// GET /orders?sellerId=<id>&limit=&offset=
router.get('/orders', async (req, res) => {
  const { sellerId } = req.query;
  if (!isValidId(sellerId)) {
    return res
      .status(400)
      .json({ error: `sellerId is required and must be at most ${MAX_ID_LENGTH} characters` });
  }

  let limit = DEFAULT_LIMIT;
  if (req.query.limit !== undefined) {
    limit = typeof req.query.limit === 'string' ? readWholeNumber(req.query.limit) : null;
    if (limit === null || limit < 1) {
      return res.status(400).json({ error: 'limit must be a whole number of at least 1' });
    }
    limit = Math.min(limit, MAX_LIMIT); // anything above 200 is cut down to 200
  }

  let offset = 0;
  if (req.query.offset !== undefined) {
    offset = typeof req.query.offset === 'string' ? readWholeNumber(req.query.offset) : null;
    if (offset === null) {
      return res.status(400).json({ error: 'offset must be a whole number of at least 0' });
    }
  }

  // One shard: the router picks it from the seller.
  const shardIndex = getShardIndex(sellerId);
  logger.info({ route: '/orders', shard: shardIndex, sellerId, scatter: false }, 'shard_query');

  const orders = await findBySeller(shardIndex, sellerId, limit, offset);
  return res.status(200).json({ sellerId, limit, offset, count: orders.length, orders });
});

// GET /orders/:orderId[?sellerId=<id>]
router.get('/orders/:orderId', async (req, res) => {
  const { orderId } = req.params;
  if (orderId.length > MAX_ID_LENGTH) {
    return res.status(400).json({ error: `orderId must be at most ${MAX_ID_LENGTH} characters` });
  }

  // sellerId is optional, but if it is present it must be a usable value.
  const { sellerId } = req.query;
  if (sellerId !== undefined && !isValidId(sellerId)) {
    return res
      .status(400)
      .json({ error: `sellerId must be a non-empty value of at most ${MAX_ID_LENGTH} characters` });
  }

  let orders;
  if (sellerId !== undefined) {
    // With the seller known, the router names the one shard to ask.
    const shardIndex = getShardIndex(sellerId);
    logger.info(
      { route: '/orders/:orderId', shard: shardIndex, sellerId, scatter: false },
      'shard_query'
    );
    orders = await findOrder(shardIndex, orderId, sellerId);
  } else {
    // Without the seller there is no way to compute the shard, so every shard is
    // asked at the same time (scatter-gather) and the answers are combined.
    logger.info(
      { route: '/orders/:orderId', shardCount: allPools().length, scatter: true },
      'shard_query'
    );
    const perShard = await Promise.all(
      allPools().map((pool, shardIndex) => findOrder(shardIndex, orderId))
    );
    orders = perShard.flat();
  }

  // Each shard sorted its own rows; sort the combined list so the order is the
  // same no matter which shard answered first.
  orders.sort(
    (a, b) =>
      (a.seller_id < b.seller_id ? -1 : a.seller_id > b.seller_id ? 1 : 0) ||
      (a.marketplace < b.marketplace ? -1 : a.marketplace > b.marketplace ? 1 : 0)
  );

  if (orders.length === 0) {
    return res.status(404).json({ error: 'Order not found' });
  }
  return res.status(200).json({ orderId, count: orders.length, orders });
});

module.exports = router;
