/* ---------- Support geometry ----------
   Every piece (tip, connection, pillar, base, landing tip, brace, raft) is its own
   closed mesh with outward winding, recorded as a triangle range for slicing. */
class MeshBuilder {
  constructor() { this.a = []; this.sup = []; this.pieces = []; this.cur = -1; this.start = 0; }
  begin(si) { this.cur = si; this.start = this.a.length / 9; }
  end() { const n = this.a.length / 9 - this.start; if (n > 0) this.pieces.push(this.start, n); }
  tri(A, B, Cc) { this.a.push(A[0], A[1], A[2], B[0], B[1], B[2], Cc[0], Cc[1], Cc[2]); this.sup.push(this.cur); }
}
function frustum(mb, p0, p1, r0, r1, seg = 10) {
  const ax = V.norm(V.sub(p1, p0));
  const h = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = V.norm(V.cross(h, ax)), v = V.cross(ax, u);
  const ring = (c, r) => { const o = []; for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2, ca = Math.cos(a) * r, sa = Math.sin(a) * r; o.push([c[0] + u[0] * ca + v[0] * sa, c[1] + u[1] * ca + v[1] * sa, c[2] + u[2] * ca + v[2] * sa]); } return o; };
  const b0 = ring(p0, Math.max(r0, 1e-4)), b1 = ring(p1, Math.max(r1, 1e-4));
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    mb.tri(b0[i], b0[j], b1[j]); mb.tri(b0[i], b1[j], b1[i]);
    mb.tri(p1, b1[i], b1[j]); mb.tri(p0, b0[j], b0[i]);
  }
}
function sphere(mb, c, r, nl = 6, nm = 10) {
  const P = (j, i) => { const ph = j / nl * Math.PI, th = i / nm * Math.PI * 2; return [c[0] + r * Math.sin(ph) * Math.cos(th), c[1] + r * Math.sin(ph) * Math.sin(th), c[2] + r * Math.cos(ph)]; };
  for (let j = 0; j < nl; j++) for (let i = 0; i < nm; i++) {
    const a = P(j, i), b = P(j + 1, i), cc = P(j + 1, i + 1), d = P(j, i + 1);
    if (j > 0) mb.tri(a, b, d === a ? cc : d);
    if (j < nl - 1) mb.tri(b, cc, d);
    else if (j === nl - 1 && j === 0) mb.tri(a, b, cc);
  }
}
function boxMesh(mb, x0, y0, z0, x1, y1, z1) {
  const t = boxTris(x0, y0, z0, x1, y1, z1);
  for (let i = 0; i < t.length; i += 9) mb.tri([t[i], t[i + 1], t[i + 2]], [t[i + 3], t[i + 4], t[i + 5]], [t[i + 6], t[i + 7], t[i + 8]]);
}
function buildSupportGeometry(p) {
  const D = supDims(), c = supCfg, mb = new MeshBuilder(), pillars = [];
  const platZ = D.platZ;
  p.sup.forEach((s, si) => {
    const T = s.t, n = V.norm(s.n || [0, 0, -1]);
    let top;
    mb.begin(si);
    if (c.tipShape === 'sphere') { top = V.add(T, V.mul(n, D.tipR - D.depth)); sphere(mb, top, D.tipR); }
    else top = V.sub(T, V.mul(n, D.depth));
    mb.end();
    const x = top[0], y = top[1];
    const landRef = s.l == null ? platZ + D.baseH : s.l;
    const span = Math.max(0.01, top[2] - landRef);
    const landLen = s.l == null ? 0 : Math.min(D.connLen, span * 0.3);
    const connLen = Math.max(0.005, Math.min(D.connLen, (span - landLen) * (s.l == null ? 0.7 : 0.55)));
    const cb = [x, y, top[2] - connLen];
    mb.begin(si);
    if (c.conn === 'cone') frustum(mb, cb, top, D.lowR, D.upR); else frustum(mb, cb, top, D.upR, D.upR);
    mb.end();
    const pb = s.l == null ? platZ + D.baseH - 0.005 : s.l + landLen - 0.005, pt = cb[2] + 0.005;
    if (pt - pb > 0.01) { mb.begin(si); frustum(mb, [x, y, pb], [x, y, pt], D.pilR, D.pilR); mb.end(); }
    mb.begin(si);
    if (s.l == null) frustum(mb, [x, y, D.raft ? platZ - 0.005 : 0], [x, y, platZ + D.baseH], D.baseR, D.baseR);
    else frustum(mb, [x, y, s.l - D.depth], [x, y, s.l + landLen], D.upR, D.lowR);
    mb.end();
    if (s.l == null) pillars.push({ x, y, zb: pb, zt: pt, si });
  });
  if (c.braces && pillars.length > 1) {
    const done = new Set(), br = D.pilR * 0.55;
    for (let i = 0; i < pillars.length; i++) {
      const A = pillars[i];
      const near = pillars.map((B, j) => [j, Math.hypot(B.x - A.x, B.y - A.y)]).filter(([j, d]) => j !== i && d > 1e-3 && d <= c.braceReach).sort((a, b) => a[1] - b[1]).slice(0, 2);
      for (const [j, d] of near) {
        const key = Math.min(i, j) + ':' + Math.max(i, j);
        if (done.has(key)) continue; done.add(key);
        const B = pillars[j], zl = Math.min(A.zt, B.zt) - 0.01;
        let z = Math.max(c.braceStart, A.zb, B.zb), up = true;
        while (z + d <= zl) {
          const f = up ? A : B, t = up ? B : A;
          mb.begin(A.si); frustum(mb, [f.x, f.y, z], [t.x, t.y, z + d], br, br, 8); mb.end();
          z += d; up = !up;
        }
      }
    }
  }
  if (D.raft && pillars.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of pillars) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    const m = D.baseR + D.margin;
    mb.begin(-1); boxMesh(mb, x0 - m, y0 - m, 0, x1 + m, y1 + m, D.raftT); mb.end();
  }
  const pos = new Float32Array(mb.a);
  let B = null;
  if (pos.length) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
    B = { min: mn, max: mx };
  }
  return { pos, triSup: Int32Array.from(mb.sup), pieces: mb.pieces, bounds: B };
}
function rebuildSupportMesh(p) {
  if (p.supMesh) { supGroup.remove(p.supMesh, p.supBack); p.supMesh.geometry.dispose(); p.supMesh = p.supBack = null; }
  p.supData = null; p.supB = null;
  p._supKey = JSON.stringify([p.sup, supCfg]);
  if (!p.sup.length) return;
  const d = buildSupportGeometry(p);
  p.supData = d; p.supB = d.bounds;
  if (!renderer || !d.pos.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
  g.computeVertexNormals(); g.computeBoundingSphere(); g.computeBoundingBox();
  p.supMesh = new THREE.Mesh(g, mats.supFront);
  p.supBack = new THREE.Mesh(g, mats.supBack);
  p.supMesh.userData.supPart = p;
  p.supBack.raycast = () => {};
  supGroup.add(p.supBack, p.supMesh);
}

/* ---------- Vertical ray casting ---------- */
function buildRayGrid(W, cellHint) {
  const n = W.length / 9, N = new Float32Array(n * 3);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    const c = V.cross([W[b + 3] - W[b], W[b + 4] - W[b + 1], W[b + 5] - W[b + 2]], [W[b + 6] - W[b], W[b + 7] - W[b + 1], W[b + 8] - W[b + 2]]);
    const l = V.len(c) || 1;
    N[t * 3] = c[0] / l; N[t * 3 + 1] = c[1] / l; N[t * 3 + 2] = c[2] / l;
    for (let k = 0; k < 9; k += 3) { const x = W[b + k], y = W[b + k + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const span = Math.max(x1 - x0, y1 - y0, 1e-6);
  const cell = Math.max(cellHint || 0, span / 256, 1e-4);
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 1), ny = Math.max(1, Math.ceil((y1 - y0) / cell) + 1);
  const cnt = new Uint32Array(nx * ny + 1);
  const rng = new Int32Array(n * 4);
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    const tx0 = Math.min(W[b], W[b + 3], W[b + 6]), tx1 = Math.max(W[b], W[b + 3], W[b + 6]);
    const ty0 = Math.min(W[b + 1], W[b + 4], W[b + 7]), ty1 = Math.max(W[b + 1], W[b + 4], W[b + 7]);
    const i0 = Math.floor((tx0 - x0) / cell), i1 = Math.floor((tx1 - x0) / cell), j0 = Math.floor((ty0 - y0) / cell), j1 = Math.floor((ty1 - y0) / cell);
    rng[t * 4] = i0; rng[t * 4 + 1] = i1; rng[t * 4 + 2] = j0; rng[t * 4 + 3] = j1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cnt[j * nx + i + 1]++;
  }
  for (let i = 0; i < nx * ny; i++) cnt[i + 1] += cnt[i];
  const fill = cnt.slice(0, nx * ny), idx = new Uint32Array(cnt[nx * ny]);
  for (let t = 0; t < n; t++) for (let j = rng[t * 4 + 2]; j <= rng[t * 4 + 3]; j++) for (let i = rng[t * 4]; i <= rng[t * 4 + 1]; i++) idx[fill[j * nx + i]++] = t;
  return { W, N, x0, y0, cell, nx, ny, cnt, idx };
}
/* all surface crossings of the vertical line at (x, y), sorted by z */
function rayHits(G, x, y) {
  const i = Math.floor((x - G.x0) / G.cell), j = Math.floor((y - G.y0) / G.cell);
  if (i < 0 || j < 0 || i >= G.nx || j >= G.ny) return [];
  const c = j * G.nx + i, W = G.W, out = [];
  for (let k = G.cnt[c]; k < G.cnt[c + 1]; k++) {
    const t = G.idx[k], b = t * 9;
    const ax = W[b], ay = W[b + 1], bx = W[b + 3], by = W[b + 4], cx = W[b + 6], cy = W[b + 7];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-14) continue;
    const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    const l3 = 1 - l1 - l2, e = -1e-9;
    if (l1 < e || l2 < e || l3 < e) continue;
    out.push({ z: l1 * W[b + 2] + l2 * W[b + 5] + l3 * W[b + 8], n: [G.N[t * 3], G.N[t * 3 + 1], G.N[t * 3 + 2]], t });
  }
  out.sort((a, b) => a.z - b.z);
  const ded = [];
  for (const h of out) { const l = ded[ded.length - 1]; if (l && Math.abs(l.z - h.z) < 1e-7 && Math.sign(l.n[2]) === Math.sign(h.n[2])) continue; ded.push(h); }
  return ded;
}

