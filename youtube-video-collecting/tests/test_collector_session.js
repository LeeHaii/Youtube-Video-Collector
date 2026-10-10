const test = require('node:test');
const assert = require('node:assert/strict');
const { createDraftStore } = require('../src/collector-session');
const { createNavigator } = require('../src/collector-navigation');
const url = 'https://www.youtube.com/watch?v=6IHKf0lk0Yc&t=118s';

test('unsaved markers survive switching and cannot be attached to a different video', () => {
  const store = createDraftStore();
  const markers = [{ time: 17, formatted: '0.17' }];
  store.save(url, { markers, currentRow: [], loadedRowIndex: -1, loadedUrlIndex: -1 }, []);
  markers[0].time = 999;
  assert.equal(store.restore(url, []).markers[0].time, 17);
  assert.equal(store.restore('https://youtu.be/f__u7kB5NIo', []), null);
  const backup = createDraftStore(store.serialize());
  assert.deepEqual(backup.restore(url, []).markers, [{ time: 17, formatted: '0.17' }]);
  store.forget(url);
  assert.equal(store.restore(url, []), null);
});
test('editing context survives unchanged rows but is detached after row replacement', () => {
  const store = createDraftStore();
  const rows = [[url, '0.10']];
  store.save(url, { markers: [{ time: 11, formatted: '0.11' }], currentRow: rows[0], loadedRowIndex: 0, loadedUrlIndex: 0 }, rows);
  assert.equal(store.restore(url, rows).loadedRowIndex, 0);
  rows[0] = ['https://youtu.be/f__u7kB5NIo', '0.20'];
  const restored = store.restore(url, rows);
  assert.equal(restored.loadedRowIndex, -1);
  assert.equal(restored.markers[0].time, 11);
});
test('legacy autosaves and malformed drafts are safe to load', () => {
  const store = createDraftStore();
  store.replace(undefined);
  assert.equal(store.hasDrafts(), false);
  store.replace({ '6IHKf0lk0Yc': { url, markers: [{ time: -1 }] } });
  assert.equal(store.hasDrafts(), false);
});
test('same-video requests seek without reloading the webview', async () => {
  let reloads = 0;
  let attempts = 0;
  const webview = { getURL: () => url, executeJavaScript: async () => { attempts++; return 'done'; }, set src(value) { reloads++; } };
  const navigator = createNavigator({ webview, prepare: async () => {}, status: () => {} });
  await navigator.open({ url });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reloads, 0);
  assert.equal(attempts, 1);
  navigator.cancel();
});
test('failed draft backup prevents navigation', async () => {
  let navigated = false;
  const navigator = createNavigator({ webview: { set src(value) { navigated = true; } },
    prepare: async () => { throw new Error('Cannot save'); }, status: () => {} });
  await assert.rejects(navigator.open({ url }), /Cannot save/);
  assert.equal(navigated, false);
});

test('an expired handoff does not begin navigation', async () => {
  let prepared = false;
  const navigator = createNavigator({ webview: {}, prepare: async () => { prepared = true; }, status: () => {} });
  await assert.rejects(navigator.open({ url, expiresAt: Date.now() - 1 }), /Request expired/);
  assert.equal(prepared, false);
});
test('a stale seek does not overwrite status or continue polling after a newer request', async () => {
  let release;
  const events = [];
  let calls = 0;
  const webview = { getURL: () => url, executeJavaScript: () => {
    calls++;
    return calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve('done');
  } };
  const navigator = createNavigator({ webview, prepare: async () => {}, status: (message) => events.push(message), pollMs: 1 });
  await navigator.open({ url });
  await navigator.open({ url: url.replace('118s', '222s') });
  await new Promise((resolve) => setImmediate(resolve));
  const count = events.length;
  release('out-of-range');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(events.length, count);
  assert.equal(calls, 2);
  navigator.cancel();
});
