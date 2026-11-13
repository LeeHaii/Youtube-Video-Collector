const { BrowserWindow, webContents } = require('electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { installRelease } = require('./ublock-release');

// Healthy profiles measured 6-62 MB; a bloated one (1 GB) never finished starting.
const STORAGE_LIMIT = 200 * 1024 * 1024;

// The user's own uBlock data, read the way uBlock's backupUserData() does (small: no filter caches).
const BACKUP_JS = `(async () => {
  const b = self.µBlock;
  const stored = await new Promise(resolve => chrome.storage.local.get(
    ['dynamicFilteringString', 'urlFilteringString', 'hostnameSwitchesString'], resolve));
  return {
    userSettings: b.getModifiedSettings(b.userSettings, b.userSettingsDefault),
    hiddenSettings: b.getModifiedSettings(b.hiddenSettings, b.hiddenSettingsDefault),
    selectedFilterLists: b.selectedFilterLists,
    netWhitelist: b.arrayFromWhitelist(b.netWhitelist),
    userFilters: (await b.loadUserFilters()).content,
    ...stored,
  };
})()`;
const restoreJs = data => `(async d => {
  const b = self.µBlock;
  await new Promise(resolve => chrome.storage.local.set({
    ...d.userSettings,
    hiddenSettings: d.hiddenSettings || {},
    netWhitelist: d.netWhitelist || [],
    dynamicFilteringString: d.dynamicFilteringString || '',
    urlFilteringString: d.urlFilteringString || '',
    hostnameSwitchesString: d.hostnameSwitchesString || '',
  }, resolve));
  await b.saveUserFilters(d.userFilters || '');
  if (Array.isArray(d.selectedFilterLists)) await b.saveSelectedFilterLists(d.selectedFilterLists);
})(${JSON.stringify(data)})`;
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) =>
  setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);

