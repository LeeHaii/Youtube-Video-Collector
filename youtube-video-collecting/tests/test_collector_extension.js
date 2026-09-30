const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouter } = require('../extension/navigation');
const sheet = 'https://docs.google.com/spreadsheets/d/abc/edit#gid=2';
const video = 'https://www.youtube.com/watch?v=6IHKf0lk0Yc&t=118s';
const clone = (value) => JSON.parse(JSON.stringify(value));

function harness(saved = {}) {
  const tabs = new Map([[1, { id: 1, url: sheet }], [2, { id: 2, url: video }], [3, { id: 3, url: 'https://example.test/' }]]);
  const messages = [], closed = [], updates = [], replies = [];
  const local = {}, session = clone(saved);
  const storage = (values) => ({
    async get(keys) { return clone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key] ?? null]))); },
    async set(next) { Object.assign(values, clone(next)); },
  });
  const api = {
    storage: { local: storage(local), session: storage(session) },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    tabs: {
      async query() { return [...tabs.values()].filter((tab) => tab.url.startsWith('https://docs.google.com/spreadsheets/')); },
      async get(id) { if (!tabs.has(id)) throw new Error('Tab is closed'); return clone(tabs.get(id)); },
      async remove(id) { closed.push(id); tabs.delete(id); },
      async update(id, change) { updates.push({ id, ...change }); Object.assign(tabs.get(id), change); },
    },
    runtime: { sendNativeMessage(host, request) {
      messages.push({ host, request });
      return new Promise((resolve) => replies.push((response = {}) => resolve({ version: 1, requestId: request.requestId, ...response })));
    } },
  };
  let number = 0;
  const router = createRouter(api, { uuid: () => `id-${++number}` });
  const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); await router.flush(); };
  return { router, tabs, messages, closed, updates, replies, local, session, settle };
}

test('Sheets-created destination is forwarded once and closed only after acceptance', async () => {
  const h = harness();
  await h.router.created({ tabId: 2, sourceTabId: 1, url: video });
  await h.router.before({ tabId: 2, frameId: 0, url: video });
  await h.router.committed({ tabId: 2, frameId: 0, url: video, transitionType: 'link' });
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.closed, []);
  h.replies[0]({ status: 'accepted' });
  await h.settle();
  assert.deepEqual(h.closed, [2]);
  assert.deepEqual(h.updates, [{ id: 1, active: true }]);
});
test('helper failure leaves the browser video available', async () => {
  const h = harness();
  await h.router.created({ tabId: 2, sourceTabId: 1, url: video });
  h.replies[0]({ status: 'error', message: 'App was not found' });
  await h.settle();
  assert.deepEqual(h.closed, []);
  assert.equal(h.local.lastStatus.state, 'error');
});
test('a target navigated elsewhere during startup is never closed', async () => {
  const h = harness();
  await h.router.created({ tabId: 2, sourceTabId: 1, url: video });
  h.tabs.get(2).url = 'https://example.test/other';
  await h.router.before({ tabId: 2, frameId: 0, url: h.tabs.get(2).url });
  h.replies[0]({ status: 'accepted' });
  await h.settle();
  assert.deepEqual(h.closed, []);
});
test('final tab check protects a changed timestamp even if its navigation event was missed', async () => {
  const h = harness();
  await h.router.created({ tabId: 2, sourceTabId: 1, url: video });
  h.tabs.get(2).url = video.replace('118s', '900s');
  h.replies[0]({ status: 'accepted' });
  await h.settle();
  assert.deepEqual(h.closed, []);
});
test('ordinary YouTube browsing and disabled routing produce no messages', async () => {
  const h = harness();
  await h.router.created({ tabId: 2, sourceTabId: 3, url: video });
  await h.router.before({ tabId: 2, frameId: 0, url: video });
  assert.equal(h.messages.length, 0);
  await h.router.setEnabled(false);
  await h.router.created({ tabId: 2, sourceTabId: 1, url: video });
  assert.equal(h.messages.length, 0);
});
test('Google redirect wrappers retain the original timestamp and request ID', async () => {
  const h = harness();
  const wrapper = `https://www.google.com/url?q=${encodeURIComponent(video)}`;
  await h.router.created({ tabId: 2, sourceTabId: 1, url: wrapper });
  await h.router.before({ tabId: 2, frameId: 0, url: video });
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].request.url, video);
  h.replies[0]({ status: 'accepted' });
  await h.settle();
  assert.deepEqual(h.closed, [2]);
});
test('same-tab link navigation restores Sheets but never closes its tab', async () => {
  const h = harness();
  await h.router.before({ tabId: 1, frameId: 0, url: video });
  assert.equal(h.messages.length, 0);
  h.tabs.get(1).url = video;
  await h.router.committed({ tabId: 1, frameId: 0, url: video, transitionType: 'link' });
  h.replies[0]({ status: 'accepted' });
  await h.settle();
  assert.deepEqual(h.closed, []);
  assert.deepEqual(h.updates, [{ id: 1, url: sheet }]);
});
test('typing a YouTube URL into a Sheets tab does not trigger delivery', async () => {
  const h = harness();
  await h.router.before({ tabId: 1, frameId: 0, url: video });
  await h.router.committed({ tabId: 1, frameId: 0, url: video, transitionType: 'typed', transitionQualifiers: ['from_address_bar'] });
  assert.equal(h.messages.length, 0);
});
test('service-worker restart retries the pending request with the same ID', async () => {
  const h = harness({ pending: { 2: { sourceTabId: 1, sourceUrl: sheet, owned: true, createdAt: Date.now(),
    requestId: 'original-request', sent: true, video: { videoId: '6IHKf0lk0Yc', seconds: 118, url: video } } } });
  await h.router.resume();
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].request.requestId, 'original-request');
  h.replies[0]({ status: 'accepted' });
  await h.settle();
  assert.deepEqual(h.closed, [2]);
});

test('worker restart does not submit an uncommitted same-tab candidate', async () => {
  const h = harness({ pending: { 1: { sourceTabId: 1, sourceUrl: sheet, owned: false, createdAt: Date.now(),
    requestId: 'uncommitted-request', sent: false, video: { videoId: '6IHKf0lk0Yc', seconds: 118, url: video } } } });
  h.tabs.get(1).url = video;
  await h.router.resume();
  assert.equal(h.messages.length, 0);
  await h.router.committed({ tabId: 1, frameId: 0, url: video, transitionType: 'typed' });
  assert.equal(h.messages.length, 0);
});
test('removed destination tabs never cause another tab to be closed', async () => {
  const h = harness();
  await h.router.created({ tabId: 2, sourceTabId: 1, url: video });
  h.tabs.delete(2);
  await h.router.removed(2);
  h.replies[0]({ status: 'accepted' });
  await h.settle();
  assert.deepEqual(h.closed, []);
});
