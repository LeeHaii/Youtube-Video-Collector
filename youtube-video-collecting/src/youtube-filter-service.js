const fs = require('fs');
const path = require('path');

const API = 'https://www.googleapis.com/youtube/v3/';
const DAY = 864e5;
const TTL_VIDEO = 30 * DAY;
const TTL_CHANNEL = 3 * DAY;
const TTL_QUALITY = 30 * DAY;
const QUALITY_CONCURRENCY = 2;
const TEST_VIDEO = 'jNQXAC9IVRw';

class LytError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const GROUPS = [
  { key: 'loai', title: 'Loại kênh', opts: [
    ['thuong', 'Kênh thường', true],
    ['tich', 'Creator có tích', false],
    ['dai', 'Đài TV / báo', false],
    ['chan', 'Kênh đã chặn', false]
  ] },
  { key: 'sub', title: 'Số sub của kênh', opts: [
    ['lt1k', 'Dưới 1 N', true],
    ['1k', '1–10 N', true],
    ['10k', '10–50 N', true],
    ['50k', '50–100 N', true],
    ['100k', '100–500 N', true],
    ['500k', '500 N–1 Tr', true],
    ['1m', 'Trên 1 Tr', true],
    ['an', 'Kênh ẩn sub', true]
  ] },
  { key: 'dangcuoi', title: 'Kênh đăng video gần nhất', opts: [
    ['3t', 'Trong 3 tháng', true],
    ['12t', '3–12 tháng', true],
    ['3n', '1–3 năm', true],
    ['tren3n', 'Trên 3 năm', true]
  ] },
  { key: 'dodai', title: 'Độ dài video', opts: [
    ['lt4', 'Dưới 4 phút', true],
    ['4', '4–10 phút', true],
    ['10', '10–20 phút', true],
    ['20', 'Trên 20 phút', true]
  ] },
  { key: 'ngaydang', title: 'Ngày đăng video', opts: [
    ['lt1n', 'Dưới 1 năm', true],
    ['1n', '1–3 năm', true],
    ['3n', '3–5 năm', true],
    ['5n', 'Trên 5 năm', true]
  ] },
  { key: 'chatluong', title: 'Chất lượng', opts: [
    ['lt720', 'Dưới 720p', false],
    ['720', '720p', true],
    ['1080', '1080p', true],
    ['2k', '2K (1440p)', true],
    ['4k', '4K trở lên', true]
  ] },
  { key: 'khac', title: 'Hiện cả', opts: [
    ['doc', 'Shorts / video dọc / khung không 16:9', false],
    ['banquyen', 'Mô tả có câu cấm dùng', false],
    ['live', 'Video trực tiếp / sắp chiếu', false]
  ] }
];

function defaultShow() {
  const s = {};
  for (const gr of GROUPS) {
    s[gr.key] = {};
    for (const [k, , on] of gr.opts) s[gr.key][k] = on;
  }
  return s;
}

const DEFAULT_CFG = {
  apiKey: '',
  enabled: true,
  show: defaultShow(),
  mode: 'hide',          // 'hide' = ẩn hẳn, 'dim' = làm mờ
  starMonths: 12,        // đánh dấu ⭐ kênh ngừng đăng từ N tháng
  measureQuality: true,  // mở ngầm trang video để đọc chất lượng 720p/1080p/2K/4K
  panelCollapsed: false,
  blocklist: [],         // [{id, name, note, date}]
  tvKeywords: [
    'tv', 'news', 'television', 'broadcast', 'broadcasting', 'network',
    'abs-cbn', 'gma', 'rappler', 'anc', 'cnn', 'bbc', 'reuters', 'al jazeera',
    'nhk', 'cgtn', 'dw', 'france 24', 'sky news', 'ptv', 'tv5', 'inquirer',
    'philstar', 'manila bulletin', 'cna', 'abc', 'nbc', 'cbs', 'fox',
    'euronews', 'vtv', 'htv', 'vtc', 'thvl'
  ],
  copyrightPhrases: [
    'all rights reserved', 'without permission', 'without written permission',
    'do not reupload', 'do not re-upload', 'no reupload', 'no re-upload',
    'download prohibited', 'downloading is prohibited', 'not allowed to download',
    'unauthorized use', 'for licensing', 'licensing inquiries', 'licensing@',
    'to license this', 'license this video', 'viralhog', 'jukin', 'storyful',
    'newsflare', 'cấm reup', 'không reup', 'cấm sử dụng', 'không được sử dụng'
  ]
};

