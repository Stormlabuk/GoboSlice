/* ---------- Baking the scene into pixel space ----------
   Image row 0 is the back (+Y) edge, column 0 the left (−X) edge, then the mirror applies. */
function pixelMapper(P, W, H) {
  const D = derived(P), sx = W / P.bx, sy = H / P.by;
  const mh = P.mirror === 'h' || P.mirror === 'hv', mv = P.mirror === 'v' || P.mirror === 'hv';
  return {
    x: (x) => { const c = (x - D.x0) * sx; return mh ? W - c : c; },
    y: (y) => { const r = (D.y1 - y) * sy; return mv ? H - r : r; }
  };
}
function mapTris(src, P, W, H, out, o) {
  const M = pixelMapper(P, W, H);
  if (!out) { out = new Float32Array(src.length); o = 0; }
  for (let i = 0; i < src.length; i += 3) { out[o + i] = M.x(src[i]); out[o + i + 1] = M.y(src[i + 1]); out[o + i + 2] = src[i + 2]; }
  return out;
}
function bakeScene(W, H, P = prof()) {
  let total = 0;
  for (const p of parts) { total += geoms.get(p.gid).ntri; if (p.supData) total += p.supData.pos.length / 9; }
  const tris = new Float32Array(total * 9), gids = new Uint32Array(total), kind = new Uint8Array(total);
  const M = pixelMapper(P, W, H);
  let o = 0, gid = 0, maxZ = 0;
  const put = (src, start, count, g, sup) => {
    for (let t = start; t < start + count; t++) {
      const b = t * 9, d = o * 9;
      for (let k = 0; k < 9; k += 3) {
        const z = src[b + k + 2];
        tris[d + k] = M.x(src[b + k]); tris[d + k + 1] = M.y(src[b + k + 1]); tris[d + k + 2] = z;
        if (z > maxZ) maxZ = z;
      }
      kind[o] = sup ? 1 : 0; gids[o++] = g;
    }
  };
  for (const p of parts) {
    const w = worldTris(p), pc = geoms.get(p.gid).pieces;
    if (pc) for (let i = 0; i < pc.length; i += 2) put(w, pc[i], pc[i + 1], gid++);
    else put(w, 0, w.length / 9, gid++);
    if (p.supData) { const pc = p.supData.pieces; for (let i = 0; i < pc.length; i += 2) put(p.supData.pos, pc[i], pc[i + 1], gid++, true); }
  }
  return { tris, gids, kind, ntri: o, maxZ };
}
/* layers needed for the scene, never more than fit in the build height */
function maxLayers(P) { return Math.max(1, Math.floor(P.bz / (P.layerUm / 1000) + 1e-7)); }
function layerCount(maxZ, lh, P = prof()) { return maxZ > 0 ? Math.min(maxLayers(P), Math.max(1, Math.ceil(maxZ / lh - 1e-7))) : 0; }
function cutByHeight(maxZ, P = prof()) { return maxZ > 0 && Math.ceil(maxZ / (P.layerUm / 1000) - 1e-7) > maxLayers(P); }

/* triangles grouped into chunks of consecutive layers (CSR), so each job only sees what it can cut;
   below / above: extra layers each chunk must also be able to cut */
function bucketChunks(bk, N, lh, chunk, below = 0, above = 0) {
  const nc = Math.ceil(N / chunk), cnt = new Uint32Array(nc + 1), rng = new Int32Array(bk.ntri * 2), T = bk.tris;
  for (let t = 0; t < bk.ntri; t++) {
    const b = t * 9, z0 = Math.min(T[b + 2], T[b + 5], T[b + 8]), z1 = Math.max(T[b + 2], T[b + 5], T[b + 8]);
    const i0 = Math.max(0, Math.ceil(z0 / lh - 0.5) - 1), i1 = Math.min(N - 1, Math.floor(z1 / lh - 0.5) + 1);
    if (i1 < i0) { rng[t * 2] = -1; continue; }
    const c0 = Math.max(0, Math.floor((i0 - above) / chunk)), c1 = Math.min(nc - 1, Math.floor((i1 + below) / chunk));
    rng[t * 2] = c0; rng[t * 2 + 1] = c1;
    for (let c = c0; c <= c1; c++) cnt[c + 1]++;
  }
  for (let c = 0; c < nc; c++) cnt[c + 1] += cnt[c];
  const fill = cnt.slice(0, nc), idx = new Uint32Array(cnt[nc]);
  for (let t = 0; t < bk.ntri; t++) { if (rng[t * 2] < 0) continue; for (let c = rng[t * 2]; c <= rng[t * 2 + 1]; c++) idx[fill[c]++] = t; }
  return {
    nc,
    get(c) {
      const a = cnt[c], n = cnt[c + 1] - a, tris = new Float32Array(n * 9), gids = new Uint32Array(n), kind = new Uint8Array(n);
      for (let k = 0; k < n; k++) { const t = idx[a + k]; tris.set(T.subarray(t * 9, t * 9 + 9), k * 9); gids[k] = bk.gids[t]; kind[k] = bk.kind[t]; }
      return { tris, gids, kind, ntri: n, l0: c * chunk, l1: Math.min(N, (c + 1) * chunk) };
    }
  };
}

