const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const HOST_NAME = 'com.rhymx.collector';
const DEVELOPMENT_ID = 'mfnhdejejkjojpjjebfjbgahbdgajbcc';
const REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const EDGE_REGISTRY_KEY = `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`;

function bridgeDirectory() {
  return process.env.RHYMX_BRIDGE_DIR || path.join(process.env.LOCALAPPDATA, 'RhymxCollector', 'bridge');
}

function secureBridgeDirectory(directory, run = execFileSync) {
  fs.mkdirSync(directory, { recursive: true });
  const identity = run('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' });
  const sid = identity.match(/S-\d-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error('Could not determine the current Windows user');
  const options = { windowsHide: true, stdio: 'pipe' };
  // Directory inheritance flags are not file permissions. Do not apply them with /T.
  run('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], options);
  for (const file of ['config.json', 'host.json']) {
    const target = path.join(directory, file);
    if (fs.existsSync(target)) run('icacls.exe', [target, '/inheritance:r', '/grant:r', `*${sid}:F`], options);
  }
}

function createConfiguration({ directory, executable, args = [], helper, extensionIds = [DEVELOPMENT_ID] }) {
  fs.mkdirSync(directory, { recursive: true });
  const configPath = path.join(directory, 'config.json');
  let old = {};
  try { old = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  const configuration = {
    version: 1,
    token: /^[a-f0-9]{64}$/.test(old.token) ? old.token : crypto.randomBytes(32).toString('hex'),
    pipeName: `\\\\.\\pipe\\rhymx-collector-${crypto.createHash('sha256').update(directory.toLowerCase()).digest('hex').slice(0, 24)}`,
    executable,
    args,
    allowedOrigins: [...new Set(extensionIds)].map((id) => {
      if (!/^[a-p]{32}$/.test(id)) throw new Error('Invalid extension ID');
      return `chrome-extension://${id}/`;
    }),
  };
  const manifest = {
    name: HOST_NAME, description: 'Rhymx YouTube Collector', path: helper,
    type: 'stdio', allowed_origins: configuration.allowedOrigins,
  };
  // Replace configuration atomically so a helper cannot observe a half-written file.
  for (const [filename, value] of [['config.json', configuration], ['host.json', manifest]]) {
    const target = path.join(directory, filename);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, target);
  }
  return configuration;
}

function registerNativeHost(app, argv = process.argv) {
  const directory = bridgeDirectory();
  const register = process.env.RHYMX_SKIP_NATIVE_REGISTRATION !== '1';
  // Repair older file ACLs before reading the saved token or replacing manifests.
  if (register) secureBridgeDirectory(directory);
  const helper = app.isPackaged ? path.join(process.resourcesPath, 'dist', 'collector_native_host.exe') :
    path.join(__dirname, '..', 'dist', 'collector_native_host.exe');
  let savedIds = [];
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
    savedIds = (saved.allowedOrigins || []).map((origin) => /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin)?.[1]).filter(Boolean);
  } catch {}
  const requestedIds = argv.filter((arg) => arg.startsWith('--collector-extension-id=')).map((arg) => arg.split('=')[1]);
  const extensionIds = [DEVELOPMENT_ID, ...savedIds, ...requestedIds, ...(process.env.RHYMX_EXTENSION_IDS || '').split(',').filter(Boolean)];
  const config = createConfiguration({ directory, executable: process.execPath,
    args: app.isPackaged ? [] : [path.join(__dirname, '..')], helper, extensionIds });
  if (register) {
    for (const key of [REGISTRY_KEY, EDGE_REGISTRY_KEY]) {
      execFileSync('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', path.join(directory, 'host.json'), '/f'], { windowsHide: true, stdio: 'pipe' });
    }
  }
  return config;
}

function unregisterNativeHost() {
  const directory = bridgeDirectory();
  for (const key of [REGISTRY_KEY, EDGE_REGISTRY_KEY]) {
    try { execFileSync('reg.exe', ['DELETE', key, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch {}
  }
  for (const file of ['config.json', 'host.json']) {
    try { fs.unlinkSync(path.join(directory, file)); } catch {}
  }
}

module.exports = { HOST_NAME, DEVELOPMENT_ID, REGISTRY_KEY, EDGE_REGISTRY_KEY, bridgeDirectory, createConfiguration, secureBridgeDirectory, registerNativeHost, unregisterNativeHost };
