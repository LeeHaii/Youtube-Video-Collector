# PyInstaller + Electron Forge Build Guide

This guide explains how to compile your Python scripts into standalone executables and bundle them with your Electron app.

## Overview

Instead of shipping Python scripts and requiring users to have Python installed, you'll compile your Python files into standalone `.exe` executables using **PyInstaller**. These executables are then bundled into your app distribution by Electron Forge.

**Benefits:**
- ✅ Users don't need Python installed
- ✅ Self-contained app distribution
- ✅ Better performance (compiled binaries)
- ✅ Easier to debug and test

---

## Prerequisites

Before you start, make sure you have:

For downloader runtime verification, install a full FFmpeg distribution with
`ffmpeg` and `ffprobe` (preferably from the same build), the `libx264` and AAC
encoders, and the `zscale`, `tonemap`, and `sidedata` filters. Keep ffprobe beside
ffmpeg or on PATH. These remain external runtime prerequisites; PyInstaller
bundles the Python dependencies, including EJS.

```bash
# Python 3.10+ installed (3.12 tested)
python --version

# Node.js and npm installed
node --version
npm --version
```

---

## Step 1: Install the pinned Python build dependencies

Install from the requirements file so the executables contain the tested yt-dlp,
EJS challenge solver, and PyInstaller versions:

```bash
python -m pip install -r tools/requirements.txt --upgrade
```

Verify installation:

```bash
pyinstaller --version
```

---

## Step 2: Build Python Executables

Run the build script to compile all your Python scripts into `.exe` files:

```bash
npm run build-exe
```

This will:
1. ✅ Compile all 7 Python scripts into standalone executables
2. ✅ Place them in the `dist/` directory
3. ✅ Bundle all dependencies, including the pinned yt-dlp and yt-dlp-ejs solver

**Output:**
```
dist/
├── 5_sec_downloader.exe
├── auto_add_effect.exe
├── auto_add_title.exe
├── capcut_auto_render.exe
├── collector_native_host.exe
├── suffle_capcu_track.exe
└── youtube_trimmer.exe
```

To rebuild only the browser bridge, run `node build-executables.js --collector-only`.
The native helper must retain console-mode binary stdin/stdout for Chrome's
native messaging protocol; do not compile it with `--windowed`. See
[Collector Links setup](extension/README.md) for the Windows/Chrome pilot.

### Troubleshooting PyInstaller

If you get `pyinstaller: command not found`:
- **Windows:** Restart your terminal or PowerShell after installing PyInstaller
- **Alternative:** Run as `python -m PyInstaller` instead of `pyinstaller`

If compilation fails with missing dependencies, reinstall the pinned build environment:
```bash
python -m pip install -r tools/requirements.txt --upgrade
```

---

## Step 3: Verify Executables Before Distribution

You can test an executable directly:

```bash
# Windows
dist/5_sec_downloader.exe --help

# Or run it with arguments
dist/5_sec_downloader.exe input.csv output_folder 3 5 2 5

# Require 1080p and compare sources up to 4K
dist/5_sec_downloader.exe input.csv output_folder --min-quality 1080 --max-quality 2160

# Inspect the frozen executable identity/capabilities
dist/5_sec_downloader.exe --capabilities-json
```

New calls default to strict 1080p minimum/maximum. `--max-quality auto` removes
the maximum and retains the minimum. `--resolution` is a compatibility alias for
the maximum: explicit values derive a minimum of `min(1080, maximum)` when no
minimum is supplied. Existing positional argument order is preserved. Conflicting
minimum/maximum settings fail before extraction. Quality uses the shorter dimension.

Set `YVC_PYTHON` to the build interpreter when `python` is not on PATH. Set
`YVC_GIT` to Git's executable when building from a shell without Git on PATH.
The builder checks yt-dlp 2026.8.19, EJS 0.8.0, and PyInstaller 6.22.3. Use
`node build-executables.js --media-only` for the downloader and shared trimmer,
or `--downloader-only` after a downloader-only source change. Do not compile
manually without the build manifest; the app rejects stale/mismatched binaries.

All resolution settings now encode the requested range as H.264 High / 8-bit
SDR video with AAC in MP4. HLG/PQ sources are tone mapped to BT.709 SDR, using a
cached probe of the selected stream rather than yt-dlp's inferred HDR label.
Source dimensions and frame rate are retained; 4K60 can require a player with
H.264 level 5.2 support. Each final output is validated before success is logged.
CDNs that reject direct ffprobe requests are checked through a temporary,
lossless one-second FFmpeg range sample. The sample is removed after probing,
and its color policy is cached for subsequent timestamps in that session.

Rebuild and verify from the project directory with pinned dependencies installed:

```powershell
node build-executables.js --media-only
python -m unittest discover -s tests -p 'test*.py'
node --test tests/*.js
python tools/verify_downloader_release.py dist/5_sec_downloader.exe ../.build-venv/quality-release-smoke
npm run make
```

