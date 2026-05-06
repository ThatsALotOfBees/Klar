// Generates build/icon.ico — a 32x32 cosmic-plasma orb on a transparent
// background with two crater dots, packed as ICO + PNG.
//
// Why this exists: electron-builder's MSI WXS template references an icon
// resource for the desktop/start-menu shortcuts. Without `build/icon.ico`
// the WiX linker errors with LGHT0094 (identifier 'Icon:KlarIcon.exe' not
// found). Producing the icon programmatically keeps the repo self-contained
// — no checked-in binary asset, no graphics-tool dependency.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [32, 48, 64, 128, 256];

function crc32Init() {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = crc32Init();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

function makeOrbPng(size) {
  const cx = (size - 1) / 2, cy = (size - 1) / 2;
  const R = size * 0.45;
  const pixels = Buffer.alloc(size * (1 + size * 4));
  // Plasma color #9d6dff = (157, 109, 255). Light highlight #c0a0ff. Dim core #5a3a99.
  const PR = 157, PG = 109, PB = 255;
  for (let y = 0; y < size; y++) {
    pixels[y * (1 + size * 4)] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx*dx + dy*dy);
      const idx = y * (1 + size * 4) + 1 + x * 4;
      if (d > R) {
        pixels[idx] = 0; pixels[idx+1] = 0; pixels[idx+2] = 0; pixels[idx+3] = 0;
        continue;
      }
      // soft anti-alias on the rim
      const rim = Math.max(0, Math.min(1, (R - d) / 1.2));
      // gradient: top-left highlight to bottom-right shadow
      const ang = (-dx - dy) / (R * 1.4);
      const k = Math.max(0, Math.min(1, 0.5 + ang * 0.5));
      const r = Math.round(PR * k + 90 * (1 - k));
      const g = Math.round(PG * k + 60 * (1 - k));
      const b = Math.round(PB * k + 160 * (1 - k));
      pixels[idx] = r; pixels[idx+1] = g; pixels[idx+2] = b;
      pixels[idx+3] = Math.round(255 * rim);
    }
  }
  // Craters
  const craters = [
    { x: 0.36 * size, y: 0.40 * size, r: size * 0.08 },
    { x: 0.62 * size, y: 0.55 * size, r: size * 0.06 },
    { x: 0.45 * size, y: 0.68 * size, r: size * 0.04 },
  ];
  for (const c of craters) {
    for (let y = Math.floor(c.y - c.r) - 1; y <= Math.ceil(c.y + c.r) + 1; y++) {
      for (let x = Math.floor(c.x - c.r) - 1; x <= Math.ceil(c.x + c.r) + 1; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dx = x - c.x, dy = y - c.y;
        const d = Math.sqrt(dx*dx + dy*dy);
        if (d > c.r) continue;
        const idx = y * (1 + size * 4) + 1 + x * 4;
        if (pixels[idx + 3] === 0) continue;
        const k = 1 - (d / c.r) * 0.4;
        pixels[idx]   = Math.max(0, Math.round(pixels[idx]   * (1 - 0.55 * k)));
        pixels[idx+1] = Math.max(0, Math.round(pixels[idx+1] * (1 - 0.55 * k)));
        pixels[idx+2] = Math.max(0, Math.round(pixels[idx+2] * (1 - 0.45 * k)));
      }
    }
  }

  const sig  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const idat = zlib.deflateSync(pixels);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function makeIco(sizes) {
  const pngs = sizes.map(makeOrbPng);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dirEntries = Buffer.alloc(16 * pngs.length);
  let offset = 6 + 16 * pngs.length;
  for (let i = 0; i < pngs.length; i++) {
    const e = dirEntries.subarray(i * 16, (i + 1) * 16);
    e[0] = sizes[i] >= 256 ? 0 : sizes[i];
    e[1] = sizes[i] >= 256 ? 0 : sizes[i];
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
  }
  return Buffer.concat([header, dirEntries, ...pngs]);
}

const out = path.join(__dirname, '..', 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
const ico = makeIco(SIZES);
fs.writeFileSync(out, ico);
console.log(`wrote ${out}  (${ico.length} bytes, sizes=${SIZES.join(',')})`);
