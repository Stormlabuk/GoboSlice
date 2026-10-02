/* ---------- Arrange (shelf packing) ---------- */
function arrangeAll(gapOverride, opts = {}) {
  if (!parts.length) { if (!opts.quiet) toast('Nothing to arrange yet.'); return true; }
  if (!opts.noUndo) pushUndo();
  const P = prof(), D = derived(P), gap = gapOverride != null ? gapOverride : arrangeGap;
  const items = parts.map((p) => { const b = footprint(p); return { p, b, w: b.max[0] - b.min[0], d: b.max[1] - b.min[1] }; });
  items.sort((a, b) => (b.d - a.d) || (b.w - a.w));
  const S = seamAware ? seamStrips(P) : null;
  if (S) {
    const pad = Math.min(opts.pad || 0, gap / 2);
    const fits = packClearOfSeams(items, D, gap - 2 * pad, pad, S);
    if (!opts.noUndo) changed({ keepPanel: true });
    if (!fits && !opts.quiet) toast(`Not every part fits on the ${fmt(P.bx)} × ${fmt(P.by)} mm plate clear of the field seams. Some are outside the build area.`, 'warn');
    return fits;
  }
  const limit = P.bx;
  const rows = [];
  let row = null;
  for (const it of items) {
    if (!row || (row.items.length && row.w + gap + it.w > limit + 1e-9)) { row = { items: [], w: 0, d: 0 }; rows.push(row); }
    it.rx = row.items.length ? row.w + gap : 0;
    row.w = it.rx + it.w; row.d = Math.max(row.d, it.d);
    row.items.push(it);
  }
  const totalD = rows.reduce((s, r) => s + r.d, 0) + gap * (rows.length - 1);
  const totalW = Math.max(...rows.map((r) => r.w));
  /* rows run from the back of the plate towards the front, each row centred in X */
  let y = D.cy + totalD / 2;
  for (const r of rows) {
    const x0 = D.cx - r.w / 2;
    for (const it of r.items) {
      const cx = x0 + it.rx + it.w / 2, cy = y - it.d / 2;
      translatePart(it.p, cx - (it.b.min[0] + it.b.max[0]) / 2, cy - (it.b.min[1] + it.b.max[1]) / 2);
    }
    y -= r.d + gap;
  }
  const fits = totalW <= P.bx + 1e-6 && totalD <= P.by + 1e-6;
  if (!opts.noUndo) changed({ keepPanel: true });
  if (!fits && !opts.quiet) toast(`The parts need ${fmt(totalW)} × ${fmt(totalD)} mm but the plate is ${fmt(P.bx)} × ${fmt(P.by)} mm. Some are outside the build area.`, 'warn');
  return fits;
}

/* Shelf packing from the back-left corner that steps over the overlap strips between fields.
   pad is extra room kept round each footprint (for supports added later). A part too big for
   any single field is placed across the strips as it has to be. */
function packClearOfSeams(items, D, gap, pad, S) {
  const e = 1e-6;
  const cells = (lo, hi, strips) => { const out = []; let a = lo; for (const [s0, s1] of strips) { out.push(s0 - a); a = s1; } out.push(hi - a); return Math.max(...out); };
  const maxW = cells(D.x0, D.x1, S.xs), maxD = cells(D.y0, D.y1, S.ys);
  /* slide [x, x + w] right, or [y - d, y] towards the front, until it cuts into no strip */
  const clearX = (x, w) => { if (w > maxW + e) return x; for (let k = 0; k < 256; k++) { const s = S.xs.find(([a, b]) => x + w > a + e && x < b - e); if (!s) break; x = s[1]; } return x; };
  const clearY = (y, d) => { if (d > maxD + e) return y; for (let k = 0; k < 256; k++) { const s = S.ys.find(([a, b]) => y > a + e && y - d < b - e); if (!s) break; y = s[0]; } return y; };
  let left = items.slice(), y = D.y1, fits = true;
  while (left.length) {
    const rowD = left[0].d + 2 * pad, top = clearY(y, rowD), row = new Set();
    let x = D.x0;
    for (const it of left) {
      const w = it.w + 2 * pad, at = clearX(x, w);
      if (row.size && at + w > D.x1 + e) continue;
      row.add(it);
      translatePart(it.p, at + pad - it.b.min[0], top - pad - it.b.max[1]);
      if (at + w > D.x1 + e || top - (it.d + 2 * pad) < D.y0 - e) fits = false;
      x = at + w + gap;
    }
    left = left.filter((it) => !row.has(it));
    y = top - rowD - gap;
  }
  return fits;
}

