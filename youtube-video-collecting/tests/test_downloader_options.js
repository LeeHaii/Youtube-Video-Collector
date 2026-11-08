const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { RESOLUTIONS, validateDownloadResolution, validateDownloadPolicy, buildDownloadArguments } = require('../src/downloader-options');
const summary = require('../src/downloader-summary');

test('resolution defaults and argument order preserve old callers and paths containing spaces', () => {
  const oldArguments = ['E:\\input file.csv', 'E:\\output folder', 0, 0.5, 10, 15, 'E:\\stop flag.txt'];
  for (const resolution of [undefined, ...RESOLUTIONS]) {
    const args = buildDownloadArguments(...oldArguments, resolution);
    assert.deepEqual(args.slice(0, 7), oldArguments.map(String));
    assert.deepEqual(args.slice(7), ['--max-quality', resolution ?? '1080', '--min-quality', String(Math.min(1080, Number(resolution === 'auto' || resolution === undefined ? 1080 : resolution))), '--quality-mode', 'strict']);
  }
  for (const invalid of [null, 720, '', '4k', '999', '--format best', {}]) {
    assert.throws(() => validateDownloadResolution(invalid), /Invalid resolution/);
  }
});

function mainHandlerHarness(verify = async () => ({ schemaVersion: 2 })) {
  let handler;
  const spawned = [], sent = [];
  const context = vm.createContext({
    __dirname: path.join(__dirname, '../src'),
    ipcMain: { handle(_channel, callback) { handler = callback; } },
    downloadProcess: null, downloadStarting: false, latestDownloadRetryPolicy: null, downloadStopFlagPath: null, rateLimitErrors: [], ageRestrictionErrors: [],
    failedDownloadErrors: [], latestDownloadSummary: null, currentInputCsvPath: '',
    console: { log() {}, error() {}, warn() {} },
    fs: { existsSync: (name) => !name.endsWith('.quality.json'), unlinkSync() {} }, path, os, process: { env: {} },
    StringDecoder: require('node:string_decoder').StringDecoder,
    verifyDownloader: verify,
    getExecutablePath: () => 'E:\\tools folder\\5_sec_downloader.exe',
    mainWindow: { webContents: { send(...args) { sent.push(args); } } },
    validateDownloadResolution, validateDownloadPolicy, buildDownloadArguments, ...summary,
    spawn(executable, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      spawned.push({ executable, args: Array.from(args), options, child });
      return child;
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('start-download'"), source.indexOf('// 5-Sec Downloader - Stop Download')), context);
  return { start: handler, spawned, sent };
}

test('actual start-download IPC passes the resolution and retains streaming and shell settings', async () => {
  for (const resolution of [undefined, ...RESOLUTIONS]) {
    const h = mainHandlerHarness();
    const result = await h.start({}, 'input file.csv', 'output folder', 1, 2, 10, 15, resolution);
    assert.equal(result.success, true);
    const { args, options, child } = h.spawned[0];
    assert.deepEqual(args.slice(0, 6), ['input file.csv', 'output folder', '1', '2', '10', '15']);
    assert.match(args[6], /downloader-stop-flag-.*\.txt$/);
    assert.deepEqual(args.slice(7), ['--max-quality', resolution ?? '1080', '--min-quality', String(Math.min(1080, Number(resolution === 'auto' || resolution === undefined ? 1080 : resolution))), '--quality-mode', 'strict']);
    assert.equal(options.shell, false);
    assert.equal(options.env.PYTHONUNBUFFERED, '1');
    child.emit('close', 3);
    const completion = h.sent.find(([channel]) => channel === 'download-complete')[1];
    assert.equal(completion.canceled, true);
  }
});

test('actual start-download IPC rejects invalid resolution before spawn', async () => {
  const h = mainHandlerHarness();
  const result = await h.start({}, 'input.csv', 'output', 1, 2, 10, 15, '999');
  assert.equal(result.success, false);
  assert.match(result.error, /Invalid resolution/);
  assert.equal(h.spawned.length, 0);
});

test('preload forwards explicit resolution and defaults legacy calls to strict 1080p', async () => {
  let api;
  const calls = [];
  const context = vm.createContext({
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(_name, value) { api = value; } },
        ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve({ success: true }); } },
      };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8'), context);
  await api.startDownload('input.csv', 'output', 1, 2, 10, 15, '2160');
  await api.startDownload('input.csv', 'output', 1, 2, 10, 15);
  assert.deepEqual(calls.map((call) => call[7]), ['2160', '1080']);
});

function rendererHarness(startResult = Promise.resolve({ success: true })) {
  const elements = new Map(), calls = [];
  let completion;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', style: {}, disabled: false, checked: false, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [] },
    console: { log() {}, warn() {}, error() {} },
    window: { electronAPI: {
      onDownloadComplete(callback) { completion = callback; },
      startDownload(...args) { calls.push(args); return startResult; },
      stopDownload: async () => ({ success: true }),
    } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/tools-handler.js'), 'utf8'), context);
  element('csv-path').value = 'input.csv';
  element('output-path').value = 'output';
  element('downloader-resolution').value = '2160';
  return { element, calls, complete: (result) => completion(result) };
}

test('renderer captures selection and locks it through running and stopping', async () => {
  const h = rendererHarness();
  h.element('downloader-start-btn').listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls[0][6], '2160');
  assert.equal(h.calls[0][7], '1080');
  assert.equal(h.element('downloader-minimum').disabled, true);
  assert.equal(h.element('downloader-resolution').disabled, true);
  h.element('downloader-stop-btn').listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.element('downloader-resolution').disabled, true);
  h.complete({ canceled: true, code: 3 });
  assert.equal(h.element('downloader-resolution').disabled, false);
  h.element('downloader-resolution').value = 'auto';
  h.element('downloader-start-btn').listeners.click();
  assert.equal(h.calls[1][6], 'auto');
});

test('renderer unlocks resolution on every completion and failed start', async () => {
  for (const completion of [{ success: true }, { partial: true }, { canceled: true }, { code: 1 }]) {
    const h = rendererHarness();
    h.element('downloader-start-btn').listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    h.complete(completion);
    assert.equal(h.element('downloader-resolution').disabled, false);
  }
  for (const failure of [() => Promise.resolve({ success: false, error: 'failed start' }), () => Promise.reject(new Error('IPC rejected'))]) {
    const h = rendererHarness(failure());
    h.element('downloader-start-btn').listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.element('downloader-resolution').disabled, false);
    assert.equal(h.element('downloader-start-btn').disabled, false);
  }
});