The smoke script uses real HD, portrait, and low-resolution media over localhost.
It tests strict rejection, verified reuse, conflicting inputs, and final exit/summary
behavior through the actual executable. The app's source-digest/hash check must
also pass before packaging. Runtime executables/manifests are staged under
`.runtime/dist`; Forge copies these to packaged `resources/dist`, excluding build
intermediates. `release-manifest.json` records executable hashes and build identity.

A clip has at most four application attempts and one 403 refresh per profile, with
a 180-second operation budget. External media/JS processes are terminated on Stop
or deadline. An in-flight extraction network request may take up to its configured
10-second socket timeout to return. Runtime FFmpeg/FFprobe and Node 22+/Deno remain
prerequisites; a Python installation is not needed by the packaged application.

`test_downloader_encoding.py` generates SDR, 10-bit SDR, HLG, PQ, and WebM
fixtures and serves them only on localhost. It exercises the real pinned
yt-dlp/FFmpeg range downloader, combined and separate streams, cached sessions,
SDR conversion, MP4 finalization, frame rate, duration, and full decoding.
Repeat a live HDR source download and a 4K60 smoke test before distributing a
rebuilt executable; small synthetic fixtures alone do not verify 4K playback.

---

## Step 4: Build Your Electron App

Now build your Electron app. The staged `.runtime/dist` executables/manifests will be included under `resources/dist`:

```bash
npm run make
```

This creates:
- **Windows Installer** (`.exe` installer)
- **Portable ZIP** (on some platforms)
- **Other platform packages** (Mac DMG, Linux deb, etc.)

### Build outputs will be in:
```
out/
├── Rhymx's Youtube Ultimate Tool Setup 1.0.0.exe  (Windows Installer)
└── other platform files...
```

---

## Folder Structure After Build

```
youtube-video-collecting/
├── src/                          # Your Electron app source
│   ├── index.js                  # Updated to use executables
│   ├── index.html
│   └── ...
├── tools/                        # Original Python scripts (keep these)
│   ├── 5_sec_downloader.py
│   ├── auto_add_effect.py
│   └── ...
├── dist/                         # Compiled executables (auto-generated)
│   ├── 5_sec_downloader.exe
│   ├── auto_add_effect.exe
│   └── ...
├── out/                          # Final app distributions (auto-generated)
│   └── Rhymx's Youtube Ultimate Tool Setup 1.0.0.exe
├── forge.config.js               # Updated to include dist/
├── package.json                  # Updated with build-exe script
└── build-executables.js          # Build script (auto-generated)
```

---

## Important Notes

### Keep Original Python Files
Keep your `tools/` directory with the original `.py` files. These are:
- ✅ Useful for debugging
- ✅ Easy to update and modify
- ✅ Can be version controlled (unlike `dist/`)

### Ignore Build Artifacts
The `dist/` and `out/` directories are in `.gitignore` and shouldn't be committed to Git. They're rebuilt each time you run the build commands.

---

## Development Workflow

```bash
# 1. Modify Python scripts as needed
# (edit tools/*.py)

# 2. Test in development mode
npm start

# 3. Rebuild executables (only when you change Python files)
npm run build-exe

# 4. Package the app
npm run make

# 5. Your installer is ready in out/
```

---

## Distribution

Your final installer `Rhymx's Youtube Ultimate Tool Setup 1.0.0.exe` contains:
- ✅ All Electron app files
- ✅ All Python executables (no Python runtime needed!)
- ✅ All dependencies bundled

Users can now install and run your app without having Python installed.

---

## Advanced: Customizing Executable Build

If you want to customize how executables are built (e.g., add hidden imports, icons), edit `build-executables.js`:

```javascript
// Example: Add hidden imports for a script
execSync(
  `pyinstaller --onefile --hidden-import=pyautogui --distpath "${DIST_DIR}" "${scriptPath}"`,
  ...
)
```

Common PyInstaller options:
- `--onefile` - Create single executable (not a directory)
- `--hidden-import=module` - Include modules that PyInstaller doesn't detect
- `--add-data "path:path"` - Include non-Python files
- `--icon=icon.ico` - Add a custom icon

---

## Rollback to Python-Based Distribution (if needed)

If you want to revert to using Python scripts instead of executables:

1. Change `forge.config.js` to use `./tools` instead of `./dist`
2. Revert changes in `src/index.js` to use `getPythonScriptPath()` and `spawn()` with Python

---

## FAQ

**Q: How big are the executables?**  
A: Each compiled executable is typically 10-30 MB depending on dependencies.

**Q: Can I sign the executables?**  
A: Yes! Use PyInstaller's signing options or sign the final `.exe` installer.

**Q: Do users still need Python?**  
A: No! The whole point of PyInstaller is to eliminate that dependency.

**Q: What if a script needs to be updated?**  
A: Update the `.py` file, run `npm run build-exe`, then `npm run make` to create a new installer.

**Q: Can I use different Python versions?**  
A: PyInstaller uses your current Python environment. Switch your environment if needed.

---

## Next Steps

1. ✅ Run `npm run build-exe` to compile executables
2. ✅ Run `npm start` to test in development
3. ✅ Run `npm run make` to build the final installer
4. ✅ Distribute `out/Rhymx's Youtube Ultimate Tool Setup 1.0.0.exe`

Good luck with your distribution! 🚀
