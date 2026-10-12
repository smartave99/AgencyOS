#!/usr/bin/env node
// Draws the AgencyOS app icon (no external tools or fonts) and writes:
//   <out>/icon.png    256x256, used by the window, tray and dialogs
//   <out>/tray.png    32x32, for the notification area (coloured: it must read on light and dark taskbars)
//   <out>/icon.ico    16..256 px, used for AgencyOS.exe, shortcuts and the installer
//
//   node installer/build/make-icons.mjs --out installer/desktop/assets

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = path.resolve(process.argv[process.argv.indexOf('--out') + 1] || 'installer/desktop/assets');

// ---- tiny PNG encoder ------------------------------------------------------------------
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
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
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- drawing: signed distances, 4x4 supersampling -----------------------------------------
const distToSegment = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const roundedBox = (px, py, half, radius) => {
  const qx = Math.abs(px) - (half - radius);
  const qy = Math.abs(py) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
};

/** Unit square coordinates (-0.5..0.5): a bold "A" made of two legs and a crossbar. */
function glyphDistance(x, y) {
  const w = 0.075; // half stroke width
  const apex = [0, -0.27];
  const left = [-0.2, 0.26];
  const right = [0.2, 0.26];
  const legs = Math.min(
    distToSegment(x, y, ...apex, ...left),
    distToSegment(x, y, ...apex, ...right)
  );
  const bar = distToSegment(x, y, -0.105, 0.1, 0.105, 0.1);
  return Math.min(legs, bar) - w;
}

function render(size, { tile = true } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size - 0.5;
          const y = (py + (sy + 0.5) / SS) / size - 0.5;
          let cover = 0;
          let cr = 255;
          let cg = 255;
          let cb = 255;
          if (tile) {
            if (roundedBox(x, y, 0.5, 0.22) <= 0) {
              cover = 1;
              const t = (x + y + 1) / 2; // diagonal gradient
              cr = 142 + (84 - 142) * t;
              cg = 108 + (58 - 108) * t;
              cb = 255 + (232 - 255) * t;
              if (glyphDistance(x, y) <= 0) {
                cr = 255;
                cg = 255;
                cb = 255;
              }
            }
          } else if (glyphDistance(x * 1.25, y * 1.25) <= 0) {
            cover = 1;
          }
          r += cr * cover;
          g += cg * cover;
          b += cb * cover;
          a += cover;
        }
      }
      const n = SS * SS;
      const o = (py * size + px) * 4;
      if (a > 0) {
        buf[o] = Math.round(r / a);
        buf[o + 1] = Math.round(g / a);
        buf[o + 2] = Math.round(b / a);
        buf[o + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return png(size, buf);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...dir, ...images.map((i) => i.data)]);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), render(256));
fs.writeFileSync(path.join(out, 'tray.png'), render(32));
fs.writeFileSync(
  path.join(out, 'icon.ico'),
  ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: render(size) })))
);
console.log(`[make-icons] wrote icon.png, tray.png, icon.ico to ${out}`);