class UBlockOrigin {
  constructor({ session, directory, bundledDirectory, userDataDirectory }) {
    this.session = session;
    this.directory = directory;
    this.bundledDirectory = bundledDirectory;
    this.userDataDirectory = userDataDirectory || path.resolve(directory, '..', '..');
    this.resetMarker = path.join(path.dirname(directory), 'ublock-reset-pending');
    this.backupFile = path.join(path.dirname(directory), 'ublock-user-data.json');
    this.extension = null;
    this.starting = false;
    this.ready = Promise.resolve();
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

  // Chromium's ID for an unpacked extension: SHA-256 of its path, first 16 bytes as a-p.
  getId() {
    const normalized = path.resolve(this.directory);
    const encoding = process.platform === 'win32' ? 'utf16le' : 'utf8';
    const hash = crypto.createHash('sha256').update(Buffer.from(normalized, encoding)).digest();
    return Array.from(hash.subarray(0, 16))
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
    return { installed: !!this.extension, starting: this.starting, version: this.extension?.version || '',
      busy: this.busy, error: this.error };
  }

  // Chromium keeps extension storage open until the app exits, so it can only be
  // deleted here, before the extension is loaded.
  async wipeStorageIfNeeded() {
    const id = this.getId();
    const settings = path.join(this.userDataDirectory, 'Local Extension Settings', id);
    const requested = fs.existsSync(this.resetMarker);
    let size = 0;
    for (const entry of await fs.promises.readdir(settings, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile()) size += (await fs.promises.stat(path.join(settings, entry.name))).size;
    }
    if (!requested && size < STORAGE_LIMIT) return false;
    console.warn(`uBlock Origin: wiping storage (${requested ? 'reset requested' : `${Math.round(size / 1048576)} MB`}).`);
    await fs.promises.rm(settings, { recursive: true, force: true });
    const indexedDb = path.join(this.userDataDirectory, 'IndexedDB');
    for (const entry of await fs.promises.readdir(indexedDb).catch(() => [])) {
      if (entry.startsWith(`chrome-extension_${id}_`)) {
        await fs.promises.rm(path.join(indexedDb, entry), { recursive: true, force: true });
      }
    }
    await fs.promises.rm(this.resetMarker, { force: true });
    return true;
  }

  background(extension) {
    return webContents.getAllWebContents().find(contents => !contents.isDestroyed() &&
      contents.getType() === 'backgroundPage' && contents.getURL() === `chrome-extension://${extension.id}/background.html`);
  }

  async load() {
    try {
      // Use a stable path so extension ID and settings survive packaged app upgrades.
      if (!fs.existsSync(path.join(this.directory, 'manifest.json')) &&
          this.bundledDirectory && fs.existsSync(path.join(this.bundledDirectory, 'manifest.json'))) {
        await fs.promises.mkdir(path.dirname(this.directory), { recursive: true });
        await fs.promises.cp(this.bundledDirectory, this.directory, { recursive: true });
      }
      if (!fs.existsSync(path.join(this.directory, 'manifest.json'))) return this.status();
      const wiped = await this.wipeStorageIfNeeded();
      const extension = await this.session.extensions.loadExtension(this.directory);
      this.extension = extension;
      this.error = '';
      this.starting = true;
      this.ready = this.startEngine(extension, wiped && fs.existsSync(this.backupFile));
      // A healthy engine is ready in a few seconds; don't hold the viewers longer than that.
      await Promise.race([this.ready, new Promise(resolve => setTimeout(resolve, 5000))]);
    } catch (error) {
      this.extension = null;
      this.starting = false;
      this.error = error.message;
      console.warn('uBlock Origin:', error.message);
    }
    return this.status();
  }

  async startEngine(extension, restore) {
    await this.waitUntilReady(extension);
    if (!restore || this.extension !== extension || this.error) return;
    try {
      const data = JSON.parse(await fs.promises.readFile(this.backupFile, 'utf8'));
      await withTimeout(this.background(extension).executeJavaScript(restoreJs(data)), 15000);
      // Restart uBlock so it starts from the restored settings, as its own restore does.
      this.session.extensions.removeExtension(extension.id);
      this.extension = null;
      const reloaded = await this.session.extensions.loadExtension(this.directory);
      this.extension = reloaded;
      this.starting = true;
      await this.waitUntilReady(reloaded);
      for (const id of this.viewers) webContents.fromId(id)?.reload();
      console.log('uBlock Origin: settings restored after storage wipe.');
    } catch (error) {
      this.starting = false;
      this.error = `Could not restore uBlock settings after a storage wipe: ${error.message}`;
      console.warn('uBlock Origin:', this.error);
    }
  }

  // Loading a manifest does not prove that the filtering engine initialized. The extension
  // stays loaded meanwhile: removing it mid-startup interrupts uBlock's cache writes.
  async waitUntilReady(extension) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && this.extension === extension) {
      const background = this.background(extension);
      // A background page can be replaced during startup; a stuck evaluation must not stall the loop.
      const ready = background && await Promise.race([
        background.executeJavaScript('self.µBlock?.readyToFilter === true').catch(() => false),
        new Promise(resolve => setTimeout(() => resolve(false), 1500)),
      ]);
      if (ready) { this.starting = false; return; }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (this.extension !== extension) return;
    this.starting = false;
    this.error = 'uBlock filtering engine is still not ready after 2 minutes. Try Reset uBlock storage in Settings.';
    console.warn('uBlock Origin:', this.error);
  }

  async requestReset() {
    await fs.promises.mkdir(path.dirname(this.resetMarker), { recursive: true });
    await fs.promises.writeFile(this.resetMarker, '');
  }

  async close() {
    if (!this.extension) return;
    try {
      const extensionId = this.extension.id;
      const background = this.background(this.extension);
      // Back up only a fully started engine, so a half-loaded state never overwrites good data.
      if (background && !this.starting && !this.error) {
        try {
          const data = await withTimeout(background.executeJavaScript(BACKUP_JS), 3000);
          await fs.promises.writeFile(`${this.backupFile}.tmp`, JSON.stringify(data));
          await fs.promises.rename(`${this.backupFile}.tmp`, this.backupFile);
        } catch (error) { console.warn('uBlock settings backup failed:', error.message); }
      }
      if (background) {
        await Promise.race([
          background.executeJavaScript('self.µBlock?.saveLocalSettings?.()').catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 500)),
        ]);
      }

      this.session.extensions.removeExtension(extensionId);
      this.extension = null;
      this.starting = false;
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
