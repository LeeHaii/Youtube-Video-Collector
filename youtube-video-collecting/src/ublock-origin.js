const { BrowserWindow, webContents } = require('electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { installRelease } = require('./ublock-release');

class UBlockOrigin {
  constructor({ session, directory, bundledDirectory, userDataDirectory }) {
    this.session = session;
    this.directory = directory;
    this.bundledDirectory = bundledDirectory;
    this.userDataDirectory = userDataDirectory || path.resolve(directory, '..', '..');
    this.extension = null;
    this.busy = false;
    this.error = '';
    this.viewers = new Set();
    this.extensions = new ElectronChromeExtensions({
      session,
      license: 'GPL-3.0',
      createTab: async ({ url }) => {
        const window = this.createExtensionWindow();
        this.extensions.addTab(window.webContents, window);
        if (url) await window.loadURL(url);
        return [window.webContents, window];
      },
      selectTab: (_tab, window) => window.show(),
      removeTab: (tab, window) => {
        // Extension-created windows may close themselves; collector viewers may not.
        if (!this.viewers.has(tab.id)) window.close();
      },
    });
  }

  getId() {
    if (this.extension?.id) return this.extension.id;
    try {
      const existing = this.session?.extensions?.getAllExtensions?.()
        ?.find(e => e.path === path.resolve(this.directory) || e.name === 'uBlock Origin');
      if (existing?.id) return existing.id;
    } catch {}
    const normalized = path.resolve(this.directory);
    const encoding = process.platform === 'win32' ? 'utf16le' : 'utf8';
    const hash = crypto.createHash('sha256').update(Buffer.from(normalized, encoding)).digest();
    return Array.from(hash.slice(0, 16))
      .map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 0x0f)))
      .join('');
  }

  createExtensionWindow(parent, popup = false) {
    const window = new BrowserWindow({
      parent, width: popup ? 480 : 1100, height: popup ? 700 : 800,
      title: 'uBlock Origin', autoHideMenuBar: true,
      webPreferences: { session: this.session, nodeIntegration: false, contextIsolation: true, sandbox: false },
    });
    // No app preload or Node access is exposed to extension pages.
    return window;
  }

  attachViewer(guest, parent) {
    if (guest.session !== this.session) return;
    this.viewers.add(guest.id);
    this.extensions.addTab(guest, parent);
    guest.on('focus', () => this.extensions.selectTab(guest));
    guest.once('destroyed', () => this.viewers.delete(guest.id));
  }

  status() {
    return { installed: !!this.extension, version: this.extension?.version || '', busy: this.busy, error: this.error };
  }

  async load() {
    let extension;
    try {
      // Use a stable path so extension ID and settings survive packaged app upgrades.
      if (!fs.existsSync(path.join(this.directory, 'manifest.json')) &&
          this.bundledDirectory && fs.existsSync(path.join(this.bundledDirectory, 'manifest.json'))) {
        await fs.promises.mkdir(path.dirname(this.directory), { recursive: true });
        await fs.promises.cp(this.bundledDirectory, this.directory, { recursive: true });
      }
      if (!fs.existsSync(path.join(this.directory, 'manifest.json'))) return this.status();
      extension = await this.session.extensions.loadExtension(this.directory);
      // Loading a manifest does not prove that the filtering engine initialized.
      const deadline = Date.now() + 35000;
      while (Date.now() < deadline) {
        const background = webContents.getAllWebContents().find(contents =>
          contents.getType() === 'backgroundPage' && contents.getURL() === `chrome-extension://${extension.id}/background.html`);
        // A background page can be replaced during startup; its pending evaluation
        // must not hold the entire application open indefinitely.
        const ready = background && await Promise.race([
          background.executeJavaScript('self.µBlock?.readyToFilter === true').catch(() => false),
          new Promise(resolve => setTimeout(() => resolve(false), 1500)),
        ]);
        if (ready) { this.extension = extension; this.error = ''; return this.status(); }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      throw new Error('uBlock filtering engine did not initialize within 35 seconds.');
    } catch (error) {
      if (extension) this.session.extensions.removeExtension(extension.id);
      this.extension = null;
      this.error = error.message;
      console.warn('uBlock Origin:', error.message);
      return this.status();
    }
  }

  async reset() {
    if (this.busy) return this.status();
    this.busy = true;
    this.error = '';
    try {
      if (this.extension) {
        try { this.session.extensions.removeExtension(this.extension.id); } catch {}
        this.extension = null;
      }
      const id = this.getId();
      const userData = this.userDataDirectory || path.resolve(this.directory, '..', '..');

      // 1. Clear LevelDB Local Extension Settings
      const localSettingsDir = path.join(userData, 'Local Extension Settings', id);
      try {
        await fs.promises.rm(localSettingsDir, { recursive: true, force: true });
      } catch (err) {
        if (err.code !== 'ENOENT') console.warn('Could not remove extension storage:', err.message);
      }

      // 2. Clear Session storage data (IndexedDB, CacheStorage, ServiceWorkers)
      if (this.session?.clearStorageData) {
        try {
          await this.session.clearStorageData({
            origin: `chrome-extension://${id}`,
            storages: ['indexdb', 'cachestorage', 'serviceworkers'],
          });
        } catch (err) {
          console.warn('Could not clear extension session storage:', err.message);
        }
      }

      // 3. Clear IndexedDB directories on disk if any linger
      const idbDir = path.join(userData, 'IndexedDB');
      try {
        const entries = await fs.promises.readdir(idbDir).catch(() => []);
        for (const entry of entries) {
          if (entry.includes(id)) {
            await fs.promises.rm(path.join(idbDir, entry), { recursive: true, force: true }).catch(() => {});
          }
        }
      } catch {}

      // 4. Reload extension
      await this.load();
      if (this.extension) {
        for (const viewerId of this.viewers) webContents.fromId(viewerId)?.reload();
      }
    } catch (err) {
      this.error = err.message;
    } finally {
      this.busy = false;
    }
    return this.status();
  }

  async close() {
    if (!this.extension) return;
    try {
      const extensionId = this.extension.id;
      const background = webContents.getAllWebContents().find(contents =>
        contents.getType() === 'backgroundPage' && contents.getURL() === `chrome-extension://${extensionId}/background.html`);

      if (background && !background.isDestroyed()) {
        await Promise.race([
          background.executeJavaScript('self.µBlock?.saveLocalSettings?.()').catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 500)),
        ]);
      }

      this.session.extensions.removeExtension(extensionId);
      this.extension = null;
    } catch (err) {
      console.warn('uBlock clean shutdown warning:', err.message);
    }
  }

  async install() {
    if (this.busy) return this.status();
    if (this.extension) return this.status();
    this.busy = true;
    this.error = '';
    try {
      await installRelease(this.directory);
      await this.load();
      if (this.extension) {
        for (const id of this.viewers) webContents.fromId(id)?.reload();
      }
    } catch (error) { this.error = error.message; }
    finally { this.busy = false; }
    return this.status();
  }

  async open(parent, viewerId) {
    if (!this.extension) throw new Error(this.error || 'Install uBlock Origin in Settings first.');
    const popup = Number.isInteger(viewerId) && this.viewers.has(viewerId);
    if (popup) this.extensions.selectTab(webContents.fromId(viewerId));
    const page = popup ? `popup-fenix.html?tabId=${viewerId}` : 'dashboard.html';
    const window = this.createExtensionWindow(parent, popup);
    await window.loadURL(`chrome-extension://${this.extension.id}/${page}`);
  }
}

module.exports = { UBlockOrigin };
