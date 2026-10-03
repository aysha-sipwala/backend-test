// Builds the Express app: middleware, routes, 404 and error handling.
// It does not call listen(), so tests can use the app without opening a port.
const express = require('express');
const multer = require('multer');
const logger = require('./logger');
const { allPools } = require('./db/shards');
const { uploadRouter, assignUploadId } = require('./routes/upload');
const ordersRouter = require('./routes/orders');
const sellersRouter = require('./routes/sellers');

const app = express();

// Gives every upload request its uploadId and a logger that carries it. It must
// come first, so even an error raised while the request body is being read (a
// multer limit, a broken JSON body) is logged with the uploadId.
app.post('/upload-orders', assignUploadId);

// Parses JSON request bodies into req.body.
app.use(express.json());

// Runs SELECT 1 on every shard in parallel. 200 if all are up, 503 if any is down.
app.get('/health', async (req, res) => {
  const pools = allPools();

  const results = await Promise.all(
    pools.map(async (pool, shardIndex) => {
      try {
        await pool.query('SELECT 1');
        return 'up';
      } catch (err) {
        // Log only the message: never the connection URL or password.
        logger.warn({ shard: shardIndex, err: err.message }, 'shard_unreachable');
        return 'down';
      }
    })
  );

  const shards = {};
  results.forEach((state, shardIndex) => {
    shards[shardIndex] = state;
  });

  const allUp = results.every((state) => state === 'up');
  res.status(allUp ? 200 : 503).json({ status: allUp ? 'ok' : 'degraded', shards });
});

// POST /upload-orders
app.use(uploadRouter);

// GET /orders, GET /orders/:orderId
app.use(ordersRouter);

// GET /sellers/:sellerId/summary
app.use(sellersRouter);

// Runs only when no route above matched the request.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Central error handler. Express treats a middleware with 4 arguments as the
// error handler, so all 4 must stay even though next is unused.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // multer errors carry a code instead of an HTTP status: too large is 413,
  // everything else (wrong field name, too many files) is the client's mistake.
  // Each limit gets a short fixed message instead of multer's own wording.
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      err.status = 413;
      err.message = 'File too large: the limit is 20 MB';
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      err.status = 400;
      err.message = `Unexpected form field "${err.field}": send the CSV in the field "file"`;
    } else if (err.code === 'LIMIT_FILE_COUNT') {
      err.status = 400;
      err.message = 'Too many files: send exactly one .csv file';
    } else if (err.code === 'LIMIT_FIELD_COUNT') {
      err.status = 400;
      err.message = 'Too many form fields in the request';
    } else if (err.code === 'LIMIT_PART_COUNT') {
      err.status = 400;
      err.message = 'Too many parts in the request';
    } else {
      err.status = 400;
    }
  }

  // Errors can carry their own HTTP status (for example 400 for bad JSON).
  // Anything without one is an unexpected bug, so it becomes 500.
  const status = err.status || err.statusCode || 500;

  // Upload requests have req.log, a logger that stamps the uploadId on every
  // line. Other routes use the shared logger.
  const log = req.log || logger;

  // The text we send to the client. For a 5xx it is hidden unless the error is
  // marked `expose` (our own fixed messages, such as the 502 for a GCS failure).
  let message;
  if (status >= 500) {
    log.error({ err, method: req.method, path: req.path }, 'request_failed');
    message = err.expose === true ? err.message : 'Internal server error';
  } else {
    log.warn({ err, method: req.method, path: req.path, status }, 'request_rejected');
    message = err.message;
  }

  // One summary line for every failed upload, with no stack, no paths and no
  // data: just the status and the same text the client receives.
  if (req.uploadId) {
    log[status >= 500 ? 'error' : 'warn']({ status, reason: message }, 'upload_failed');
  }

  res.status(status).json({ error: message });
});

module.exports = app;
