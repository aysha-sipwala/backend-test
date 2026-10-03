# Project Spec: Sharded Orders Ingestion Service

**Owner:** Aysha
**Context:** Backend Engineering Assessment for HM Square Solutions LLP (Junior Software Developer). Submission deadline: **Sunday 4 October 2026, 1:00 PM IST**.
**Repository:** `github.com/aysha-sipwala/backend-test` (public). **Local folder:** `D:\backend-test` (Windows, VS Code).
**Purpose of this document:** This is the single source of truth for every AI agent (Architect, Coder, Reviewer, Tester) working on this project. Work happens in Claude chat: this file is pasted in full at the start of every chat, and the AI reads all of it before writing or reviewing any code. If a task isn't described here, stop and ask rather than assume. (The Teacher persona lives in its own file, `teacher_persona.md`, and is not part of the build loop.)

---

## 1. One-line pitch

A Node.js and Express.js API for marketplace seller order analytics. It accepts an orders CSV (~10,000 rows), stores the original file in Google Cloud Storage, validates every row while streaming, and batch-inserts the valid rows into a PostgreSQL setup that is sharded at the application level by `seller_id`, so each seller's data lives together.

## 2. Use case and problem this solves

**Use case (chosen by Aysha, 3 October 2026): marketplace seller order analytics.** Shop owners sell products on marketplaces such as Amazon, Flipkart, Meesho and Myntra. Each marketplace gives them an orders report. A company that manages or analyses seller accounts (the kind of problem a business like HM Square deals with) collects these reports and wants to show each shop owner which products sell most, which marketplace brings the most sales, and how orders change over time. This use case is a design choice inspired by public information about that kind of business. It does not claim any knowledge of a company's internal systems.

**Who uses it:** the shop owners (sellers) are the clients the system exists for. The company staff who upload their reports are the ones calling the API. There is no login or screen in this assessment: whoever calls `POST /upload-orders` plays the company staff.

**Words used in this project (never mix them up):**
- **Seller:** the shop owner, our client, for example Ramesh who sells kurtis on Meesho and Amazon. `seller_id` is a short code for that shop owner (for example `S0112`). It says whose shop an order belongs to. It says nothing about the product.
- **Customer:** the shopper who bought the item. `customer_id` is a code for that buyer.
- **Product:** the item sold, identified by `sku` (for example `KURTI-BLU-M`).
- **Marketplace:** where the order was placed: amazon, flipkart, meesho or myntra.

**The questions the system answers (every one is about a single seller):**
1. Which of my products sell the most?
2. Which marketplace brings me the most sales?
3. How are my orders and revenue changing over time?

**Why sharding:** with many sellers and thousands of orders each, one database eventually gets slow, so the data is split across several databases (shards). The shard key is the column that decides which shard a row goes to, and it must follow the questions above. All of them are about one seller, so the shard key is `seller_id`: all of one seller's orders sit in one shard, and each question above is answered by one query on one shard. Section 11 has the full reasoning and the trade-offs.

**Honest note:** 10,000 rows fit easily in one database, so sharding is not needed at this volume. The project demonstrates a design that scales, and the README must say so openly.

The assessment evaluates five things (Section 10 of the assessment PDF): Node.js async and streams, PostgreSQL schema and batch inserts, sharding, GCP usage with ADC, and code quality. Every decision below is made to score on those five, and nothing else.

## 3. Non-negotiable constraints

These apply to every ticket, every agent, every session:

- **No credentials in the repository. Ever.** No service account key files, no hardcoded secrets, no real `.env` committed. Google authentication is Application Default Credentials (ADC) only. `.gitignore` must exclude `.env`, `node_modules`, the temp upload folder (`tmp/`), and any key-file names such as `credentials.json` or `*-key.json` before the first commit. Never use the pattern `*.json` itself, because that would also hide `package.json`.
- **Never load the full file into memory.** The CSV is read as a stream, row by row. No `fs.readFile` on the upload, no `multer.memoryStorage()`, no collecting all rows into one array.
- **Never insert rows one by one.** All inserts go through the batch insert function (Section 10). A loop of single-row `INSERT` statements is a failed review.
- **Every row goes through the shard router.** No code path may write to or read from a shard without calling the routing function in Section 11. No hardcoded "shard 0" shortcuts for order data.
- **All SQL is parameterized.** No string concatenation of row values into SQL.
- **Aysha must be able to explain every file.** The next interview round is a walkthrough of this code. Prefer plain, readable JavaScript over clever abstractions, with a short comment explaining why on any non-obvious line.
- **No scope creep.** If a feature is not in Section 4, do not build it. Flag it instead.