/* Platform-only mode: the whole column (tip, pillar and base) must stand clear of the part.
   Rays around the column ring must not meet any surface lower than the contact itself,
   allowing only for the slope of the overhang being supported. */
function pathClear(G, x, y, z, D, c) {
  const r = Math.max(D.pilR, D.baseR, D.lowR) + 0.01;
  const slack = r * Math.min(3, Math.tan(Math.max(1, c.overhang) * DEG)) + D.depth + 0.01;
  for (const rr of [r * 0.5, r]) for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2, hs = rayHits(G, x + rr * Math.cos(a), y + rr * Math.sin(a));
    if (hs.length && hs[0].z < z - slack) return false;
  }
  return true;
}

/* ---------- Automatic supports ---------- */
function autoSupport(p, opt = {}) {
  const c = supCfg, D = supDims();
  if (!opt.onBed && p.zb < c.lift - 1e-9) { p.zb = c.lift; updateWorld(p); }
  const W = worldTris(p), sp = D.spacing;
  const G = buildRayGrid(W, sp * 0.75);
  const cosA = Math.cos(c.overhang * DEG);
  const minZ = Math.max(opt.minZ != null ? opt.minZ : -Infinity, c.minZOn ? c.minZ : -Infinity);
  const minPlat = D.platZ + D.baseH + 0.05;
  const sups = [];
  const decide = (x, y, hit, below) => {
    if (hit.z < minZ) return;
    if (!below) { if (hit.z >= minPlat && pathClear(G, x, y, hit.z, D, c)) sups.push({ t: [x, y, hit.z], n: hit.n, l: null }); return; }
    if (c.platformOnly || below.n[2] <= 0.01 || hit.z - below.z < D.gapMin) return;
    sups.push({ t: [x, y, hit.z], n: hit.n, l: below.z });
  };
  const wb = p.wb, w = wb.max[0] - wb.min[0], d = wb.max[1] - wb.min[1];
  const nx = Math.floor(w / sp) + 1, ny = Math.floor(d / sp) + 1;
  const sx = (wb.min[0] + wb.max[0]) / 2 - (nx - 1) / 2 * sp, sy = (wb.min[1] + wb.max[1]) / 2 - (ny - 1) / 2 * sp;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = sx + i * sp, y = sy + j * sp, hits = rayHits(G, x, y);
    for (let k = 0; k < hits.length; k++) if (hits[k].n[2] <= -cosA) decide(x, y, hits[k], k ? hits[k - 1] : null);
  }
  /* local-minimum vertices */
  const wl = geomWeld(geoms.get(p.gid)), L = p.L, t = p.t;
  const vz = new Float32Array(wl.nv), vx = new Float32Array(wl.nv), vy = new Float32Array(wl.nv);
  for (let v = 0; v < wl.nv; v++) {
    const x = wl.verts[v * 3], y = wl.verts[v * 3 + 1], z = wl.verts[v * 3 + 2];
    vx[v] = L[0] * x + L[1] * y + L[2] * z + t[0]; vy[v] = L[3] * x + L[4] * y + L[5] * z + t[1]; vz[v] = L[6] * x + L[7] * y + L[8] * z + t[2];
  }
  const near = 0.6 * sp, hc = near, hash = new Map();
  const hkey = (x, y) => Math.floor(x / hc) + ',' + Math.floor(y / hc);
  const addHash = (x, y) => { const k = hkey(x, y); if (!hash.has(k)) hash.set(k, []); hash.get(k).push([x, y]); };
  const tooClose = (x, y) => {
    const i = Math.floor(x / hc), j = Math.floor(y / hc);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const l = hash.get((i + a) + ',' + (j + b)); if (l) for (const q of l) if (Math.hypot(q[0] - x, q[1] - y) < near) return true; }
    return false;
  };
  for (const s of sups) addHash(s.t[0], s.t[1]);
  for (let v = 0; v < wl.nv; v++) {
    const z = vz[v];
    if (z < minZ) continue;
    let ok = true, nsum = [0, 0, 0];
    for (let k = wl.off[v]; k < wl.off[v + 1]; k++) {
      const tr = wl.tri[k];
      for (let q = 0; q < 3; q++) { const o = wl.corner[tr * 3 + q]; if (o !== v && vz[o] < z - 1e-9) { ok = false; break; } }
      if (!ok) break;
      nsum = V.add(nsum, [G.N[tr * 3], G.N[tr * 3 + 1], G.N[tr * 3 + 2]]);
    }
    if (!ok || tooClose(vx[v], vy[v])) continue;
    let n = V.norm(nsum); if (n[2] > -0.3) n = [0, 0, -1];
    const hits = rayHits(G, vx[v], vy[v]).filter((h) => h.z < z - 1e-4);
    const before = sups.length;
    decide(vx[v], vy[v], { z, n }, hits.length ? hits[hits.length - 1] : null);
    if (sups.length > before) addHash(vx[v], vy[v]);
  }
  p.sup = sups;
  rebuildSupportMesh(p);
  return sups.length;
}
function opAutoSupport(list) {
  if (!list.length) { toast('Add a part first.'); return; }
  pushUndo();
  let n = 0;
  for (const p of list) n += autoSupport(p);
  changed({ keepPanel: true });
  toast(`Added ${n} support${n === 1 ? '' : 's'} to ${list.length === 1 ? list[0].name : list.length + ' parts'}.`);
}
function opRemoveSupports(list) {
  const hit = list.filter((p) => p.sup.length);
  if (!hit.length) { toast('No supports to remove.'); return; }
  pushUndo();
  for (const p of hit) { p.sup = []; rebuildSupportMesh(p); }
  changed({ keepPanel: true });
}
function opRemoveOneSupport(p, si) {
  if (!p || si == null || si < 0 || si >= p.sup.length) { if (si === -1) toast('That is the raft. Turn the raft off in Supports.'); return; }
  pushUndo();
  p.sup.splice(si, 1);
  rebuildSupportMesh(p);
  changed({ keepPanel: true });
}
function opAddSupportAt(p, point, normal) {
  const c = supCfg, D = supDims();
  if (normal[2] > -0.05) { toast('Pick a point on a face that points down.'); return; }
  const G = buildRayGrid(worldTris(p), D.spacing);
  const hits = rayHits(G, point.x, point.y).filter((h) => h.z < point.z - 1e-4);
  const below = hits.length ? hits[hits.length - 1] : null;
  let s;
  if (!below) {
    if (point.z < D.platZ + D.baseH + 0.05) { toast('Too close to the platform for a support. Raise the part first.'); return; }
    if (!pathClear(G, point.x, point.y, point.z, D, c)) { toast('A support here would touch the part on its way down. Pick a point further from the walls below.'); return; }
    s = { t: [point.x, point.y, point.z], n: normal, l: null };
  } else {
    if (c.platformOnly) { toast('Part of the model is below this point, and supports are set to stand on the platform only.'); return; }
    if (below.n[2] <= 0.01 || point.z - below.z < D.gapMin) { toast('No clear path below this point.'); return; }
    s = { t: [point.x, point.y, point.z], n: normal, l: below.z };
  }
  pushUndo();
  p.sup.push(s);
  rebuildSupportMesh(p);
  changed({ keepPanel: true });
}
