const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const executable = process.env.DOWNLOADER_EXE
  ? path.resolve(process.env.DOWNLOADER_EXE)
  : path.join(projectRoot, 'dist', '5_sec_downloader.exe');
const inputCsv = path.join(__dirname, 'fixtures', 'one_clip.csv');
function temporaryOutput(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-frozen-'));
  context.after(() => {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('quality-frozen-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

for (const resolution of [null, '2160']) {
test(`frozen downloader streams logs before graceful Stop completes (${resolution || 'strict default'})`, { timeout: 15_000 }, async (context) => {
  if (process.platform !== 'win32' || !fs.existsSync(executable)) {
    context.skip('requires the frozen Windows downloader executable');
    return;
  }

  const output = temporaryOutput(context);
  const localAppData = path.join(output, 'app-data');
  const stopFlag = path.join(os.tmpdir(), `downloader-stream-test-${process.pid}-${Date.now()}.flag`);
  fs.rmSync(localAppData, { recursive: true, force: true });

  let stdout = '';
  let stderr = '';
  let firstChunkAt = null;
  const startedAt = Date.now();
  const args = [inputCsv, output, '0', '0', '0', '0', stopFlag];
  if (resolution) args.push('--resolution', resolution);
  const child = spawn(executable, args, {
    stdio: 'pipe',
    shell: false,
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      YVC_DISABLE_RUNTIME_DOWNLOAD: '1',
    },
  });

  const timeout = setTimeout(() => child.kill(), 10_000);
  child.stdout.on('data', (data) => {
    stdout += data.toString();
    if (firstChunkAt === null) {
      firstChunkAt = Date.now();
      fs.writeFileSync(stopFlag, 'STOP', 'utf8');
    }
  });
  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timeout);
  fs.rmSync(stopFlag, { force: true });
  fs.rmSync(localAppData, { recursive: true, force: true });

  assert.notEqual(firstChunkAt, null, `no stdout arrived before exit; stderr: ${stderr}`);
  assert.ok(firstChunkAt - startedAt < 10_000, 'first log chunk was not streamed promptly');
  assert.equal(code, 3, `expected graceful canceled exit; stderr: ${stderr}`);
  assert.match(stdout, /Starting 5-Sec Download/);
  assert.match(stdout, /Processing canceled by user/);
  assert.match(stdout, new RegExp(`Quality: minimum 1080p / maximum ${resolution || '1080'}`));
});
}

test('frozen CLI supports help, fatal validation, and named resolution without optional positional arguments', { timeout: 30_000 }, (context) => {
  if (process.platform !== 'win32' || !fs.existsSync(executable)) {
    context.skip('requires the frozen Windows downloader executable');
    return;
  }
  const output = temporaryOutput(context);
  const localAppData = path.join(output, 'app-data');
  const run = (args) => spawnSync(executable, args, {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: localAppData, YVC_DISABLE_RUNTIME_DOWNLOAD: '1' },
  });
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--resolution/);
  const invalid = run([inputCsv, output, '--resolution', '999']);
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(invalid.stderr, /invalid choice/);
  assert.doesNotMatch(invalid.stdout, /Starting 5-Sec/);
  try {
    const empty = run([path.join(__dirname, 'fixtures/no_clips.csv'), output, '--resolution', '720']);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /Quality: minimum 720p \/ maximum 720/);
    assert.match(empty.stdout, /EJS solver: 0\.8\.0/);
    assert.match(empty.stdout, /DOWNLOAD_SUMMARY:.*"total":0/);
  } finally {
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
});
