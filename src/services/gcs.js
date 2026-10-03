// STUB FOR TICKET 6. This does NOT talk to Google Cloud.
// Ticket 7 replaces the body of uploadFileToGcs with the real upload using
// @google-cloud/storage and Application Default Credentials (new Storage() with
// no arguments). The function signature and the returned "gs://..." string stay
// exactly the same, so ingest.js does not change when the real upload arrives.
const config = require('../config');
const logger = require('../logger');

// uploadFileToGcs(localPath, destination) -> "gs://<bucket>/<destination>"
// localPath: the temp file on disk. destination: the object name in the bucket.
// eslint-disable-next-line no-unused-vars
async function uploadFileToGcs(localPath, destination) {
  // The bucket name is optional until Ticket 7, so fall back to a placeholder
  // instead of crashing. The path still shows where the file WOULD be stored.
  const bucket = config.GCS_BUCKET_NAME || 'not-configured';
  const gcsPath = `gs://${bucket}/${destination}`;

  // destination contains the uploadId, so this line can still be matched to its upload.
  logger.info({ destination, gcsPath }, 'gcs_upload_stubbed');
  return gcsPath;
}

module.exports = { uploadFileToGcs };
