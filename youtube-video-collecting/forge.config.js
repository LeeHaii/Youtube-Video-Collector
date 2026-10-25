const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyDownloader } = require('./src/downloader-runtime');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
    icon: 'assets/chitoge.ico',
    // Executables are already copied as resources; do not duplicate them in ASAR.
    ignore: [/^\/dist(?:\/|$)/, /^\/out(?:\/|$)/, /^\/\.runtime(?:\/|$)/],
    extraResource: [
      './.runtime/dist',
    ],
  },
  hooks: {
    prePackage: async () => {
      const directory = path.join(__dirname, '.runtime', 'dist');
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'release-manifest.json'), 'utf8'));
      const digest = crypto.createHash('sha256');
      for (const name of ['5_sec_downloader.py', 'downloader_quality.py', 'downloader_output.py', 'downloader_control.py']) digest.update(fs.readFileSync(path.join(__dirname, 'tools', name)));
      if (manifest.sourceDigest !== digest.digest('hex') || manifest.applicationVersion !== require('./package.json').version) {
        throw new Error('Downloader source/version changed since compilation. Rebuild media executables before packaging.');
      }
      const binary = await verifyDownloader(path.join(directory, '5_sec_downloader.exe'));
      if (binary.executableSha256 !== manifest.artifacts['5_sec_downloader']) throw new Error('Downloader executable hash mismatch.');
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