## 4. In scope for v1

1. `POST /upload-orders`: accepts one CSV file (multipart form field `file`).
2. The uploaded file is stored in a GCS bucket using ADC.
3. Streaming CSV parsing, row by row.
4. Row validation. Invalid rows are skipped, logged, and counted. A sample of them is returned in the response.
5. Application-level sharding across 3 PostgreSQL databases, shard key `seller_id`.
6. Batch inserts (1,000 rows per batch) inside transactions.
7. Idempotent inserts: uploading the same file twice does not create duplicates.
8. A JSON summary response: total rows, inserted, duplicates, invalid, failed batches, per-shard counts, duration.
9. Bonus endpoint `GET /orders?sellerId=`: one seller's orders (single shard).
10. Bonus endpoint `GET /orders/:orderId`: one order, optionally narrowed by `sellerId`.
11. Seller summary endpoint `GET /sellers/:sellerId/summary`: top products and sales by marketplace for one seller (single shard). This is the endpoint that shows why the shard key was chosen.
12. Bonus endpoint `GET /health`: checks every shard is reachable.
13. Structured logging: upload start/end, GCS result, batch flushes, failed records, errors.
14. SQL migration script and a migration runner that applies it to every shard.
15. A sample-data generator script that produces a 10,000-row CSV (about 50 sellers of uneven size, 4 marketplaces, deliberately invalid and duplicate rows), needed for the demo video.
16. Unit tests for the two pieces of pure logic: row validation and shard routing.
17. `README.md` (setup, ADC configuration, the use case, sharding explanation, design decisions and trade-offs) and `.env.example`.
18. **Optional, only if everything above is done and working:** Docker Compose setup for the app and the 3 databases.

## 5. Explicitly out of scope for v1

- Excel (`.xlsx`) uploads. The assessment says CSV or Excel is the candidate's choice. CSV is chosen because it streams naturally.
- Background workers or queues (BullMQ, Redis, Pub/Sub). Processing is synchronous inside the request. 10,000 rows finish in a few seconds, so a queue would add complexity without benefit here. It is named in the README as the next step at larger scale.
- Authentication on the API.
- A frontend. The demo uses Postman or curl.
- Cloud deployment (Cloud Run, etc.). The app runs locally and talks to the real GCS bucket.
- Consistent hashing, resharding, or shard rebalancing tools.
- Cross-shard transactions (two-phase commit).
- TypeScript, ORMs (Prisma, Sequelize, Knex). JavaScript with the `pg` driver only, so the SQL is visible and explainable.
- Real marketplace API integrations, or each marketplace's own report format. The input is one simplified CSV format (Section 8).

## 6. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 20+ (LTS) | Required by the assessment |
| Language | JavaScript (CommonJS) on Node.js | No TypeScript. Readability and explainability over type safety for a 24-hour task |
| Web framework | Express.js | The standard Node.js web framework, minimal and widely known |
| File upload | `multer` with **disk storage** | Writes the upload to a temp file as a stream. Never `memoryStorage` |
| CSV parsing | `csv-parse` (streaming API, async iterator) | `for await (const row of parser)` gives row-by-row reading with automatic backpressure |
| Database driver | `pg` (node-postgres) | One connection pool per shard |
| Database | PostgreSQL 15+ | 3 separate databases act as 3 shards: `orders_shard_0`, `orders_shard_1`, `orders_shard_2` |
| Cloud storage | `@google-cloud/storage` | `new Storage()` with no arguments, so it picks up ADC automatically |
| Logging | `pino` | Structured JSON logs |
| Config | `dotenv` | Reads `.env` locally. `.env.example` is committed, `.env` is not |
| Tests | Node's built-in test runner (`node --test`) | No extra dependency |
| API testing / demo | Postman or curl | |

