// Run with: electron tools/test-ublock-electron.js
// Uses a disposable profile and a local server, never the user's YouTube session.
const { app, BrowserWindow, session, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { UBlockOrigin } = require('../src/ublock-origin');

const runtime = path.resolve(__dirname, '../.runtime');
fs.mkdirSync(runtime, { recursive: true });
const profile = fs.mkdtempSync(path.join(runtime, 'ublock-smoke-'));
app.setPath('userData', profile);
let server;
const report = { versions: { electron: process.versions.electron, chromium: process.versions.chrome }, checks: [] };
const deadline = setTimeout(() => finish(new Error('uBlock smoke test timed out')), process.argv.includes('--youtube') ? 100000 : 60000);

function finish(error) {
  clearTimeout(deadline);
  if (error) report.error = error.stack;
  fs.writeFileSync(path.join(runtime, 'ublock-smoke-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  server?.close();
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  try {
    const ublock = new UBlockOrigin({ session: session.defaultSession,
      directory: path.join(profile, 'extension'), bundledDirectory: path.join(runtime, 'ublock-origin') });
    const parent = new BrowserWindow({ show: false, webPreferences: {
      webviewTag: true, nodeIntegration: true, contextIsolation: true } });
    const status = await ublock.load();
    assert.equal(status.installed, true, status.error);
    report.checks.push(`Official uBlock Origin ${status.version} filtering engine initialized`);
    const background = webContents.getAllWebContents().find(wc => wc.getType() === 'backgroundPage');
    await background.executeJavaScript(`self.µBlock.appendUserFilters('/ublock-blocked.js$script\\n127.0.0.1##.ad-fixture')`);

    const requests = [];
    server = http.createServer((req, res) => {
      requests.push(req.url);
      if (req.url.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(req.url === '/ublock-blocked.js' ? 'window.blockedExecuted = true' : 'window.allowedExecuted = true');
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end('<div class="ad-fixture">advertisement</div><script src="/ublock-blocked.js"></script><script src="/allowed.js"></script>');
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const viewers = [];
    parent.webContents.on('did-attach-webview', (_event, guest) => {
      ublock.attachViewer(guest, parent);
      viewers.push(guest);
    });
    await parent.loadURL('data:text/html,<webview src="about:blank"></webview><webview src="about:blank"></webview>');
    const waitUntil = async (predicate) => {
      for (let i = 0; i < 80; i++) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Timed out waiting for viewer state');
    };
    await waitUntil(() => viewers.length === 2);
    const url = `http://127.0.0.1:${server.address().port}/`;
    for (const guest of viewers) {
      await guest.loadURL(url);
      await waitUntil(() => guest.executeJavaScript(`getComputedStyle(document.querySelector('.ad-fixture')).display === 'none'`));
      assert.deepEqual(await guest.executeJavaScript('({blocked:!!window.blockedExecuted,allowed:!!window.allowedExecuted})'),
        { blocked: false, allowed: true });
    }
    assert.equal(requests.includes('/ublock-blocked.js'), false);
    report.checks.push('Both viewers block network requests, hide cosmetic fixtures, and allow ordinary scripts');

    // Keep extension controls hidden during the automated test.
    const extensionWindows = [];
    ublock.createExtensionWindow = () => {
      const window = new BrowserWindow({ show: false, webPreferences: {
        session: session.defaultSession, sandbox: false, nodeIntegration: false, contextIsolation: true } });
      extensionWindows.push(window);
      return window;
    };
    await ublock.open(parent, viewers[0].id);
    const popup = extensionWindows.at(-1);
    await waitUntil(() => popup.webContents.executeJavaScript(`document.body.textContent.includes('127.0.0.1')`));
    await popup.webContents.executeJavaScript(`document.querySelector('#switch').click()`);
    await new Promise(resolve => setTimeout(resolve, 300));
    await viewers[0].loadURL(url + 'unblocked');
    assert.equal(await viewers[0].executeJavaScript('!!window.blockedExecuted'), true);
    report.checks.push('uBlock popup targets the viewer and its power switch disables blocking');
    await ublock.open(parent);
    const dashboard = extensionWindows.at(-1);
    await waitUntil(() => dashboard.webContents.executeJavaScript(`!!self.vAPI && !!document.querySelector('iframe')`));
    report.checks.push('uBlock dashboard opens with its extension APIs');
    if (process.argv.includes('--youtube')) {
      // A live playback check complements the deterministic local ad fixtures.
      const viewer = viewers[1];
      await viewer.loadURL('https://www.youtube.com/watch?v=jNQXAC9IVRw');
      for (let attempt = 0; attempt < 40; attempt++) {
        report.youtube = await viewer.executeJavaScript(`(() => {
          const video = document.querySelector('video');
          video?.play().catch(() => {});
          return { title:document.title, readyState:video?.readyState, time:video?.currentTime,
            paused:video?.paused, mediaError:video?.error?.message,
            playerError:document.querySelector('.ytp-error-content-wrap')?.innerText || '',
            adShowing:!!document.querySelector('.ad-showing') };
        })()`);
        if (report.youtube.readyState >= 2 && report.youtube.time > 0 && !report.youtube.paused) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (report.youtube.readyState >= 2 && report.youtube.time > 0 && !report.youtube.paused) {
        report.checks.push('Live YouTube video plays with uBlock loaded');
      } else { report.youtube.limitation = 'Live playback could not be confirmed from this test environment'; }
    }
    finish();
  } catch (error) { finish(error); }
});
