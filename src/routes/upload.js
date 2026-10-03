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

const upload = multer({
  // Disk storage writes the file to disk chunk by chunk as it arrives, so it is
  // never held in memory. multer gives it a random name, so the client's
  // filename never decides where anything is written.
  storage: multer.diskStorage({ destination: UPLOAD_DIR }),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  // Runs before the file is written. Rejecting here means nothing is stored.
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.csv') {
      const err = new Error('Only .csv files are accepted');
      err.status = 400;
      return cb(err);
    }
    return cb(null, true);
  },
});

const router = express.Router();

// upload.single('file') accepts one file from the form field "file". Its errors
// (too large, wrong field name) go to the central error handler in app.js.
router.post('/upload-orders', upload.single('file'), async (req, res, next) => {
  if (!req.file) {
    return res
      .status(400)
      .json({ error: 'No file uploaded: send a .csv file in the multipart form field "file"' });
  }

  const uploadId = crypto.randomUUID();

  try {
    const summary = await ingestOrdersFile(req.file.path, req.file.originalname, uploadId);
    return res.status(200).json(summary);
  } catch (err) {
    // The central handler hides the message of every 5xx error, which is right
    // for bugs. A GCS failure is expected, so answer it here with our own
    // fixed message (it contains no paths or credentials).
    if (err.status === 502) {
      return res.status(502).json({ error: err.message });
    }
    // 400 (bad header) keeps its message; anything else becomes a generic 500.
    return next(err);
  } finally {
    // Runs on success and on every error, so tmp/uploads never fills up.
    try {
      await fs.promises.unlink(req.file.path);
    } catch (unlinkErr) {
      logger.warn({ uploadId, reason: unlinkErr.message }, 'temp_file_delete_failed');
    }
  }
});

module.exports = router;
