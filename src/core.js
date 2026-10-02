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

  /* ---------- Run sets ----------
     A run set is an Int32Array of [row, c0, c1) triples sorted by row then column, the runs
     of a row disjoint and not touching: the same form rasterLayer records. All the design
     checks below work on run sets, so a 9400 × 5200 layer never needs a full bitmap. */
  const NONE = new Int32Array(0);
  function rowStarts(a, H) {
    const idx = new Int32Array(H + 1), n = a.length / 3;
    for (let r = 0, k = 0; r <= H; r++) { while (k < n && a[k * 3] < r) k++; idx[r] = k; }
    return idx;
  }
  function inRuns(a, idx, r, c) {
    let lo = idx[r], hi = idx[r + 1] - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m * 3 + 2] <= c) lo = m + 1; else if (a[m * 3 + 1] > c) hi = m - 1; else return true; }
    return false;
  }
  /* op 0 union, 1 intersection, 2 a minus b */
  function combine(A, B, op) {
    const na = A.length / 3, nb = B.length / 3, out = [];
    if (!na) return op === 0 ? B : NONE;
    if (!nb) return op === 1 ? NONE : A;
    let i = 0, p = 0;
    while (i < na || p < nb) {
      const r = Math.min(i < na ? A[i * 3] : Infinity, p < nb ? B[p * 3] : Infinity);
      let i1 = i; while (i1 < na && A[i1 * 3] === r) i1++;
      let p1 = p; while (p1 < nb && B[p1 * 3] === r) p1++;
      if (op === 0) {
        let a = i, b = p, cs = 0, ce = -1;
        while (a < i1 || b < p1) {
          let s0, e0;
          if (b >= p1 || (a < i1 && A[a * 3 + 1] <= B[b * 3 + 1])) { s0 = A[a * 3 + 1]; e0 = A[a * 3 + 2]; a++; } else { s0 = B[b * 3 + 1]; e0 = B[b * 3 + 2]; b++; }
          if (ce >= 0 && s0 <= ce) { if (e0 > ce) ce = e0; } else { if (ce >= 0) out.push(r, cs, ce); cs = s0; ce = e0; }
        }
        if (ce >= 0) out.push(r, cs, ce);
      } else if (op === 1) {
        let a = i, b = p;
        while (a < i1 && b < p1) {
          const s0 = Math.max(A[a * 3 + 1], B[b * 3 + 1]), e0 = Math.min(A[a * 3 + 2], B[b * 3 + 2]);
          if (e0 > s0) out.push(r, s0, e0);
          if (A[a * 3 + 2] < B[b * 3 + 2]) a++; else b++;
        }
      } else {
        let b = p;
        for (let a = i; a < i1; a++) {
          let s0 = A[a * 3 + 1]; const e0 = A[a * 3 + 2];
          while (b < p1 && B[b * 3 + 2] <= s0) b++;
          for (let q = b; q < p1 && B[q * 3 + 1] < e0; q++) { if (B[q * 3 + 1] > s0) out.push(r, s0, B[q * 3 + 1]); if (B[q * 3 + 2] > s0) s0 = B[q * 3 + 2]; }
          if (s0 < e0) out.push(r, s0, e0);
        }
      }
      i = i1; p = p1;
    }
    return out.length ? Int32Array.from(out) : NONE;
  }
  const runsOr = (a, b) => combine(a, b, 0), runsAnd = (a, b) => combine(a, b, 1), runsSub = (a, b) => combine(a, b, 2);
  /* half-widths of a disk of radius k + 0.5 pixels, row by row: the odd-sized disk 2k + 1 across */
  function disk(k) { const w = []; const R = k + 0.5; for (let dy = 0; dy <= k; dy++) w.push(Math.floor(Math.sqrt(R * R - dy * dy) + 1e-9)); return w; }
  /* dilation by disk(k); `rows` (sorted) limits the output to those rows */
  function dilate(A, k, W, H, rows) {
    if (!A.length || k <= 0) return A;
    const w = disk(k), idx = rowStarts(A, H), out = [], key = [];
    const want = rows || null, r0 = Math.max(0, A[0] - k), r1 = Math.min(H - 1, A[A.length - 3] + k);
    const doRow = (r) => {
      key.length = 0;
      for (let dy = -k; dy <= k; dy++) {
        const y = r + dy; if (y < 0 || y >= H) continue;
        const e = w[dy < 0 ? -dy : dy];
        for (let q = idx[y]; q < idx[y + 1]; q++) key.push(Math.max(0, A[q * 3 + 1] - e) * 65536 + Math.min(W, A[q * 3 + 2] + e));
      }
      if (!key.length) return;
      key.sort((x, y) => x - y);
      let cs = Math.floor(key[0] / 65536), ce = key[0] % 65536;
      for (let q = 1; q < key.length; q++) { const s0 = Math.floor(key[q] / 65536), e0 = key[q] % 65536; if (s0 <= ce) { if (e0 > ce) ce = e0; } else { out.push(r, cs, ce); cs = s0; ce = e0; } }
      out.push(r, cs, ce);
    };
    if (want) { for (const r of want) if (r >= r0 && r <= r1) doRow(r); } else for (let r = r0; r <= r1; r++) doRow(r);
    return out.length ? Int32Array.from(out) : NONE;
  }
  /* erosion by disk(k): a pixel stays when the whole disk round it is lit */
  function erode(A, k, W, H) {
    if (!A.length || k <= 0) return A;
    const w = disk(k), idx = rowStarts(A, H), out = [];
    let cur = [], nxt = [];
    for (let r = A[0]; r <= A[A.length - 3]; r++) {
      if (idx[r] === idx[r + 1]) continue;
      cur.length = 0;
      for (let q = idx[r]; q < idx[r + 1]; q++) { const s0 = A[q * 3 + 1] + w[0], e0 = A[q * 3 + 2] - w[0]; if (e0 > s0) cur.push(s0, e0); }
      for (let dy = 1; dy <= k && cur.length; dy++) for (const y of [r - dy, r + dy]) {
        if (y < 0 || y >= H) { cur.length = 0; break; }
        const e = w[dy]; nxt.length = 0;
        let a = 0, b = idx[y];
        while (a < cur.length && b < idx[y + 1]) {
          const bs = A[b * 3 + 1] + e, be = A[b * 3 + 2] - e;
          if (be <= bs) { b++; continue; }
          const s0 = Math.max(cur[a], bs), e0 = Math.min(cur[a + 1], be);
          if (e0 > s0) nxt.push(s0, e0);
          if (cur[a + 1] < be) a += 2; else b++;
        }
        const t = cur; cur = nxt; nxt = t;
        if (!cur.length) break;
      }
      for (let q = 0; q < cur.length; q += 2) out.push(r, cur[q], cur[q + 1]);
    }
    return out.length ? Int32Array.from(out) : NONE;
  }
  /* connected components of a run set (8- or 4-connected) with area, bounding box and centroid */
  function labelRuns(A, eight) {
    const n = A.length / 3, par = new Int32Array(n);
    for (let i = 0; i < n; i++) par[i] = i;
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const t = eight ? 0 : 1;
    let last = -1;
    for (let i = 0; i < n;) {
      const r = A[i * 3]; let j = i; while (j < n && A[j * 3] === r) j++;
      if (last >= 0 && A[last * 3] === r - 1) {
        let p = last;
        for (let q = i; q < j; q++) {
          const c0 = A[q * 3 + 1], c1 = A[q * 3 + 2];
          while (p < i && A[p * 3 + 2] < c0 + t) p++;
          for (let s0 = p; s0 < i && A[s0 * 3 + 1] <= c1 - t; s0++) { const x = find(q), y = find(s0); if (x !== y) par[x] = y; }
        }
      }
      last = i; i = j;
    }
    const lab = new Int32Array(n), map = new Map();
    for (let i = 0; i < n; i++) { const rt = find(i); let id = map.get(rt); if (id === undefined) { id = map.size; map.set(rt, id); } lab[i] = id; }
    const m = map.size, area = new Float64Array(m), sx = new Float64Array(m), sy = new Float64Array(m);
    const x0 = new Int32Array(m).fill(2147483647), y0 = new Int32Array(m).fill(2147483647), x1 = new Int32Array(m).fill(-1), y1 = new Int32Array(m).fill(-1);
    for (let i = 0; i < n; i++) {
      const c = lab[i], r = A[i * 3], a = A[i * 3 + 1], b = A[i * 3 + 2], w = b - a;
      area[c] += w; sx[c] += w * (a + b) / 2; sy[c] += w * (r + 0.5);
      if (a < x0[c]) x0[c] = a; if (b > x1[c]) x1[c] = b; if (r < y0[c]) y0[c] = r; if (r + 1 > y1[c]) y1[c] = r + 1;
    }
    return { lab, m, area, sx, sy, x0, y0, x1, y1 };
  }
  function pickRuns(A, lab, keep) { const out = []; for (let i = 0; i < lab.length; i++) if (keep[lab[i]]) out.push(A[i * 3], A[i * 3 + 1], A[i * 3 + 2]); return out.length ? Int32Array.from(out) : NONE; }
  /* unlit regions completely enclosed by lit pixels (4-connected, the dual of 8-connected lit) */
  function holesOf(A, W, H) {
    if (!A.length) return NONE;
    const rmin = A[0], rmax = A[A.length - 3], idx = rowStarts(A, H), bg = [], outside = [];
    for (let r = rmin; r <= rmax; r++) {
      let x = 0;
      for (let q = idx[r]; q < idx[r + 1]; q++) { const a = A[q * 3 + 1]; if (a > x) { bg.push(r, x, a); outside.push(r === rmin || r === rmax || x === 0); } x = A[q * 3 + 2]; }
      if (x < W) { bg.push(r, x, W); outside.push(true); }
    }
    if (!bg.length) return NONE;
    const B = Int32Array.from(bg), L = labelRuns(B, false), open = new Uint8Array(L.m);
    for (let i = 0; i < outside.length; i++) if (outside[i]) open[L.lab[i]] = 1;
    const keep = new Uint8Array(L.m); for (let c = 0; c < L.m; c++) keep[c] = open[c] ? 0 : 1;
    return pickRuns(B, L.lab, keep);
  }
  /* which components of A have something lit in `prev` within one pixel (diagonals count) */
  function supportedComps(A, L, prev, H) {
    const sup = new Uint8Array(L.m);
    if (!prev || !prev.length) return sup;
    const D = dilate(prev, 1, 1 << 30, H), T = runsAnd(A, D);
    if (!T.length) return sup;
    const idx = rowStarts(A, H), n = T.length / 3;
    for (let q = 0; q < n; q++) {
      const r = T[q * 3], c = T[q * 3 + 1];
      let lo = idx[r], hi = idx[r + 1] - 1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (A[m * 3 + 2] <= c) lo = m + 1; else if (A[m * 3 + 1] > c) hi = m - 1; else { sup[L.lab[m]] = 1; break; } }
    }
    return sup;
  }

  /* ---------- Design check ----------
     checkRange rasterises layers l0..l1-1 of a job (plus the layers below and one above that
     the rules need) and emits one result per layer. Rules (lengths already in pixels / layers):
       island: lit regions resting on nothing (all geometry, supports included)
       ledge:  new pixels further than `ledge` from support, unless bridged within `bridge`
       thin:   part regions narrower than 2·thinE+1 (error) or 2·thinW+1 (warning) pixels
       gap:    open gaps between part regions closed by a disk of 2·gap+1
       vhole:  enclosed holes narrower than 2·hole+1
       hhole:  overhang pixels with part material at most `gmax` layers below
     Thin, gap and vhole must persist into the layer above or below, so slivers at the very top
     or bottom of a curved surface are not reported, and must be a whole feature (all of a pin,
     fin or hole) or at least three minimum widths long, so the rounded-off tip of a sharp
     corner is not reported either. Pins and enclosed holes small enough to
     break the aspect-ratio rules are returned for the caller to track up the stack. */
  function checkRange(m, emit) {
    const W = m.W, H = m.H, lh = m.lh, R = m.check, N = m.N;
    const kind = m.kind, nt = m.ntri;
    let pn = 0; for (let t = 0; t < nt; t++) if (!kind[t]) pn++;
    const pt = new Float32Array(pn * 9), pg = new Uint32Array(pn);
    for (let t = 0, o = 0; t < nt; t++) if (!kind[t]) { pt.set(m.tris.subarray(t * 9, t * 9 + 9), o * 9); pg[o++] = m.gids[t]; }
    const sa = makeRaster(), sp = makeRaster(); sa.rec = sp.rec = true;
    const runsAt = (st, tris, gids, n, L) => { rasterLayer(st, tris, gids, n, (L + 0.5) * lh, W, H, null, 3); return st.nr ? st.runs.slice(0, st.nr * 3) : NONE; };
    const ck = { prevAll: null, prevP: null, hist: [], pend: null, prevRaw: null };
    const from = Math.max(0, m.l0 - 1 - R.gmax), to = Math.min(N - 1, m.l1);
    for (let L = from; L <= to; L++) {
      const P = runsAt(sp, pt, pg, pn, L);
      if (L < m.l0 - 1) { ck.hist.push(P); if (ck.hist.length > R.gmax + 1) ck.hist.shift(); ck.prevP = P; continue; }
      const A = runsAt(sa, m.tris, m.gids, nt, L);
      const done = feedLayer(ck, L, A, P, R, W, H);
      if (done && done.L >= m.l0 && done.L < m.l1) emit(done.L, done);
    }
    if (m.l1 >= N && ck.pend) { const done = finishLayer(ck.pend, ck.prevRaw, null, R, H); if (done.L >= m.l0) emit(done.L, done); }
  }
  function issuesFrom(out, A, k, sev, minArea, cap, value) {
    if (!A.length) return;
    const L = labelRuns(A, true), list = [];
    for (let c = 0; c < L.m; c++) if (L.area[c] >= minArea) list.push(c);
    list.sort((a, b) => L.area[b] - L.area[a]);
    for (const c of list.slice(0, cap)) out.push({ k, s: sev, a: L.area[c], cx: L.sx[c] / L.area[c], cy: L.sy[c] / L.area[c], x0: L.x0[c], y0: L.y0[c], x1: L.x1[c], y1: L.y1[c], v: value ? value(c, L) : 0 });
  }
  function feedLayer(ck, Lz, A, P, R, W, H) {
    const out = { L: Lz, issues: [], pins: [], chans: [] }, cap = R.cap;
    /* islands and overhang reach, on everything that is exposed */
    if (Lz > 0 && A.length) {
      const LA = labelRuns(A, true), sup = supportedComps(A, LA, ck.prevAll, H), isl = new Uint8Array(LA.m);
      for (let c = 0; c < LA.m; c++) isl[c] = sup[c] ? 0 : 1;
      const islRuns = pickRuns(A, LA.lab, isl);
      issuesFrom(out.issues, islRuns, 'island', 2, 1, cap, (c, L) => L.area[c]);
      if (ck.prevAll && ck.prevAll.length) {
        const D1 = dilate(ck.prevAll, 1, W, H), S = runsAnd(A, D1);
        const Nw = runsSub(runsSub(A, D1), islRuns);
        let cand = Nw.length ? runsSub(Nw, dilate(S, Math.min(3, R.ledge), W, H)) : NONE;
        if (cand.length && R.ledge > 3) {
          const rows = []; for (let q = 0; q < cand.length; q += 3) if (!rows.length || rows[rows.length - 1] !== cand[q]) rows.push(cand[q]);
          cand = runsSub(cand, dilate(S, R.ledge, W, H, rows));
        }
        if (cand.length) {
          const LF = labelRuns(cand, true), idxS = rowStarts(S, H), seen = [];
          for (let c = 0; c < LF.m; c++) if (LF.area[c] >= 2) seen.push(c);
          seen.sort((a, b) => LF.area[b] - LF.area[a]);
          for (const c of seen.slice(0, cap)) {
            /* seed: the run midpoint of this region nearest its centroid */
            const gx = LF.sx[c] / LF.area[c], gy = LF.sy[c] / LF.area[c];
            let best = Infinity, sr = 0, sc = 0;
            for (let q = 0; q < LF.lab.length; q++) if (LF.lab[q] === c) {
              const r = cand[q * 3], a = cand[q * 3 + 1], b = cand[q * 3 + 2], x = Math.min(b - 1, Math.max(a, Math.round(gx - 0.5)));
              const d = (x + 0.5 - gx) ** 2 + (r + 0.5 - gy) ** 2; if (d < best) { best = d; sr = r; sc = x; }
            }
            /* nearest supported pixel in each 45° sector round the seed: support in two opposite
               sectors makes it a bridge, else it is a cantilever */
            const sec = new Float64Array(8).fill(Infinity);
            for (let dy = -R.maxSteps; dy <= R.maxSteps; dy++) {
              const r = sr + dy; if (r < 0 || r >= H) continue;
              for (let q = idxS[r]; q < idxS[r + 1]; q++) {
                const a = S[q * 3 + 1], b = S[q * 3 + 2] - 1;
                if (b < sc - R.maxSteps || a > sc + R.maxSteps) continue;
                for (const x of [Math.min(b, Math.max(a, sc)), a, b]) {
                  const dx = x - sc, d = Math.hypot(dx, dy); if (d > R.maxSteps || d === 0) continue;
                  const k = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
                  if (d < sec[k]) sec[k] = d;
                }
              }
            }
            let span = Infinity, reach = Infinity;
            for (let d = 0; d < 8; d++) { reach = Math.min(reach, sec[d]); if (d < 4) span = Math.min(span, sec[d] + sec[d + 4]); }
            if (span <= R.bridge) continue;
            out.issues.push({ k: 'ledge', s: 2, a: LF.area[c], cx: gx, cy: gy, x0: LF.x0[c], y0: LF.y0[c], x1: LF.x1[c], y1: LF.y1[c], v: span < Infinity ? span : reach, b: span < Infinity ? 1 : 0 });
          }
        }
      }
    }
    /* horizontal holes and gaps: overhanging part pixels with part material close below */
    if (Lz > 0 && P.length && ck.prevP && ck.hist.length > 1) {
      const Np = runsSub(P, ck.prevP);
      if (Np.length) {
        const below = ck.hist.slice(0, -1);
        let U = NONE; for (const h of below) U = runsOr(U, h);
        const F = runsAnd(Np, U);
        if (F.length) issuesFrom(out.issues, F, 'hhole', 2, 3, cap, (c, L) => {
          const keep = new Uint8Array(L.m); keep[c] = 1; const mine = pickRuns(F, L.lab, keep);
          for (let i = below.length - 1, g = 1; i >= 0; i--, g++) if (runsAnd(mine, below[i]).length) return g;
          return below.length;
        });
      }
    }
    /* raw sets for the rules that must persist; pins and channel candidates */
    let raw = { tE: NONE, tW: NONE, gp: NONE, hl: NONE }, Hs = NONE;
    if (P.length) {
      const tE = runsSub(P, dilate(erode(P, R.thinE, W, H), R.thinE, W, H));
      const tW = R.thinW > R.thinE ? runsSub(P, dilate(erode(P, R.thinW, W, H), R.thinW, W, H)) : tE;
      Hs = holesOf(P, W, H);
      const closeG = erode(dilate(P, R.gap, W, H), R.gap, W, H);
      const gp = runsSub(runsSub(closeG, P), Hs);
      const hl = Hs.length ? runsAnd(Hs, R.hole === R.gap ? closeG : erode(dilate(P, R.hole, W, H), R.hole, W, H)) : NONE;
      raw = { tE, tW, gp, hl };
      const LP = labelRuns(P, true);
      for (let c = 0; c < LP.m && out.pins.length < 400; c++) { const d = 2 * Math.sqrt(LP.area[c] / Math.PI); if (d < R.pinD) out.pins.push([LP.sx[c] / LP.area[c], LP.sy[c] / LP.area[c], LP.x0[c], LP.y0[c], LP.x1[c], LP.y1[c], d]); }
      if (Hs.length) { const LH = labelRuns(Hs, false); for (let c = 0; c < LH.m && out.chans.length < 400; c++) { const d = 2 * Math.sqrt(LH.area[c] / Math.PI); if (d < R.chanD) out.chans.push([LH.sx[c] / LH.area[c], LH.sy[c] / LH.area[c], LH.x0[c], LH.y0[c], LH.x1[c], LH.y1[c], d]); } }
    }
    let done = null;
    if (ck.pend) done = finishLayer(ck.pend, ck.prevRaw, raw, R, H);
    ck.prevRaw = ck.pend ? ck.pend.raw : null;
    ck.pend = { out, raw, P, Hs };
    ck.prevAll = A; ck.prevP = P;
    ck.hist.push(P); if (ck.hist.length > R.gmax + 1) ck.hist.shift();
    return done;
  }
  function finishLayer(p, below, above, R, H) {
    const keep = (k) => {
      const mine = p.raw[k]; if (!mine.length) return NONE;
      const nb = runsOr(below ? below[k] : NONE, above ? above[k] : NONE);
      return nb.length ? runsAnd(mine, dilate(nb, 1, 1 << 30, H)) : NONE;
    };
    const tE = keep('tE'), tW = runsSub(keep('tW'), tE), gp = keep('gp'), hl = keep('hl'), out = p.out, cap = R.cap;
    const solid = p.P.length ? { A: p.P, L: labelRuns(p.P, true), idx: rowStarts(p.P, H) } : null;
    const holes = p.Hs.length ? { A: p.Hs, L: labelRuns(p.Hs, false), idx: rowStarts(p.Hs, H) } : null;
    featureIssues(out.issues, tE, 'thin', 2, R.thinE, cap, solid, H);
    featureIssues(out.issues, tW, 'thin', 1, R.thinW, cap, solid, H);
    featureIssues(out.issues, gp, 'gap', 1, R.gap, cap, null, H);
    featureIssues(out.issues, hl, 'vhole', 2, R.hole, cap, holes, H);
    return out;
  }
  /* regions of A narrower than 2k + 1 that are a whole component of `whole` (most of it), or
     at least three times that long; the others are the rounded-off tips of sharp corners */
  function featureIssues(out, A, k, sev, kk, cap, whole, H) {
    if (!A.length) return;
    const L = labelRuns(A, true), minLen = 3 * (2 * kk + 1), minA = Math.max(2, (kk + 0.5) * (kk + 0.5)), first = new Int32Array(L.m).fill(-1);
    for (let i = 0; i < L.lab.length; i++) if (first[L.lab[i]] < 0) first[L.lab[i]] = i;
    const list = [];
    for (let c = 0; c < L.m; c++) {
      if (L.area[c] < minA) continue;
      let ok = Math.max(L.x1[c] - L.x0[c], L.y1[c] - L.y0[c]) >= minLen;
      if (!ok && whole) {
        const r = A[first[c] * 3], x = A[first[c] * 3 + 1], W2 = whole.A;
        let lo = whole.idx[r], hi = whole.idx[r + 1] - 1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (W2[m * 3 + 2] <= x) lo = m + 1; else if (W2[m * 3 + 1] > x) hi = m - 1; else { ok = L.area[c] >= 0.8 * whole.L.area[whole.L.lab[m]]; break; } }
      }
      if (ok) list.push(c);
    }
    list.sort((a, b) => L.area[b] - L.area[a]);
    for (const c of list.slice(0, cap)) {
      /* width: the widest odd disk that still fits inside the region, 2j + 1 pixels */
      const keep = new Uint8Array(L.m); keep[c] = 1;
      const mine = pickRuns(A, L.lab, keep);
      let j = 0; while (j < 16 && erode(mine, j + 1, 0, H).length) j++;
      out.push({ k, s: sev, a: L.area[c], cx: L.sx[c] / L.area[c], cy: L.sy[c] / L.area[c], x0: L.x0[c], y0: L.y0[c], x1: L.x1[c], y1: L.y1[c], v: 2 * j + 1 });
    }
  }
  /* link per-layer blobs [cx, cy, x0, y0, x1, y1, d] whose boxes overlap one to one into
     vertical chains: pins, pillars and channels */
  function trackChains(per) {
    const done = []; let act = [];
    const touch = (b, c) => c[2] <= b[4] && b[2] <= c[4] && c[3] <= b[5] && b[3] <= c[5];
    for (let L = 0; L < per.length; L++) {
      const cs = per[L] || [], cand = cs.map((c) => act.filter((ch) => touch(ch.box, c))), n = new Map(), next = [], cont = new Set();
      for (const l of cand) for (const ch of l) n.set(ch, (n.get(ch) || 0) + 1);
      cs.forEach((c, i) => {
        const l = cand[i];
        if (l.length === 1 && n.get(l[0]) === 1) {
          const ch = l[0], u = ch.ub; ch.l1 = L; ch.box = c; ch.d.push(c[6]); cont.add(ch); next.push(ch);
          u[0] = Math.min(u[0], c[2]); u[1] = Math.min(u[1], c[3]); u[2] = Math.max(u[2], c[4]); u[3] = Math.max(u[3], c[5]);
        } else next.push({ l0: L, l1: L, box: c, d: [c[6]], ub: [c[2], c[3], c[4], c[5]] });
      });
      for (const ch of act) if (!cont.has(ch)) done.push(ch);
      act = next;
    }
    return done.concat(act);
  }

  return { crc32, adler32, zlibStored, zlib, encodePNG, rawSize, makeRaster, rasterLayer, islandsBegin, islandsPrime, islandsTake,
    runsOr, runsAnd, runsSub, dilate, erode, labelRuns, holesOf, checkRange, trackChains };
}

/* Worker entry: receives jobs of layer ranges with pre-bucketed triangles */
function gobosliceWorkerMain(Core) {
  let raw = null, st = Core.makeRaster();
  self.onmessage = async function (e) {
    const m = e.data;
    if (m.type === 'ping') { self.postMessage({ type: 'pong' }); return; }
    if (m.type !== 'job') return;
    try {
      if (m.check) {
        Core.checkRange(m, (L, res) => self.postMessage({ type: 'check', id: m.id, layer: L, res: res }));
        self.postMessage({ type: 'done', id: m.id });
        return;
      }
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