**Why 3 databases instead of table partitioning:** the assessment lists application-level sharding as the recommended approach. Separate databases with routing logic in the app is the clearest demonstration: each shard could be moved to its own server by changing one connection URL, with no code change.

### 6a. Environment variables

All configuration comes from environment variables, loaded from `.env` locally. `.env` is never committed. `.env.example` is committed with placeholders only. Aysha adds each variable when the ticket that needs it arrives.

| Variable | Needed from | Meaning |
|---|---|---|
| `PORT` | Ticket 1 | HTTP port, default 3000 |
| `LOG_LEVEL` | Ticket 1 | pino log level, default `info` |
| `BATCH_SIZE` | Ticket 1 | Rows per batch insert, default 1000 |
| `SHARD_URLS` | Ticket 2 | Comma-separated PostgreSQL connection URLs, one per shard. The number of URLs is `SHARD_COUNT` |
| `GCP_PROJECT_ID` | Ticket 7 | Google Cloud project ID (`silver-osprey-460010-d8`) |
| `GCS_BUCKET_NAME` | Ticket 7 | Cloud Storage bucket for uploaded files |

**Rule:** a ticket validates (and fails fast on) only the variables it needs. Ticket 1 must not crash because later variables are not set yet. The PostgreSQL password in `SHARD_URLS` uses only letters and numbers, so it needs no URL encoding.

## 7. Schema notation key

- **pk**: primary key. The unique ID for each row.
- **composite primary key**: a primary key made of more than one column. The combination of values must be unique.
- **text**: a string of any length.
- **timestamptz**: a timestamp stored with time zone (PostgreSQL normalizes it to UTC).
- **numeric(12,2)**: an exact decimal with 2 digits after the point. Used for money because floating-point types cause rounding errors.
- **check constraint**: a rule the database enforces on a column's value.
- **index**: a lookup structure that makes queries on a column fast, at the cost of slightly slower inserts.
- **shard**: one of the separate databases that together hold the full data set.
- **shard key**: the column whose value decides which shard a row lives in.

## 8. Data model

The same schema exists in **every** shard. The migration file is `sql/001_create_orders.sql`.

**`orders`** (one row per order line)
- order_id (text, not null): the marketplace's own order number. Unique only within one seller and marketplace, so it is not a primary key on its own.
- seller_id (text, not null): the shop owner this order belongs to. **The shard key.**
- marketplace (text, not null, check in: `amazon`, `flipkart`, `meesho`, `myntra`)
- sku (text, not null): the product sold
- quantity (integer, not null, check `quantity >= 1`)
- customer_id (text, not null): the buyer. Required by the assessment. Marketplaces generally do not give sellers a stable buyer ID, so it is stored but never used for sharding or analytics.
- order_date (timestamptz, not null)
- order_amount (numeric(12,2), not null, check `order_amount >= 0`): the total for this order line in INR, quantity included
- status (text, not null, check in: `pending`, `confirmed`, `shipped`, `delivered`, `cancelled`, `returned`)
- source_file (text, not null): the GCS object path the row came from, for traceability
- created_at (timestamptz, not null, default `now()`)
- **Primary key: `(seller_id, marketplace, order_id)`**

**Indexes**
- The primary key `(seller_id, marketplace, order_id)`: makes `ON CONFLICT ... DO NOTHING` possible, and its leading column `seller_id` also serves per-seller lookups. Because `seller_id` is both the shard key and part of the primary key, duplicate detection always happens inside the one shard the row belongs to.
- `idx_orders_seller_date` on `(seller_id, order_date DESC)`: serves `GET /orders?sellerId=` (newest first) and time-based summaries.
- No other indexes. Every extra index slows down bulk inserts, and no other query exists in v1.

**CSV input contract**
- Header row required. Columns: `order_id, seller_id, marketplace, sku, quantity, customer_id, order_date, order_amount, status`.
- The assessment PDF spells the amount field `order_amout` (a typo). The parser must accept **both** `order_amount` and `order_amout` as the header for this column.
- Extra columns are ignored. Header names are trimmed and lowercased before matching.

