(function (root, factory) {
  const commonJs = typeof window === 'undefined' && typeof module === 'object' && module.exports;
  const api = factory(commonJs ? require('./collector-link') : root.CollectorLink);
  if (commonJs) module.exports = api;
  else root.CollectorRouter = api;
})(typeof globalThis === 'object' ? globalThis : this, function (links) {
  const HOST = 'com.rhymx.collector';
  const TTL = 90000;

  function createRouter(api, options = {}) {
    const uuid = options.uuid || (() => crypto.randomUUID());
    const now = options.now || Date.now;
    let sheets = {};
    let pending = {};
    let enabled = true;
    let sequence = Promise.resolve();
    const inFlight = new Map();
    const ready = (async () => {
      const local = await api.storage.local.get('enabled');
      enabled = local.enabled !== false;
      const saved = await api.storage.session.get(['sheets', 'pending']);
      sheets = saved.sheets || {};
      pending = saved.pending || {};
      const tabs = await api.tabs.query({ url: 'https://docs.google.com/spreadsheets/*' });
      for (const tab of tabs) if (links.isSheetUrl(tab.url)) sheets[tab.id] = tab.url;
      for (const [id, entry] of Object.entries(pending)) if (now() - entry.createdAt > TTL) delete pending[id];
    })();

    function enqueue(action) {
      const operation = sequence.then(() => ready).then(action);
      sequence = operation.catch((error) => report('error', error.message));
      return operation;
    }
    async function persist() { await api.storage.session.set({ sheets, pending }); }
    async function report(state, message, url = '') {
      await api.storage.local.set({ lastStatus: { state, message, url, at: now() } });
      await api.action.setBadgeText({ text: state === 'error' ? '!' : '' });
      if (state === 'error') await api.action.setBadgeBackgroundColor({ color: '#b32635' });
    }
    function entry(sourceTabId, sourceUrl, owned) {
      return { sourceTabId, sourceUrl, owned, createdAt: now(), requestId: uuid(), video: null, latestUrl: '', sent: false };
    }

    async function finish(tabId, tracked, response) {
      inFlight.delete(tracked.requestId);
      if (pending[tabId]?.requestId !== tracked.requestId) return;
      delete pending[tabId];
      await persist();
      if (response?.version !== 1 || response.requestId !== tracked.requestId || response.status !== 'accepted') {
        await report('error', response?.message || 'Collector could not accept this link', tracked.video.url);
        return;
      }
      await report('accepted', 'Opened in collector', tracked.video.url);
      let target;
      try { target = await api.tabs.get(Number(tabId)); } catch { return; }
      const current = links.destination(target.pendingUrl || target.url);
      if (!current || current.url !== tracked.video.url) return;
      if (tracked.owned) {
        await api.tabs.remove(Number(tabId));
        try {
          const source = await api.tabs.get(tracked.sourceTabId);
          if (source.url === tracked.sourceUrl) await api.tabs.update(source.id, { active: true });
        } catch {}
      } else {
        await api.tabs.update(Number(tabId), { url: tracked.sourceUrl });
      }
    }

    async function submit(tabId, tracked) {
      if (!enabled || !tracked.video || inFlight.has(tracked.requestId)) return;
      tracked.sent = true;
      await persist();
      await report('opening', 'Opening in collector', tracked.video.url);
      // Keep navigation events responsive while the app is starting.
      const delivery = api.runtime.sendNativeMessage(HOST, {
        version: 1, type: 'open-video', requestId: tracked.requestId, url: tracked.video.url,
      });
      inFlight.set(tracked.requestId, delivery);
      delivery.then((response) => enqueue(() => finish(tabId, tracked, response)),
        (error) => enqueue(() => finish(tabId, tracked, { message: error.message })));
    }

    async function updateDestination(tabId, url, allowSend) {
      const tracked = pending[tabId];
      if (!tracked) return;
      if (now() - tracked.createdAt > TTL) { delete pending[tabId]; await persist(); return; }
      const video = links.destination(url);
      if (!video) {
        if (url === 'about:blank' && !tracked.sent) return;
        delete pending[tabId];
        await persist();
        return;
      }
      if (tracked.video && video.url !== tracked.video.url) {
        delete pending[tabId];
        await persist();
        return;
      }
      tracked.latestUrl = url;
      tracked.video = video;
      if (allowSend) await submit(tabId, tracked);
      else await persist();
    }

    const router = {
      ready,
      created(details) {
        return enqueue(async () => {
          if (!enabled || details.sourceTabId === details.tabId) return;
          let source;
          try { source = await api.tabs.get(details.sourceTabId); } catch { return; }
          const sourceUrl = source.url || sheets[details.sourceTabId];
          if (!links.isSheetUrl(sourceUrl) || !links.destination(details.url)) return;
          if (!pending[details.tabId]) pending[details.tabId] = entry(details.sourceTabId, sourceUrl, true);
          await updateDestination(details.tabId, details.url, true);
        });
      },
      before(details) {
        return enqueue(async () => {
          if (details.frameId !== 0 || !enabled) return;
          if (!pending[details.tabId] && sheets[details.tabId] && links.destination(details.url)) {
            pending[details.tabId] = entry(details.tabId, sheets[details.tabId], false);
          }
          await updateDestination(details.tabId, details.url, pending[details.tabId]?.owned === true);
        });
      },
      committed(details) {
        return enqueue(async () => {
          if (details.frameId !== 0) return;
          if (links.isSheetUrl(details.url)) {
            sheets[details.tabId] = details.url;
            await persist();
            return;
          }
          const tracked = pending[details.tabId];
          delete sheets[details.tabId];
          if (tracked && !tracked.owned &&
              (details.transitionType !== 'link' || details.transitionQualifiers?.some((q) => ['forward_back', 'from_address_bar'].includes(q)))) {
            delete pending[details.tabId];
          }
          if (enabled) await updateDestination(details.tabId, details.url, true);
          await persist();
        });
      },
      removed(tabId) {
        return enqueue(async () => { delete sheets[tabId]; delete pending[tabId]; await persist(); });
      },
      setEnabled(value) {
        return enqueue(async () => {
          enabled = value !== false;
          if (!enabled) pending = {};
          await api.storage.local.set({ enabled });
          await persist();
        });
      },
      resume() {
        return enqueue(async () => {
          if (!enabled) return;
          for (const [id, tracked] of Object.entries(pending)) {
            if (!tracked.video) continue;
            // Same-tab candidates are not link activations until committed.
            if (!tracked.owned && !tracked.sent) continue;
            try {
              const tab = await api.tabs.get(Number(id));
              if (links.destination(tab.pendingUrl || tab.url)?.url !== tracked.video.url) { delete pending[id]; continue; }
              await submit(id, tracked);
            } catch { delete pending[id]; }
          }
          await persist();
        });
      },
      async checkConnection() {
        await ready;
        const requestId = uuid();
        try {
          const result = await api.runtime.sendNativeMessage(HOST, { version: 1, type: 'ping', requestId });
          if (result?.version !== 1 || result.requestId !== requestId || !['connected', 'installed'].includes(result.status)) {
            throw new Error(result?.message || 'Collector connection failed');
          }
          await report(result.status, result.ready ? 'Collector connected' : 'Collector installed; app is closed');
          return result;
        } catch (error) {
          await report('error', error.message);
          return { status: 'error', message: error.message };
        }
      },
      flush() { return sequence; },
    };
    return router;
  }
  return { createRouter, HOST };
});
