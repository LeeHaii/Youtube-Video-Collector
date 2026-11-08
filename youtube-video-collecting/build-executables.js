#!/usr/bin/env node
// Build using an explicit interpreter and checked dependency versions.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TOOLS_DIR = path.join(__dirname, 'tools');
const DIST_DIR = path.join(__dirname, 'dist');
const python = process.env.YVC_PYTHON || 'python';
const allScripts = ['5_sec_downloader.py', 'auto_add_effect.py', 'auto_add_title.py', 'capcut_auto_render.py', 'suffle_capcu_track.py', 'youtube_trimmer.py', 'collector_native_host.py'];
const media = new Set(['5_sec_downloader.py', 'youtube_trimmer.py']);
const scripts = process.argv.includes('--collector-only') ? ['collector_native_host.py']
  : process.argv.includes('--downloader-only') ? ['5_sec_downloader.py']
  : process.argv.includes('--media-only') ? [...media] : allScripts;
fs.mkdirSync(DIST_DIR, { recursive: true });
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: TOOLS_DIR, windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || String(result.stderr || 'Build failed'));
  return result.stdout?.toString().trim();
}
const expected = { 'yt-dlp': '2026.8.19', 'yt-dlp-ejs': '0.8.0', pyinstaller: '6.22.3' };
if (scripts.some((script) => media.has(script))) {
  const versions = JSON.parse(run(python, ['-c', 'import json,importlib.metadata as m; print(json.dumps({n:m.version(n) for n in ("yt-dlp","yt-dlp-ejs","pyinstaller")}))']));
  for (const [name, version] of Object.entries(expected)) {
    if (versions[name] !== version) throw new Error(`Expected ${name} ${version}, got ${versions[name]}. Use the pinned build environment.`);
  }
}
const digest = crypto.createHash('sha256');
for (const name of ['5_sec_downloader.py', 'downloader_quality.py', 'downloader_output.py', 'downloader_control.py']) digest.update(fs.readFileSync(path.join(TOOLS_DIR, name)));
const git = (args) => {
  const result = spawnSync(process.env.YVC_GIT || 'git', ['-c', `safe.directory=${path.resolve(__dirname, '..').replaceAll('\\', '/')}`, ...args], { cwd: __dirname, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Cannot read Git build identity. Set YVC_GIT to a working git executable.');
  return result.stdout.toString().trim();
};
const manifest = { sourceCommit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']) !== '',
  sourceDigest: digest.digest('hex'), buildType: 'pyinstaller', builtAt: new Date().toISOString(),
  applicationVersion: require('./package.json').version, schemaVersion: 2, policyVersion: 2, dependencies: expected };
const manifestPath = path.join(DIST_DIR, 'downloader-build.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
for (const script of scripts) {
  const args = ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile', '--paths', TOOLS_DIR,
    '--distpath', DIST_DIR, '--specpath', DIST_DIR, '--workpath', path.join(DIST_DIR, 'build')];
  if (media.has(script)) args.push('--collect-all', 'yt_dlp_ejs', '--add-data', `${manifestPath}${path.delimiter}.`);
  args.push(path.join(TOOLS_DIR, script));
  console.log(`Building ${script} with ${python}`);
  run(python, args, { stdio: 'inherit' });
}
const artifacts = {};
for (const name of ['5_sec_downloader', 'youtube_trimmer']) {
  const file = path.join(DIST_DIR, name + '.exe');
  if (fs.existsSync(file)) artifacts[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
fs.writeFileSync(path.join(DIST_DIR, 'release-manifest.json'), JSON.stringify({ ...manifest, artifacts }, null, 2));
console.log('Executables built. Verify the packaged resources and run the release checks before client distribution.');

const runtime = path.join(__dirname, '.runtime', 'dist');
fs.mkdirSync(runtime, { recursive: true });
for (const name of [...allScripts.map((script) => script.replace('.py', '.exe')), 'downloader-build.json', 'release-manifest.json']) {
  const source = path.join(DIST_DIR, name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(runtime, name));
}
