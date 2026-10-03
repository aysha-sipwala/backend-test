// Unit tests for getShardIndex (Section 11).
const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// shards.js loads config.js, which requires SHARD_URLS and builds one pg pool
// per URL. These dummy URLs must be set BEFORE the require below. dotenv never
// overwrites a variable that is already set, so the real .env is not needed.
// A pg pool only connects on its first query, so no database is touched.
process.env.SHARD_URLS = [
  'postgresql://test:test@localhost:5432/dummy_shard_0',
  'postgresql://test:test@localhost:5432/dummy_shard_1',
  'postgresql://test:test@localhost:5432/dummy_shard_2',
].join(',');

const { getShardIndex, SHARD_COUNT, closeAll } = require('../src/db/shards');

// Ends the (never used) pools so the test process can exit cleanly.
after(async () => {
  await closeAll();
});

// 1,000 seller ids in the same style as the sample data: S0001 ... S1000.
const SELLER_IDS = Array.from({ length: 1000 }, (_, i) => `S${String(i + 1).padStart(4, '0')}`);

describe('getShardIndex', () => {
  test('there are 3 shards with the dummy URLs', () => {
    assert.equal(SHARD_COUNT, 3);
  });

  test('the same sellerId always returns the same shard', () => {
    for (const sellerId of ['S0001', 'S0002', 'S0112', 'some-other-seller']) {
      const first = getShardIndex(sellerId);
      for (let i = 0; i < 100; i++) {
        assert.equal(getShardIndex(sellerId), first, sellerId);
      }
    }
  });

  test('the result is always an integer from 0 to SHARD_COUNT - 1', () => {
    for (const sellerId of SELLER_IDS) {
      const index = getShardIndex(sellerId);
      assert.ok(Number.isInteger(index), `${sellerId} gave ${index}`);
      assert.ok(index >= 0 && index < SHARD_COUNT, `${sellerId} gave ${index}`);
    }
  });

  test('every shard receives at least one of 1,000 seller ids', () => {
    const perShard = new Array(SHARD_COUNT).fill(0);
    for (const sellerId of SELLER_IDS) {
      perShard[getShardIndex(sellerId)]++;
    }
    perShard.forEach((count, shard) => {
      assert.ok(count > 0, `shard ${shard} received no sellers`);
    });
  });

  test('the spread is roughly even: no shard gets less than half its fair share', () => {
    const perShard = new Array(SHARD_COUNT).fill(0);
    for (const sellerId of SELLER_IDS) {
      perShard[getShardIndex(sellerId)]++;
    }
    const fairShare = SELLER_IDS.length / SHARD_COUNT;
    perShard.forEach((count, shard) => {
      assert.ok(count >= fairShare / 2, `shard ${shard} received only ${count}`);
    });
  });

  test('it follows the Section 11 formula: MD5, first 8 hex characters, modulo SHARD_COUNT', () => {
    // Written out again here, independently of shards.js.
    function expectedIndex(sellerId) {
      const hex = crypto.createHash('md5').update(sellerId).digest('hex');
      return parseInt(hex.slice(0, 8), 16) % SHARD_COUNT;
    }
    for (const sellerId of SELLER_IDS) {
      assert.equal(getShardIndex(sellerId), expectedIndex(sellerId), sellerId);
    }
  });

  test('known sellers keep landing on the same shard (guards against changing the hash)', () => {
    // If these change, rows already stored in the databases would be on the wrong shard.
    assert.equal(getShardIndex('S0001'), 0);
    assert.equal(getShardIndex('S0002'), 1);
    assert.equal(getShardIndex('S0003'), 0);
    assert.equal(getShardIndex('S0112'), 2);
  });
});
