// Writes sample-data/orders.csv: 10,000 data rows of marketplace orders for
// about 50 sellers, including deliberately invalid and duplicate rows.
// Run with: npm run generate
//
// Uses only Node built-ins. It does not use the app logger or config, because
// those require SHARD_URLS and this script never touches a database.
// A fixed random seed and a fixed reference date make every run produce the
// exact same file, so the numbers in the demo are repeatable.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOTAL_ROWS = 10000; // every data row in the file, valid or not
const SELLER_COUNT = 50;
const INVALID_ROWS = 200; // about 2 percent
const DUPLICATE_ROWS = 25;
const SHARD_COUNT = 3; // default from Section 11; only used for the printed preview
const SEED = 20261003;

// "Today" for the data. Fixed (not new Date()) so the file never changes between runs.
const REFERENCE_TIME = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAYS_BACK = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const OUTPUT_FILE = path.join(__dirname, '..', 'sample-data', 'orders.csv');

// Spelled order_amount (the correct spelling), same column order as Section 8.
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
];

const MARKETPLACES = ['amazon', 'flipkart', 'meesho', 'myntra'];

// Product types a seller can sell. Prices are in whole rupees (min to max).
const PRODUCT_TYPES = [
  { name: 'KURTI', minPrice: 299, maxPrice: 899, sizes: ['S', 'M', 'L', 'XL'] },
  { name: 'SAREE', minPrice: 499, maxPrice: 2499, sizes: ['FREE'] },
  { name: 'TSHIRT', minPrice: 249, maxPrice: 699, sizes: ['S', 'M', 'L', 'XL'] },
  { name: 'JEANS', minPrice: 599, maxPrice: 1799, sizes: ['30', '32', '34', '36'] },
  { name: 'HOODIE', minPrice: 699, maxPrice: 1999, sizes: ['M', 'L', 'XL'] },
  { name: 'SNEAKER', minPrice: 799, maxPrice: 2999, sizes: ['7', '8', '9', '10'] },
  { name: 'HANDBAG', minPrice: 399, maxPrice: 1499, sizes: ['FREE'] },
  { name: 'WATCH', minPrice: 499, maxPrice: 3499, sizes: ['FREE'] },
];
const COLORS = ['RED', 'BLU', 'BLK', 'WHT', 'GRN', 'YEL', 'PNK', 'MAR'];

// Status mix: mostly delivered. Weights are relative, not percentages.
const STATUSES = ['delivered', 'shipped', 'confirmed', 'pending', 'cancelled', 'returned'];
const STATUS_WEIGHTS = [62, 8, 8, 7, 8, 7];

// ---------- seeded random numbers ----------

