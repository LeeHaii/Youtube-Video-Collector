const fs = require('node:fs');
const path = require('node:path');
const { CollectorBridge } = require('../../src/collector-bridge');
const directory = process.env.RHYMX_BRIDGE_DIR;
const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
const bridge = new CollectorBridge({ ...config, onOpen: async (video) => {
  fs.appendFileSync(path.join(directory, 'received.jsonl'), JSON.stringify({ videoId: video.videoId, seconds: video.seconds }) + '\n');
} });
bridge.start().then(() => {
  bridge.setReady(true);
  fs.writeFileSync(path.join(directory, 'fixture.pid'), String(process.pid));
  setTimeout(async () => { await bridge.close(); }, 5000);
});
