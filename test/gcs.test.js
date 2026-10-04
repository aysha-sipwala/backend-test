// Tests for uploadFileToGcs. They run without the internet: the Google client is
// pointed at a small fake server on this machine (STORAGE_EMULATOR_HOST), which
// also skips authentication. The fake can answer like Google, answer "no such
// bucket", or accept the upload and then never reply (a stalled upload).
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// gcs.js loads config.js, which needs SHARD_URLS, and reads the bucket name from
// the environment. dotenv never overwrites a variable that is already set, so
// these values win over the real .env. Nothing here touches a database.
process.env.SHARD_URLS = 'postgresql://test:test@localhost:5432/dummy_shard_0';
process.env.GCS_BUCKET_NAME = 'test-bucket';

const CSV = 'order_id,seller_id\nA1,S0001\nA2,S0002\n';

// CRC32C (Castagnoli) is the checksum Google returns for an object, and the
// client checks it against the bytes it sent.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
  return c >>> 0;
});
function crc32c(text) {
  let c = 0xffffffff;
  for (const byte of Buffer.from(text)) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  const out = Buffer.alloc(4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return out.toString('base64');
}

let server;
let mode = 'ok'; // what the fake server does: 'ok', 'notfound' or 'hang'
let tmpDir;
let uploadFileToGcs;

before(async () => {
  server = http.createServer((req, res) => {
    req.on('data', () => {}); // read and discard the uploaded bytes
    req.on('end', () => {
      if (mode === 'hang') return; // accept the upload, then never answer
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'notfound') {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: { code: 404, message: 'secret-detail-xyz' } }));
      }
      return res.end(
        JSON.stringify({
          name: 'x',
          size: String(Buffer.byteLength(CSV)),
          crc32c: crc32c(CSV),
          md5Hash: crypto.createHash('md5').update(CSV).digest('base64'),
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));

  // Must be set before gcs.js is loaded: the Google client reads it when created.
  process.env.STORAGE_EMULATOR_HOST = `http://localhost:${server.address().port}`;
  ({ uploadFileToGcs } = require('../src/services/gcs'));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcs-test-'));
});

after(async () => {
  // Closes the connection of the stalled upload too, so the test process can exit.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A logger that remembers what was written instead of printing it.
function recorder() {
  const lines = [];
  return {
    lines,
    info: (fields, msg) => lines.push({ level: 'info', msg, ...fields }),
    error: (fields, msg) => lines.push({ level: 'error', msg, ...fields }),
  };
}

function writeTempFile(name) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, CSV);
  return file;
}

// How many timers are pending right now. A timer that is not cleared would raise it.
function pendingTimers() {
  return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
}

describe('uploadFileToGcs', () => {
  test('a successful upload returns the gs:// path, logs gcs_upload_ok and leaves no timer behind', async () => {
    mode = 'ok';
    const log = recorder();
    const timersBefore = pendingTimers();

    const result = await uploadFileToGcs(writeTempFile('ok.csv'), 'uploads/abc-orders.csv', log);

    assert.equal(result, 'gs://test-bucket/uploads/abc-orders.csv');
    assert.equal(log.lines.length, 1);
    assert.equal(log.lines[0].msg, 'gcs_upload_ok');
    assert.equal(log.lines[0].sizeBytes, Buffer.byteLength(CSV));
    assert.equal(pendingTimers(), timersBefore, 'the 60 second timer must be cleared');
  });

  test('a stalled upload fails after the timeout with a fixed reason, and releases the temp file', async () => {
    mode = 'hang';
    const log = recorder();
    const file = writeTempFile('hang.csv');
    const timersBefore = pendingTimers();
    const startedAt = Date.now();

    await assert.rejects(uploadFileToGcs(file, 'uploads/hang-orders.csv', log, 300), {
      message: 'GCS upload failed',
    });

    assert.ok(Date.now() - startedAt < 5000, 'it must give up quickly, not hang');
    assert.equal(log.lines.length, 1);
    assert.equal(log.lines[0].msg, 'gcs_upload_failed');
    assert.equal(log.lines[0].reason, 'upload timed out');
    assert.equal(pendingTimers(), timersBefore, 'the timer must be cleared on failure too');
    // The route deletes the temp file next. That fails on Windows if the file is
    // still open, so this proves the read stream was closed.
    fs.unlinkSync(file);
  });

  test('a missing bucket logs only the error code, never the text Google sent', async () => {
    mode = 'notfound';
    const log = recorder();

    await assert.rejects(uploadFileToGcs(writeTempFile('nf.csv'), 'uploads/nf-orders.csv', log), {
      message: 'GCS upload failed',
    });

    assert.equal(log.lines[0].msg, 'gcs_upload_failed');
    assert.equal(log.lines[0].reason, 'GCS error code 404');
    assert.ok(!JSON.stringify(log.lines).includes('secret-detail-xyz'));
  });

  test('a local file that is missing fails with a fixed reason and no path in the log', async () => {
    mode = 'ok';
    const log = recorder();
    const missing = path.join(tmpDir, 'does-not-exist.csv');

    await assert.rejects(uploadFileToGcs(missing, 'uploads/x-orders.csv', log), {
      message: 'GCS upload failed',
    });

    assert.equal(log.lines[0].reason, 'GCS error code ENOENT');
    assert.ok(!JSON.stringify(log.lines).includes('does-not-exist'));
  });
});
