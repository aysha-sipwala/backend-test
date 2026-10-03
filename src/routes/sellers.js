// GET /sellers/:sellerId/summary (Section 9): top products and sales per
// marketplace for ONE seller. This is the payoff of sharding on seller_id: all of
// a seller's orders live on one shard, so exactly one shard answers.
const express = require('express');
const logger = require('../logger');
const { getShardIndex } = require('../db/shards');
const { sellerSummary } = require('../db/ordersRepo');

const MAX_ID_LENGTH = 64; // same limit the validator puts on seller_id

const router = express.Router();

// Express 5 passes an error from an async handler to the central error handler
// by itself, so a database failure becomes the generic 500 without a try/catch.
router.get('/sellers/:sellerId/summary', async (req, res) => {
  const { sellerId } = req.params;
  if (sellerId.length > MAX_ID_LENGTH) {
    return res.status(400).json({ error: `sellerId must be at most ${MAX_ID_LENGTH} characters` });
  }

  // The shard router decides which one database holds this seller's orders.
  const shardIndex = getShardIndex(sellerId);
  logger.info(
    { route: '/sellers/:sellerId/summary', shard: shardIndex, sellerId, scatter: false },
    'shard_query'
  );

  const summary = await sellerSummary(shardIndex, sellerId);
  if (summary === null) {
    return res.status(404).json({ error: 'No orders found for this seller' });
  }

  return res.status(200).json({ sellerId, ...summary });
});

module.exports = router;
