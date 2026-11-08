const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const extract = require('extract-zip');

// Pin both the official release and its bytes; never execute an unverified update.
const RELEASE = Object.freeze({
  version: '1.75.0',
  url: 'https://github.com/gorhill/uBlock/releases/download/1.75.0/uBlock0_1.75.0.chromium.zip',
  sha256: '393cf95709d1074d4022970e9014e434395c53a822387f1e25f43be97cf4b582',
});

async function installRelease(directory, { fetchRelease = globalThis.fetch, archivePath } = {}) {
  const parent = path.dirname(directory);
  await fs.mkdir(parent, { recursive: true });
  const staging = await fs.mkdtemp(path.join(parent, '.ublock-install-'));
  const backup = path.join(staging, 'previous');
  let previous = false;
  let preserveBackup = false;
  try {
    let bytes;
    if (archivePath) {
      bytes = await fs.readFile(archivePath);
    } else {
      const response = await fetchRelease(RELEASE.url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`uBlock download failed: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== RELEASE.sha256) {
      throw new Error('uBlock download failed its SHA-256 check. Existing installation was kept.');
    }
    const archive = path.join(staging, 'release.zip');
    await fs.writeFile(archive, bytes);
    const unpacked = path.join(staging, 'unpacked');
    await extract(archive, { dir: unpacked });
    const source = path.join(unpacked, 'uBlock0.chromium');
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
    if (manifest.name !== 'uBlock Origin' || manifest.version !== RELEASE.version || manifest.manifest_version !== 2) {
      throw new Error('Unexpected uBlock release manifest.');
    }
    try { await fs.rename(directory, backup); previous = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(source, directory); }
    catch (error) {
      if (previous) {
        try { await fs.rename(backup, directory); }
        catch (restoreError) {
          preserveBackup = true;
          throw new Error(`Installation failed; previous files are preserved at ${backup}: ${restoreError.message}`);
        }
      }
      throw error;
    }
    return manifest.version;
  } finally {
    if (!preserveBackup) await fs.rm(staging, { recursive: true, force: true });
  }
}

module.exports = { RELEASE, installRelease };
