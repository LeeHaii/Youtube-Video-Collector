const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const content = Buffer.concat([Buffer.from(type), body]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(content));
  return Buffer.concat([header, content, checksum]);
}
function icon(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x / size, py = y / size;
    let color = [255, 255, 255, 0];
    if (px >= .06 && px <= .94 && py >= .16 && py <= .84) color = [208, 46, 61, 255];
    if (px >= .36 && px <= .69 && Math.abs(py - .5) <= (.69 - px) * .7) color = [255, 255, 255, 255];
    if (px >= .7 && px <= .96 && py >= .66 && py <= .96) color = [35, 127, 97, 255];
    if (px >= .77 && px <= .89 && py >= .73 && py <= .89 && (Math.floor(py * 32) % 2 === 0)) color = [255, 255, 255, 255];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    pixels.set(color, offset);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const directory = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(directory, { recursive: true });
for (const size of [16, 48, 128]) fs.writeFileSync(path.join(directory, `${size}.png`), icon(size));
