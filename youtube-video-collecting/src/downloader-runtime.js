const { execFile } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');

function validateCapabilities(value) {
  if (value?.schemaVersion !== 2 || value.policyVersion !== 2 || !value.ejs
      || !value.qualityModes?.includes('strict')
      || !['--min-quality', '--max-quality', '--replace-existing', '--retry-policy'].every((flag) => value.flags?.includes(flag))) {
    throw new Error('Downloader executable is incompatible with this app. Rebuild/install the matching quality-fix release.');
  }
  return value;
}

function verifyDownloader(executable, { sourceDirectory } = {}) {
  return new Promise((resolve, reject) => {
    execFile(executable, ['--capabilities-json'], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error('Cannot verify downloader executable: ' + error.message));
      try {
        const capabilities = validateCapabilities(JSON.parse(stdout.trim()));
        const sha256 = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
        const manifestPath = require('node:path').join(require('node:path').dirname(executable), 'release-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.artifacts?.['5_sec_downloader'] !== sha256 || manifest.sourceDigest !== capabilities.sourceDigest
            || capabilities.applicationVersion !== require('../package.json').version) {
          throw new Error('Downloader build identity/hash does not match this app release. Rebuild/install the matching package.');
        }
        if (sourceDirectory) {
          const digest = crypto.createHash('sha256');
          for (const name of ['5_sec_downloader.py', 'downloader_quality.py', 'downloader_output.py', 'downloader_control.py']) digest.update(fs.readFileSync(require('node:path').join(sourceDirectory, name)));
          if (digest.digest('hex') !== capabilities.sourceDigest) throw new Error('Python source changed since the executable was compiled. Rebuild the downloader.');
        }
        resolve({ ...capabilities, executableSha256: sha256 });
      } catch (failure) { reject(failure); }
    });
  });
}

module.exports = { verifyDownloader, validateCapabilities };
