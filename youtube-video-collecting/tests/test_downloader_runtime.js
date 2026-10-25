const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCapabilities } = require('../src/downloader-runtime');
const { validateDownloadPolicy } = require('../src/downloader-options');
const { createDownloadParseState, consumeDownloaderStdout, validateDownloadCompletion, buildRetryPolicy } = require('../src/downloader-summary');

const policy = validateDownloadPolicy();
function record(overrides = {}) {
  return { schemaVersion: 2, clipId: 'run:1:1:1', status: 'OK', state: 'committed',
    url: 'https://youtube.com/watch?v=test', timestamp: 10, sourceKey: 'source-hash',
    policy, target: [1080, 60], outputDimensions: [1920, 1080], encoding: { fps: 60, width: 1920, height: 1080 }, ...overrides };
}
const summary = { schemaVersion: 2, total: 1, processed: 1, succeeded: 1, failed: 0, degraded: 0, notProcessed: 0, canceled: false };
function report(clip = record(), final = summary) {
  const state = createDownloadParseState();
  const output = 'CLIP_RESULT: ' + JSON.stringify(clip) + '\nDOWNLOAD_SUMMARY: ' + JSON.stringify(final);
  for (let i = 0; i < output.length; i += 7) consumeDownloaderStdout(state, output.slice(i, i + 7));
  consumeDownloaderStdout(state, '', true);
  return state;
}

test('only complete, policy-compliant per-clip evidence permits green success', () => {
  assert.equal(validateDownloadCompletion(report(), 0), true);
  assert.equal(validateDownloadCompletion(createDownloadParseState(), 0), false);
  for (const change of [
    { outputDimensions: [640, 360] }, { outputDimensions: [3840, 2160] },
    { encoding: { fps: 30, width: 1920, height: 1080 } }, { policy: { policy_version: 2 } }, { state: 'pending' }, { target: null },
  ]) assert.equal(validateDownloadCompletion(report(record(change)), 0), false);
  for (const change of [{ processed: 2 }, { failed: 1 }, { schemaVersion: 1 }, { degraded: 1 }, { notProcessed: 1 }]) {
    assert.equal(validateDownloadCompletion(report(record(), { ...summary, ...change }), 0), false);
  }
  assert.equal(validateDownloadCompletion(report(), 2), false);
});

test('malformed, duplicate, and truncated structured records cannot report success', () => {
  for (const line of ['CLIP_RESULT: {bad json}\n', 'DOWNLOAD_SUMMARY: {bad json}\n']) {
    const state = report();
    consumeDownloaderStdout(state, line, true);
    assert.equal(validateDownloadCompletion(state, 0), false);
  }
  const state = report();
  consumeDownloaderStdout(state, 'CLIP_RESULT: ' + JSON.stringify(record()) + '\n');
  assert.equal(validateDownloadCompletion(state, 0), false);
  const missing = createDownloadParseState();
  consumeDownloaderStdout(missing, 'DOWNLOAD_SUMMARY: ' + JSON.stringify(summary), true);
  assert.equal(validateDownloadCompletion(missing, 0), false);
});

test('quality failures enter retry CSV data and preserve policy plus locked targets', () => {
  const state = report(record({ status: 'QUALITY_UNAVAILABLE', message: 'HD unavailable' }), { ...summary, succeeded: 0, failed: 1 });
  assert.equal(state.errors[0].category, 'QUALITY_UNAVAILABLE');
  assert.deepEqual(state.errors[0].timestamps, [10]);
  assert.deepEqual(buildRetryPolicy(state, policy), { schemaVersion: 2, policy, targets: { 'source-hash': [1080, 60] } });
  assert.equal(validateDownloadCompletion(state, 0), false);
});

test('binary capability and quality validation reject stale executables and contradictory settings', () => {
  const capabilities = { schemaVersion: 2, policyVersion: 2, ejs: '0.8.0', qualityModes: ['strict'],
    flags: ['--min-quality', '--max-quality', '--replace-existing', '--retry-policy'] };
  assert.equal(validateCapabilities(capabilities), capabilities);
  for (const change of [{ schemaVersion: 1 }, { flags: [] }, { ejs: null }, { qualityModes: [] }]) {
    assert.throws(() => validateCapabilities({ ...capabilities, ...change }), /incompatible/);
  }
  assert.throws(() => validateDownloadPolicy('720', '1080'), /cannot exceed/);
  assert.throws(() => validateDownloadPolicy('1080', '0'), /Invalid minimum/);
  assert.equal(validateDownloadPolicy('auto').minimum_edge, 1080);
});
