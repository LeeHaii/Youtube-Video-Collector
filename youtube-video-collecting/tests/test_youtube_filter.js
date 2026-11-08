const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  YoutubeFilterService,
  mergeCfg,
  defaultShow,
  parseDuration,
  copyrightMatch,
  hashList,
  quotaDay
} = require('../src/youtube-filter-service');

test('parseDuration parses standard ISO durations into seconds', () => {
  assert.equal(parseDuration('PT1M30S'), 90);
  assert.equal(parseDuration('PT1H'), 3600);
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT45S'), 45);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration(null), null);
});

test('copyrightMatch correctly detects forbidden copyright phrases', () => {
  const phrases = ['all rights reserved', 'do not reupload', 'do not re-upload', 'viralhog'];
  assert.equal(copyrightMatch('This video is All Rights Reserved by Creator', phrases), 'all rights reserved');
  assert.equal(copyrightMatch('Please do not reupload this video', phrases), 'do not reupload');
  assert.equal(copyrightMatch('Please do not re-upload this clip', phrases), 'do not re-upload');
  assert.equal(copyrightMatch('Standard licensed content from ViralHog archive', phrases), 'viralhog');
  assert.equal(copyrightMatch('Casual travel vlog with family', phrases), null);
});

test('hashList produces stable hash for phrasing changes', () => {
  const h1 = hashList(['phrase a', 'phrase b']);
  const h2 = hashList(['phrase a', 'phrase b']);
  const h3 = hashList(['phrase a', 'phrase c']);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

test('quotaDay returns valid Pacific time date stamp YYYY-MM-DD', () => {
  const day = quotaDay();
  assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
});

test('mergeCfg preserves custom properties and default groups', () => {
  const merged = mergeCfg({
    apiKey: 'AIzaSyTest123',
    mode: 'dim',
    show: { loai: { dai: true } }
  });
  assert.equal(merged.apiKey, 'AIzaSyTest123');
  assert.equal(merged.mode, 'dim');
  assert.equal(merged.show.loai.dai, true);
  assert.equal(merged.show.loai.thuong, true); // preserved from default
  assert.equal(merged.show.chatluong.lt720, false); // preserved from default
});

test('YoutubeFilterService initializes, loads/saves config, and returns filter assets', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyt-test-'));
  try {
    const service = new YoutubeFilterService({
      userDataPath: tempDir,
      bundledSharedPath: path.join(__dirname, '..', 'src', 'cau-hinh-chung.json'),
    });

    // Check assets
    const assets = service.getAssets();
    assert.ok(assets.css && assets.css.includes('.lyt-badge'));
    assert.ok(assets.js && assets.js.includes('__lytReply'));

    // Check default config
    const cfg = service.getCfg();
    assert.equal(cfg.apiKey, '');
    assert.equal(cfg.enabled, true);

    // Save updated config
    service.saveCfg({ apiKey: 'AIzaSyCustomKey', starMonths: 18 });
    const updated = service.getCfg();
    assert.equal(updated.apiKey, 'AIzaSyCustomKey');
    assert.equal(updated.starMonths, 18);

    // Check persistence to disk
    const reloaded = new YoutubeFilterService({
      userDataPath: tempDir,
      bundledSharedPath: path.join(__dirname, '..', 'src', 'cau-hinh-chung.json'),
    });
    assert.equal(reloaded.getCfg().apiKey, 'AIzaSyCustomKey');
    assert.equal(reloaded.getCfg().starMonths, 18);

    // Check cache and quota
    reloaded.data.cache['v:test1234567'] = { title: 'Test Video', t: Date.now() };
    reloaded.saveData();
    assert.equal(reloaded.clearCache().removed, 1);
    assert.equal(Object.keys(reloaded.data.cache).length, 0);

    // Check message dispatch
    const msgRes = await service.handleMessage({ type: 'storageGet', keys: ['cfg'] });
    assert.equal(msgRes.ok, true);
    assert.equal(msgRes.data.cfg.apiKey, 'AIzaSyCustomKey');

    const quotaRes = await service.handleMessage({ type: 'quota' });
    assert.equal(quotaRes.ok, true);
    assert.equal(typeof quotaRes.quota.units, 'number');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
