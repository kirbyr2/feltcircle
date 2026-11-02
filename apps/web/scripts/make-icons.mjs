// Renders the PNG app icons (no image libraries needed): node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function render(size) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const c = size / 2;
  const s = size / 512;
  const mix = (a, b, t) => a + (b - a) * t;
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      const d = Math.hypot(dx, dy) / s;
      const t = (x + y) / (2 * size);
      const gold = [mix(241, 184, t), mix(215, 137, t), mix(126, 43, t)];
      let col = [9, 9, 10];
      if (d < 179) col = [15, 61, 46];
      if (d >= 157 && d < 179) col = gold;
      if (d >= 107 && d < 117) {
        const ang = (Math.atan2(dy, dx) + Math.PI) * 112;
        if (ang % 58 < 36) col = gold;
      }
      if (d < 58) col = gold;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      px[o] = col[0]; px[o + 1] = col[1]; px[o + 2] = col[2]; px[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(px, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public/icons');
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(out, name), render(size));
  console.log('wrote', name);
}
