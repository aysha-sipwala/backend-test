# Sharded Orders Ingestion Service

A Node.js and Express API for marketplace seller order analytics. It accepts an orders CSV (about 10,000 rows), stores the original file in Google Cloud Storage, validates every row while streaming, and batch-inserts the valid rows into PostgreSQL. The data is sharded at the application level by `seller_id`, so each seller's orders live together on one shard.

Built for the HM Square Solutions LLP backend assessment (Round 2).

## Table of contents

1. [Use case](#use-case)
2. [How it works](#how-it-works)
3. [Tech stack](#tech-stack)
4. [Setup and run](#setup-and-run)
5. [Google Cloud and ADC](#google-cloud-and-adc)
6. [API](#api)
7. [Sharding](#sharding)
8. [Design decisions](#design-decisions)
9. [Testing](#testing)
10. [Known limitations](#known-limitations)
11. [Project layout](#project-layout)

## Use case

Shop owners (sellers) sell products on marketplaces such as Amazon, Flipkart, Meesho and Myntra. Each marketplace gives them an orders report. A company that manages or analyses seller accounts collects these reports and wants to show each seller:

1. Which of my products sell the most?
2. Which marketplace brings me the most sales?
3. How are my orders and revenue changing over time?

Every one of these questions is about a single seller. That decides the shard key (see [Sharding](#sharding)).

The use case is a design choice for this assessment, inspired by public information about that kind of business. It does not claim any knowledge of a company's internal systems.

A note on scale: 10,000 rows fit easily in one PostgreSQL database, so sharding is not needed at this volume. This project demonstrates a design that scales, not a design the data requires today.

## How it works

`POST /upload-orders` runs this pipeline:

1. `multer` streams the upload to a temp file on disk. The server generates an `uploadId` (UUID).
2. The temp file is uploaded to Cloud Storage first, as `uploads/<uploadId>-orders.csv`. The raw file is the source of truth: if it is safely stored, any later database problem can be recovered by reprocessing. If this step fails, the API returns `502` and nothing is processed.
3. The temp file is read as a stream and piped into `csv-parse`, so the whole file is never held in memory.
4. Each row is validated. Invalid rows are skipped, logged and counted.
5. Each valid row is routed to a shard by its `seller_id` and added to that shard's buffer.
6. When a shard's buffer reaches 1,000 rows it is flushed with one multi-row `INSERT` inside a transaction. The flush is awaited inside the read loop, so the file is never read faster than the database can accept it (backpressure).
7. At the end of the file, the remaining buffers are flushed. The temp file is always deleted, and a JSON summary is returned.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ (CommonJS) |
| Web framework | Express |
| File upload | `multer` with disk storage |
| CSV parsing | `csv-parse` (streaming) |
| Database | PostgreSQL, 3 separate databases as 3 shards, `pg` driver |
| Cloud storage | Google Cloud Storage, `@google-cloud/storage` with Application Default Credentials |
| Logging | `pino` (structured JSON) |
| Tests | Node's built-in test runner |

No ORM and no TypeScript, so the SQL is visible and easy to explain.

## Setup and run

### Prerequisites

- Node.js 20 or newer
- PostgreSQL (tested with 18) running locally
- A Google Cloud project with a Cloud Storage bucket, and the `gcloud` CLI (see [Google Cloud and ADC](#google-cloud-and-adc))

### Steps

1. Install dependencies:

   ```
   npm install
   ```

2. Create three empty databases in PostgreSQL: `orders_shard_0`, `orders_shard_1`, `orders_shard_2`.

3. Copy `.env.example` to `.env` and fill in the values:

   | Variable | Meaning |
   |---|---|
   | `PORT` | HTTP port (default 3000) |
   | `LOG_LEVEL` | pino log level (default `info`) |
   | `BATCH_SIZE` | Rows per batch insert (default 1000, whole number from 1 to 6500) |
   | `SHARD_URLS` | Comma-separated PostgreSQL connection URLs, one per shard. The number of URLs is the shard count |
   | `GCP_PROJECT_ID` | Google Cloud project ID |
   | `GCS_BUCKET_NAME` | Cloud Storage bucket for uploaded files |

   `.env` is git-ignored and never committed. Example `SHARD_URLS` shape:

   ```
   postgres://USER:PASSWORD@localhost:5432/orders_shard_0,postgres://USER:PASSWORD@localhost:5432/orders_shard_1,postgres://USER:PASSWORD@localhost:5432/orders_shard_2
   ```

4. Create the table in every shard:

   ```
   npm run migrate
   ```

5. Generate the sample file (10,000 rows, about 50 sellers, with deliberately invalid and duplicate rows). It is deterministic, and a copy is committed at `sample-data/orders.csv`:

   ```
   npm run generate
   ```

6. Start the server:

   ```
   npm start
   ```

7. Upload the sample file:

   ```
   curl.exe -F "file=@sample-data/orders.csv" http://localhost:3000/upload-orders
   ```

   On Linux or macOS use `curl` instead of `curl.exe`.

The server refuses to start if `GCP_PROJECT_ID` or `GCS_BUCKET_NAME` is missing.

## Google Cloud and ADC

Authentication to Google Cloud uses Application Default Credentials only. There is no service account key file and no `GOOGLE_APPLICATION_CREDENTIALS` variable anywhere in the project. The code calls `new Storage()` with no arguments, and the library finds the credentials on its own.

To set it up on a development machine:

```
gcloud auth application-default login
```

This stores a credentials file in your user profile, outside the repository. Your Google account needs permission to write objects to the bucket. The same code works unchanged on Cloud Run, where ADC comes from the attached service account.

The bucket has public access prevention on, and the code never sets an ACL on the uploaded object.

## API

| Method and path | Purpose |
|---|---|
| `POST /upload-orders` | Upload a CSV (multipart field `file`, `.csv`, max 20 MB) |
| `GET /orders?sellerId=` | One seller's orders, newest first (`limit` default 50, max 200, and `offset`) |
| `GET /orders/:orderId` | One order. Add `?sellerId=` to query a single shard |
| `GET /sellers/:sellerId/summary` | Totals, top 5 products and sales by marketplace for one seller |
| `GET /health` | Checks that every shard is reachable (`503` if any is down) |

### CSV format

Header row required, with these columns: `order_id, seller_id, marketplace, sku, quantity, customer_id, order_date, order_amount, status`. The header `order_amout` (the spelling in the assessment PDF) is accepted as well. Extra columns are ignored.

Validation rules (a row that fails any rule is skipped and counted as invalid):

- `order_id`, `seller_id`, `sku`, `customer_id`: required, at most 64 characters
- `marketplace`: one of `amazon`, `flipkart`, `meesho`, `myntra`
- `quantity`: a whole number, from 1 up to 2,147,483,647 (the largest PostgreSQL integer)
- `order_date`: a valid ISO 8601 date
- `order_amount`: a number, from 0 up to 9,999,999,999.99 (the largest `numeric(12,2)`), at most 2 decimal places
- `status`: one of `pending`, `confirmed`, `shipped`, `delivered`, `cancelled`, `returned`

### Upload response

```json
{
  "status": "completed",
  "uploadId": "07b75782-5762-4eb5-8017-c0ec15ef968d",
  "gcsPath": "gs://<bucket>/uploads/<uploadId>-orders.csv",
  "totalRows": 10000,
  "inserted": 9775,
  "duplicates": 25,
  "invalid": 200,
  "failedBatches": 0,
  "failedRows": 0,
  "perShard": { "0": 5330, "1": 2830, "2": 1615 },
  "durationMs": 16734,
  "sampleErrors": [ { "line": 19, "reason": "invalid order_amount" } ]
}
```

Every row ends up in exactly one bucket, so `inserted + duplicates + invalid + failedRows = totalRows`. `sampleErrors` holds the first 20 invalid rows. All invalid rows are logged.

Errors: `400` for no file, a wrong field name, a non-`.csv` file, or unreadable headers. `413` for a file that is too large. `502` if Cloud Storage fails (nothing is processed). `500` for anything unexpected. Error messages never contain row data, connection strings or raw Google errors.

### Seller summary

```
GET /sellers/S0025/summary
```

Returns `totalOrders`, `totalUnits`, `totalRevenue`, `topProducts` and `byMarketplace`. Orders with status `cancelled` or `returned` are not counted. The figures are calculated inside PostgreSQL (`SUM`, `COUNT`, `GROUP BY`), not in JavaScript, and exactly one shard answers the request.

## Sharding

**Shard key: `seller_id`. Strategy: hash-based, application-level routing.**

```
shardIndex = hash(seller_id) % SHARD_COUNT
hash = first 8 hex characters of the MD5 of seller_id, read as an integer
```

All of the routing lives in `src/db/shards.js`. Every read and write of order data goes through it.

### Why `seller_id`

- Every question the system answers is about one seller, so each one is a single query on a single shard.
- A seller's data is kept together and isolated, the usual pattern for multi-tenant systems.
- There are many distinct sellers, and hashing spreads them across the shards.
- The value never changes after insert.
- `seller_id` is also the first column of the primary key `(seller_id, marketplace, order_id)`, so every copy of the same order always lands in the same shard and duplicate detection is always correct.

### Keys that were considered and rejected

| Key | Why not |
|---|---|
| Month of `order_date` | A seller's dashboard spans months, and the current month would receive all new writes. Good for archiving, wrong here |
| `order_id` | Spreads evenly, but every seller query would hit every shard |
| `customer_id` | Nobody asks per-buyer questions here, and marketplaces do not give sellers a stable buyer ID |
| `marketplace` | Only 4 values, and one marketplace dominates |
| `sku` | Bestsellers skew it, SKUs repeat across sellers, and each seller asks about their own products |

### Why a hash and why MD5

A hash spreads sellers evenly and avoids hot spots from sequential IDs. Ranges would make range queries easy, but this system has none. MD5 is built into Node's `crypto`, gives the same result on every machine and restart, and distributes evenly. It is used for distribution only, not for security.

### How each endpoint finds its shard

- Upload: each row is routed by its own `seller_id`.
- `GET /orders?sellerId=` and `GET /sellers/:sellerId/summary`: routed by `sellerId`, one shard queried. The logs show which one (`shard_query`).
- `GET /orders/:orderId` without `sellerId`: the shard cannot be computed, so all shards are queried in parallel and the matches are combined (scatter-gather). With `?sellerId=` it is a single-shard lookup.

### Trade-offs

1. **A very large seller makes a hot shard.** The sample data deliberately includes a few large sellers, so it shows: shard 0 receives about 54% of the rows. Fixes at scale: shard large sellers by `seller_id` plus month, or give them a dedicated shard through a lookup table.
2. **Reports across all sellers must query every shard and merge the results.** They are rarer than per-seller dashboards. At scale they would feed a separate analytics store such as BigQuery.
3. **Changing the shard count is hard.** With `hash % N`, changing N moves most rows. Production systems use consistent hashing or a fixed number of virtual shards mapped onto physical servers.
4. **Order lookup without a seller is a scatter query.** Fine for 3 shards, expensive for 100.
5. **No cross-shard transactions.** Covered by per-batch transactions and idempotent inserts.
6. **Sharding is not needed at 10,000 rows.** This demonstrates a design that scales.

## Design decisions

- **Streaming everywhere.** The upload goes to disk, then through a streaming parser. Memory use stays flat whatever the file size.
- **Backpressure.** The batch flush is awaited inside the read loop, so the file is read no faster than the database writes.
- **Batch inserts.** One multi-row parameterized `INSERT` per batch: 1,000 rows by 10 columns is 10,000 parameters, safely under PostgreSQL's limit of 65,535.
- **One transaction per batch, per shard.** A transaction cannot span separate databases without two-phase commit, and short transactions hold locks briefly. A file can be partially loaded if a batch fails, which is acceptable because inserts are idempotent.
- **Idempotent inserts.** `ON CONFLICT (seller_id, marketplace, order_id) DO NOTHING`. Uploading the same file twice inserts nothing new (the second upload of the sample file reports 0 inserted and 9,800 duplicates).
- **Retry once.** A failed batch is retried once after 500 ms. If it fails again it is counted in `failedBatches` and `failedRows`, and the rest of the file continues.
- **Store the raw file first.** If Cloud Storage fails, the upload stops before any row is processed. The upload has a 60-second timeout (an abort timer around the stream), so a stalled connection becomes a quick `502` instead of a hanging request.
- **Client filenames are never trusted.** The object name is built from the server's own `uploadId`. The original filename is sanitised and only appears in a log line.
- **Safe errors and logs.** Logs and responses never contain row data, connection strings or raw Google error text, because those can carry personal data, account emails and file paths. Every log line for one upload carries the same `uploadId`.
- **ADC only.** No secret files exist to leak.
- **Plain JavaScript and the `pg` driver.** No ORM, so every query can be read and explained.
- **Processing is synchronous inside the request.** 10,000 rows finish in seconds, so a queue (BullMQ, Pub/Sub) would add complexity without benefit. It is the next step at larger scale.

## Testing

```
npm test
```

78 tests with Node's built-in runner, covering `validateOrderRow` (every rule, valid and invalid, including the upper limits), `getShardIndex` (deterministic, always in range, reasonable spread, and a guard against changing the hash), the `BATCH_SIZE` setting check, and the Cloud Storage upload (success, timeout, missing bucket and missing file, using a fake server on the local machine, so no internet is needed).

End-to-end checks used during development:

- First upload of the sample file: 10,000 rows, 9,775 inserted, 25 duplicates, 200 invalid, per shard 5,330 / 2,830 / 1,615. The same counts were confirmed with `SELECT count(*) FROM orders` in each shard database.
- Second upload of the same file: 0 inserted and 9,800 duplicates.
- A wrong bucket name gives `502`, nothing is inserted, and the log shows only an error code.
- The seller summary of all 50 sellers matched numbers computed independently from the CSV.

## Known limitations

These are recorded honestly, and none of them affects the core flow:

- **Validator edges.** Years such as 0001 or 9999 pass the date check. A date with a space instead of `T` is rejected as non-ISO.
- **Partial commit edge.** If a connection drops after PostgreSQL commits but before the reply arrives, the retry counts those rows as duplicates, so `inserted` is under-reported (no data is lost).
- **Upload parsing.** A broken quote can swallow the lines that follow it, and they are counted as one malformed row. Files are accepted by `.csv` extension only. A crash mid-request can leave a temp file in `tmp/uploads/`.
- **Upload timeout.** The 60-second Cloud Storage timeout means a very slow connection (under about 340 KB per second for a 20 MB file) would fail with a `502`. The value is one constant in `gcs.js`. After a timeout, the library gives no way to cancel the network request itself, so that one connection can stay open until Google or the operating system closes it. It does not affect the next upload.
- **Seller summary** runs three queries without a shared snapshot, so an upload finishing in the middle could make the totals and the breakdown differ slightly.
- **Failure mid-file.** If the stream fails halfway through a file, earlier batches are already committed, but the client gets a `500` with no summary. Re-uploading is safe because of the duplicate check.
- **Deep pages.** `GET /orders` uses `LIMIT` and `OFFSET`, which gets slow on very deep pages. Keyset pagination would scale better.
- **Scatter lookup** returns a `500` if one shard is down, instead of a partial answer, and scans each shard because there is no index on `order_id` alone.
- **Dependencies.** `npm audit` reports 2 moderate issues in `uuid`, pulled in by Google's `gaxios` library. To be reviewed.
- No authentication, no frontend and no deployment: all out of scope for this assessment.

## Project layout

```
src/
  server.js            starts the HTTP server, checks required settings
  app.js               builds the Express app, mounts routes, error handler
  config.js            reads and validates environment variables
  logger.js            pino instance
  routes/              upload.js, orders.js, sellers.js, health.js
  services/
    gcs.js             uploads the file to Cloud Storage with ADC
    ingest.js          the streaming pipeline
  db/
    shards.js          pools and getShardIndex (the routing function)
    ordersRepo.js      insertBatch, findBySeller, findOrder, sellerSummary
  validation/
    orderRow.js        validateOrderRow
sql/001_create_orders.sql
scripts/               migrate.js, generate-orders.js, try-insert.js
sample-data/orders.csv
test/                  orderRow.test.js, shards.test.js
.env.example           placeholders only
```