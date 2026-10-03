// Stores the uploaded file in Google Cloud Storage (Section 10, step 2).
//
// Authentication is Application Default Credentials (ADC) only. `new Storage()`
// is called with NO arguments, so the library finds credentials by itself: first
// the login made with `gcloud auth application-default login` on a developer
// machine, or the attached service account when running on Google Cloud. There is
// no key file anywhere, so there is no secret that could end up in the repository.
const fs = require('fs');
const { Storage } = require('@google-cloud/storage');
const config = require('../config');
const logger = require('../logger');

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

// uploadFileToGcs(localPath, destination, uploadLogger?) -> "gs://<bucket>/<destination>"
// localPath: the temp file on disk. destination: the object name in the bucket.
// uploadLogger: the upload's child logger, so these lines carry the uploadId.
async function uploadFileToGcs(localPath, destination, uploadLogger) {
  const log = uploadLogger || logger;
  const bucketName = config.GCS_BUCKET_NAME;
  const startedAt = Date.now();

  try {
    const { size } = await fs.promises.stat(localPath);

    // bucket.upload streams the file from disk to Google, so the file is never
    // held in memory. resumable: false sends it in one request, which is fine for
    // files up to the 20 MB limit. No ACL is set and nothing is made public: the
    // bucket uses uniform access control and blocks public access.
    await storage.bucket(bucketName).upload(localPath, {
      destination,
      resumable: false,
      contentType: 'text/csv',
    });

    log.info({ destination, sizeBytes: size, durationMs: Date.now() - startedAt }, 'gcs_upload_ok');
    return `gs://${bucketName}/${destination}`;
  } catch (err) {
    log.error(
      { destination, reason: safeReason(err), durationMs: Date.now() - startedAt },
      'gcs_upload_failed'
    );
    // A fresh error with fixed text: the raw error never leaves this function.
    // ingest.js turns it into the 502 response.
    throw new Error('GCS upload failed');
  }
}

module.exports = { uploadFileToGcs };
