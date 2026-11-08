# uBlock Origin in the YouTube viewers

The Collector and Trimmer can run the **official, unmodified uBlock Origin
Chromium extension**. This replaces the disabled Cliqz adblocker integration.
`electron-chrome-extensions` supplies the browser APIs missing from Electron.
Both viewers keep using the existing persistent default session and login cookies.

## Install from the app

Open **Setting → YouTube ad blocking → Install uBlock Origin**. The app downloads
the pinned official GitHub release, checks its SHA-256 digest, and installs it
under the app's user-data directory in `extensions/ublock-origin`. On success,
both viewers reload with blocking enabled. A download failure leaves any existing
installation intact and displays an error in Settings.

Use **uBlock** beside the Collector navigation buttons, or **uBlock Origin
controls** above the Trimmer preview, to open uBlock's actual per-site popup.
Its power button controls blocking for YouTube. **uBlock settings** opens the
extension's dashboard, filter lists, and custom filters.

## Development and packaging

```powershell
cd youtube-video-collecting
npm install
npm run setup:ublock
npm start
```

`setup:ublock` stages the verified release in `.runtime/ublock-origin`. Forge
copies this folder outside `app.asar` into the packaged app's resources, since
Chromium requires an unpacked extension directory. If it is not staged, users
can install through Settings instead. A user-installed copy takes precedence
over the bundled copy. Bundled files are copied into the same stable user-data
location on first launch, preserving the extension ID across app upgrades.
The extension reloads automatically on every app launch;
its storage and settings persist in the same Electron session.

The extension binary is pinned to **1.75.0** in `src/ublock-release.js`.
Filter lists update through uBlock's own updater; the extension binary does not
auto-update. To upgrade it, update the release URL, version, and verified SHA-256
together, rerun setup, and repeat the Electron smoke test.

```powershell
npm run test:ublock
.\node_modules\electron\dist\electron.exe tools/test-ublock-electron.js
```

The integration test uses a disposable profile and local server. It checks real
network cancellation and cosmetic filtering in two webviews, allowed requests,
the per-site power button, and dashboard access. Its report is written to
`.runtime/ublock-smoke-result.json`. It does not prove that every live YouTube ad
format is blocked; verify real playback, seeking, markers, and Trimmer behavior
before publishing a build. YouTube behavior and filter rules can change.

Do not also register an Electron `session.webRequest` ad blocker: Electron's
handlers take precedence over extension `chrome.webRequest` handlers.

## Third-party licenses

- [uBlock Origin](https://github.com/gorhill/uBlock): GPL-3.0-or-later; its
  unmodified release includes its license and upstream notices.
- [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell/tree/master/packages/electron-chrome-extensions):
  dual licensed under GPL-3.0 or the author's Patron license. This integration
  selects `GPL-3.0`; see the dependency's `LICENSE.md`, `LICENSE-GPL`, and
  `LICENSE-PATRON.md` for distribution terms.

The project's MIT notice does not replace these third-party licenses. Preserve
their notices and review the selected distribution terms before releasing a build.
