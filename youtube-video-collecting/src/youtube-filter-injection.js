// YouTube Filter Injected Script (Rhymx YouTube Ultimate Tool)
// Runs inside the YouTube <webview>
(function () {
  'use strict';
  if (window.__lytLoaded) return;
  window.__lytLoaded = true;

  // ============================================================================
  // PART 1: CORE FILTER LOGIC (chung.js)
  // ============================================================================
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
    mode: 'hide',
    starMonths: 12,
    measureQuality: true,
    panelCollapsed: false,
    blocklist: [],
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

  function label(gk, ok) {
    const gr = GROUPS.find((x) => x.key === gk);
    const o = gr && gr.opts.find((x) => x[0] === ok);
    return o ? o[1] : ok;
  }

  function formatCount(n) {
    if (n === null || n === undefined || isNaN(n)) return '?';
    const fmt = (x) => {
      const r = x >= 100 ? Math.round(x) : Math.round(x * 10) / 10;
      return String(r).replace('.', ',');
    };
    if (n < 1000) return String(n);
    if (n < 1e6) return fmt(n / 1e3) + ' N';
    if (n < 1e9) return fmt(n / 1e6) + ' Tr';
    return fmt(n / 1e9) + ' T';
  }

  function parseDuration(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso || '');
    if (!m) return null;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }

  function monthsSince(dateStr, now) {
    const t = Date.parse(dateStr);
    if (isNaN(t)) return null;
    return ((now || Date.now()) - t) / (30.44 * 864e5);
  }

  function formatAge(months) {
    if (months === null || months === undefined) return '?';
    if (months < 1) return 'dưới 1 tháng';
    if (months < 12) return Math.floor(months) + ' tháng';
    const y = Math.floor(months / 12);
    const r = Math.floor(months % 12);
    return y + ' năm' + (y < 3 && r ? ' ' + r + ' tháng' : '');
  }

  function formatMonthYear(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d)) return '?';
    return String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function tvMatch(title, keywords) {
    const t = ' ' + String(title || '').toLowerCase() + ' ';
    for (const kw of keywords || []) {
      const k = String(kw).trim().toLowerCase();
      if (!k) continue;
      const re = new RegExp('(^|[^\\p{L}\\p{N}])' + escapeRe(k) + '($|[^\\p{L}\\p{N}])', 'u');
      if (re.test(t)) return k;
    }
    return null;
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

  function videoIdFrom(href) {
    const m = String(href || '').match(/(?:[?&]v=|\/shorts\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  function bucketSub(ch) {
    if (!ch) return null;
    if (ch.hs || ch.subs === null || ch.subs === undefined) return 'an';
    const n = ch.subs;
    if (n < 1e3) return 'lt1k';
    if (n < 1e4) return '1k';
    if (n < 5e4) return '10k';
    if (n < 1e5) return '50k';
    if (n < 5e5) return '100k';
    if (n < 1e6) return '500k';
    return '1m';
  }

  function bucketMonths(m, cuts, keys) {
    if (m === null || m === undefined) return null;
    for (let i = 0; i < cuts.length; i++) if (m < cuts[i]) return keys[i];
    return keys[keys.length - 1];
  }

  function bucketDuration(sec) {
    if (sec === null || sec === undefined) return null;
    if (sec < 240) return 'lt4';
    if (sec < 600) return '4';
    if (sec < 1200) return '10';
    return '20';
  }

  function bucketQuality(h) {
    if (!h) return null;
    if (h < 720) return 'lt720';
    if (h < 1080) return '720';
    if (h < 1440) return '1080';
    if (h < 2160) return '2k';
    return '4k';
  }

  function frameIssue(ar) {
    if (!ar) return null;
    if (ar < 0.95) return 'video dọc';
    if (ar < 1.55) return 'khung vuông / 4:3';
    if (ar > 2.05) return 'khung siêu rộng';
    return null;
  }

  function classify(x, cfg) {
    const now = x.now || Date.now();
    const v = x.v && !x.v.gone ? x.v : null;
    const ch = x.ch || null;
    const q = x.q || null;
    const dom = x.dom || {};
    const tags = [];
    const add = (gk, ok) => { if (ok) tags.push([gk, ok]); };

    const loai = [];
    if (dom.verified) loai.push('tich');
    if (ch && tvMatch(ch.title, cfg.tvKeywords)) loai.push('dai');
    if (x.blocked) loai.push('chan');
    if (!loai.length && ch) loai.push('thuong');
    loai.forEach((k) => add('loai', k));

    if (ch) {
      add('sub', bucketSub(ch));
      add('dangcuoi', bucketMonths(monthsSince(ch.lu, now), [3, 12, 36], ['3t', '12t', '3n', 'tren3n']));
    }
    if (v) {
      add('dodai', bucketDuration(v.dur));
      add('ngaydang', bucketMonths(monthsSince(v.pub, now), [12, 36, 60], ['lt1n', '1n', '3n', '5n']));
    }

    let qh = q && q.q ? q.q : null;
    if (!qh && v && v.def === 'sd') qh = 480;
    if (!qh && dom.is4k) qh = 2160;
    add('chatluong', bucketQuality(qh));

    const frame = dom.short ? 'Shorts' : frameIssue((q && q.ar) || (v && v.ar));
    if (frame) add('khac', 'doc');
    if (v && v.cr) add('khac', 'banquyen');
    if (v && v.live) add('khac', 'live');

    const hiddenBy = [];
    if (cfg.enabled) {
      for (const [gk, ok] of tags) {
        if (cfg.show[gk] && cfg.show[gk][ok] === false) hiddenBy.push([gk, ok]);
      }
    }
    return { tags, hiddenBy, qh, frame };
  }

  const L = {
    GROUPS, DEFAULT_CFG, defaultShow, mergeCfg, label, formatCount, parseDuration,
    monthsSince, formatAge, formatMonthYear, tvMatch, copyrightMatch,
    hashList, videoIdFrom, bucketSub, bucketQuality, frameIssue, classify
  };
  self.LYT = L;

  // ============================================================================
  // PART 2: IPC BRIDGE SHIM (Communicates with Electron Host)
  // ============================================================================
  let reqCounter = 0;
  const pendingRequests = new Map();

  function send(msg) {
    return new Promise((resolve) => {
      const reqId = ++reqCounter;
      pendingRequests.set(reqId, resolve);
      console.log('__LYT_REQ__' + JSON.stringify({ reqId, msg }));
      setTimeout(() => {
        if (pendingRequests.has(reqId)) {
          pendingRequests.delete(reqId);
          resolve({ ok: false, error: 'TIMEOUT', message: 'Request timeout' });
        }
      }, 40000);
    });
  }

  window.__lytReply = function (reqId, response) {
    const resolve = pendingRequests.get(reqId);
    if (resolve) {
      pendingRequests.delete(reqId);
      resolve(response || { ok: false });
    }
  };

  const storageListeners = [];
  window.__lytTriggerStorageChange = function (changes) {
    for (const listener of storageListeners) {
      try { listener(changes, 'local'); } catch (e) { console.error(e); }
    }
  };

  const shimStorage = {
    local: {
      get: async (keys) => {
        const res = await send({ type: 'storageGet', keys });
        return (res && res.data) || {};
      },
      set: async (items) => {
        return send({ type: 'storageSet', items });
      }
    },
    onChanged: {
      addListener: (fn) => storageListeners.push(fn)
    }
  };

  // ============================================================================
  // PART 3: DOM SCRAPING, BADGES, AND SHADOW DOM UI (content.js)
  // ============================================================================
  const CONT = 'ytd-video-renderer, yt-lockup-view-model, ytd-rich-item-renderer, ytd-grid-video-renderer, ' +
    'ytd-compact-video-renderer, ytd-reel-item-renderer, ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model';
  const SHELF = 'ytd-reel-shelf-renderer, grid-shelf-view-model, ytd-rich-shelf-renderer';
  const SHORT_IN_SHELF = 'ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytd-reel-item-renderer';

  const ERR = {
    NO_KEY: 'Chưa có key YouTube API. Bấm "Cài đặt" để nhập key.',
    BAD_KEY: 'Key YouTube API không đúng. Kiểm tra lại trong "Cài đặt".',
    API_OFF: 'Key chưa bật "YouTube Data API v3" trong Google Cloud.',
    KEY_RESTRICTED: 'Key đang giới hạn website/IP. Trong Google Cloud, để "Application restrictions" = None.',
    QUOTA: 'Hết hạn mức API hôm nay (đặt lại khoảng 14–15h giờ VN).',
    MANG: 'Không kết nối được YouTube API. Kiểm tra mạng.',
    EXT: 'Lỗi kết nối bộ lọc.'
  };

  let cfg = L.mergeCfg(null);
  let sharedBlock = [];
  let blockMap = new Map();
  const V = {};
  const C = {};
  const Q = {};
  const pendingV = new Set();
  const pendingQ = new Set();
  let lookupBusy = false;
  let qualityBusy = false;
  let errorCode = null;
  let errorMsg = '';
  let pauseUntil = 0;
  let dead = false;
  let quota = null;
  let peek = false;
  let stats = null;
  let ui = null;
  let scanTimer = null;
  const badges = new WeakMap();

  function setError(code, msg) {
    errorCode = code || 'LOI';
    errorMsg = msg || '';
    if (code === 'EXT') dead = true;
    pauseUntil = Date.now() + 60e3;
  }

  function clearError() {
    errorCode = null;
    errorMsg = '';
    pauseUntil = 0;
  }

  async function loadCfg() {
    try {
      const r = await shimStorage.local.get('cfg');
      cfg = L.mergeCfg(r.cfg);
    } catch (e) {
      setError('EXT', e.message);
    }
    rebuildBlock();
  }

  async function saveCfg(patch) {
    try {
      const r = await shimStorage.local.get('cfg');
      const updated = Object.assign({}, r.cfg || {}, patch);
      await shimStorage.local.set({ cfg: updated });
    } catch (e) {
      setError('EXT', e.message);
      updateUi();
    }
  }

  async function loadShared() {
    const r = await send({ type: 'getShared' });
    if (r.ok && r.shared) {
      sharedBlock = r.shared.blocklist || [];
      rebuildBlock();
    }
  }

  function rebuildBlock() {
    blockMap = new Map();
    for (const b of sharedBlock) blockMap.set(b.id, Object.assign({ shared: true }, b));
    for (const b of cfg.blocklist || []) if (b && b.id && !blockMap.has(b.id)) blockMap.set(b.id, b);
  }

  function readDom(c, href) {
    const verified = !!c.querySelector(
      'ytd-channel-name ytd-badge-supported-renderer:not([hidden]) badge-shape, ' +
      'yt-content-metadata-view-model badge-shape[aria-label]'
    );
    let is4k = false;
    for (const b of c.querySelectorAll('ytd-badge-supported-renderer badge-shape, #badges badge-shape')) {
      if (/^(4K|8K)$/i.test((b.textContent || '').trim())) { is4k = true; break; }
    }
    return { verified, is4k, short: href.includes('/shorts/') };
  }

  function collect() {
    const root = document.querySelector('ytd-search');
    if (!root) return { items: [], shelves: [] };
    const items = [];
    const seen = new Set();
    const shelves = new Set();
    for (const a of root.querySelectorAll('a[href*="watch?v="], a[href*="/shorts/"]')) {
      const href = a.getAttribute('href') || '';
      if (/[?&]list=/.test(href)) continue;
      const id = L.videoIdFrom(href);
      if (!id) continue;
      const shelf = a.closest(SHELF);
      if (shelf && shelf.querySelector(SHORT_IN_SHELF)) { shelves.add(shelf); continue; }
      let c = a.closest(CONT);
      if (!c) continue;
      const outer = c.parentElement && c.parentElement.closest(CONT);
      if (outer) c = outer;
      if (seen.has(c)) continue;
      seen.add(c);
      items.push({ c, id, dom: readDom(c, href) });
    }
    return { items, shelves: [...shelves] };
  }

  async function requestLookup(items) {
    if (!cfg.enabled || dead || lookupBusy || Date.now() < pauseUntil) return;
    const ids = [];
    for (const it of items) if (!V[it.id] && !pendingV.has(it.id)) ids.push(it.id);
    if (!ids.length) return;
    lookupBusy = true;
    ids.forEach((i) => pendingV.add(i));
    const r = await send({ type: 'lookup', ids });
    lookupBusy = false;
    ids.forEach((i) => pendingV.delete(i));
    if (r.ok) {
      Object.assign(V, r.videos || {});
      Object.assign(C, r.channels || {});
      if (r.quota) quota = r.quota;
      clearError();
    } else {
      setError(r.error, r.message);
    }
    scheduleScan(0);
  }

  async function requestQuality(items) {
    if (!cfg.enabled || dead || !cfg.measureQuality || qualityBusy) return;
    const ids = [];
    for (const it of items) {
      if (ids.length >= 4) break;
      const v = V[it.id];
      if (!v || v.gone || Q[it.id] || pendingQ.has(it.id) || it.dom.short || it.dom.is4k) continue;
      if (v.def === 'sd') continue;
      if (it.res && it.res.hiddenBy.some(([g]) => g !== 'chatluong')) continue;
      ids.push(it.id);
    }
    if (!ids.length) return;
    qualityBusy = true;
    ids.forEach((i) => pendingQ.add(i));
    updateUi();
    const r = await send({ type: 'quality', ids });
    qualityBusy = false;
    ids.forEach((i) => pendingQ.delete(i));
    if (r.ok) {
      Object.assign(Q, r.quality || {});
      if (r.quota) quota = r.quota;
    } else {
      ids.forEach((i) => { Q[i] = { q: null, err: r.message || r.error }; });
      if (r.error === 'EXT') setError('EXT', r.message);
    }
    scheduleScan(0);
  }

  function qualityText(h, q) {
    if ((!q || !q.q) && h === 480) return 'dưới 720p';
    if (h >= 4320) return '8K';
    if (h >= 2160) return '4K';
    if (h >= 1440) return '2K (1440p)';
    return h + 'p';
  }

  function placeBadge(c, b) {
    const ci = c.querySelector('#channel-info');
    if (ci && ci.parentElement) { ci.insertAdjacentElement('afterend', b); return; }
    const meta = c.querySelector('yt-lockup-metadata-view-model, #meta, .text-wrapper');
    if (meta) { meta.appendChild(b); return; }
    c.appendChild(b);
  }

  function removeBadge(c) {
    const b = badges.get(c);
    if (b) { b.remove(); badges.delete(c); }
  }

  function renderBadge(it, v, ch, res, star) {
    const parts = [];
    if (res.hiddenBy.length) {
      parts.push(['Bị lọc: ' + res.hiddenBy.map(([g, k]) => L.label(g, k)).join(', '), 'loc']);
    }
    if (!v) {
      parts.push(errorCode ? ['chưa có thông tin kênh (xem bảng lọc)', 'loi'] : ['đang lấy thông tin kênh…', 'cho']);
    } else if (v.gone) {
      parts.push(['video riêng tư / đã xoá', 'loi']);
    } else {
      if (ch) {
        parts.push([ch.hs ? 'ẩn sub' : L.formatCount(ch.subs) + ' sub', 'sub',
          (ch.vc !== null && ch.vc !== undefined ? ch.vc + ' video trên kênh' : '') +
          (ch.country ? ' · quốc gia ' + ch.country : '')]);
        if (ch.lu) {
          parts.push(['đăng cuối ' + L.formatMonthYear(ch.lu) + ' (' + L.formatAge(L.monthsSince(ch.lu)) + ' trước)',
            star ? 'sao' : '']);
        }
      }
      const q = Q[it.id];
      if (res.qh) parts.push([qualityText(res.qh, q), 'cl', q && q.q ? 'đo trên trang video' : (it.dom.is4k ? 'theo nhãn 4K của YouTube' : 'theo YouTube API')]);
      else if (pendingQ.has(it.id)) parts.push(['đang đo chất lượng…', 'cho']);
      else if (q && !q.q) parts.push(['chưa đo được chất lượng', 'cho', q.err || q.st || '']);
      if (res.frame) parts.push([res.frame, 'canh']);
      if (it.dom.verified) parts.push(['✔ có tích', 'canh']);
      const tv = ch && L.tvMatch(ch.title, cfg.tvKeywords);
      if (tv) parts.push(['nghi đài TV / báo ("' + tv + '")', 'canh']);
      if (v.cr) parts.push(['mô tả có "' + v.cr + '"', 'canh']);
      if (v.live) parts.push([v.live === 'live' ? 'đang phát trực tiếp' : 'sắp chiếu', 'canh']);
      if (blockMap.has(v.ch)) parts.push(['đã chặn' + (blockMap.get(v.ch).shared ? ' (danh sách chung)' : ''), 'loi']);
      if (star) parts.push(['⭐ kênh ngừng đăng', 'sao']);
    }
    const blockable = !!(v && !v.gone && v.ch);
    const blocked = blockable && blockMap.has(v.ch);
    const sharedBlocked = blocked && !!blockMap.get(v.ch).shared;
    const sig = JSON.stringify([it.id, parts, blockable, blocked, sharedBlocked]);

    let b = badges.get(it.c);
    if (b && b.isConnected && b.dataset.sig === sig) return;
    if (!b || !b.isConnected) {
      b = document.createElement('div');
      b.className = 'lyt-badge';
      badges.set(it.c, b);
      placeBadge(it.c, b);
    }
    b.dataset.sig = sig;
    b.textContent = '';
    for (const [t, cls, title] of parts) {
      const s = document.createElement('span');
      s.className = 'lyt-chip' + (cls ? ' lyt-c-' + cls : '');
      s.textContent = t;
      if (title) s.title = title;
      b.appendChild(s);
    }
    if (blockable && !sharedBlocked) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lyt-btn';
      btn.textContent = blocked ? 'Bỏ chặn' : 'Chặn kênh';
      btn.dataset.act = blocked ? 'unblock' : 'block';
      btn.dataset.ch = v.ch;
      btn.dataset.name = (ch && ch.title) || v.cht || '';
      b.appendChild(btn);
    }
  }

  function render(items, shelves) {
    const now = Date.now();
    const st = { total: 0, shown: 0, hidden: 0, loading: 0, measuring: pendingQ.size, by: new Map(), tags: new Map(), shelves: 0 };
    for (const it of items) {
      if (!cfg.enabled) {
        it.c.classList.remove('lyt-an', 'lyt-mo', 'lyt-uutien');
        removeBadge(it.c);
        it.res = null;
        continue;
      }
      const v = V[it.id];
      const ch = v && !v.gone ? C[v.ch] : null;
      const res = L.classify({ dom: it.dom, v, ch, q: Q[it.id], blocked: !!(v && v.ch && blockMap.has(v.ch)), now }, cfg);
      it.res = res;
      st.total++;
      if (!v && !errorCode) st.loading++;
      for (const [g, k] of res.tags) st.tags.set(g + ':' + k, (st.tags.get(g + ':' + k) || 0) + 1);
      const hidden = res.hiddenBy.length > 0;
      if (hidden) {
        st.hidden++;
        for (const [g, k] of res.hiddenBy) {
          const lb = L.label(g, k);
          st.by.set(lb, (st.by.get(lb) || 0) + 1);
        }
      } else {
        st.shown++;
      }
      const mode = !hidden ? '' : (peek || cfg.mode === 'dim') ? 'dim' : 'hide';
      it.c.classList.toggle('lyt-an', mode === 'hide');
      it.c.classList.toggle('lyt-mo', mode === 'dim');
      const star = !!(ch && ch.lu && L.monthsSince(ch.lu, now) >= cfg.starMonths);
      it.c.classList.toggle('lyt-uutien', star && !hidden);
      renderBadge(it, v, ch, res, star);
    }
    const hideShelves = cfg.enabled && cfg.show.khac.doc === false;
    for (const s of shelves) {
      s.classList.toggle('lyt-an', hideShelves && !peek);
      s.classList.toggle('lyt-mo', hideShelves && peek);
      if (hideShelves) st.shelves++;
    }
    stats = st;
    updateUi();
  }

  function scan() {
    scanTimer = null;
    if (dead) { updateUi(); return; }
    if (location.pathname !== '/results') {
      if (ui) ui.host.style.display = 'none';
      document.documentElement.classList.remove('lyt-chua-cho');
      return;
    }
    ensureUi();
    ui.host.style.display = '';
    document.documentElement.classList.toggle('lyt-chua-cho', !cfg.panelCollapsed);
    const { items, shelves } = collect();
    render(items, shelves);
    requestLookup(items);
    requestQuality(items);
  }

  function scheduleScan(delay) {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, delay === undefined ? 250 : delay);
  }

  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.lyt-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const id = btn.dataset.ch;
    const list = (cfg.blocklist || []).filter((b) => b && b.id !== id);
    if (btn.dataset.act === 'block') {
      list.push({ id, name: btn.dataset.name || '', note: '', date: new Date().toISOString().slice(0, 10) });
    }
    cfg.blocklist = list;
    rebuildBlock();
    saveCfg({ blocklist: list });
    scheduleScan(0);
  }, true);

  const PANEL_CSS = `
    :host { all: initial; }
    .p { position: fixed; top: 64px; right: 12px; z-index: 2300; width: 272px; max-height: calc(100vh - 80px);
      overflow: auto; box-sizing: border-box; font: 13px/1.4 Roboto, Arial, sans-serif; color: var(--fg);
      background: var(--bg); border: 1px solid var(--bd); border-radius: 12px; box-shadow: 0 4px 18px rgba(0,0,0,.18); }
    .p { --fg: #0f0f0f; --mut: #606060; --bg: #ffffff; --bd: #d9d9d9; --soft: #f2f2f2; --acc: #065fd4; --warn: #b3261e; }
    :host([data-dark]) .p { --fg: #f1f1f1; --mut: #aaaaaa; --bg: #212121; --bd: #3f3f3f; --soft: #2f2f2f; --acc: #3ea6ff; --warn: #ff8a80; }
    .hd { display: flex; align-items: center; gap: 6px; padding: 8px 10px; position: sticky; top: 0; background: var(--bg);
      border-bottom: 1px solid var(--bd); cursor: pointer; user-select: none; }
    .hd b { font-size: 14px; }
    .hd .count { margin-left: auto; color: var(--mut); font-size: 12px; }
    .p.collapsed { width: auto; }
    .p.collapsed .bd { display: none; }
    .p.collapsed .hd { border-bottom: 0; }
    .bd { padding: 8px 10px 10px; }
    .row { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; margin-bottom: 6px; }
    fieldset { border: 1px solid var(--bd); border-radius: 8px; margin: 0 0 8px; padding: 4px 8px 6px; }
    legend { padding: 0 4px; font-weight: 600; font-size: 12.5px; }
    .opts { display: grid; grid-template-columns: 1fr 1fr; gap: 1px 6px; font-size: 12.5px; }
    .opts.one { grid-template-columns: 1fr; }
    label { display: flex; align-items: center; gap: 4px; cursor: pointer; min-width: 0; }
    .opts label { display: block; line-height: 1.45; padding: 1px 0; }
    .opts label input { vertical-align: -2px; margin-right: 3px; }
    input { margin: 0; accent-color: var(--acc); }
    i.n { font-style: normal; color: var(--mut); font-size: 11.5px; }
    button { font: inherit; font-size: 12px; color: var(--fg); background: var(--soft); border: 1px solid var(--bd);
      border-radius: 14px; padding: 3px 10px; cursor: pointer; }
    button:hover { border-color: var(--acc); }
    button.all { padding: 0 6px; font-size: 11px; margin-left: 4px; border-radius: 8px; }
    button.on { background: var(--acc); color: #fff; border-color: var(--acc); }
    .btns { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 10px; }
    .msg { color: var(--warn); font-size: 12.5px; margin: 0 0 6px; }
    .msg:empty { display: none; }
    .sum { background: var(--soft); border-radius: 8px; padding: 6px 8px; font-size: 12.5px; }
    .sum div + div { margin-top: 2px; color: var(--mut); }
    .quota { color: var(--mut); font-size: 11.5px; margin-top: 4px; }
    .toggle { border: 0; background: none; padding: 0 2px; font-size: 14px; }
  `;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid);
    return el;
  }

  function buildPanel(root) {
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    const groups = L.GROUPS.map((gr) => h('fieldset', {},
      h('legend', {}, gr.title + ' ',
        h('button', { class: 'all', 'data-act': 'all', 'data-g': gr.key, title: 'Tích / bỏ tích cả nhóm' }, 'tất cả')),
      h('div', { class: gr.key === 'khac' || gr.key === 'loai' ? 'opts one' : 'opts' },
        gr.opts.map(([k, lb]) => h('label', {},
          h('input', { type: 'checkbox', 'data-g': gr.key, 'data-k': k }), ' ',
          h('span', {}, lb), ' ',
          h('i', { class: 'n', 'data-n': gr.key + ':' + k }))))));
    const p = h('div', { class: 'p' },
      h('div', { class: 'hd', 'data-act': 'collapse' },
        h('span', { class: 'toggle' }, '▾'), h('b', {}, 'Lọc kênh'), h('span', { class: 'count' })),
      h('div', { class: 'bd' },
        h('div', { class: 'row' },
          h('label', {}, h('input', { type: 'checkbox', 'data-cfg': 'enabled' }), ' ', h('b', {}, 'Bật lọc')),
          h('label', {}, h('input', { type: 'radio', name: 'mode', value: 'hide' }), ' Ẩn hẳn'),
          h('label', {}, h('input', { type: 'radio', name: 'mode', value: 'dim' }), ' Làm mờ')),
        h('div', { class: 'msg' }),
        h('div', { class: 'sum' }),
        h('div', { class: 'btns' },
          h('button', { 'data-act': 'peek' }, 'Hiện tạm video bị lọc'),
          h('button', { 'data-act': 'more' }, 'Tải thêm kết quả'),
          h('button', { 'data-act': 'opts' }, 'Cài đặt')),
        groups,
        h('div', { class: 'quota' })));
    root.append(style, p);
  }

  function ensureUi() {
    if (ui) {
      if (!ui.host.isConnected) (document.body || document.documentElement).appendChild(ui.host);
      return;
    }
    const host = document.createElement('div');
    host.id = 'lyt-panel-host';
    const root = host.attachShadow({ mode: 'open' });
    buildPanel(root);
    (document.body || document.documentElement).appendChild(host);
    ui = { host, root, p: root.querySelector('.p') };

    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.g && t.dataset.k) {
        cfg.show[t.dataset.g][t.dataset.k] = t.checked;
        saveCfg({ show: cfg.show });
      } else if (t.dataset.cfg === 'enabled') {
        cfg.enabled = t.checked;
        saveCfg({ enabled: cfg.enabled });
      } else if (t.name === 'mode') {
        cfg.mode = t.value;
        saveCfg({ mode: cfg.mode });
      }
      scheduleScan(0);
    });

    root.addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      if (act === 'collapse') {
        cfg.panelCollapsed = !cfg.panelCollapsed;
        saveCfg({ panelCollapsed: cfg.panelCollapsed });
        syncUi();
      } else if (act === 'all') {
        e.stopPropagation();
        const g = cfg.show[el.dataset.g];
        const allOn = Object.values(g).every(Boolean);
        for (const k of Object.keys(g)) g[k] = !allOn;
        saveCfg({ show: cfg.show });
        syncUi();
        scheduleScan(0);
      } else if (act === 'peek') {
        peek = !peek;
        scheduleScan(0);
      } else if (act === 'more') {
        loadMore(el);
      } else if (act === 'opts') {
        send({ type: 'openOptions' });
      }
    });
    syncUi();
  }

  function syncUi() {
    if (!ui) return;
    const r = ui.root;
    ui.p.classList.toggle('collapsed', !!cfg.panelCollapsed);
    if (location.pathname === '/results') document.documentElement.classList.toggle('lyt-chua-cho', !cfg.panelCollapsed);
    r.querySelector('.toggle').textContent = cfg.panelCollapsed ? '▸' : '▾';
    r.querySelector('[data-cfg="enabled"]').checked = !!cfg.enabled;
    for (const el of r.querySelectorAll('input[name="mode"]')) el.checked = el.value === cfg.mode;
    for (const el of r.querySelectorAll('input[data-g]')) {
      el.checked = !!(cfg.show[el.dataset.g] && cfg.show[el.dataset.g][el.dataset.k]);
    }
    if (document.documentElement.hasAttribute('dark')) ui.host.setAttribute('data-dark', '');
    else ui.host.removeAttribute('data-dark');
    updateUi();
  }

  function updateUi() {
    if (!ui) return;
    const r = ui.root;
    const st = stats;
    const msg = r.querySelector('.msg');
    msg.textContent = errorCode ? (ERR[errorCode] || ('Lỗi: ' + errorMsg)) : '';
    if (errorCode && errorMsg && ERR[errorCode]) msg.title = errorMsg;

    const peekBtn = r.querySelector('[data-act="peek"]');
    peekBtn.textContent = peek ? 'Ẩn lại video bị lọc' : 'Hiện tạm video bị lọc';
    peekBtn.classList.toggle('on', peek);

    for (const el of r.querySelectorAll('i.n')) {
      const n = st && st.tags.get(el.dataset.n);
      el.textContent = n ? '(' + n + ')' : '';
    }

    const count = r.querySelector('.count');
    const sum = r.querySelector('.sum');
    if (!cfg.enabled) {
      count.textContent = 'đang tắt';
      sum.replaceChildren(h('div', {}, 'Đang tắt lọc. Tích "Bật lọc" để dùng.'));
    } else if (st) {
      count.textContent = 'hiện ' + st.shown + ' / ' + st.total;
      const lines = [];
      lines.push(['Đang hiện ', h('b', {}, String(st.shown)), ' / ' + st.total + ' video' + (st.hidden ? ', lọc bớt ' + st.hidden : '') + '.']);
      if (st.by.size) {
        lines.push(['Bị lọc vì: ' + [...st.by.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ' ' + n).join(' · ')]);
      }
      if (st.shelves) lines.push(['Ẩn ' + st.shelves + ' kệ Shorts.']);
      if (st.loading) lines.push(['Đang lấy thông tin ' + st.loading + ' video…']);
      if (st.measuring) lines.push(['Đang đo chất lượng ' + st.measuring + ' video…']);
      sum.replaceChildren(...lines.map((x) => h('div', {}, x)));
    }
    const qt = r.querySelector('.quota');
    if (quota) {
      qt.textContent = 'Hôm nay máy này: ' + quota.units + ' / 10.000 điểm API · mở ' + (quota.pages || 0) + ' trang video để đo chất lượng.';
    }
  }

  async function loadMore(btn) {
    btn.disabled = true;
    const y = window.scrollY;
    for (let i = 0; i < 3; i++) {
      const cont = document.querySelector('ytd-search ytd-continuation-item-renderer');
      if (!cont) break;
      cont.scrollIntoView({ block: 'end' });
      await new Promise((r) => setTimeout(r, 1800));
    }
    window.scrollTo(0, y);
    btn.disabled = false;
    scheduleScan(0);
  }

  // Storage listener for external updates
  shimStorage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.cfg) {
      const old = cfg;
      cfg = L.mergeCfg(changes.cfg.newValue);
      if (L.hashList(old.copyrightPhrases) !== L.hashList(cfg.copyrightPhrases)) {
        for (const k of Object.keys(V)) delete V[k];
      }
      if (old.apiKey !== cfg.apiKey) clearError();
      rebuildBlock();
      syncUi();
      scheduleScan(0);
    }
    if (changes.quota && changes.quota.newValue) {
      quota = changes.quota.newValue;
      updateUi();
    }
  });

  document.addEventListener('yt-navigate-finish', () => {
    peek = false;
    loadShared();
    scheduleScan(50);
  });
  new MutationObserver(() => scheduleScan()).observe(document.documentElement, { childList: true, subtree: true });

  (async () => {
    await loadCfg();
    await loadShared();
    const q = await send({ type: 'quota' });
    if (q.ok) quota = q.quota;
    scheduleScan(0);
  })();
})();