test('preflight rejects stale binaries and reserves the run against simultaneous starts', async () => {
  const rejected = mainHandlerHarness(async () => { throw new Error('stale binary'); });
  assert.equal((await rejected.start({}, 'input.csv', 'output', 1, 2, 10, 15)).success, false);
  assert.equal(rejected.spawned.length, 0);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const h = mainHandlerHarness(() => pending);
  const first = h.start({}, 'input.csv', 'output', 1, 2, 10, 15);
  for (let i = 0; i < 2; i++) assert.equal((await h.start({}, 'input.csv', 'output', 1, 2, 10, 15)).success, false);
  release({ schemaVersion: 2 });
  assert.equal((await first).success, true);
  assert.equal(h.spawned.length, 1);
  h.spawned[0].child.emit('close', 0);
  const completion = h.sent.find(([channel]) => channel === 'download-complete')[1];
  assert.equal(completion.success, false);
  assert.equal(completion.protocolFailure, true);
});

test('actual IPC decodes UTF-8 record fragments and never reports quality failures as success', async () => {
  const h = mainHandlerHarness();
  await h.start({}, 'input.csv', 'output', 1, 2, 10, 15);
  const child = h.spawned[0].child;
  const record = { schemaVersion: 2, clipId: 'run:1:1:1', status: 'QUALITY_UNAVAILABLE', url: 'https://youtube.com/watch?v=test', timestamp: 10, message: '1080p unavailable ⚠️' };
  const final = { schemaVersion: 2, total: 1, processed: 1, succeeded: 0, failed: 1, degraded: 0, notProcessed: 0, canceled: false, qualityUnavailable: 1 };
  const bytes = Buffer.from('CLIP_RESULT: ' + JSON.stringify(record) + '\nDOWNLOAD_SUMMARY: ' + JSON.stringify(final) + '\n');
  for (const byte of bytes) child.stdout.emit('data', Buffer.from([byte]));
  child.emit('close', 2);
  assert.equal(h.sent.find(([channel]) => channel === 'download-clip-result')[1].message, record.message);
  const completion = h.sent.find(([channel]) => channel === 'download-complete')[1];
  assert.equal(completion.success, false);
  assert.equal(completion.summary.qualityUnavailableCount, 1);
});