**Validation rules (a row failing any rule is invalid and skipped)**
- `order_id`, `seller_id`, `sku`, `customer_id`: required, non-empty after trim, max 64 characters.
- `marketplace`: required, lowercased, one of the four allowed values.
- `quantity`: required, a whole number, at least 1.
- `order_date`: required, must parse to a valid date (ISO 8601 expected).
- `order_amount`: required, must be a number, must be >= 0, at most 2 decimal places.
- `status`: required, lowercased, one of the six allowed values.

The validator is a pure function: `validateOrderRow(row) -> { valid: true, order } | { valid: false, reason }`. No database or network access inside it, so it is easy to unit test.

## 9. Core API routes

- `POST /upload-orders`
  - Request: `multipart/form-data`, field name `file`, a `.csv` file, max 20 MB.
  - Success response `200`:
    ```json
    {
      "status": "completed",
      "uploadId": "uuid",
      "gcsPath": "gs://bucket/uploads/<uploadId>-orders.csv",
      "totalRows": 10000,
      "inserted": 9780,
      "duplicates": 20,
      "invalid": 200,
      "failedBatches": 0,
      "perShard": { "0": 3260, "1": 3301, "2": 3219 },
      "durationMs": 1840,
      "sampleErrors": [ { "line": 14, "reason": "invalid order_date" } ]
    }
    ```
  - `status` is `"completed"` when no batch failed, `"completed_with_errors"` when at least one batch failed after retry. Invalid rows alone do not make it `completed_with_errors`. They are expected input problems and are reported in `invalid`.
  - `sampleErrors` holds at most the first 20 invalid rows. All invalid rows are logged.
  - Errors: `400` no file, wrong field name, or not a `.csv`. `413` file too large. `502` GCS upload failed (nothing is processed). `500` unexpected error.
- `GET /orders?sellerId=<id>`: returns that seller's orders, newest first, with `limit` (default 50, max 200) and `offset` query params. `400` if `sellerId` is missing. One shard is queried.
- `GET /orders/:orderId`: returns every order row with that `order_id` (the same number can exist for different sellers or marketplaces). Optional `sellerId` query param: if given, only that seller's shard is queried. If omitted, all shards are queried in parallel (scatter-gather). `404` if nothing matches.
- `GET /sellers/:sellerId/summary`: the analytics endpoint. Routed by `sellerId`, so exactly one shard is queried. Response `200`:
  ```json
  {
    "sellerId": "S0112",
    "totalOrders": 412,
    "totalUnits": 590,
    "totalRevenue": 245310.5,
    "topProducts": [ { "sku": "KURTI-BLU-M", "units": 85, "revenue": 33915.0 } ],
    "byMarketplace": [ { "marketplace": "meesho", "orders": 230, "units": 340, "revenue": 118200.0 } ]
  }
  ```
  - Only orders whose status is not `cancelled` or `returned` count toward the figures.
  - `topProducts` is the top 5 SKUs by units. `byMarketplace` lists every marketplace the seller has sales on, highest revenue first.
  - `404` if the seller has no orders.
- `GET /health`: runs `SELECT 1` on every shard. `200` with per-shard status if all are up, `503` if any is down.

## 10. Processing pipeline and error strategy

**Pipeline for `POST /upload-orders`, in order:**

1. `multer` streams the upload to a temp file on disk (`tmp/uploads/`). Generate an `uploadId` (UUID). Log "upload started".
2. **Upload the temp file to GCS first**, as `uploads/<uploadId>-<originalFilename>`. If this fails, return `502`, delete the temp file, and stop. Reason for doing GCS first: the raw file is the source of truth. If it is safely stored, any later database problem can be recovered by reprocessing. Processing data whose original file was lost is the worse failure.
3. Open a read stream on the temp file and pipe it into the `csv-parse` streaming parser.
4. For each row: validate (Section 8). Invalid: count it, log it, add to `sampleErrors` if fewer than 20. Valid: ask the shard router (Section 11) for the shard index using the row's `seller_id`, and push the row into that shard's buffer.
5. When any shard's buffer reaches `BATCH_SIZE` (1,000), **flush** it (below) before reading further rows. Awaiting the flush inside the `for await` loop is what creates backpressure: the file is not read faster than the database can accept it.
6. At end of file, flush every remaining non-empty buffer.
7. Delete the temp file (in a `finally` block so it also happens on errors). Log "upload finished" with the summary. Return the summary.

