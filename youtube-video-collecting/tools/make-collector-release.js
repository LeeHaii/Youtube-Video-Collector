const fs = require('node:fs');
const path = require('node:path');
const { api } = require('@electron-forge/core');

const root = path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(root, 'dist', 'collector_native_host.exe'))) {
  throw new Error('Build collector_native_host.exe before making the release');
}
for (const size of [16, 48, 128]) {
  if (!fs.existsSync(path.join(root, 'extension', 'icons', `${size}.png`))) throw new Error('Run tools/build-collector-assets.js first');
}
api.make({ dir: root, outDir: path.join(root, 'out', 'collector-links'),
  platform: 'win32', arch: 'x64', overrideTargets: ['@electron-forge/maker-squirrel'] })
  .then((results) => {
    for (const result of results) for (const artifact of result.artifacts) console.log(artifact);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
