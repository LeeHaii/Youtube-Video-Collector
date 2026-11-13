(() => {
  const status = document.querySelector('#ublock-status');
  const install = document.querySelector('#ublock-install-btn');
  const dashboard = document.querySelector('#ublock-settings-btn');
  const reset = document.querySelector('#ublock-reset-btn');
  const controls = [...document.querySelectorAll('[data-ublock-viewer]')];

  function render(state) {
    status.textContent = state.busy ? (state.message || 'Working on uBlock Origin…')
      : state.starting ? `uBlock Origin ${state.version} is starting (loading filter lists)…`
      : state.error ? `uBlock Origin unavailable: ${state.error}`
      : state.installed ? `uBlock Origin ${state.version} loaded. Use its controls to manage blocking for YouTube.`
      : 'uBlock Origin is not installed.';
    install.disabled = state.busy || state.installed;
    install.textContent = state.installed ? 'Installed' : 'Install uBlock Origin';
    dashboard.disabled = !state.installed || state.busy;
    if (reset) {
      reset.disabled = state.busy || (!state.installed && !state.error);
    }
    for (const button of controls) button.disabled = !state.installed || state.busy;
  }

  // The engine keeps starting in the background after the first status arrives.
  async function follow(state) {
    render(state);
    while (state.starting) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      state = await window.electronAPI.getUBlockStatus();
      render(state);
    }
  }

  install.addEventListener('click', async () => {
    render({ busy: true, message: 'Installing uBlock Origin…' });
    try { await follow(await window.electronAPI.installUBlock()); }
    catch (error) { render({ error: error.message }); }
  });
  if (reset) {
    reset.addEventListener('click', async () => {
      if (!confirm('Reset restarts the app and rebuilds uBlock\'s cache (your whitelist and custom filters are kept). ' +
        'Unsaved collected rows will be lost. Continue?')) return;
      render({ busy: true, message: 'Restarting to reset uBlock storage…' });
      try { render(await window.electronAPI.resetUBlock()); }
      catch (error) { render({ error: error.message }); }
    });
  }
  dashboard.addEventListener('click', async () => {
    const result = await window.electronAPI.openUBlock();
    if (result.error) status.textContent = result.error;
  });
  for (const button of controls) {
    button.addEventListener('click', async () => {
      const viewer = document.getElementById(button.dataset.ublockViewer);
      const result = await window.electronAPI.openUBlock(viewer.getWebContentsId());
      if (result.error) status.textContent = result.error;
    });
  }
  (async () => {
    let state;
    try { state = await window.electronAPI.getUBlockStatus(); render(state); }
    catch (error) { render({ error: error.message }); }
    // The first status arrives once the extension is loaded (at most ~5s after startup).
    // Preserve any navigation already requested.
    for (const id of ['youtube-webview', 'trimmer-webview']) {
      const viewer = document.getElementById(id);
      if (viewer.getAttribute('src') === 'about:blank') viewer.src = 'https://www.youtube.com';
    }
    if (state) await follow(state).catch(error => render({ error: error.message }));
  })();
})();
