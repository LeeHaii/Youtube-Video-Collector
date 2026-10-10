const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseYouTubeUrl, destination, isSheetUrl } = require('../src/collector-link');
const { CollectorBridge, encodeMessage, createDecoder } = require('../src/collector-bridge');
const { createConfiguration, secureBridgeDirectory, DEVELOPMENT_ID } = require('../src/native-host-registration');
const fixtures = require('./fixtures/collector-links.json');

for (const fixture of fixtures) test(`URL: ${fixture.url}`, () => {
  if (fixture.invalid) assert.throws(() => parseYouTubeUrl(fixture.url));
  else {
    const actual = parseYouTubeUrl(fixture.url);
    assert.equal(actual.videoId, '6IHKf0lk0Yc');
    assert.equal(actual.seconds, fixture.seconds);
  }
});
test('recognizes Sheets and unwraps only known Google redirects', () => {
  assert.equal(isSheetUrl('https://docs.google.com/spreadsheets/d/abc/edit#gid=2'), true);
  assert.equal(isSheetUrl('https://docs.google.com/document/d/abc/edit'), false);
  assert.equal(isSheetUrl('https://docs.google.com.evil.test/spreadsheets/d/abc/edit'), false);
  const video = 'https://youtu.be/6IHKf0lk0Yc?t=118';
  assert.equal(destination(`https://www.google.com/url?q=${encodeURIComponent(video)}`).seconds, 118);
  assert.equal(destination(`https://evil.test/url?q=${encodeURIComponent(video)}`), null);
});

test('framing supports fragmented UTF-8 messages and rejects oversized input', () => {
  const values = [];
  const packet = encodeMessage({ text: 'marker \u65e5\u672c' });
  const decode = createDecoder((value) => values.push(value), (error) => { throw error; });
  for (const byte of packet) decode(Buffer.from([byte]));
  assert.deepEqual(values, [{ text: 'marker \u65e5\u672c' }]);
  let rejected;
  const bad = Buffer.alloc(4); bad.writeUInt32LE(1000000);
  createDecoder(() => assert.fail('must not decode'), (error) => { rejected = error; })(bad);
  assert.ok(rejected);
});

function makeBridge(t, onOpen, timeoutMs = 500) {
  const pipeName = process.platform === 'win32' ? `\\\\.\\pipe\\rhymx-test-${crypto.randomUUID()}` : path.join(os.tmpdir(), `rhymx-${crypto.randomUUID()}.sock`);
  const bridge = new CollectorBridge({ pipeName, token: 'test-token', onOpen, timeoutMs });
  t.after(() => bridge.close());
  return bridge;
}
const request = (id = 'one') => ({ version: 1, requestId: id, type: 'open-video', token: 'test-token', url: fixtures[0].url });
function send(pipeName, message) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName);
    socket.on('error', reject);
    socket.on('data', createDecoder(resolve, reject));
    socket.on('connect', () => {
      const bytes = encodeMessage(message);
      socket.write(bytes.subarray(0, 3));
      socket.write(bytes.subarray(3));
    });
  });
}

test('a real pipe waits for renderer readiness and returns its acknowledgement', async (t) => {
  let opens = 0;
  const bridge = makeBridge(t, async (video) => { assert.equal(video.seconds, 118); opens++; });
  await bridge.start();
  const reply = send(bridge.pipeName, request());
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(opens, 0);
  bridge.setReady(true);
  assert.equal((await reply).status, 'accepted');
  assert.equal(opens, 1);
});
test('duplicates share delivery, and reused IDs with different videos fail', async (t) => {
  let opens = 0;
  const bridge = makeBridge(t, async () => { opens++; });
  bridge.setReady(true);
  const messages = await Promise.all([bridge.handle(request()), bridge.handle(request())]);
  assert.equal(opens, 1);
  assert.equal(messages[0].status, 'accepted');
  assert.equal((await bridge.handle({ ...request(), url: fixtures[1].url + '&t=999' })).status, 'accepted');
  assert.equal((await bridge.handle({ ...request(), url: 'https://youtu.be/f__u7kB5NIo' })).code, 'invalid_request');
});
test('wrong token and renderer rejection never acknowledge delivery', async (t) => {
  const bridge = makeBridge(t, async () => { throw new Error('Backup failed'); });
  bridge.setReady(true);
  assert.equal((await bridge.handle({ ...request(), token: 'wrong' })).code, 'unauthorized');
  assert.equal((await bridge.handle(request())).code, 'delivery_failed');
});
test('startup timeout cancels queued requests before they navigate', async (t) => {
  let opened = false;
  const bridge = makeBridge(t, async () => { opened = true; }, 30);
  assert.equal((await bridge.handle(request())).code, 'startup_timeout');
  bridge.setReady(true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(opened, false);
});
test('registration keeps a stable token, endpoint, and extension ID across updates', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rhymx-registration-'));
  try {
    const options = { directory, executable: 'collector.exe', helper: 'host.exe' };
    const first = createConfiguration(options);
    const second = createConfiguration({ ...options, executable: 'new-version.exe' });
    assert.equal(first.token, second.token);
    assert.equal(first.pipeName, second.pipeName);
    assert.equal(second.executable, 'new-version.exe');
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'host.json')));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${DEVELOPMENT_ID}/`]);
    const browserManifest = require('../extension/manifest.json');
    const key = Buffer.from(browserManifest.key, 'base64');
    const id = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (n) => String.fromCharCode(97 + parseInt(n, 16)));
    assert.equal(id, DEVELOPMENT_ID);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('registration grants file access explicitly and never recurses directory-only flags', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rhymx-acl-'));
  try {
    createConfiguration({ directory, executable: 'collector.exe', helper: 'host.exe' });
    const calls = [];
    secureBridgeDirectory(directory, (command, args) => {
      calls.push({ command, args });
      return command === 'whoami.exe' ? '"test-user","S-1-5-21-100-200-300-1001"' : '';
    });
    const grants = calls.filter((call) => call.command === 'icacls.exe');
    assert.equal(grants.length, 3);
    assert.equal(grants[0].args.at(-1), '*S-1-5-21-100-200-300-1001:(OI)(CI)F');
    assert.equal(grants[1].args.at(-1), '*S-1-5-21-100-200-300-1001:F');
    assert.equal(grants[2].args.at(-1), '*S-1-5-21-100-200-300-1001:F');
    assert.equal(grants.some((call) => call.args.includes('/T')), false);
    assert.equal(path.basename(grants[1].args[0]), 'config.json');
    assert.equal(path.basename(grants[2].args[0]), 'host.json');
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
