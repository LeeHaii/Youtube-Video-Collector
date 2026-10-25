const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { installRelease } = require('../src/ublock-release');

test('a failed download preserves the installed extension and removes staging files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ublock-download-test-'));
  try {
    const destination = path.join(root, 'ublock-origin');
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, 'manifest.json'), 'existing installation');
    await assert.rejects(installRelease(destination, {
      fetchRelease: async () => ({ ok: false, status: 503 }),
    }), /HTTP 503/);
    assert.equal(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'), 'existing installation');
    assert.deepEqual(await fs.readdir(root), ['ublock-origin']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('tampered release bytes cannot replace an installed extension', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ublock-integrity-test-'));
  try {
    const destination = path.join(root, 'ublock-origin');
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, 'manifest.json'), 'existing installation');
    await assert.rejects(installRelease(destination, {
      fetchRelease: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('tampered zip') }),
    }), /SHA-256/);
    assert.equal(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'), 'existing installation');
    assert.deepEqual(await fs.readdir(root), ['ublock-origin']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