function mergeCfg(saved) {
  const cfg = Object.assign({}, DEFAULT_CFG, saved || {});
  for (const k of ['blocklist', 'tvKeywords', 'copyrightPhrases']) {
    if (!Array.isArray(cfg[k])) cfg[k] = DEFAULT_CFG[k].slice();
  }
  const show = defaultShow();
  const s = (saved && saved.show) || {};
  for (const gk of Object.keys(show)) {
    for (const ok of Object.keys(show[gk])) {
      if (s[gk] && typeof s[gk][ok] === 'boolean') show[gk][ok] = s[gk][ok];
    }
  }
  cfg.show = show;
  return cfg;
}

function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
  if (!m) return null;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

function copyrightMatch(desc, phrases) {
  const d = String(desc || '').toLowerCase();
  for (const p of phrases || []) {
    const k = String(p).trim().toLowerCase();
    if (k && d.includes(k)) return k;
  }
  return null;
}

function hashList(list) {
  let h = 5381;
  const s = (list || []).join('\n');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function quotaDay(now) {
  return new Date(now || Date.now()).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function poolMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function mapError(status, body) {
  const err = (body && body.error) || {};
  const reasons = []
    .concat((err.errors || []).map((e) => e.reason))
    .concat((err.details || []).map((d) => d.reason))
    .filter(Boolean)
    .join(' ');
  const msg = err.message || ('HTTP ' + status);
  if (/quotaExceeded|dailyLimitExceeded|RATE_LIMIT_EXCEEDED/.test(reasons)) return new LytError('QUOTA', msg);
  if (/API_KEY_INVALID|keyInvalid/.test(reasons) || /API key not valid/i.test(msg)) return new LytError('BAD_KEY', msg);
  if (/accessNotConfigured|SERVICE_DISABLED/.test(reasons)) return new LytError('API_OFF', msg);
  if (/API_KEY_.*_BLOCKED|forbidden/.test(reasons) && status === 403) return new LytError('KEY_RESTRICTED', msg);
  if (/playlistNotFound/.test(reasons) || status === 404) return new LytError('NOT_FOUND', msg);
  return new LytError('LOI_API', msg);
}

class YoutubeFilterService {
  constructor({ userDataPath, bundledSharedPath } = {}) {
    this.userDataPath = userDataPath || '';
    this.storageFile = userDataPath ? path.join(userDataPath, 'youtube-filter-data.json') : '';
    this.bundledSharedPath = bundledSharedPath || '';
    this.sharedCache = null;
    this.sharedAt = 0;
    this.qualityInflight = new Map();
    this.data = this.loadData();
  }

  loadData() {
    const fallback = {
      cfg: DEFAULT_CFG,
      quota: { day: quotaDay(), units: 0, pages: 0 },
      cache: {},
      lastPrune: 0
    };
    if (!this.storageFile || !fs.existsSync(this.storageFile)) return fallback;
    try {
      const raw = fs.readFileSync(this.storageFile, 'utf8');
      const j = JSON.parse(raw);
      return {
        cfg: mergeCfg(j.cfg),
        quota: j.quota && j.quota.day === quotaDay() ? j.quota : { day: quotaDay(), units: 0, pages: 0 },
        cache: j.cache && typeof j.cache === 'object' ? j.cache : {},
        lastPrune: typeof j.lastPrune === 'number' ? j.lastPrune : 0
      };
    } catch (e) {
      console.warn('[YouTubeFilterService] Error reading filter storage:', e.message);
      return fallback;
    }
  }

  saveData() {
    if (!this.storageFile) return;
    try {
      fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
      fs.writeFileSync(this.storageFile, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      console.error('[YouTubeFilterService] Error saving filter storage:', e.message);
    }
  }

  async getShared() {
    if (this.sharedCache && Date.now() - this.sharedAt < 60e3) return this.sharedCache;
    let s = { apiKey: '', blocklist: [], capNhat: '' };
    if (this.bundledSharedPath && fs.existsSync(this.bundledSharedPath)) {
      try {
        const raw = fs.readFileSync(this.bundledSharedPath, 'utf8');
        const j = JSON.parse(raw);
        s = {
          apiKey: String(j.apiKey || '').trim(),
          blocklist: (Array.isArray(j.danhSachChan) ? j.danhSachChan : [])
            .filter((x) => x && /^UC[\w-]{22}$/.test(x.id))
            .map((x) => ({ id: x.id, name: x.ten || '', note: x.ghiChu || '', shared: true })),
          capNhat: j.capNhat || ''
        };
      } catch (e) {
        s.error = 'Không đọc được cau-hinh-chung.json: ' + e.message;
      }
    }
    this.sharedCache = s;
    this.sharedAt = Date.now();
    return s;
  }

  getCfg() {
    return mergeCfg(this.data.cfg);
  }

  saveCfg(patch) {
    this.data.cfg = mergeCfg(Object.assign({}, this.data.cfg || {}, patch || {}));
    this.saveData();
    return this.data.cfg;
  }

  async getKey() {
    const cfg = this.getCfg();
    const shared = await this.getShared();
    const key = (cfg.apiKey || '').trim() || shared.apiKey;
    if (!key) throw new LytError('NO_KEY');
    return { key, cfg };
  }

  async addQuota(units) {
    if (!units) return this.readQuota();
    const day = quotaDay();
    const q = this.data.quota && this.data.quota.day === day ? this.data.quota : { day, units: 0, pages: 0 };
    q.units += units;
    this.data.quota = q;
    this.saveData();
    return q;
  }

  async addPages(n) {
    if (!n) return;
    const day = quotaDay();
    const q = this.data.quota && this.data.quota.day === day ? this.data.quota : { day, units: 0, pages: 0 };
    q.pages = (q.pages || 0) + n;
    this.data.quota = q;
    this.saveData();
  }

  readQuota() {
    const day = quotaDay();
    return this.data.quota && this.data.quota.day === day ? this.data.quota : { day, units: 0, pages: 0 };
  }

  async api(ctx, endpoint, params) {
    const u = new URL(API + endpoint);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('key', ctx.key);
    let res;
    try {
      res = await fetch(u.toString());
    } catch (e) {
      throw new LytError('MANG', 'Không kết nối được YouTube API: ' + e.message);
    }
    ctx.units = (ctx.units || 0) + 1;
    let body = null;
    try { body = await res.json(); } catch (e) { /* bỏ qua */ }
    if (!res.ok) throw mapError(res.status, body);
    return body || {};
  }

  async lookup(ids) {
    const ctx = Object.assign({ units: 0 }, await this.getKey());
    const cfg = ctx.cfg;
    const pv = hashList(cfg.copyrightPhrases);
    const now = Date.now();
    ids = [...new Set(ids)].filter((x) => /^[\w-]{11}$/.test(x));

    const videos = {};
    const channels = {};
    const toSave = {};
    let quota = null;

    try {
      // 1) Video details
      const needV = [];
      for (const id of ids) {
        const e = this.data.cache['v:' + id];
        if (e && now - e.t < TTL_VIDEO && e.pv === pv) videos[id] = e;
        else needV.push(id);
      }

      for (const part of chunks(needV, 50)) {
        const r = await this.api(ctx, 'videos', {
          part: 'snippet,contentDetails,player',
          id: part.join(','),
          maxWidth: '640',
          fields: 'items(id,snippet(channelId,channelTitle,publishedAt,description,liveBroadcastContent),' +
            'contentDetails(duration,definition),player(embedWidth,embedHeight))'
        });
        const got = new Set();
        for (const it of r.items || []) {
          got.add(it.id);
          const sn = it.snippet || {};
          const cd = it.contentDetails || {};
          const pl = it.player || {};
          const hit = copyrightMatch(sn.description, cfg.copyrightPhrases);
          const e = {
            t: now, pv,
            ch: sn.channelId,
            cht: sn.channelTitle,
            pub: sn.publishedAt,
            dur: parseDuration(cd.duration),
            def: cd.definition,
            ar: pl.embedWidth && pl.embedHeight ? +(pl.embedWidth / pl.embedHeight).toFixed(3) : null,
            cr: hit,
            live: sn.liveBroadcastContent && sn.liveBroadcastContent !== 'none' ? sn.liveBroadcastContent : null
          };
          videos[it.id] = e;
          toSave['v:' + it.id] = e;
        }
        for (const id of part) {
          if (!got.has(id)) {
            const e = { t: now, pv, gone: true };
            videos[id] = e;
            toSave['v:' + id] = e;
          }
        }
      }

      // 2) Channels
      const chIds = [...new Set(Object.values(videos).map((v) => v.ch).filter(Boolean))];
      const needC = [];
      for (const id of chIds) {
        const e = this.data.cache['c:' + id];
        if (e && now - e.t < TTL_CHANNEL) channels[id] = e;
        else needC.push(id);
      }

      const fresh = [];
      for (const part of chunks(needC, 50)) {
        const r = await this.api(ctx, 'channels', {
          part: 'snippet,statistics,contentDetails',
          id: part.join(','),
          fields: 'items(id,snippet(title,customUrl,publishedAt,country),' +
            'statistics(subscriberCount,hiddenSubscriberCount,videoCount),' +
            'contentDetails(relatedPlaylists(uploads)))'
        });
        for (const it of r.items || []) {
          const st = it.statistics || {};
          const e = {
            t: now,
            id: it.id,
            title: (it.snippet || {}).title || '',
            handle: (it.snippet || {}).customUrl || '',
            country: (it.snippet || {}).country || '',
            created: (it.snippet || {}).publishedAt || '',
            hs: !!st.hiddenSubscriberCount,
            subs: st.subscriberCount !== undefined ? +st.subscriberCount : null,
            vc: st.videoCount !== undefined ? +st.videoCount : null,
            up: ((it.contentDetails || {}).relatedPlaylists || {}).uploads || '',
            lu: null
          };
          channels[it.id] = e;
          fresh.push(e);
        }
      }

      // 3) Latest upload per channel
      await poolMap(fresh, 4, async (e) => {
        if (!e.up) return;
        try {
          const r = await this.api(ctx, 'playlistItems', {
            part: 'contentDetails',
            playlistId: e.up,
            maxResults: '5',
            fields: 'items(contentDetails(videoPublishedAt))'
          });
          const ts = (r.items || [])
            .map((x) => Date.parse((x.contentDetails || {}).videoPublishedAt))
            .filter((x) => !isNaN(x));
          if (ts.length) e.lu = new Date(Math.max(...ts)).toISOString();
        } catch (err) {
          if (err.code !== 'NOT_FOUND') throw err;
        }
      });
      for (const e of fresh) toSave['c:' + e.id] = e;
    } finally {
      if (Object.keys(toSave).length) {
        Object.assign(this.data.cache, toSave);
        this.saveData();
      }
      quota = await this.addQuota(ctx.units);
    }
    return { videos, channels, quota };
  }

  async measureQuality(id) {
    const res = await fetch('https://www.youtube.com/watch?v=' + id + '&hl=en');
    if (!res.ok) return { q: null, err: 'HTTP ' + res.status };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    let start = -1;
    let seg = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if (start < 0) {
        start = text.indexOf('ytInitialPlayerResponse');
        if (start < 0 && text.length > 200000) text = text.slice(-50000);
        if (start >= 0) text = text.slice(start), start = 0;
      }
      if (start >= 0) {
        const end = text.indexOf('"videoDetails"');
        if (end > 0) { seg = text.slice(0, end); break; }
        if (text.length > 4e6) { seg = text; break; }
      }
    }
    try { reader.cancel(); } catch (e) { /* ignore */ }
    if (!seg) seg = start >= 0 ? text : '';
    const status = (seg.match(/"playabilityStatus":\{"status":"(\w+)"/) || [])[1] || null;
    let maxQ = 0;
    for (const m of seg.matchAll(/"qualityLabel":"(\d+)p/g)) maxQ = Math.max(maxQ, +m[1]);
    let best = null;
    for (const m of seg.matchAll(/"width":(\d+),"height":(\d+)/g)) {
      const w = +m[1], h = +m[2];
      if (w >= 100 && h >= 100 && (!best || w * h > best[0] * best[1])) best = [w, h];
    }
    return {
      q: maxQ || null,
      ar: best ? +(best[0] / best[1]).toFixed(3) : null,
      st: status
    };
  }

  async quality(ids) {
    ids = [...new Set(ids)].filter((x) => /^[\w-]{11}$/.test(x));
    const now = Date.now();
    const out = {};
    const need = [];
    for (const id of ids) {
      const e = this.data.cache['q:' + id];
      if (e && now - e.t < TTL_QUALITY) out[id] = e;
      else need.push(id);
    }
    let pages = 0;
    await poolMap(need, QUALITY_CONCURRENCY, async (id) => {
      if (!this.qualityInflight.has(id)) {
        this.qualityInflight.set(id, (async () => {
          try {
            const r = await this.measureQuality(id);
            pages++;
            const e = Object.assign({ t: Date.now() }, r);
            if (!e.q) e.t = Date.now() - TTL_QUALITY + 3600e3;
            this.data.cache['q:' + id] = e;
            return e;
          } catch (err) {
            return { t: Date.now(), q: null, err: err.message };
          } finally {
            this.qualityInflight.delete(id);
          }
        })());
      }
      out[id] = await this.qualityInflight.get(id);
    });
    if (pages > 0) {
      await this.addPages(pages);
      this.saveData();
    }
    return { quality: out, quota: this.readQuota() };
  }

  async testKey(key) {
    const ctx = { key: String(key || '').trim(), units: 0 };
    if (!ctx.key) throw new LytError('NO_KEY', 'Chưa nhập key.');
    try {
      const r = await this.api(ctx, 'videos', { part: 'id', id: TEST_VIDEO, fields: 'items(id)' });
      return { valid: (r.items || []).length === 1 };
    } finally {
      await this.addQuota(ctx.units);
    }
  }

  async resolveHandles(handles) {
    const ctx = Object.assign({ units: 0 }, await this.getKey());
    const out = {};
    try {
      for (const h of handles) {
        const r = await this.api(ctx, 'channels', { part: 'snippet', forHandle: h, fields: 'items(id,snippet(title))' });
        const it = (r.items || [])[0];
        out[h] = it ? { id: it.id, name: it.snippet.title } : null;
      }
    } finally {
      await this.addQuota(ctx.units);
    }
    return out;
  }

  clearCache() {
    const keys = Object.keys(this.data.cache || {});
    this.data.cache = {};
    this.saveData();
    return { removed: keys.length };
  }

  getAssets() {
    const cssPath = path.join(__dirname, 'youtube-filter-content.css');
    const jsPath = path.join(__dirname, 'youtube-filter-injection.js');
    return {
      css: fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '',
      js: fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : ''
    };
  }

  prune() {
    const now = Date.now();
    if (this.data.lastPrune && now - this.data.lastPrune < DAY) return;
    const oldKeys = Object.keys(this.data.cache || {}).filter((k) => {
      const e = this.data.cache[k];
      if (!e || typeof e.t !== 'number') return false;
      if (k.startsWith('v:')) return now - e.t > TTL_VIDEO;
      if (k.startsWith('c:')) return now - e.t > TTL_CHANNEL * 4;
      if (k.startsWith('q:')) return now - e.t > TTL_QUALITY;
      return false;
    });
    for (const k of oldKeys) delete this.data.cache[k];
    this.data.lastPrune = now;
    if (oldKeys.length) this.saveData();
  }

  async handleMessage(msg) {
    try {
      switch (msg && msg.type) {
        case 'lookup': {
          const r = await this.lookup(msg.ids || []);
          return Object.assign({ ok: true }, r);
        }
        case 'quality': {
          const r = await this.quality(msg.ids || []);
          return Object.assign({ ok: true }, r);
        }
        case 'getShared': {
          const s = await this.getShared();
          return { ok: true, shared: s };
        }
        case 'quota': {
          return { ok: true, quota: this.readQuota() };
        }
        case 'testKey': {
          const r = await this.testKey(msg.key);
          return Object.assign({ ok: true }, r);
        }
        case 'resolveHandles': {
          const r = await this.resolveHandles(msg.handles || []);
          return { ok: true, result: r };
        }
        case 'clearCache': {
          const r = this.clearCache();
          return Object.assign({ ok: true }, r);
        }
        case 'storageGet': {
          const keys = Array.isArray(msg.keys) ? msg.keys : [msg.keys];
          const out = {};
          for (const k of keys) {
            if (k === 'cfg') out.cfg = this.getCfg();
            else if (k === 'quota') out.quota = this.readQuota();
            else if (this.data.cache[k]) out[k] = this.data.cache[k];
          }
          return { ok: true, data: out };
        }
        case 'storageSet': {
          const items = msg.items || {};
          if (items.cfg) this.saveCfg(items.cfg);
          return { ok: true };
        }
        default:
          return { ok: false, error: 'UNKNOWN_MSG', message: 'Unknown message type: ' + (msg && msg.type) };
      }
    } catch (e) {
      return { ok: false, error: e.code || 'LOI', message: e.message };
    }
  }
}

module.exports = {
  YoutubeFilterService,
  GROUPS,
  DEFAULT_CFG,
  defaultShow,
  mergeCfg,
  parseDuration,
  copyrightMatch,
  hashList,
  quotaDay,
  LytError
};
