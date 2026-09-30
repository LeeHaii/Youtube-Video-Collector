# Collector Links Pilot

## Install

1. Install the updated Rhymx collector and launch it once. This registers the
   bundled Windows helper for the current user.
2. In Google Chrome, open `chrome://extensions` and enable Developer mode.
   In Microsoft Edge, use `edge://extensions` instead.
3. Click **Load unpacked** and select this `extension` directory (the directory
   containing `manifest.json`). If using the pilot ZIP, extract it first.
4. Pin **Rhymx Collector Links**, open its popup, and click the connection icon.
5. Activate a YouTube hyperlink in Google Sheets. The collector opens the video
   at the timestamp in its URL. A temporary YouTube tab closes after delivery.

The pilot extension ID is `mfnhdejejkjojpjjebfjbgahbdgajbcc`. Keep the manifest's
public key so the ID remains stable when the directory is moved or reloaded.

The popup toggle pauses forwarding. Ordinary YouTube browsing is unaffected.
Google Sheets still displays its normal hyperlink popup when selecting a cell.

## Supported Links

- HTTPS `youtube.com/watch?v=...` links on the main, `www`, or mobile hostname.
- HTTPS `youtu.be/...` share links.
- `t=118s`, `t=118`, `t=1m58s`, `start=118`, or `#t=118` timestamps.
- Missing timestamps start at zero. Fractional timestamps use whole seconds.
- Google redirect links through `google.com/url` or `www.google.com/url`.

YouTube Shorts are excluded because the collector currently blocks Shorts.
This pilot targets Windows with Chrome or Edge. Store distribution is follow-up
release work.
Desktop Excel link clicks are outside this browser extension's scope.

## Privacy and Security

The extension forwards only the activated YouTube URL to the local collector.
It does not read spreadsheet cells or upload sheet contents. The Windows helper
accepts only registered extension origins and authenticates its per-user named
pipe requests with a private local token. There is no listening HTTP server.

## Connection Problems

If Chrome reports that the native host was not found, launch the updated collector
once under the same Windows account used for Chrome, then check the connection
again. An older collector installation does not include the helper.

Bridge files are stored in `%LOCALAPPDATA%\RhymxCollector\bridge`. The host is
registered under
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.rhymx.collector`.
Edge has a separate registration under
`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.rhymx.collector`.
Opening a link can start a closed collector; checking the connection does not
start the app. Failed delivery leaves the YouTube browser tab available.

An earlier pilot applied directory-only ACL flags recursively to the two bridge
files, leaving their access rules empty. The corrected app repairs these before
registering. Both files remain restricted to the current Windows user. If an
earlier installation reports "host not found", install the corrected build and
launch it once; the existing extension does not need to be reinstalled.

If YouTube fails after delivery, the collector displays an error and retains your
collection drafts. Ads can delay seeking. Protected or unavailable videos still
require normal YouTube access in the collector's separate browser session.

## Development

Build just the helper from the application directory:

```powershell
node build-executables.js --collector-only
```

Generate the extension PNG icons and run focused tests:

```powershell
node tools/build-collector-assets.js
node --test tests/test_collector_*.js
python -m unittest discover -s tests -p test_collector_native_host.py
```

Then launch the app with `npm start` and load the unpacked extension. Development
registration launches Electron with the correct application entry directory.

Build an installer in a separate output directory:

```powershell
node tools/make-collector-release.js
```

The existing `npm run make` workflow also includes the new helper after
`npm run build-exe`. Do not build the helper with PyInstaller's windowed mode:
native messaging needs binary stdin and stdout. App subprocess output is detached
from those protocol streams.

## Store Release

The unpacked pilot is ready for development and a small client trial. For a store
release, obtain the store extension ID and register it with the installed app:

```powershell
& 'C:\path\to\Rhymx collector.exe' --collector-extension-id=YOUR_STORE_EXTENSION_ID
```

Extra registered IDs survive app updates. Configure the production ID in
`native-host-registration.js` before distributing to clients so they do not need
this command. Update the app version before publishing a Squirrel update.

Store submission and publication are not part of the pilot build.

## Pilot Verification

After loading the extension, verify these in Chrome with your actual sheet:

1. With the app closed, activate a timestamped link and confirm the app starts at
   that second. With the app running, repeat with another video and then a
   different timestamp in the same video.
2. Add unsaved markers before switching videos, then return to the original
   video and confirm the markers remain. Repeat while editing an existing row.
3. Pause forwarding in the popup and confirm links open normally in Chrome.
4. Check a restricted/unavailable video and confirm the app reports its loading
   or seeking failure without losing collection data.

The automated suite covers routing, worker recovery, URL validation, framing,
authenticated Windows pipes, the compiled helper, and renderer draft handling.
Loading the extension and real YouTube playback still require this manual pilot
check; an accepted delivery is not a guarantee of successful playback.
