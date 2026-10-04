// Stores the uploaded file in Google Cloud Storage (Section 10, step 2).
//
// Authentication is Application Default Credentials (ADC) only. `new Storage()`
// is called with NO arguments, so the library finds credentials by itself: first
// the login made with `gcloud auth application-default login` on a developer
// machine, or the attached service account when running on Google Cloud. There is
// no key file anywhere, so there is no secret that could end up in the repository.
const fs = require('fs');
const { pipeline } = require('stream/promises');
const { Storage } = require('@google-cloud/storage');
const config = require('../config');
const logger = require('../logger');

// How long one upload may take before it is given up as stalled. Without a limit,
// a connection that goes quiet would keep the request (and the temp file) open
// forever. 60 seconds is enough for the largest allowed file (20 MB) on a normal
// connection, and short enough that the caller gets a clear 502 instead of a hang.
const UPLOAD_TIMEOUT_MS = 60 * 1000;

// Created once and reused. It does not contact Google until the first upload.
const storage = new Storage();

// A short text that is safe to log: never the raw Google error message, which can
// contain account details, tokens or file paths. Only an error code or fixed text.
function safeReason(err) {
  const code = err && err.code;
  // Google API errors use the HTTP status as the code (403 no access, 404 no
  // bucket). Network and file errors use short upper-case names (ENOTFOUND,
  // ENOENT). Anything else is not trusted and not logged.
  if (typeof code === 'number' || (typeof code === 'string' && /^[A-Z0-9_]{2,30}$/.test(code))) {
    return `GCS error code ${code}`;
  }
  // The most common first-day problem gets a fixed hint (our own text, not Google's).
  if (err && typeof err.message === 'string' && /default credentials/i.test(err.message)) {
    return 'no Application Default Credentials found (run: gcloud auth application-default login)';
  }
  return 'GCS upload failed';
}

// uploadFileToGcs(localPath, destination, uploadLogger?, timeoutMs?)
//   -> "gs://<bucket>/<destination>"
// localPath: the temp file on disk. destination: the object name in the bucket.
// uploadLogger: the upload's child logger, so these lines carry the uploadId.
// timeoutMs: optional, only so a test can use a short time instead of 60 seconds.
async function uploadFileToGcs(localPath, destination, uploadLogger, timeoutMs = UPLOAD_TIMEOUT_MS) {
  const log = uploadLogger || logger;
  const bucketName = config.GCS_BUCKET_NAME;
  const startedAt = Date.now();

  // The library's own `timeout` option did not end a stalled upload when tested
  // (the call simply never finished), so the limit is enforced here. Aborting the
  // controller makes pipeline() stop and destroy both streams, which also closes
  // the temp file so the route can delete it.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true; // remembered so the log can say "timed out", not "aborted"
    controller.abort();
  }, timeoutMs);

  try {
    const { size } = await fs.promises.stat(localPath);

    // The file is streamed from disk to Google, so it is never held in memory.
    // resumable: false sends it in one request, which is fine for files up to the
    // 20 MB limit. No ACL is set and nothing is made public: the bucket uses
    // uniform access control and blocks public access.
    await pipeline(
      fs.createReadStream(localPath),
      storage.bucket(bucketName).file(destination).createWriteStream({
        resumable: false,
        contentType: 'text/csv',
      }),
      { signal: controller.signal }
    );

    log.info({ destination, sizeBytes: size, durationMs: Date.now() - startedAt }, 'gcs_upload_ok');
    return `gs://${bucketName}/${destination}`;
  } catch (err) {
    log.error(
      {
        destination,
        reason: timedOut ? 'upload timed out' : safeReason(err),
        durationMs: Date.now() - startedAt,
      },
      'gcs_upload_failed'
    );
    // A fresh error with fixed text: the raw error never leaves this function.
    // ingest.js turns it into the 502 response, for a timeout and for every other failure.
    throw new Error('GCS upload failed');
  } finally {
    // Always runs, on success and on every failure, so no timer is left behind to
    // fire later or keep the process alive.
    clearTimeout(timer);
  }
}

module.exports = { uploadFileToGcs, UPLOAD_TIMEOUT_MS };
