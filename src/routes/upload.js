// POST /upload-orders (Section 9). multer streams the upload to a temp file on
// disk, then the ingest service does the real work. This file only deals with
// HTTP: accepting the file, choosing the status code, and cleaning up.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const logger = require('../logger');
const { ingestOrdersFile } = require('../services/ingest');

// tmp/uploads/ at the project root (git-ignored). Built from __dirname so it
// does not depend on which folder the server was started from.
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'tmp', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

// A request may carry one file and a few tiny text fields, nothing more. Without
// these limits a client could send thousands of parts and tie up the server.
// When a limit is hit, multer raises a MulterError that app.js turns into a 400.
const LIMITS = {
  fileSize: MAX_FILE_SIZE_BYTES,
  files: 1,
  fields: 5, // text fields (the endpoint itself needs none)
  fieldSize: 1024, // bytes per text field value
  parts: 6, // files + fields together: 1 file and 5 fields at most
};

// An Error that carries the HTTP status the central handler should answer with.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true; // fixed message we wrote, safe to send to the client
  return err;
}

// Runs first (app.js mounts it before every other middleware), so even a request
// that is rejected while its body is still being read already has an uploadId.
// req.log is a logger that stamps the uploadId on every line it writes.
function assignUploadId(req, res, next) {
  req.uploadId = crypto.randomUUID();
  req.log = logger.child({ uploadId: req.uploadId });
  next();
}

const upload = multer({
  // Disk storage writes the file to disk chunk by chunk as it arrives, so it is
  // never held in memory. multer gives it a random name, so the client's
  // filename never decides where anything is written.
  storage: multer.diskStorage({ destination: UPLOAD_DIR }),
  limits: LIMITS,
  // Runs before the file is written. Rejecting here means nothing is stored.
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.csv') {
      return cb(httpError(400, 'Only .csv files are accepted'));
    }
    return cb(null, true);
  },
});

const router = express.Router();

// upload.single('file') accepts one file from the form field "file". Every error
// (multer limits, wrong field name, bad header, GCS failure, bugs) goes to the
// central error handler in app.js, which logs it and answers.
router.post('/upload-orders', upload.single('file'), async (req, res, next) => {
  if (!req.file) {
    return next(
      httpError(400, 'No file uploaded: send a .csv file in the multipart form field "file"')
    );
  }

  try {
    const summary = await ingestOrdersFile(req.file.path, req.file.originalname, req.uploadId);
    return res.status(200).json(summary);
  } catch (err) {
    return next(err);
  } finally {
    // Runs on success and on every error, so tmp/uploads never fills up.
    try {
      await fs.promises.unlink(req.file.path);
    } catch (unlinkErr) {
      req.log.warn({ reason: unlinkErr.message }, 'temp_file_delete_failed');
    }
  }
});

module.exports = { uploadRouter: router, assignUploadId };