/* ---------- Web Worker pool ---------- */
let workerURL = null;
function spawnWorker() {
  if (!workerURL) {
    const src = `'use strict';\n${gobosliceCore.toString()}\n${gobosliceWorkerMain.toString()}\ngobosliceWorkerMain(gobosliceCore());`;
    workerURL = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  }
  return new Worker(workerURL);
}
function pingWorker(w, ms = 2500) {
  return new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    w.onmessage = (e) => { if (e.data && e.data.type === 'pong') { clearTimeout(t); res(true); } };
    w.onerror = () => { clearTimeout(t); res(false); };
    w.postMessage({ type: 'ping' });
  });
}
async function makePool(n) {
  const ws = [];
  try { for (let i = 0; i < n; i++) ws.push(spawnWorker()); }
  catch (e) { for (const w of ws) w.terminate(); return []; }
  const ok = await Promise.all(ws.map((w) => pingWorker(w)));
  const live = ws.filter((w, i) => { if (!ok[i]) w.terminate(); return ok[i]; });
  return live;
}

/* ---------- Slicing ---------- */
let slicing = null, sliceResult = null;
function setProgress(f, text) {
  $('#prog').classList.add('on');
  $('#progBar').style.width = (clamp(f, 0, 1) * 100).toFixed(1) + '%';
  $('#progText').textContent = text;
}
function invalidateSlice() {
  if (slicing && !slicing.cancelled) slicing.cancel('changed');
  if (sliceResult) { sliceResult = null; $('#btnDownload').disabled = true; }
  if (checkResult) clearCheck();
  updateStats();
}
function confirmBox(title, text, yes = 'Continue') {
  const d = $('#confirmDlg');
  $('#cfTitle').textContent = title; $('#cfText').textContent = text; $('#cfYes').textContent = yes;
  return new Promise((res) => {
    d.addEventListener('close', () => res(d.returnValue === 'yes'), { once: true });
    d.returnValue = '';
    try { d.showModal(); } catch (e) { res(window.confirm(text)); }
  });
}
async function startSlice() {
  if (slicing) return;
  if (!parts.length) { toast('Add a part to slice.'); return; }
  for (const p of parts) p.oob = computeOOB(p);
  if (checkCfg.before) {
    /* pre-slice design check; it also covers parts outside the build volume */
    if (!checkValid()) await runDesignCheck({ quiet: true });
    if (!checkValid()) return;
    const r = checkResult;
    if (r.errors || r.warnings) {
      const go = await confirmBox('Design check', `${checkSummary()}. See Design check for where. Slice anyway?`, 'Slice anyway');
      if (!go) { $('#checkSec').open = true; return; }
    }
  }
  const oob = checkCfg.before ? [] : parts.filter((p) => p.oob);
  if (oob.length) {
    const names = oob.slice(0, 4).map((p) => p.name).join(', ') + (oob.length > 4 ? ` and ${oob.length - 4} more` : '');
    const go = await confirmBox('Parts outside the build area', `${names} ${oob.length === 1 ? 'is' : 'are'} partly outside the build volume. Anything off the plate is cut off in the masks, and anything above the build height is left out. Slice anyway?`, 'Slice anyway');
    if (!go) return;
  }
  const P = normaliseProfile(clone(prof())), D = derived(P), W = P.resX, H = P.resY, lh = D.lh;
  const t0 = performance.now();
  const job = { cancelled: false, reason: '', workers: [], reject: null };
  job.cancel = (why) => {
    job.cancelled = true; job.reason = why || 'user';
    for (const w of job.workers) w.terminate();
    job.workers = [];
    if (job.reject) job.reject(new Error('cancelled'));
  };
  slicing = job;
  $('#btnSlice').disabled = true; $('#btnDownload').disabled = true; updateCheckUI();
  setProgress(0, 'Preparing');
  await new Promise((r) => setTimeout(r, 20));
  try {
    const bk = bakeScene(W, H, P);
    const N = layerCount(bk.maxZ, lh, P);
    if (!N) throw new Error('nothing to slice');
    if (N > 65000) throw new Error(`${N} layers is more than one ZIP can hold here`);
    const results = new Array(N);
    let done = 0, lastUI = 0;
    const aa = aaFor(P);
    const onLayer = (L, lit, islands, png, crc, area) => {
      results[L] = { png, crc, lit, area: area == null ? lit : area }; done++;
      const now = performance.now();
      if (now - lastUI > 80 || done === N) { lastUI = now; setProgress(done / N, `Layer ${done} of ${N}`); }
    };
    const run = await runLayers(bk, N, P, { encode: true, islands: false, aa }, onLayer, job);
    if (job.cancelled) throw new Error('cancelled');
    setProgress(1, 'Writing ZIP');
    await new Promise((r) => setTimeout(r, 0));
    const entries = results.map((r, i) => ({ name: fileName(P, i), data: r.png, crc: r.crc }));
    let totalLit = 0, totalArea = 0; for (const r of results) { totalLit += r.lit; totalArea += r.area; }
    const sliceMs = performance.now() - t0;
    const bounds = sceneBounds(false);
    if (P.preview) {
      try {
        const pv = await renderPreviewPNG(P, N, bounds);
        if (pv) entries.push({ name: 'preview.png', data: pv, crc: Core.crc32(pv) });
      } catch (e) { toast('The preview image could not be rendered, so the ZIP has masks only.', 'warn'); }
    }
    if (job.cancelled) throw new Error('cancelled');
    const blob = makeZip(entries);
    sliceResult = {
      blob, P, N, W, H, lit: results.map((r) => r.lit), area: results.map((r) => r.area), totalLit, totalArea, aa, ms: sliceMs, mode: run.mode, workers: run.workers,
      files: [fileName(P, 0), fileName(P, N - 1)], preview: entries.length > N, bounds, version: sceneVersion
    };
    $('#btnDownload').disabled = false;
    toast(`Sliced ${N} layer${N === 1 ? '' : 's'} in ${fmt(sliceMs / 1000, 1)} s. The ZIP is ready.`);
    drawLayer();
  } catch (e) {
    if (job.cancelled) toast(job.reason === 'changed' ? 'Slicing stopped because the scene changed.' : 'Slicing cancelled.');
    else { console.error(e); toast('Slicing failed: ' + (e && e.message || e), 'warn'); }
  } finally {
    for (const w of job.workers) w.terminate();
    if (slicing === job) slicing = null;
    $('#prog').classList.remove('on');
    $('#btnSlice').disabled = false;
    updateStats(); updateCheckUI();
  }
}
/* Rasterises layers 0..N-1 in the worker pool (or on the main thread if workers are blocked).
   opts.encode: write PNGs; opts.islands: find islands; opts.aa: anti-aliased 8-bit masks ({ S, lo },
   encode only). onLayer(L, lit, islands, png, crc, area), area = lit area in pixels.
   opts.check: design-check rules instead; onLayer(L, result). */
