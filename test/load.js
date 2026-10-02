/* Loads the real slicing code into a Node VM: src/core.js plus the app files that
   define profiles, test shapes and the scene-to-pixel mapping. Nothing is copied. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

function loadCore() {
  return vm.runInNewContext(read('core.js') + '\ngobosliceCore();', { Blob, Response, CompressionStream });
}

function loadApp() {
  const files = ['core.js', 'app/util.js', 'app/profiles.js', 'app/geometry.js', 'app/slicing.js'];
  const src = files.map(read).join('\n') +
    '\n({ Core, normaliseProfile, DEFAULT_PROFILES, boxTris, pixelMapper, mapTris, derived });';
  return vm.runInNewContext(src, { navigator: { platform: 'node' }, Blob, Response, CompressionStream, TextEncoder, TextDecoder });
}

/* Minimal PNG reader: IHDR fields and the inflated scanlines. */
function readPNG(png) {
  const zlib = require('zlib');
  const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let o = 8, ihdr = null; const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8);
    if (zlib.crc32 && zlib.crc32(b.subarray(o + 4, o + 8 + len)) !== b.readUInt32BE(o + 8 + len)) throw new Error(`bad CRC in ${type}`);
    if (type === 'IHDR') ihdr = { W: b.readUInt32BE(o + 8), H: b.readUInt32BE(o + 12), bits: b[o + 16], colour: b[o + 17] };
    if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
    if (type === 'IEND') break;
  }
  return { ...ihdr, raw: zlib.inflateSync(Buffer.concat(idat)) };
}

/* Number of white pixels in decoded PNG scanlines (filter byte 0 on every row). */
function countLit({ W, H, bits, raw }) {
  const stride = bits === 1 ? ((W + 7) >> 3) + 1 : W + 1;
  let n = 0;
  for (let r = 0; r < H; r++) {
    if (raw[r * stride] !== 0) throw new Error(`row ${r} uses filter ${raw[r * stride]}`);
    for (let c = 0; c < W; c++) {
      const v = bits === 1 ? (raw[r * stride + 1 + (c >> 3)] >> (7 - (c & 7))) & 1 : raw[r * stride + 1 + c];
      if (v) n++;
    }
  }
  return n;
}

module.exports = { loadCore, loadApp, readPNG, countLit };