// mulberry32: a tiny seeded random generator. Same seed, same sequence, always.
function createRng(seed) {
  let state = seed;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = createRng(SEED);

// Whole number from min to max, both included.
function randInt(min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick(list) {
  return list[Math.floor(rng() * list.length)];
}

// Picks an index, where a bigger weight means a more likely pick.
function weightedIndex(weights) {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

// Returns a shuffled copy (Fisher-Yates), leaving the original untouched.
function shuffled(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function randomDigits(count) {
  let digits = '';
  for (let i = 0; i < count; i++) {
    digits += String(randInt(0, 9));
  }
  return digits;
}

// ---------- sellers ----------

function buildSkus() {
  // One or two product types per seller, then readable SKUs like KURTI-RED-M.
  const types = shuffled(PRODUCT_TYPES).slice(0, randInt(1, 2));
  const allCombos = [];
  for (const type of types) {
    // Price per SKU ends in 9 (299, 449, ...) like real shop prices.
    for (const color of COLORS) {
      for (const size of type.sizes) {
        const rupees = randInt(type.minPrice, type.maxPrice);
        allCombos.push({
          sku: `${type.name}-${color}-${size}`,
          pricePaise: (Math.floor(rupees / 10) * 10 + 9) * 100,
        });
      }
    }
  }
  const wanted = randInt(5, 15);
  const chosen = shuffled(allCombos).slice(0, wanted);
  // Earlier SKUs get more weight, so each seller has a few bestsellers.
  return chosen.map((item, index) => ({ ...item, weight: Math.round(100 / (index + 1)) }));
}

function buildSellers() {
  const sellers = [];
  for (let n = 1; n <= SELLER_COUNT; n++) {
    // Uneven on purpose: 3 large sellers, 7 medium, 40 small (Section 11, trade-off 1).
    let weight;
    if (n <= 3) {
      weight = [1600, 1200, 900][n - 1];
    } else if (n <= 10) {
      weight = randInt(250, 400);
    } else {
      weight = randInt(40, 160);
    }

    // Each seller sells on 1 to 3 marketplaces.
    const marketplaces = shuffled(MARKETPLACES).slice(0, randInt(1, 3));
    const skus = buildSkus();

    sellers.push({
      id: `S${String(n).padStart(4, '0')}`,
      weight,
      marketplaces,
      marketplaceWeights: marketplaces.map(() => randInt(1, 10)),
      skus,
      skuWeights: skus.map((s) => s.weight),
    });
  }
  return sellers;
}

// ---------- orders ----------

function makeOrderId(marketplace) {
  // Plausible-looking numbers per marketplace. Not the real formats.
  if (marketplace === 'amazon') return `${randomDigits(3)}-${randomDigits(7)}-${randomDigits(7)}`;
  if (marketplace === 'flipkart') return `OD${randomDigits(12)}`;
  if (marketplace === 'meesho') return `MSH${randomDigits(9)}`;
  return `MYN${randomDigits(10)}`;
}

// Order numbers already used, as "seller|marketplace|order_id". This is what
// keeps order_id unique within one seller and marketplace.
const usedKeys = new Set();

// Builds one valid order (every value is a string, ready to write to CSV).
function makeOrder(seller) {
  const marketplace = seller.marketplaces[weightedIndex(seller.marketplaceWeights)];
  const product = seller.skus[weightedIndex(seller.skuWeights)];

  let orderId;
  do {
    orderId = makeOrderId(marketplace);
  } while (usedKeys.has(`${seller.id}|${marketplace}|${orderId}`));
  usedKeys.add(`${seller.id}|${marketplace}|${orderId}`);

  // Quantity 1 to 5, small quantities far more common.
  const quantity = weightedIndex([50, 25, 12, 8, 5]) + 1;

  // Money is worked out in paise (whole numbers) to avoid floating-point
  // rounding errors, then printed with exactly 2 decimals.
  const discount = pick([1, 1, 1, 0.95, 0.9]);
  const unitPaise = Math.round(product.pricePaise * discount);
  const amountPaise = unitPaise * quantity; // quantity is included in the amount

  const orderTime = REFERENCE_TIME - Math.floor(rng() * DAYS_BACK * DAY_MS);

  return {
    order_id: orderId,
    seller_id: seller.id,
    marketplace,
    sku: product.sku,
    quantity: String(quantity),
    customer_id: `C${String(randInt(1, 3000)).padStart(5, '0')}`,
    order_date: new Date(orderTime).toISOString(),
    order_amount: (amountPaise / 100).toFixed(2),
    status: STATUSES[weightedIndex(STATUS_WEIGHTS)],
  };
}

// ---------- deliberately invalid rows ----------

// One entry per validation rule in Section 8 (some rules have several ways to fail).
const INVALID_KINDS = [
  { name: 'missing seller_id', apply: (r) => ({ ...r, seller_id: '' }) },
  { name: 'unknown marketplace', apply: (r) => ({ ...r, marketplace: pick(['ebay', 'snapdeal', 'shopify']) }) },
  { name: 'quantity is 0', apply: (r) => ({ ...r, quantity: '0' }) },
  { name: 'quantity not a number', apply: (r) => ({ ...r, quantity: 'two' }) },
  { name: 'quantity not a whole number', apply: (r) => ({ ...r, quantity: '1.5' }) },
  { name: 'bad order_date', apply: (r) => ({ ...r, order_date: pick(['2026-13-45T10:00:00.000Z', 'not-a-date', '']) }) },
  { name: 'negative order_amount', apply: (r) => ({ ...r, order_amount: `-${r.order_amount}` }) },
  { name: 'order_amount not a number', apply: (r) => ({ ...r, order_amount: 'abc' }) },
  { name: 'order_amount has 3 decimals', apply: (r) => ({ ...r, order_amount: `${r.order_amount}7` }) },
  { name: 'unknown status', apply: (r) => ({ ...r, status: pick(['shipping', 'lost', 'done']) }) },
  { name: 'empty order_id', apply: (r) => ({ ...r, order_id: '' }) },
  { name: 'empty sku', apply: (r) => ({ ...r, sku: '' }) },
  { name: 'empty customer_id', apply: (r) => ({ ...r, customer_id: '' }) },
  { name: 'order_id longer than 64 characters', apply: (r) => ({ ...r, order_id: 'X'.repeat(70) }) },
];

// ---------- shard preview ----------

// Same logic as getShardIndex in src/db/shards.js (MD5, first 8 hex characters,
// modulo SHARD_COUNT). Copied here on purpose: importing shards.js would load
// config.js, which demands SHARD_URLS and creates database pools, and this
// script must not need a database. Keep the two in step if the contract changes.
function shardIndexFor(sellerId) {
  const hex = crypto.createHash('md5').update(String(sellerId)).digest('hex');
  return parseInt(hex.slice(0, 8), 16) % SHARD_COUNT;
}

// ---------- main ----------

function main() {
  const sellers = buildSellers();

  // 1. Valid, unique orders, split between sellers in proportion to their weight.
  const uniqueCount = TOTAL_ROWS - INVALID_ROWS - DUPLICATE_ROWS;
  const totalWeight = sellers.reduce((sum, s) => sum + s.weight, 0);
  const counts = sellers.map((s) => Math.floor((s.weight / totalWeight) * uniqueCount));
  counts[0] += uniqueCount - counts.reduce((sum, c) => sum + c, 0); // rounding leftovers

  const validRows = [];
  sellers.forEach((seller, index) => {
    for (let i = 0; i < counts[index]; i++) {
      validRows.push(makeOrder(seller));
    }
  });

  // Mix sellers together, like a real combined report.
  const rows = shuffled(validRows);

  // 2. Duplicates: exact copies of earlier valid rows, placed somewhere later in the file.
  const duplicateRows = [];
  for (const original of shuffled(validRows).slice(0, DUPLICATE_ROWS)) {
    const copy = { ...original };
    const originalPosition = rows.indexOf(original);
    rows.splice(randInt(originalPosition + 1, rows.length), 0, copy);
    duplicateRows.push(copy);
  }

  // 3. Invalid rows: valid-looking orders with one field broken, cycling through every kind.
  const invalidByKind = INVALID_KINDS.map((kind) => ({ name: kind.name, count: 0 }));
  for (let i = 0; i < INVALID_ROWS; i++) {
    const kindIndex = i % INVALID_KINDS.length;
    const seller = sellers[weightedIndex(sellers.map((s) => s.weight))];
    const broken = INVALID_KINDS[kindIndex].apply(makeOrder(seller));
    rows.splice(randInt(0, rows.length), 0, broken);
    invalidByKind[kindIndex].count++;
  }

  if (rows.length !== TOTAL_ROWS) {
    throw new Error(`Expected ${TOTAL_ROWS} rows but built ${rows.length}`);
  }

  // 4. Write the file. No value contains a comma or a quote, so plain join is safe.
  const lines = [COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(COLUMNS.map((column) => row[column]).join(','));
  }
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, lines.join('\n') + '\n');

  // 5. Report. console.log is fine here: this is a one-off script, not the server.
  const uniquePerShard = new Array(SHARD_COUNT).fill(0);
  const duplicatesPerShard = new Array(SHARD_COUNT).fill(0);
  validRows.forEach((row) => uniquePerShard[shardIndexFor(row.seller_id)]++);
  duplicateRows.forEach((row) => duplicatesPerShard[shardIndexFor(row.seller_id)]++);

  const sellersInFile = new Set(validRows.map((row) => row.seller_id)).size;
  const largest = counts.slice().sort((a, b) => b - a).slice(0, 3);

  console.log('Wrote sample-data/orders.csv');
  console.log(`Total data rows:        ${rows.length}`);
  console.log(`Sellers:                ${sellersInFile} (largest three: ${largest.join(', ')} rows)`);
  console.log(`Intentionally invalid:  ${INVALID_ROWS}`);
  invalidByKind.forEach((kind) => console.log(`  ${String(kind.count).padStart(2)}  ${kind.name}`));
  console.log(`Intentional duplicates: ${duplicateRows.length}`);
  console.log(`Rows per shard (${SHARD_COUNT} shards, valid rows routed by seller_id):`);
  for (let i = 0; i < SHARD_COUNT; i++) {
    console.log(`  shard ${i}: ${uniquePerShard[i]} unique + ${duplicatesPerShard[i]} duplicates`);
  }
}

main();