async function runLayers(bk, N, P, opts, onLayer, job) {
  const W = P.resX, H = P.resY, lh = P.layerUm / 1000, R = opts.check;
  /* checks hold run lists, not images, so they can take long chunks; they also need layers below */
  const chunk = R ? clamp(Math.ceil(N / 8), 16, 96) : clamp(Math.round(8e7 / (W * H)), 2, 32);
  const B = R ? bucketChunks(bk, N, lh, chunk, R.gmax + 1, 1) : bucketChunks(bk, N, lh, chunk);
  const nW = clamp((navigator.hardwareConcurrency || 4) - 1, 1, W * H > 2e7 ? 4 : 6);
  let pool = [];
  try { pool = await makePool(Math.min(nW, B.nc)); } catch (e) { pool = []; }
  if (job.cancelled) throw new Error('cancelled');
  if (pool.length) {
    job.workers = pool;
    await new Promise((resolve, reject) => {
      job.reject = reject;
      let next = 0, active = 0;
      const give = (w) => {
        if (job.cancelled) return;
        if (next >= B.nc) { if (active === 0) resolve(); return; }
        const c = B.get(next++);
        active++;
        w.postMessage({ type: 'job', id: next - 1, tris: c.tris, gids: c.gids, kind: c.kind, ntri: c.ntri, l0: c.l0, l1: c.l1, lh, W, H, N, bits: P.bits, encode: opts.encode, islands: opts.islands, aa: opts.aa || null, check: R }, [c.tris.buffer, c.gids.buffer, c.kind.buffer]);
      };
      for (const w of pool) {
        w.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'layer') onLayer(m.layer, m.lit, m.islands, m.png, m.crc, m.area);
          else if (m.type === 'check') onLayer(m.layer, m.res);
          else if (m.type === 'done') { active--; give(w); if (next >= B.nc && active === 0) resolve(); }
          else if (m.type === 'error') reject(new Error(m.message));
        };
        w.onerror = (ev) => { ev.preventDefault(); reject(new Error(ev.message || 'a slicing worker failed')); };
        give(w);
      }
    });
    for (const w of pool) w.terminate();
    job.workers = [];
    return { mode: 'workers', workers: pool.length };
  }
  if (R) {
    for (let c = 0; c < B.nc; c++) {
      if (job.cancelled) throw new Error('cancelled');
      const ch = B.get(c);
      Core.checkRange({ ...ch, lh, W, H, N, check: R }, (L, res) => onLayer(L, res));
      await new Promise((r) => setTimeout(r, 0));
    }
    return { mode: 'main thread', workers: 0 };
  }
  /* main thread: chunks run in order, so island tracking carries straight on from one to the next */
  const st = Core.makeRaster(), mode = opts.encode ? (P.bits === 1 ? 1 : 0) : 3;
  const aa = mode === 0 && !opts.islands && opts.aa ? opts.aa : null;
  const raw = opts.encode ? new Uint8Array(Core.rawSize(W, H, P.bits)) : null;
  if (opts.islands) Core.islandsBegin(st);
  let tick = performance.now();
  for (let c = 0; c < B.nc; c++) {
    const ch = B.get(c);
    for (let L = ch.l0; L < ch.l1; L++) {
      if (job.cancelled) throw new Error('cancelled');
      if (raw) raw.fill(0);
      const z = (L + 0.5) * lh;
      const lit = aa ? Core.rasterLayerAA(st, ch.tris, ch.gids, ch.ntri, z, W, H, raw, 0, aa.S, aa.lo) : Core.rasterLayer(st, ch.tris, ch.gids, ch.ntri, z, W, H, raw, mode);
      const isl = opts.islands ? Core.islandsTake(st, H, L === 0) : null;
      if (raw) { const png = await Core.encodePNG(raw, W, H, P.bits); onLayer(L, lit, isl, png, Core.crc32(png), aa ? st.grey : lit); }
      else onLayer(L, lit, isl);
      if (performance.now() - tick > 30) { await new Promise((r) => setTimeout(r, 0)); tick = performance.now(); }
    }
  }
  return { mode: 'main thread', workers: 0 };
}
function downloadZip() {
  if (!sliceResult) return;
  const base = (parts.length === 1 ? parts[0].name : 'goboslice') + '-' + sliceResult.P.name;
  const name = base.replace(/\.stl$/i, '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '.zip';
  saveBlob(sliceResult.blob, name);
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

/* ---------- ZIP (store method) ---------- */
function makeZip(entries, date = new Date()) {
  if (entries.length > 65535) throw new Error('too many files for a ZIP without ZIP64');
  const dt = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dd = (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const enc = new TextEncoder(), out = [], cen = [];
  let off = 0, cenSize = 0;
  for (const e of entries) {
    const nm = enc.encode(e.name), size = e.data.length, crc = (e.crc != null ? e.crc : Core.crc32(e.data)) >>> 0;
    const lh = new Uint8Array(30 + nm.length), a = new DataView(lh.buffer);
    a.setUint32(0, 0x04034b50, true); a.setUint16(4, 20, true); a.setUint16(6, 0x0800, true); a.setUint16(8, 0, true);
    a.setUint16(10, dt, true); a.setUint16(12, dd, true); a.setUint32(14, crc, true); a.setUint32(18, size, true); a.setUint32(22, size, true);
    a.setUint16(26, nm.length, true); a.setUint16(28, 0, true); lh.set(nm, 30);
    const ch = new Uint8Array(46 + nm.length), c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, nm.length, true); c.setUint16(30, 0, true); c.setUint16(32, 0, true); c.setUint16(34, 0, true); c.setUint16(36, 0, true);
    c.setUint32(38, 0, true); c.setUint32(42, off, true); ch.set(nm, 46);
    out.push(lh, e.data); cen.push(ch);
    off += lh.length + size; cenSize += ch.length;
    if (off + cenSize > 0xFFFFFFFF - 22) throw new Error('the ZIP would be larger than 4 GB');
  }
  const eo = new Uint8Array(22), d = new DataView(eo.buffer);
  d.setUint32(0, 0x06054b50, true); d.setUint16(8, entries.length, true); d.setUint16(10, entries.length, true);
  d.setUint32(12, cenSize, true); d.setUint32(16, off, true);
  return new Blob([...out, ...cen, eo], { type: 'application/zip' });
}

