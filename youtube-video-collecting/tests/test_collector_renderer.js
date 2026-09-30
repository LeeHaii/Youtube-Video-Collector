const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const videoA = 'https://www.youtube.com/watch?v=6IHKf0lk0Yc&t=118s';
const videoB = 'https://www.youtube.com/watch?v=f__u7kB5NIo&t=537s';

function rendererHarness() {
  const elements = new Map();
  const listeners = {};
  const intervals = [];
  const replies = [], backups = [];
  let openCallback, location = videoA;
  function element(selector) {
    if (elements.has(selector)) return elements.get(selector);
    const object = {
      style: {}, dataset: {}, value: '', innerHTML: '', textContent: '', children: [],
      classList: { add() {}, remove() {}, contains() { return false; } },
      addEventListener() {}, setAttribute() {}, after() {}, click() {}, scrollIntoView() {},
      appendChild(child) { this.children.push(child); }, querySelector: element, querySelectorAll: () => [],
      getURL: () => location, canGoBack: () => false, canGoForward: () => false,
      executeJavaScript: async (script) => script === 'window.location.href' ? location : script.includes('const target =') ? 'done' : null,
      set src(value) { location = value; },
    };
    elements.set(selector, object);
    return object;
  }
  const document = {
    readyState: 'loading', querySelector: element, getElementById: (id) => element(`#${id}`),
    querySelectorAll: () => [], createElement: (tag) => element(`new-${tag}-${elements.size}`),
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    body: element('body'),
  };
  const window = {
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    electronAPI: {
      onCollectorOpen(fn) { openCallback = fn; }, collectorReady() {},
      collectorOpenResult(id, response) { replies.push({ id, ...response }); },
      async saveRowAutosave(rows, currentRow, session) { backups.push(JSON.parse(JSON.stringify({ rows, currentRow, session }))); return { success: true }; },
      onTrimLog() {}, onCapcutRenderLog() {},
    },
  };
  const context = vm.createContext({ window, document, URL, URLSearchParams, console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {}, Date, alert() {},
    // Electron may expose CommonJS globals: HTML scripts must still populate window APIs.
    module: { exports: {} }, require() { throw new Error('Browser script must not require Node'); },
  });
  const root = path.resolve(__dirname, '..');
  for (const file of ['extension/collector-link.js', 'src/collector-session.js', 'src/collector-navigation.js', 'src/renderer.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  const run = (code) => vm.runInContext(code, context);
  const state = () => JSON.parse(run('JSON.stringify({markers,currentRow,rows,currentUrl,loadedRowIndex,loadedUrlIndex})'));
  const open = async (url, extra = {}) => { openCallback({ requestId: `open-${replies.length}`, url, ...extra }); await run('externalOpenQueue'); };
  return { run, state, open, backups, replies, intervals, elements, window };
}

test('actual renderer preserves pending markers across external video switches', async () => {
  const h = rendererHarness();
  await new Promise((resolve) => setImmediate(resolve));
  h.run(`currentUrl=${JSON.stringify(videoA)};markers=[{time:17,formatted:'0.17'}];currentRow=[${JSON.stringify(videoA)},'0.10'];`);
  await h.open(videoB);
  assert.equal(h.replies[0].status, 'accepted', h.replies[0].message);
  assert.equal(h.state().currentUrl, videoB);
  assert.deepEqual(h.state().markers, []);
  assert.deepEqual(h.state().currentRow, [videoA, '0.10']);
  assert.equal(h.backups[0].session.drafts['6IHKf0lk0Yc'].markers[0].time, 17);
  await h.open(videoA);
  assert.equal(h.state().markers[0].time, 17);
  assert.equal(h.replies.every((reply) => reply.status === 'accepted'), true);
});
test('actual renderer detaches row edits from new videos and restores them on return', async () => {
  const h = rendererHarness();
  await new Promise((resolve) => setImmediate(resolve));
  h.run(`currentUrl=${JSON.stringify(videoA)};rows=[[${JSON.stringify(videoA)},'0.10']];loadedRowIndex=0;loadedUrlIndex=0;markers=[{time:18,formatted:'0.18'}];`);
  await h.open(videoB);
  assert.equal(h.replies[0].status, 'accepted', h.replies[0].message);
  assert.equal(h.state().loadedRowIndex, -1);
  assert.equal(h.elements.get('#take-url-btn').disabled, false);
  await h.open(videoA);
  assert.equal(h.state().loadedRowIndex, 0);
  assert.equal(h.state().loadedUrlIndex, 0);
  assert.equal(h.state().markers[0].time, 18);
  assert.equal(h.elements.get('#take-url-btn').disabled, true);
});

test('an exact incoming URL does not block subsequent in-app browsing', async () => {
  const h = rendererHarness();
  await new Promise((resolve) => setImmediate(resolve));
  h.run(`currentUrl=${JSON.stringify(videoA)};markers=[{time:17,formatted:'0.17'}];`);
  await h.open(videoB);
  await h.run('updateUrlDisplay()');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.run('pendingExternalVideo'), null);
  h.elements.get('#youtube-webview').src = videoA;
  await h.run('updateUrlDisplay()');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state().currentUrl, videoA);
  assert.equal(h.state().markers[0].time, 17);
});
test('actual renderer refuses a link when collection backup fails', async () => {
  const h = rendererHarness();
  await new Promise((resolve) => setImmediate(resolve));
  h.run(`currentUrl=${JSON.stringify(videoA)};markers=[{time:17,formatted:'0.17'}];`);
  h.window.electronAPI.saveRowAutosave = async () => ({ success: false });
  await h.open(videoB);
  assert.equal(h.state().currentUrl, videoA);
  assert.equal(h.state().markers[0].time, 17);
  assert.equal(h.replies[0].status, 'error');
});

test('a request expiring during backup does not change the active draft', async () => {
  const h = rendererHarness();
  await new Promise((resolve) => setImmediate(resolve));
  h.run(`currentUrl=${JSON.stringify(videoA)};markers=[{time:17,formatted:'0.17'}];`);
  h.window.electronAPI.saveRowAutosave = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { success: true };
  };
  await h.open(videoB, { expiresAt: Date.now() + 15 });
  assert.equal(h.state().currentUrl, videoA);
  assert.equal(h.state().markers[0].time, 17);
  assert.equal(h.replies[0].status, 'error');
  assert.match(h.replies[0].message, /Request expired/);
});

test('manual row selection during backup supersedes the external link', async () => {
  const h = rendererHarness();
  await new Promise((resolve) => setImmediate(resolve));
  h.run(`currentUrl=${JSON.stringify(videoA)};markers=[{time:17,formatted:'0.17'}];`);
  let release;
  h.window.electronAPI.saveRowAutosave = () => new Promise((resolve) => { release = resolve; });
  const opening = h.open(videoB);
  await new Promise((resolve) => setImmediate(resolve));
  h.run(`externalNavigator.cancel();markers=[{time:35,formatted:'0.35'}];`);
  release({ success: true });
  await opening;
  assert.equal(h.state().currentUrl, videoA);
  assert.equal(h.state().markers[0].time, 35);
  assert.equal(h.replies[0].status, 'error');
  assert.match(h.replies[0].message, /Navigation was superseded/);
});
