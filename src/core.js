/* ===================================================================
   Core: pure functions shared by the main thread and Web Workers.
   Everything inside gobosliceCore() must be self-contained, because
   its source text is copied into a worker Blob.
   =================================================================== */
function gobosliceCore() {
  'use strict';

  /* ---------- CRC32 / Adler-32 ---------- */
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf, prev) {
    let c = ((prev === undefined ? 0 : prev) ^ 0xFFFFFFFF) >>> 0;
    for (let i = 0, n = buf.length; i < n; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function adler32(d) {
    let a = 1, b = 0, i = 0;
    const n = d.length;
    while (i < n) {
      const end = Math.min(i + 5552, n);
      for (; i < end; i++) { a += d[i]; b += a; }
      a %= 65521; b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  /* zlib stream made of stored (uncompressed) deflate blocks */
  function zlibStored(d) {
    const nb = Math.max(1, Math.ceil(d.length / 65535));
    const out = new Uint8Array(2 + d.length + nb * 5 + 4);
    out[0] = 0x78; out[1] = 0x01;
    let o = 2, i = 0;
    for (let b = 0; b < nb; b++) {
      const len = Math.min(65535, d.length - i);
      out[o++] = (b === nb - 1) ? 1 : 0;
      out[o++] = len & 255; out[o++] = (len >>> 8) & 255;
      out[o++] = (~len) & 255; out[o++] = ((~len) >>> 8) & 255;
      out.set(d.subarray(i, i + len), o);
      o += len; i += len;
    }
    const a = adler32(d);
    out[o++] = a >>> 24; out[o++] = (a >>> 16) & 255; out[o++] = (a >>> 8) & 255; out[o++] = a & 255;
    return out;
  }

  let streamOK = (typeof CompressionStream !== 'undefined');
  async function zlib(d) {
    if (streamOK) {
      try {
        const cs = new CompressionStream('deflate');
        const ab = await new Response(new Blob([d]).stream().pipeThrough(cs)).arrayBuffer();
        return new Uint8Array(ab);
      } catch (e) { streamOK = false; }
    }
    return zlibStored(d);
  }

  /* ---------- PNG (greyscale, 8-bit or 1-bit) ---------- */
  function rawSize(W, H, bits) {
    return (bits === 1 ? ((W + 7) >> 3) + 1 : W + 1) * H;
  }

  function writeChunk(out, o, type, data) {
    const len = data ? data.length : 0;
    out[o] = len >>> 24; out[o + 1] = (len >>> 16) & 255; out[o + 2] = (len >>> 8) & 255; out[o + 3] = len & 255;
    for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
    if (len) out.set(data, o + 8);
    const c = crc32(out.subarray(o + 4, o + 8 + len));
    const e = o + 8 + len;
    out[e] = c >>> 24; out[e + 1] = (c >>> 16) & 255; out[e + 2] = (c >>> 8) & 255; out[e + 3] = c & 255;
    return e + 4;
  }

  /* raw: scanlines, each prefixed by filter byte 0 */
  async function encodePNG(raw, W, H, bits) {
    const z = await zlib(raw);
    const ihdr = new Uint8Array(13);
    ihdr[0] = W >>> 24; ihdr[1] = (W >>> 16) & 255; ihdr[2] = (W >>> 8) & 255; ihdr[3] = W & 255;
    ihdr[4] = H >>> 24; ihdr[5] = (H >>> 16) & 255; ihdr[6] = (H >>> 8) & 255; ihdr[7] = H & 255;
    ihdr[8] = bits === 1 ? 1 : 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const out = new Uint8Array(8 + (12 + 13) + (12 + z.length) + 12);
    out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    let o = writeChunk(out, 8, 'IHDR', ihdr);
    o = writeChunk(out, o, 'IDAT', z);
    writeChunk(out, o, 'IEND', null);
    return out;
  }

  /* ---------- Rasteriser ----------
     tris: Float32Array, 9 floats per triangle: x,y in pixels, z in mm.
     gids: Uint32Array group id per triangle (one per closed solid).
     mode 0: 8-bit PNG raw (stride W+1, filter byte first)
     mode 1: 1-bit PNG raw (stride ceil(W/8)+1, MSB first)
     mode 2: plain 8-bit mask, stride W
     mode 3: no output (out may be null); only counts, and records runs if st.rec
     Returns the number of lit pixels. `out` must be zeroed beforehand.
     With st.rec set, every lit run is also recorded in st.runs as [row, c0, c1) triples,
     in row order, st.nr of them. */
  function makeRaster() {
    return {
      seg: new Float64Array(5 * 4096), key: new Float64Array(256),
      iv: new Int32Array(512), act: new Int32Array(1024),
      cnt: new Int32Array(1), ord: new Int32Array(4096),
      rec: false, runs: new Int32Array(3 * 1024), nr: 0, prev: new Int32Array(3 * 1024), np: 0, pidx: null
    };
  }

  function grow(arr, need, Ctor) {
    if (need <= arr.length) return arr;
    let n = arr.length * 2; while (n < need) n *= 2;
    const a = new Ctor(n); a.set(arr); return a;
  }

  function rasterLayer(st, tris, gids, ntri, z, W, H, out, mode) {
    let seg = st.seg, ns = 0;
    if (st.rec) st.nr = 0;
    /* 1. plane intersection -> segments covering rows [rs, re) */
    for (let t = 0; t < ntri; t++) {
      const b = t * 9;
      const za = tris[b + 2], zb = tris[b + 5], zc = tris[b + 8];
      const A = za >= z, B = zb >= z, C = zc >= z;
      if (A === B && B === C) continue;
      let p, q, r;
      if (A === B) { p = 2; q = 0; r = 1; } else if (A === C) { p = 1; q = 0; r = 2; } else { p = 0; q = 1; r = 2; }
      const px = tris[b + p * 3], py = tris[b + p * 3 + 1], pz = tris[b + p * 3 + 2];
      const qx = tris[b + q * 3], qy = tris[b + q * 3 + 1], qz = tris[b + q * 3 + 2];
      const rx = tris[b + r * 3], ry = tris[b + r * 3 + 1], rz = tris[b + r * 3 + 2];
      const t1 = (z - pz) / (qz - pz), t2 = (z - pz) / (rz - pz);
      let x1 = px + (qx - px) * t1, y1 = py + (qy - py) * t1;
      let x2 = px + (rx - px) * t2, y2 = py + (ry - py) * t2;
      if (y1 === y2) continue;
      if (y1 > y2) { let s = y1; y1 = y2; y2 = s; s = x1; x1 = x2; x2 = s; }
      let rs = Math.ceil(y1 - 0.5), re = Math.ceil(y2 - 0.5);
      if (rs < 0) rs = 0;
      if (re > H) re = H;
      if (re <= rs) continue;
      const dxdy = (x2 - x1) / (y2 - y1);
      if (ns * 5 + 5 > seg.length) { seg = st.seg = grow(seg, ns * 5 + 5, Float64Array); }
      const o = ns * 5;
      seg[o] = rs; seg[o + 1] = re; seg[o + 2] = x1 + (rs + 0.5 - y1) * dxdy; seg[o + 3] = dxdy; seg[o + 4] = gids[t];
      ns++;
    }
    if (!ns) return 0;

    /* 2. counting sort by start row */
    if (st.cnt.length < H + 1) st.cnt = new Int32Array(H + 1); else st.cnt.fill(0, 0, H + 1);
    const cnt = st.cnt;
    let rmin = H, rmax = 0;
    for (let s = 0; s < ns; s++) {
      const rs = seg[s * 5], re = seg[s * 5 + 1];
      cnt[rs + 1]++;
      if (rs < rmin) rmin = rs; if (re > rmax) rmax = re;
    }
    for (let i = 1; i <= H; i++) cnt[i] += cnt[i - 1];
    if (st.ord.length < ns) st.ord = new Int32Array(ns * 2);
    const ord = st.ord;
    for (let s = 0; s < ns; s++) { const rs = seg[s * 5]; ord[cnt[rs]++] = s; }
    /* after this loop cnt[r] = end index of row r's starts; start of row r = (r? cnt[r-1] : 0) */

    let act = st.act, na = 0, key = st.key, iv = st.iv;
    let ptr = 0;
    const M = W + 8;
    const stride = mode === 0 ? W + 1 : (mode === 1 ? ((W + 7) >> 3) + 1 : W);
    const off = mode === 2 ? 0 : 1;
    let lit = 0;

    for (let r = rmin; r < rmax; r++) {
      const end = cnt[r];
      while (ptr < end) {
        if (na >= act.length) act = st.act = grow(act, na + 1, Int32Array);
        act[na++] = ord[ptr++];
      }
      if (!na) continue;
      if (key.length < na) key = st.key = new Float64Array(na * 2);
      let nk = 0;
      for (let i = 0; i < na; i++) {
        const o = act[i] * 5;
        let x = seg[o + 2] + (r - seg[o]) * seg[o + 3];
        if (x < -2) x = -2; else if (x > W + 2) x = W + 2;
        key[nk++] = seg[o + 4] * M + x + 4;
      }
      const ks = key.subarray(0, nk); ks.sort();
      /* per group even-odd -> column intervals */
      let ni = 0, i = 0;
      while (i < nk) {
        const g = Math.floor(ks[i] / M);
        let j = i + 1;
        while (j < nk && Math.floor(ks[j] / M) === g) j++;
        const base = g * M + 4;
        for (let k = i; k + 1 < j; k += 2) {
          let c0 = Math.ceil(ks[k] - base - 0.5), c1 = Math.ceil(ks[k + 1] - base - 0.5);
          if (c0 < 0) c0 = 0; if (c1 > W) c1 = W;
          if (c1 > c0) {
            if (ni + 2 > iv.length) iv = st.iv = grow(iv, ni + 2, Int32Array);
            iv[ni++] = c0; iv[ni++] = c1;
          }
        }
        i = j;
      }
      if (ni) {
        /* insertion sort interval pairs by start, then merge (union of groups) */
        for (let a = 2; a < ni; a += 2) {
          const s0 = iv[a], s1 = iv[a + 1];
          let b = a - 2;
          while (b >= 0 && iv[b] > s0) { iv[b + 2] = iv[b]; iv[b + 3] = iv[b + 1]; b -= 2; }
          iv[b + 2] = s0; iv[b + 3] = s1;
        }
        const rowBase = r * stride + off;
        let cs = iv[0], ce = iv[1];
        for (let a = 2; a <= ni; a += 2) {
          if (a < ni && iv[a] <= ce) { if (iv[a + 1] > ce) ce = iv[a + 1]; continue; }
          lit += ce - cs;
          if (st.rec) {
            if (st.nr * 3 + 3 > st.runs.length) st.runs = grow(st.runs, st.nr * 3 + 3, Int32Array);
            const q = st.nr++ * 3; st.runs[q] = r; st.runs[q + 1] = cs; st.runs[q + 2] = ce;
          }
          if (mode === 1) {
            for (let c = cs; c < ce; c++) {
              if ((c & 7) === 0 && c + 8 <= ce) {
                let cc = c; const bs = rowBase + (c >> 3);
                let nbytes = 0; while (cc + 8 <= ce) { cc += 8; nbytes++; }
                out.fill(255, bs, bs + nbytes);
                c = cc - 1;
              } else out[rowBase + (c >> 3)] |= (0x80 >> (c & 7));
            }
          } else if (mode !== 3) {
            out.fill(255, rowBase + cs, rowBase + ce);
          }
          if (a < ni) { cs = iv[a]; ce = iv[a + 1]; }
        }
      }
      /* drop segments that end at the next row */
      let w = 0;
      for (let k = 0; k < na; k++) { const s = act[k]; if (seg[s * 5 + 1] > r + 1) act[w++] = s; }
      na = w;
      if (!na && ptr >= ns) break;
    }
    return lit;
  }

  /* ---------- Islands ----------
     An island is an 8-connected region of a layer with no lit pixel of the layer below within
     one pixel (diagonals count): it would be exposed onto nothing. The first layer rests on
     the platform. Layers must be fed in order: islandsBegin, optionally islandsPrime with the
     layer just below the first one, then rasterLayer + islandsTake for each layer. */
  function islandsBegin(st) { st.rec = true; st.nr = 0; st.np = 0; }
  function keepRuns(st) { const t = st.prev; st.prev = st.runs; st.runs = t; st.np = st.nr; st.nr = 0; }
  function islandsPrime(st, tris, gids, ntri, z, W, H) {
    st.rec = true;
    rasterLayer(st, tris, gids, ntri, z, W, H, null, 3);
    keepRuns(st);
  }
  /* islands of the layer just rasterised, against the one before; [] when onPlate */
  function islandsTake(st, H, onPlate) {
    const res = onPlate || !st.nr ? [] : findIslands(st.runs, st.nr, st.prev, st.np, H, st);
    keepRuns(st);
    return res;
  }
  function findIslands(cur, nc, prev, np, H, st) {
    /* pidx[r] = first run of `prev` on row r or later */
    if (!st.pidx || st.pidx.length < H + 2) st.pidx = new Int32Array(H + 2);
    const pidx = st.pidx;
    for (let r = 0, k = 0; r <= H + 1; r++) { while (k < np && prev[k * 3] < r) k++; pidx[r] = k; }
    const par = new Int32Array(nc), sup = new Uint8Array(nc);
    for (let i = 0; i < nc; i++) par[i] = i;
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    /* runs [a, b) and [c0, c1) on neighbouring rows touch, diagonals included, when b >= c0 && a <= c1 */
    let last = -1;
    for (let i = 0; i < nc;) {
      const r = cur[i * 3];
      let j = i; while (j < nc && cur[j * 3] === r) j++;
      if (last >= 0 && cur[last * 3] === r - 1) {
        let p = last;
        for (let q = i; q < j; q++) {
          const c0 = cur[q * 3 + 1], c1 = cur[q * 3 + 2];
          while (p < i && cur[p * 3 + 2] < c0) p++;
          for (let s = p; s < i && cur[s * 3 + 1] <= c1; s++) { const x = find(q), y = find(s); if (x !== y) par[x] = y; }
        }
      }
      /* support: anything lit in the layer below on rows r-1..r+1 within one column */
      for (let pr = r - 1; pr <= r + 1; pr++) {
        if (pr < 0 || pr >= H) continue;
        let p = pidx[pr]; const end = pidx[pr + 1];
        for (let q = i; q < j && p < end; q++) {
          if (sup[q]) continue;
          const c0 = cur[q * 3 + 1], c1 = cur[q * 3 + 2];
          while (p < end && prev[p * 3 + 2] < c0) p++;
          if (p < end && prev[p * 3 + 1] <= c1) sup[q] = 1;
        }
      }
      last = i; i = j;
    }
    const comp = new Map();
    for (let q = 0; q < nc; q++) {
      const root = find(q);
      let g = comp.get(root);
      if (!g) comp.set(root, g = { s: 0, area: 0, sx: 0, sy: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
      const r = cur[q * 3], c0 = cur[q * 3 + 1], c1 = cur[q * 3 + 2], n = c1 - c0;
      g.s |= sup[q]; g.area += n; g.sx += n * (c0 + c1) / 2; g.sy += n * (r + 0.5);
      if (c0 < g.x0) g.x0 = c0; if (c1 > g.x1) g.x1 = c1; if (r < g.y0) g.y0 = r; if (r + 1 > g.y1) g.y1 = r + 1;
    }
    const out = [];
    for (const g of comp.values()) if (!g.s) out.push({ area: g.area, cx: g.sx / g.area, cy: g.sy / g.area, x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 });
    return out;
  }

  return { crc32, adler32, zlibStored, zlib, encodePNG, rawSize, makeRaster, rasterLayer, islandsBegin, islandsPrime, islandsTake };
}

/* Worker entry: receives jobs of layer ranges with pre-bucketed triangles */
function gobosliceWorkerMain(Core) {
  let raw = null, st = Core.makeRaster();
  self.onmessage = async function (e) {
    const m = e.data;
    if (m.type === 'ping') { self.postMessage({ type: 'pong' }); return; }
    if (m.type !== 'job') return;
    try {
      const encode = m.encode !== false, mode = encode ? (m.bits === 1 ? 1 : 0) : 3;
      if (encode) { const size = Core.rawSize(m.W, m.H, m.bits); if (!raw || raw.length !== size) { raw = null; raw = new Uint8Array(size); } }
      st.rec = false;
      if (m.islands) { Core.islandsBegin(st); if (m.l0 > 0) Core.islandsPrime(st, m.tris, m.gids, m.ntri, (m.l0 - 0.5) * m.lh, m.W, m.H); }
      for (let L = m.l0; L < m.l1; L++) {
        if (encode) raw.fill(0);
        const lit = Core.rasterLayer(st, m.tris, m.gids, m.ntri, (L + 0.5) * m.lh, m.W, m.H, encode ? raw : null, mode);
        const islands = m.islands ? Core.islandsTake(st, m.H, L === 0) : null;
        if (!encode) { self.postMessage({ type: 'layer', id: m.id, layer: L, lit: lit, islands: islands }); continue; }
        const png = await Core.encodePNG(raw, m.W, m.H, m.bits);
        const crc = Core.crc32(png);
        self.postMessage({ type: 'layer', id: m.id, layer: L, png: png, crc: crc, lit: lit, islands: islands }, [png.buffer]);
      }
      self.postMessage({ type: 'done', id: m.id });
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
    }
  };
}
