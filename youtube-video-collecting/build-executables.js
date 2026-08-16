#!/usr/bin/env node

/**
 * Build script to compile Python scripts into standalone executables using PyInstaller
 * Run this ONCE before packaging: node build-executables.js
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const TOOLS_DIR = path.join(__dirname, 'tools');
const DIST_DIR = path.join(__dirname, 'dist');

// List of Python scripts to compile
const SCRIPTS = [
  '5_sec_downloader.py',
  'auto_add_effect.py',
  'auto_add_title.py',
  'capcut_auto_render.py',
  'suffle_capcu_track.py',
  'youtube_trimmer.py',
];

const YT_DLP_SCRIPTS = new Set([
  '5_sec_downloader.py',
  'youtube_trimmer.py',
]);

// Create dist directory if it doesn't exist
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
  console.log('✅ Created dist/ directory');
}

console.log('🔨 Starting PyInstaller compilation...\n');

for (const script of SCRIPTS) {
  const scriptPath = path.join(TOOLS_DIR, script);
  const scriptName = path.basename(script, '.py');
  
  if (!fs.existsSync(scriptPath)) {
    console.error(`❌ Script not found: ${scriptPath}`);
    process.exit(1);
  }

  console.log(`📦 Compiling ${script}...`);
  
  try {
    // Clean prevents old yt-dlp bytecode from leaking into a newly dated executable.
    // yt-dlp-ejs is loaded dynamically, so PyInstaller must collect it explicitly.
    const ytDlpBundleArgs = YT_DLP_SCRIPTS.has(script)
      ? ' --collect-all yt_dlp_ejs'
      : '';
    execSync(
      `pyinstaller --noconfirm --clean --onefile${ytDlpBundleArgs} --distpath "${DIST_DIR}" --specpath "${DIST_DIR}" --workpath "${DIST_DIR}/build" "${scriptPath}"`,
      { stdio: 'inherit', cwd: TOOLS_DIR }
    );
    console.log(`✅ ${scriptName}.exe created\n`);
  } catch (error) {
    console.error(`❌ Failed to compile ${script}: ${error.message}`);
    process.exit(1);
  }
}

console.log('🎉 All scripts compiled successfully!');
console.log(`📁 Executables are in: ${DIST_DIR}`);
console.log('\n📝 Next steps:');
console.log('   1. Review the .exe files in dist/');
console.log('   2. Run "npm run make" to package your app');
console.log('   3. The bundled executables will be included in the final distribution\n');