/* ---------- Magic wand: orient ---------- */
function magicOrient(p) {
  const g = geoms.get(p.gid), src = g.pos, n = g.ntri;
  const s = [0, 1, 2].map((i) => p.scale[i] * (p.mir[i] ? -1 : 1));
  const flip = s[0] * s[1] * s[2] < 0;
  /* scaled local vertices (rotation is what we are choosing) */
  const P = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) { P[i] = src[i] * s[0]; P[i + 1] = src[i + 1] * s[1]; P[i + 2] = src[i + 2] * s[2]; }
  const N = new Float32Array(n * 3), A = new Float32Array(n);
  let total = 0;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    let c = V.cross([P[b + 3] - P[b], P[b + 4] - P[b + 1], P[b + 5] - P[b + 2]], [P[b + 6] - P[b], P[b + 7] - P[b + 1], P[b + 8] - P[b + 2]]);
    if (flip) c = V.mul(c, -1);
    const l = V.len(c) || 1;
    N[t * 3] = c[0] / l; N[t * 3 + 1] = c[1] / l; N[t * 3 + 2] = c[2] / l; A[t] = l / 2; total += l / 2;
    for (let k = 0; k < 9; k++) { const v = P[b + k], a = k % 3; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
  }
  if (!(total > 0)) return { onBed: false };
  const diag = Math.max(1e-6, Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]));
  /* flat-face clusters: bucket normals at ~1.5° */
  const q = Math.sin(1.5 * DEG), buckets = new Map();
  for (let t = 0; t < n; t++) {
    const key = Math.round(N[t * 3] / q) + ',' + Math.round(N[t * 3 + 1] / q) + ',' + Math.round(N[t * 3 + 2] / q);
    let e = buckets.get(key);
    if (!e) { e = { a: 0, s: [0, 0, 0] }; buckets.set(key, e); }
    e.a += A[t]; e.s[0] += N[t * 3] * A[t]; e.s[1] += N[t * 3 + 1] * A[t]; e.s[2] += N[t * 3 + 2] * A[t];
  }
  const clusters = [...buckets.values()].sort((a, b) => b.a - a.a).slice(0, 14).map((e) => V.norm(e.s));
  const cur = m3v(m3T(Q.toMat3(Q.fromEuler(p.rot))), [0, 0, -1]);
  const cands = [];
  const cosDup = Math.cos(2 * DEG);
  for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], ...clusters]) {
    if (!cands.some((c) => V.dot(c, d) > cosDup)) cands.push(d);
  }
  const c = supCfg, D = supDims();
  const cosO = Math.cos(c.overhang * DEG), nearH = (c.raft ? c.raftT : 0) + c.baseH + 0.1;
  const tol = Math.max(1e-3, diag * 2e-4);
  let best = null;
  for (const d of cands) {
    let bed = -Infinity, low = Infinity;
    for (let i = 0; i < P.length; i += 3) { const v = P[i] * d[0] + P[i + 1] * d[1] + P[i + 2] * d[2]; if (v > bed) bed = v; if (v < low) low = v; }
    let contact = 0, near = 0, over = 0;
    for (let t = 0; t < n; t++) {
      const nd = N[t * 3] * d[0] + N[t * 3 + 1] * d[1] + N[t * 3 + 2] * d[2];
      if (nd < cosO) continue;
      const b = t * 9;
      const p0 = P[b] * d[0] + P[b + 1] * d[1] + P[b + 2] * d[2];
      const p1 = P[b + 3] * d[0] + P[b + 4] * d[1] + P[b + 5] * d[2];
      const p2 = P[b + 6] * d[0] + P[b + 7] * d[1] + P[b + 8] * d[2];
      const lowest = Math.max(p0, p1, p2);
      if (nd > 0.999 && bed - Math.min(p0, p1, p2) <= tol) contact += A[t];
      else if (bed - lowest <= nearH) near += A[t];
      else over += A[t];
    }
    const onBed = contact >= 0.01 * total;
    let cost = (over + near + (onBed ? 0 : contact)) / total + 0.12 * (bed - low) / diag;
    if (V.dot(d, cur) > 0.9999) cost -= 1e-4;
    if (!best || cost < best.cost - 1e-12) best = { d, cost, onBed };
  }
  /* rotate the chosen direction to straight down, then spin about Z to minimise the footprint */
  const q0 = Q.fromUnitVectors(best.d, [0, 0, -1]), R0 = Q.toMat3(q0);
  const stride = Math.max(1, Math.floor(P.length / 3 / 60000));
  const xs = [], ys = [];
  for (let i = 0; i < P.length / 3; i += stride) { const v = m3v(R0, [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]); xs.push(v[0]); ys.push(v[1]); }
  let bestA = 0, bestArea = Infinity;
  for (let a = 0; a < 90; a += 5) {
    const ca = Math.cos(a * DEG), sa = Math.sin(a * DEG);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      const x = ca * xs[i] - sa * ys[i], y = sa * xs[i] + ca * ys[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea * (1 - 1e-3)) { bestArea = area; bestA = a; }
  }
  /* of the two equal rectangles 90° apart, lay the long side along the plate's long side */
  {
    const ca = Math.cos(bestA * DEG), sa = Math.sin(bestA * DEG);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < xs.length; i++) { const x = ca * xs[i] - sa * ys[i], y = sa * xs[i] + ca * ys[i]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const Pp = prof();
    if ((x1 - x0) + 1e-6 < (y1 - y0) && Pp.bx >= Pp.by) bestA += 90;
    else if ((y1 - y0) + 1e-6 < (x1 - x0) && Pp.by > Pp.bx) bestA += 90;
  }
  p.rot = Q.toEuler(Q.mul(Q.axis([0, 0, 1], bestA * DEG), q0));
  return { onBed: best.onBed };
}

