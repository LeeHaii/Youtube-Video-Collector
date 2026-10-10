const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { createConfiguration, secureBridgeDirectory, DEVELOPMENT_ID } = require('../src/native-host-registration');
const { encodeMessage, createDecoder } = require('../src/collector-bridge');
const executable = path.resolve(__dirname, '..', 'dist', 'collector_native_host.exe');

function runHelper(directory, message, origin = `chrome-extension://${DEVELOPMENT_ID}/`) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [origin], { windowsHide: true,
      env: { ...process.env, RHYMX_BRIDGE_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
    let response, errors = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Helper timed out')); }, 35000);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.stdout.on('data', createDecoder((value) => { response = value; }, reject));
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !response) reject(new Error(`Helper exited ${code}: ${errors}`));
      else resolve(response);
    });
    child.stdin.end(encodeMessage(message));
  });
}

test('compiled helper starts an absent app and receives real pipe acknowledgements', {
  skip: process.platform !== 'win32' || !fs.existsSync(executable), timeout: 40000,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rhymx-host-test-'));
  try {
    const original = createConfiguration({ directory, executable: process.execPath,
      args: [path.join(__dirname, 'fixtures', 'collector-pipe-app.js')], helper: executable });
    if (process.env.RHYMX_TEST_REAL_ACL === '1') {
      const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' });
      const sid = identity.match(/S-\d-\d+(?:-\d+)+/)[0];
      // Reproduce the original installer defect only inside this disposable folder.
      execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/T'], { windowsHide: true, stdio: 'pipe' });
      assert.throws(() => fs.readFileSync(path.join(directory, 'host.json')));
      secureBridgeDirectory(directory);
      // Atomic replacements must remain readable after securing existing files.
      const repaired = createConfiguration({ directory, executable: process.execPath,
        args: [path.join(__dirname, 'fixtures', 'collector-pipe-app.js')], helper: executable });
      assert.equal(repaired.token, original.token);
    }
    const ping = { version: 1, requestId: 'ping-one', type: 'ping' };
    assert.equal((await runHelper(directory, ping)).status, 'installed');
    const message = { version: 1, requestId: 'open-one', type: 'open-video', url: 'https://youtu.be/6IHKf0lk0Yc?t=118' };
    const response = await runHelper(directory, message);
    assert.equal(response.status, 'accepted');
    assert.equal((await runHelper(directory, message)).status, 'accepted');
    assert.equal((await runHelper(directory, { ...ping, requestId: 'ping-two' })).status, 'connected');
    assert.equal((await runHelper(directory, ping, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/')).code, 'unauthorized');
    const log = fs.readFileSync(path.join(directory, 'received.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(log, [{ videoId: '6IHKf0lk0Yc', seconds: 118 }]);
    const pid = Number(fs.readFileSync(path.join(directory, 'fixture.pid'), 'utf8'));
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.throws(() => process.kill(pid, 0));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
