// Tests for the BATCH_SIZE rule in config.js. config.js reads the environment
// when it is first loaded, so each case loads it in a fresh Node process with its
// own BATCH_SIZE. The process runs in an empty temporary folder, so a real .env
// file cannot add values of its own.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', 'src', 'config.js');

let emptyDir;
before(() => {
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
});
after(() => {
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

// Loads config.js with BATCH_SIZE set to `value` (or not set at all when undefined).
function loadConfig(value) {
  const env = {
    ...process.env,
    // config.js requires SHARD_URLS; this is a dummy, no database is contacted.
    SHARD_URLS: 'postgresql://test:test@localhost:5432/dummy_shard_0',
  };
  delete env.BATCH_SIZE;
  if (value !== undefined) {
    env.BATCH_SIZE = value;
  }
  const result = spawnSync(
    process.execPath,
    ['-e', `process.stdout.write(String(require(${JSON.stringify(CONFIG_PATH)}).BATCH_SIZE))`],
    { cwd: emptyDir, env, encoding: 'utf8' }
  );
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
}

describe('BATCH_SIZE', () => {
  test('defaults to 1000 when it is not set', () => {
    const result = loadConfig(undefined);
    assert.equal(result.ok, true);
    assert.equal(result.stdout, '1000');
  });

  test('defaults to 1000 when it is empty', () => {
    const result = loadConfig('');
    assert.equal(result.ok, true);
    assert.equal(result.stdout, '1000');
  });

  test('1, 1000 and 6500 are accepted', () => {
    for (const value of ['1', '1000', '6500']) {
      const result = loadConfig(value);
      assert.equal(result.ok, true, `${value} should be accepted`);
      assert.equal(result.stdout, value);
    }
  });

  test('6501 and larger are rejected with a message that names the variable and the limit', () => {
    for (const value of ['6501', '65535', '100000']) {
      const result = loadConfig(value);
      assert.equal(result.ok, false, `${value} should be rejected`);
      assert.match(result.stderr, /BATCH_SIZE must be a whole number from 1 to 6500/);
      assert.ok(!result.stderr.includes(`"${value}"`), 'the typed value is not echoed');
    }
  });

  test('zero, negative, decimal and non-numeric values are rejected', () => {
    for (const value of ['0', '-1', '-1000', '2.5', 'abc', '1000abc']) {
      const result = loadConfig(value);
      assert.equal(result.ok, false, `${value} should be rejected`);
      assert.match(result.stderr, /BATCH_SIZE must be a whole number from 1 to 6500/);
    }
  });
});
