(function (root, factory) {
  const commonJs = typeof window === 'undefined' && typeof module === 'object' && module.exports;
  const api = factory(commonJs ? require('./collector-link') : root.CollectorLink);
  if (commonJs) module.exports = api;
  else root.CollectorSession = api;
})(typeof globalThis === 'object' ? globalThis : this, function (links) {
  function videoKey(url) {
    try { return links.parseYouTubeUrl(url).videoId; } catch { return null; }
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function createDraftStore(initial = {}) {
    let drafts = {};
    const store = {
      replace(values) {
        drafts = {};
        if (!values || typeof values !== 'object' || Array.isArray(values)) return;
        for (const [id, draft] of Object.entries(values)) {
          if (!/^[A-Za-z0-9_-]{11}$/.test(id) || !draft || videoKey(draft.url) !== id || !Array.isArray(draft.markers)) continue;
          if (!draft.markers.every((m) => m && Number.isFinite(m.time) && m.time >= 0 && typeof m.formatted === 'string')) continue;
          drafts[id] = clone(draft);
        }
      },
      save(url, state, rows) {
        const id = videoKey(url);
        if (!id) return;
        const rowIndex = state.loadedRowIndex;
        if (!state.markers.length && rowIndex === -1) { delete drafts[id]; return; }
        drafts[id] = clone({ url, markers: state.markers, loadedRowIndex: rowIndex,
          loadedUrlIndex: state.loadedUrlIndex, currentRow: state.currentRow,
          rowFingerprint: rowIndex >= 0 ? JSON.stringify(rows[rowIndex]) : null });
      },
      restore(url, rows) {
        const draft = drafts[videoKey(url)];
        if (!draft) return null;
        const result = clone(draft);
        const index = result.loadedRowIndex;
        if (!Number.isInteger(index) || index < 0 || JSON.stringify(rows[index]) !== result.rowFingerprint ||
            !Number.isInteger(result.loadedUrlIndex) || result.loadedUrlIndex < -1 ||
            (result.loadedUrlIndex >= 0 && videoKey(rows[index]?.[result.loadedUrlIndex]) !== videoKey(url))) {
          result.loadedRowIndex = -1;
          result.loadedUrlIndex = -1;
        }
        return result;
      },
      forget(url) { delete drafts[videoKey(url)]; },
      serialize() { return clone(drafts); },
      hasDrafts() { return Object.keys(drafts).length > 0; },
    };
    store.replace(initial);
    return store;
  }
  return { videoKey, createDraftStore };
});
