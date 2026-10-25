const path = require('node:path');
const { installRelease } = require('../src/ublock-release');

// This directory is also copied outside app.asar when packaging.
installRelease(path.resolve(__dirname, '../.runtime/ublock-origin'), { archivePath: process.argv[2] })
  .then(version => console.log(`Installed official uBlock Origin ${version}. Restart the app to load it.`))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
