(() => {
  const status = document.querySelector('#ublock-status');
  const install = document.querySelector('#ublock-install-btn');
  const dashboard = document.querySelector('#ublock-settings-btn');
  const controls = [...document.querySelectorAll('[data-ublock-viewer]')];

  function render(state) {
    status.textContent = state.busy ? 'Installing uBlock Origin…' : state.installed
      ? `uBlock Origin ${state.version} loaded. Use its controls to manage blocking for YouTube.`
      : state.error ? `uBlock Origin unavailable: ${state.error}` : 'uBlock Origin is not installed.';
    install.disabled = state.busy || state.installed;
    install.textContent = state.installed ? 'Installed' : 'Install uBlock Origin';
    dashboard.disabled = !state.installed || state.busy;
    for (const button of controls) button.disabled = !state.installed || state.busy;
  }

  install.addEventListener('click', async () => {
    render({ busy: true });
    try { render(await window.electronAPI.installUBlock()); }
    catch (error) { render({ error: error.message }); }
  });
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
  window.electronAPI.getUBlockStatus().then(render).catch(error => render({ error: error.message })).finally(() => {
    // Wait for extension startup before the first remote requests. Keep the
    // application responsive, and preserve any navigation already requested.
    for (const id of ['youtube-webview', 'trimmer-webview']) {
      const viewer = document.getElementById(id);
      if (viewer.getAttribute('src') === 'about:blank') viewer.src = 'https://www.youtube.com';
    }
  });
})();
