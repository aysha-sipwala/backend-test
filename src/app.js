// Builds the Express app: middleware, routes, 404 and error handling.
// It does not call listen(), so tests can use the app without opening a port.
const express = require('express');
const multer = require('multer');
const logger = require('./logger');
const { allPools } = require('./db/shards');
const uploadRouter = require('./routes/upload');

const app = express();

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
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      err.status = 413;
      err.message = 'File too large: the limit is 20 MB';
    } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      err.status = 400;
      err.message = `Unexpected form field "${err.field}": send the CSV in the field "file"`;
    } else {
      err.status = 400;
    }
  }

  // Errors can carry their own HTTP status (for example 400 for bad JSON).
  // Anything without one is an unexpected bug, so it becomes 500.
  const status = err.status || err.statusCode || 500;

  if (status >= 500) {
    logger.error({ err, method: req.method, path: req.path }, 'request_failed');
    // Hide internal details from the client on server errors.
    res.status(status).json({ error: 'Internal server error' });
  } else {
    logger.warn({ err, method: req.method, path: req.path, status }, 'request_rejected');
    res.status(status).json({ error: err.message });
  }
});

module.exports = app;
