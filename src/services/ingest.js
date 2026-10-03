// The upload pipeline (Section 10, steps 2 to 7). Takes the temp file multer
// wrote to disk, stores it in GCS, then streams it through the CSV parser row by
// row: validate, route to a shard, buffer, and batch insert. Returns the summary
// object from Section 9. Deleting the temp file is the route's job (its finally).
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { parse } = require('csv-parse');
const config = require('../config');
const logger = require('../logger');
const { SHARD_COUNT, getShardIndex } = require('../db/shards');
const { insertBatch } = require('../db/ordersRepo');
const { validateOrderRow } = require('../validation/orderRow');
const { uploadFileToGcs } = require('./gcs');

// The 9 columns of the CSV input contract (Section 8). Any other column is ignored.
const REQUIRED_COLUMNS = [
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

// The assessment PDF spells the amount column "order_amout", so accept both.
const HEADER_ALIASES = { order_amout: 'order_amount' };

const MAX_SAMPLE_ERRORS = 20;
const MALFORMED_ROW = 'malformed row';

// An Error that carries the HTTP status the route should answer with.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// " Order_Amout " -> "order_amount"
function normalizeHeader(name) {
  const clean = String(name).trim().toLowerCase();
  return HEADER_ALIASES[clean] || clean;
}

// Reads the header row. Returns a Map from column name to its position in the
// row, plus the list of required columns that are missing. A Map (not a plain
// object) so a header like "constructor" cannot collide with built-in properties.
function readHeader(record) {
  const columnIndex = new Map();
  record.forEach((name, position) => {
    const column = normalizeHeader(name);
    // If a column appears twice, the first one wins.
    if (!columnIndex.has(column)) {
      columnIndex.set(column, position);
    }
  });
  const missing = REQUIRED_COLUMNS.filter((column) => !columnIndex.has(column));
  return { columnIndex, missing };
}

// Turns one parsed row (an array of fields) into the object validateOrderRow
// expects. Only the 9 required columns are copied, so extra columns are ignored.
// A row with too few fields gets undefined for the missing ones, and the
// validator reports it as invalid (for example "missing status").
function toRowObject(record, columnIndex) {
  const row = {};
  for (const column of REQUIRED_COLUMNS) {
    row[column] = record[columnIndex.get(column)];
  }
  return row;
}

// ingestOrdersFile(tempPath, originalFilename, uploadId) -> summary (Section 9)
// Throws an error with status 502 if GCS fails, 400 if the header is unusable.
async function ingestOrdersFile(tempPath, originalFilename, uploadId) {
  const startedAt = Date.now();
  // A child logger adds uploadId to every line, so one upload's logs can be filtered.
  const log = logger.child({ uploadId });
  log.info({ originalFilename }, 'upload_started');

  // Step 2: store the raw file first. If that fails, nothing is processed: the
  // original file is the source of truth, and without it we cannot reprocess.
  // basename() drops any folder part a client might put in the filename.
  const destination = `uploads/${uploadId}-${path.basename(originalFilename)}`;
  let gcsPath;
  try {
    gcsPath = await uploadFileToGcs(tempPath, destination);
    log.info({ gcsPath }, 'gcs_upload_ok');
  } catch (err) {
    log.error({ destination, reason: err.message }, 'gcs_upload_failed');
    throw httpError(502, 'Could not store the file in Cloud Storage. Nothing was processed.');
  }

  // Running totals for the summary.
  const totals = { totalRows: 0, inserted: 0, duplicates: 0, invalid: 0, failedBatches: 0 };
  const sampleErrors = [];
  // One buffer per shard, and perShard keyed "0", "1", "2" so shards with 0 rows still show.
  const buffers = [];
  const perShard = {};
  for (let shardIndex = 0; shardIndex < SHARD_COUNT; shardIndex++) {
    buffers.push([]);
    perShard[String(shardIndex)] = 0;
  }

  function recordInvalid(line, reason) {
    totals.totalRows++;
    totals.invalid++;
    log.warn({ line, reason }, 'row_invalid');
    if (sampleErrors.length < MAX_SAMPLE_ERRORS) {
      sampleErrors.push({ line, reason });
    }
  }

  // Writes one shard's buffer with a single batch insert. insertBatch already
  // retries once and logs batch_flushed (with the uploadId, through `log`).
  // If it still fails, the batch is counted and the rest of the file continues.
  async function flush(shardIndex) {
    const rows = buffers[shardIndex];
    buffers[shardIndex] = [];
    try {
      // gcsPath goes into the source_file column, so every row points back to its file.
      const result = await insertBatch(shardIndex, rows, gcsPath, log);
      totals.inserted += result.inserted;
      totals.duplicates += result.duplicates;
      perShard[String(shardIndex)] += result.inserted;
    } catch (err) {
      totals.failedBatches++;
      // insertBatch builds its error messages without row data or connection strings.
      log.error({ shard: shardIndex, rows: rows.length, reason: err.message }, 'batch_failed');
    }
  }

  // Set when the header line itself cannot be parsed (see on_skip below).
  let headerMalformed = false;
  // csv-parse can report one broken line twice (for example "invalid closing
  // quote", then "quote not closed" at end of file, both on the same line).
  // Remembering the last skipped line stops that row being counted twice.
  let lastSkippedLine = null;

  // Step 3: the streaming parser. Without `columns`, each record is an array of
  // fields, and the header is handled by hand below.
  const parser = parse({
    bom: true, // drop the invisible UTF-8 marker Excel puts at the start of a file
    skip_empty_lines: true,
    relax_column_count: true, // too few / too many fields: let the validator decide
    info: true, // each record comes as { record, info } so we know its line number
    skip_records_with_error: true, // a row the parser cannot read is skipped, not fatal
    // Called for each skipped row. err.lines is the line where the parser gave up.
    on_skip: (err) => {
      // No record emitted yet means the broken line is the header.
      if (parser.info.records === 0) {
        headerMalformed = true;
        return;
      }
      const line = err ? err.lines : null;
      if (line !== null && line === lastSkippedLine) {
        return;
      }
      lastSkippedLine = line;
      recordInvalid(line, MALFORMED_ROW);
    },
  });

  let columnIndex = null; // filled in from the header row

  // pipeline() connects the file stream, the parser and our loop. If any of them
  // fails (file read error, or an error thrown in the loop), it destroys all of
  // them and rejects, so the request can never hang on a broken stream.
  await pipeline(fs.createReadStream(tempPath), parser, async (records) => {
    for await (const { record, info } of records) {
      // The first record is the header.
      if (columnIndex === null) {
        if (headerMalformed) {
          log.warn('upload_rejected_bad_header');
          throw httpError(400, 'The header row could not be read. Nothing was inserted.');
        }
        const header = readHeader(record);
        if (header.missing.length > 0) {
          log.warn({ missing: header.missing }, 'upload_rejected_missing_columns');
          throw httpError(
            400,
            `Missing required column(s): ${header.missing.join(', ')}. Nothing was inserted.`
          );
        }
        columnIndex = header.columnIndex;
        continue;
      }

      // Step 4: validate. info.lines counts the header as line 1.
      const line = info.lines;
      const result = validateOrderRow(toRowObject(record, columnIndex));
      if (!result.valid) {
        recordInvalid(line, result.reason);
        continue;
      }

      totals.totalRows++;
      // Every row goes through the shard router (Section 3).
      const shardIndex = getShardIndex(result.order.seller_id);
      buffers[shardIndex].push(result.order);

      // Step 5: backpressure. While we await the insert, this loop does not ask
      // for the next record, so the parser stops, its buffer fills, and the
      // file stream pauses. The file is never read faster than the DB writes.
      if (buffers[shardIndex].length >= config.BATCH_SIZE) {
        await flush(shardIndex);
      }
    }
  });

  // No header at all: the file was empty (or held only blank lines).
  if (columnIndex === null) {
    const message = headerMalformed
      ? 'The header row could not be read. Nothing was inserted.'
      : 'The file is empty: a header row is required.';
    log.warn('upload_rejected_no_header');
    throw httpError(400, message);
  }

  // Step 6: end of file, write whatever is left in each shard's buffer.
  for (let shardIndex = 0; shardIndex < SHARD_COUNT; shardIndex++) {
    if (buffers[shardIndex].length > 0) {
      await flush(shardIndex);
    }
  }

  // The parser reads a little ahead of this loop, so a malformed row can be
  // reported before earlier invalid rows. Sorting the (at most 20) samples keeps
  // them in file order.
  sampleErrors.sort((a, b) => a.line - b.line);

  // Step 7: the summary (Section 9). Invalid rows alone do not change the status.
  const summary = {
    status: totals.failedBatches > 0 ? 'completed_with_errors' : 'completed',
    uploadId,
    gcsPath,
    totalRows: totals.totalRows,
    inserted: totals.inserted,
    duplicates: totals.duplicates,
    invalid: totals.invalid,
    failedBatches: totals.failedBatches,
    perShard,
    durationMs: Date.now() - startedAt,
    sampleErrors,
  };
  log.info({ summary }, 'upload_finished');
  return summary;
}

module.exports = { ingestOrdersFile };