function opMagic() {
  if (!parts.length) { toast('Add a part first, then the wand will orient, arrange and support it.'); return; }
  pushUndo();
  const t0 = performance.now();
  const c = supCfg, D = supDims();
  const res = new Map();
  for (const p of parts) {
    const r = magicOrient(p);
    res.set(p, r);
    p.sup = []; p.zb = 0;
    recomputeLinear(p);
    rebuildSupportMesh(p);
  }
  const widen = 2 * (D.baseR + (c.raft ? D.margin : 0));
  const fits = arrangeAll(arrangeGap + widen, { noUndo: true, quiet: true, pad: widen / 2 });
  let onBed = 0, lifted = 0, nsup = 0;
  for (const p of parts) {
    if (res.get(p).onBed) {
      onBed++;
      p.zb = 0; updateWorld(p);
      nsup += autoSupport(p, { onBed: true, minZ: D.platZ + D.baseH + 0.1 });
    } else {
      lifted++;
      nsup += autoSupport(p);
    }
  }
  changed();
  fitView();
  const bits = [];
  if (onBed) bits.push(`${onBed} on the plate`);
  if (lifted) bits.push(`${lifted} lifted on supports`);
  toast(`Magic done in ${fmt((performance.now() - t0) / 1000, 1)} s: ${bits.join(', ')}, ${nsup} support${nsup === 1 ? '' : 's'} in total.${fits ? '' : ' Not everything fits on the plate.'}`, fits ? '' : 'warn');
}