**Batch flush (the only way rows are written):**

- One multi-row statement per batch:
  `INSERT INTO orders (order_id, seller_id, marketplace, sku, quantity, customer_id, order_date, order_amount, status, source_file) VALUES ($1,$2,...),(...),... ON CONFLICT (seller_id, marketplace, order_id) DO NOTHING`
- 1,000 rows x 10 columns = 10,000 parameters, safely under PostgreSQL's 65,535 parameter limit.
- Wrapped in a transaction on a single client from that shard's pool: `BEGIN`, insert, `COMMIT`. On any error: `ROLLBACK`.
- `inserted` = the statement's `rowCount`. `duplicates` = batch size minus `rowCount`.

**Transaction scope (locked): one transaction per batch, per shard.** Not one giant transaction for the whole file. Reasons: a transaction cannot span separate databases without two-phase commit (out of scope), and short transactions hold locks briefly. The consequence is that a file can be partially loaded if a batch fails. That is acceptable **because inserts are idempotent**: re-uploading the same file inserts only the missing rows.

**Idempotency:** `ON CONFLICT (seller_id, marketplace, order_id) DO NOTHING`. A repeated combination of seller, marketplace and order number is counted as a duplicate, never an error, never a second row.

**Retry strategy:** if a batch fails, retry it **once** after a short delay (500 ms). If it fails again, log the error with the shard index and batch size, increment `failedBatches`, and continue with the rest of the file. No infinite retries. No crash.

**Error categories and handling:**

| Failure | Handling |
|---|---|
| No file / wrong type / too large | `400` / `400` / `413`, nothing stored |
| GCS upload fails | `502`, temp file deleted, nothing processed |
| CSV row malformed or invalid | Row skipped, counted, logged. Processing continues |
| CSV file structurally unreadable (e.g. missing required headers) | `400` with a clear message |
| Batch insert fails | Rollback, retry once, then count as failed batch and continue |
| Shard unreachable at startup or in `/health` | Logged. `/health` returns `503` |

**Logging (pino):** every log line for one upload carries the `uploadId`. Required events: `upload_started`, `gcs_upload_ok` / `gcs_upload_failed`, `batch_flushed` (shard, rows, inserted, duplicates), `row_invalid` (line, reason), `batch_failed`, `upload_finished` (full summary).

## 11. The sharding logic, explicitly

This is the heart of the assessment and the part Aysha must be able to explain and redraw on a whiteboard without notes. The use case in Section 2 decides the key, not the other way round.

**Shard key: `seller_id`. Strategy: hash-based, application-level routing.**

```
shardIndex = hash(seller_id) % SHARD_COUNT

hash(seller_id):
    take the MD5 of the seller_id string
    take the first 8 hex characters
    convert them to an integer

SHARD_COUNT = number of connection URLs in SHARD_URLS (3 by default)
```

All of this lives in one module, `src/db/shards.js`, which exposes:
- `getShardIndex(sellerId)`: the pure routing function above.
- `getPool(shardIndex)`: the `pg` pool for that shard.
- `allPools()`: every pool, for health checks and scatter queries.

**Why `seller_id`:**
- Every question the system answers is about one seller (top products, sales per marketplace, orders over time). With this key, each of those is one query on one shard.
- A seller's data is kept together and isolated, which is the normal pattern for multi-tenant systems where each client only sees their own data.
- There are many distinct sellers, and hashing spreads them evenly across the shards.
- The value never changes after a row is inserted.
- Because `seller_id` is also part of the primary key, every copy of the same order always lands in the same shard, so duplicate detection is always correct.

**A shard key is good if it passes four tests:** it matches the most common query, it has many distinct values, it spreads data evenly, and it never changes. How the candidates compare for this use case:

| Key | Matches the main query | Many distinct values | Even spread | Verdict |
|---|---|---|---|---|
| `seller_id` | Yes | Yes | Mostly (a very large seller is the risk) | **Chosen** |
| month of `order_date` | No (a seller's dashboard spans months) | No (12 a year) | No (the current month receives all new writes) | Right for archiving and monthly reporting, wrong for this use case |
| `order_id` | No | Yes | Yes | Spreads well, but every seller query would hit every shard |
| `customer_id` | No | Yes | Yes | Answers a question nobody asks here: sellers do not query per buyer, and marketplaces do not give sellers a stable buyer ID |
| `marketplace` | No | No (4 values) | No (one marketplace dominates) | Unusable |
| `sku` (product) | No | Yes | No (bestsellers skew it) | Wrong: SKUs repeat across sellers, and each seller asks about their own products |

**Why a hash instead of ranges of seller IDs:** a hash spreads sellers evenly and avoids hot spots from sequential IDs. Ranges would make range queries easy, but this system has no such query.

**Why MD5 for the hash:** it is built into Node's `crypto`, deterministic across machines and restarts, and distributes evenly. It is used here for distribution only, not for security.

**How each endpoint finds its shard:**
- `POST /upload-orders`: each row is routed by its own `seller_id`.
- `GET /orders?sellerId=`: route by `sellerId`. One shard queried.
- `GET /sellers/:sellerId/summary`: route by `sellerId`. One shard queried. This is the payoff of the shard key.
- `GET /orders/:orderId`: with `sellerId`, one shard. Without it, the shard cannot be computed, so all shards are queried in parallel (`Promise.all`) and the matches are combined. This is called scatter-gather.

**Trade-offs to state honestly in the README and the interview:**
1. **A very large seller makes a hot shard.** The sample data deliberately includes a few large sellers so this is visible in the per-shard counts. Fixes at scale: shard large sellers by `seller_id` plus month, or give them a dedicated shard through a lookup table.
2. **Reports across all sellers must query every shard and merge the results.** They are rarer than per-seller dashboards. At larger scale they would feed a separate analytics store such as BigQuery.
3. **Changing the shard count is hard.** With `hash % N`, changing N moves most rows to a different shard. Production systems use consistent hashing or a fixed number of virtual shards mapped onto physical servers. Out of scope here.
4. **Order lookup without a seller is a scatter query.** Fine for 3 shards, expensive for 100.
5. **No cross-shard transactions.** Covered by per-batch transactions plus idempotent inserts (Section 10).
6. **Sharding is not needed at 10,000 rows.** This is a demonstration of a design that scales.

## 12. Definition of done for v1

- `POST /upload-orders` works end to end with the generated 10,000-row file: file visible in the GCS bucket, rows visible in all 3 shard databases, summary response correct.
- Uploading the same file a second time reports ~0 inserted and the rest as duplicates.
- Invalid rows are skipped and reported, and do not stop the upload.
- `GET /orders?sellerId=`, `GET /orders/:orderId`, `GET /sellers/:sellerId/summary`, and `GET /health` work. The seller summary is answered by one shard only (visible in the logs).
- `npm test` passes.
- No credentials anywhere in the repo or its git history.
- README contains: setup and run instructions, how ADC is configured, the sharding explanation, and design decisions and trade-offs.
- `.env.example` and the SQL migration are in the repo.
- Demo video recorded, Google Drive folder shared with "Anyone with the link", GitHub repo accessible, links emailed before 1:00 PM on 4 October.
- **Aysha can explain every file, the full request flow, and the sharding logic and its trade-offs from memory.**

## 13. Open items

Status of the items that were open at the start (updated Saturday 3 October 2026):

- **How PostgreSQL is run locally: RESOLVED.** Native PostgreSQL install on Windows with 3 databases (`orders_shard_0`, `orders_shard_1`, `orders_shard_2`). No Docker unless Ticket 10 is reached. The code must not care: it only reads connection URLs from `SHARD_URLS`.
- **GCP project ID: RESOLVED**, `silver-osprey-460010-d8` (Google Cloud free trial is active). **GCS bucket name: PENDING**, created in Ticket 0, region `asia-south1`. The code does not need either until Ticket 7.
- **Project folder and file layout: RESOLVED.** The repo root is the project root, so every path below sits directly inside `backend-test` (no extra `backend` subfolder).
- **Development machine: RESOLVED.** Windows, VS Code, PowerShell terminal. See Section 17 for what that means for commands.
- **Use case and shard key: RESOLVED (3 October 2026).** Marketplace seller order analytics, sharded on `seller_id` (Sections 2 and 11).
- **GCP project ID: RESOLVED**, `silver-osprey-460010-d8` (Google Cloud free trial is active). **GCS bucket name: RESOLVED**, `aysha-backend-test-2026`, region `asia-south1` (Mumbai), Standard class, public access prevented. The code does not need either until Ticket 7.

Layout:
```
src/
  server.js            starts the HTTP server
  app.js               builds the Express app, mounts routes, error handler
  config.js            reads and validates environment variables
  logger.js            pino instance
  routes/
    upload.js          POST /upload-orders
    orders.js          GET /orders/:orderId, GET /orders?sellerId=
    sellers.js         GET /sellers/:sellerId/summary
    health.js          GET /health
  services/
    gcs.js             uploadFileToGcs(localPath, destination)
    ingest.js          the streaming pipeline in Section 10
  db/
    shards.js          pools + getShardIndex (Section 11)
    ordersRepo.js      insertBatch, findOrder, findBySeller, sellerSummary
  validation/
    orderRow.js        validateOrderRow (Section 8)
sql/
  001_create_orders.sql
scripts/
  migrate.js           applies the SQL file to every shard
  generate-orders.js   writes sample-data/orders_10k.csv
test/
  orderRow.test.js
  shards.test.js
.env                   local values, git-ignored, never committed
.env.example           placeholders only, committed
.gitignore
README.md
docs/                  working notes (this spec and the persona files)
```

Any new ambiguity discovered during implementation is added here rather than silently resolved by a Coder session.

## 14. Build order (ticket sequence)

This is the source of truth for what comes next. Each ticket is roughly one Coder message in chat, followed by a Reviewer pass. The Tester runs after Tickets 4, 6, and 8. Update the status line of each ticket as work proceeds.

0. **Environment setup (Aysha, manual, no code).** Google Cloud account, project, bucket, gcloud CLI, `gcloud auth application-default login`. PostgreSQL installed with 3 empty databases. GitHub repo created. **Status: partly done.** Done: Google Cloud free-trial account and project `silver-osprey-460010-d8`; project folder with `.gitignore`, `.env` and `.env.example`; GitHub repo `backend-test` created and in use (public); PostgreSQL 18 installed with the 3 databases `orders_shard_0`, `orders_shard_1` and `orders_shard_2`; GCS bucket `aysha-backend-test-2026` created in `asia-south1`. Not done yet: gcloud CLI and ADC login (needed before Ticket 7).
1. **Skeleton.** `package.json`, `src/config.js`, `src/logger.js`, `src/app.js`, `src/server.js`, and `GET /health` returning `{ "status": "ok" }` for now. `.gitignore`, `.env` and `.env.example` already exist (done in Ticket 0) and must not be modified. `config.js` must require only `PORT`, `LOG_LEVEL` and `BATCH_SIZE` (with defaults) and must not crash if `GCP_PROJECT_ID`, `GCS_BUCKET_NAME` or `SHARD_URLS` are missing, because later tickets add and validate them (Section 6a). **Status: COMPLETE (committed and pushed to GitHub on 3 October 2026).**
2. **Shard layer + migration.** `db/shards.js` (pools, `getShardIndex`), `sql/001_create_orders.sql` (the `orders` table exactly as in Section 8, including the composite primary key and `idx_orders_seller_date`), `scripts/migrate.js`. `GET /health` now checks every shard. **Status: not started.**
3. **Sample data generator.** `scripts/generate-orders.js`: 10,000 rows for about 50 sellers of uneven size (a few large, most small, so the hot-seller trade-off shows in the per-shard counts), 4 marketplaces, several SKUs per seller, a mix of statuses including cancelled and returned, about 2% invalid rows of different kinds, and a few duplicate (seller, marketplace, order) rows. **Status: not started.**
4. **Row validation + tests.** `validation/orderRow.js`, `test/orderRow.test.js`, `test/shards.test.js`. **Status: not started.**
5. **Batch insert repository.** `ordersRepo.insertBatch(shardIndex, rows, sourceFile)` with transaction, `ON CONFLICT`, one retry. **Status: not started.**
6. **Upload pipeline.** `routes/upload.js` + `services/ingest.js`: multer disk storage, streaming parse, validate, route, buffer, flush, summary response. GCS call stubbed for this ticket. **Highest-risk ticket. Keep it isolated.** **Status: not started.**
7. **GCS upload with ADC.** `services/gcs.js`, wired into the pipeline as step 2. **Status: not started.**
8. **Read endpoints.** `GET /orders?sellerId=` (single shard), `GET /sellers/:sellerId/summary` (single shard: top products and sales by marketplace), and `GET /orders/:orderId` (single shard with `sellerId`, scatter-gather without). The summary route logs which shard answered. Note for the Coder: `pg` returns `numeric` columns as strings, so convert sums to numbers in the response. **Status: not started.**
9. **README + final cleanup.** All README sections from Section 12, secrets check of the repo and git history. **Status: not started.**
10. **Optional bonus: Docker Compose.** Only if Tickets 0 to 9 are complete, working, and understood. **Status: not started.**
11. **Demo video + submission (Aysha, manual).** **Status: not started.**

**Time budget (deadline 1:00 PM Sunday):** Tickets 0 to 8 on Saturday evening. Ticket 9, the Teacher review of the whole flow, and Ticket 11 on Sunday morning. Submit by 12:00 PM to leave an hour of buffer. If time runs short, cut in this order: Ticket 10, then Ticket 8. Never cut Tickets 0 to 7 or 9.

## 15. Known issues log

Empty at project start. Reviewer and Tester findings that are not fixed immediately are recorded here with the ticket number, so nothing is silently dropped and the README's limitations section can be written from this list.

## 16. Submission checklist

- GitHub repo is accessible to reviewers and contains source, README, `sql/`, `.env.example`.
- Demo video covers: the problem in one sentence, a live upload in Postman, the file in the GCS bucket, row counts in each of the 3 shard databases, a second upload showing duplicates are ignored, the seller summary endpoint (answered by a single shard) and the order list endpoint, an explanation of the use case and why `seller_id` is the shard key, and a short walk through `shards.js` and the batch insert.
- Google Drive folder named in the required `FirstName_Surname_Branch` format, shared as "Anyone with the link", containing the video.
- Email sent with the GitHub link, the Drive folder link, and the video link. Every link opened in a private browser window first to confirm access.

## 17. Working in Claude chat

Claude chat cannot see Aysha's folders, so the workflow differs from an agentic coding tool:

- **Start of every new chat:** paste the full `project_spec.md`, then the persona section from `agent_personas.md` for the job being done, then the ticket number.
- **One ticket per message.** The Coder replies with complete file contents, each under a header showing its path (for example `src/db/shards.js`), never partial snippets, so every file can be pasted in whole.
- **Aysha runs it.** After pasting the files into the project, she runs the command the Coder gives and pastes the full terminal output or error back into the same chat.
- **Reviewer and Tester:** Aysha pastes the files from the ticket into a chat together with the persona prompt. They only report issues. Fixes go back to a Coder message.
- **When a chat gets long** (slow, or forgetting earlier decisions): start a new chat, paste the spec, and add a short list of the tickets completed and the file paths that exist.
- **Never paste real secrets** into chat. Only placeholders and `.env.example` values.
- The Teacher persona runs in a separate chat, only after the code works. See `teacher_persona.md`.
- **Every Coder reply ends with two sections:** a plain-language **Summary** of what was built and how the pieces connect, and a **What changed** list (every file created or modified with one line each, plus any packages installed).
- **Model choice:** Sonnet 5.5 for most tickets. Use Opus 5.5 for Ticket 6 (the upload pipeline) and for Reviewer passes on Tickets 5, 6 and 7, because that is where a mistake costs the most.
- **Platform:** Aysha works on Windows in VS Code with the PowerShell terminal. Every command the Coder gives must work there: one command per line (no `&&` chains), `curl.exe` instead of `curl` for file uploads (in PowerShell `curl` is an alias for a different command), forward-slash paths in code and config, and no bash-only syntax such as `export`. Postman is an equally good way to test uploads.
- **Git workflow:** one commit per finished ticket, with the message format `Ticket N: short description`. Before every commit run `git status` and confirm `.env` is not listed. The first push is `git remote add origin https://github.com/aysha-sipwala/backend-test.git`, then `git branch -M main`, then `git push -u origin main`. After that, `git push` is enough.