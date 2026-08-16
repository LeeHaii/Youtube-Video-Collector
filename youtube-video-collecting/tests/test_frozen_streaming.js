const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const executable = process.env.DOWNLOADER_EXE
  ? path.resolve(process.env.DOWNLOADER_EXE)
  : path.join(projectRoot, 'dist', '5_sec_downloader.exe');
const inputCsv = path.join(__dirname, 'fixtures', 'one_clip.csv');
const localAppData = path.join(__dirname, 'streaming-app-data');

test('frozen downloader streams logs before graceful Stop completes', { timeout: 15_000 }, async (context) => {
  if (process.platform !== 'win32' || !fs.existsSync(executable)) {
    context.skip('requires the frozen Windows downloader executable');
    return;
  }

  const stopFlag = path.join(os.tmpdir(), `downloader-stream-test-${process.pid}-${Date.now()}.flag`);
  fs.rmSync(localAppData, { recursive: true, force: true });

  let stdout = '';
  let stderr = '';
  let firstChunkAt = null;
  const startedAt = Date.now();
  const child = spawn(executable, [inputCsv, __dirname, '0', '0', '0', '0', stopFlag], {
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
});
