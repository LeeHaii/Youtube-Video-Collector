// Run with: node tools/test-ublock-restore.js
// Checks that the user's uBlock settings survive a storage wipe. Each phase is its own Electron
// process: Chromium keeps extension storage open until exit, so the wipe needs a fresh one.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runtime = path.resolve(__dirname, '../.runtime');

if (!process.versions.electron) {
  const { execFileSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(runtime, 'ublock-restore-'));
  for (const phase of ['save', 'restore']) {
    execFileSync(require('electron'), [__filename, phase, profile], { stdio: ['ignore', 'inherit', 'ignore'] });
  }
  console.log('PASS: uBlock whitelist and custom filters survive a storage wipe');
  return;
}

const { app, session } = require('electron');
const { UBlockOrigin } = require('../src/ublock-origin');
const [phase, profile] = process.argv.slice(-2);
app.setPath('userData', profile);

app.whenReady().then(async () => {
  try {
    const ublock = new UBlockOrigin({ session: session.defaultSession, directory: path.join(profile, 'extension'),
      bundledDirectory: path.join(runtime, 'ublock-origin'), userDataDirectory: profile });
    if (phase === 'restore') await ublock.requestReset();
    await ublock.load();
    await ublock.ready;
    assert.equal(ublock.error, '');
    const background = ublock.background(ublock.extension);
    if (phase === 'save') {
      await background.executeJavaScript(`(async () => { const b = self.µBlock;
        await b.saveUserFilters('example.com##.restore-check');
        b.netWhitelist = b.whitelistFromArray(['restore-check.example']); b.saveWhitelist(); })()`);
    } else {
      const got = await background.executeJavaScript(`(async () => { const b = self.µBlock;
        return { filters: (await b.loadUserFilters()).content, whitelist: b.arrayFromWhitelist(b.netWhitelist) }; })()`);
      assert.deepEqual(got, { filters: 'example.com##.restore-check', whitelist: ['restore-check.example'] });
    }
    await ublock.close(); // writes the backup the restore phase reads
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
