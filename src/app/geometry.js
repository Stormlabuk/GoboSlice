/* ---------- STL parsing ---------- */
function parseSTL(buf) {
  const dv = new DataView(buf);
  const n = buf.byteLength >= 84 ? dv.getUint32(80, true) : -1;
  if (n >= 0 && 84 + n * 50 === buf.byteLength) return parseBinarySTL(dv, n);
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 512)));
  if (/^\s*solid/i.test(head)) {
    const txt = new TextDecoder().decode(buf);
    if (/facet/i.test(txt)) return parseAsciiSTL(txt);
  }
  if (n > 0 && 84 + n * 50 <= buf.byteLength) return parseBinarySTL(dv, n);
  throw new Error('not a recognisable STL file');
}
function parseBinarySTL(dv, n) {
  const pos = new Float32Array(n * 9);
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12;
    for (let k = 0; k < 9; k++) { pos[i * 9 + k] = dv.getFloat32(o, true); o += 4; }
    o += 2;
  }
  return pos;
}
function parseAsciiSTL(txt) {
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(txt))) out.push(+m[1], +m[2], +m[3]);
  const n = Math.floor(out.length / 9);
  if (!n) throw new Error('no triangles found');
  return new Float32Array(out.slice(0, n * 9));
}
/* Drop degenerate / non-finite triangles */
function cleanTris(pos) {
  const n = pos.length / 9; let w = 0;
  for (let t = 0; t < n; t++) {
    const b = t * 9; let ok = true;
    for (let k = 0; k < 9; k++) if (!isFinite(pos[b + k])) { ok = false; break; }
    if (ok) {
      const c = V.cross([pos[b + 3] - pos[b], pos[b + 4] - pos[b + 1], pos[b + 5] - pos[b + 2]], [pos[b + 6] - pos[b], pos[b + 7] - pos[b + 1], pos[b + 8] - pos[b + 2]]);
      if (c[0] === 0 && c[1] === 0 && c[2] === 0) ok = false;
    }
    if (ok) { if (w !== t) pos.copyWithin(w * 9, b, b + 9); w++; }
  }
  return w === n ? pos : pos.slice(0, w * 9);
}

/* ---------- Geometry registry ----------
   Geometries are kept even after their parts are deleted so undo can restore them. */
const geoms = new Map();
let nextGeomId = 1;
/* pieces: optional [first triangle, count, ...] of separate closed solids in pos (from Combine);
   they are sliced as separate groups, so where they overlap the result is still solid */
function addGeometry(name, pos, pieces) {
  if (!pieces) pos = cleanTris(pos);
  if (!pos.length) throw new Error('the file has no usable triangles');
  const n = pos.length / 9;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  for (let i = 0; i < pos.length; i += 3) { pos[i] -= c[0]; pos[i + 1] -= c[1]; pos[i + 2] -= c[2]; }
  let vol = 0;
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    vol += pos[b] * (pos[b + 4] * pos[b + 8] - pos[b + 5] * pos[b + 7])
      - pos[b + 1] * (pos[b + 3] * pos[b + 8] - pos[b + 5] * pos[b + 6])
      + pos[b + 2] * (pos[b + 3] * pos[b + 7] - pos[b + 4] * pos[b + 6]);
  }
  let flipped = false;
  if (vol < 0) {
    flipped = true;
    for (let t = 0; t < n; t++) {
      const b = t * 9;
      for (let k = 0; k < 3; k++) { const s = pos[b + 3 + k]; pos[b + 3 + k] = pos[b + 6 + k]; pos[b + 6 + k] = s; }
    }
  }
  const g = { id: nextGeomId++, name, pos, ntri: n, pieces: pieces || null, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]], vol: Math.abs(vol) / 6, three: null, face: null, weld: null, flipped };
  geoms.set(g.id, g);
  return g;
}
function geomThree(g) {
  if (!g.three) {
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(g.pos, 3));
    bg.computeVertexNormals();
    bg.computeBoundingBox(); bg.computeBoundingSphere();
    g.three = bg;
  }
  return g.three;
}
/* local face normals, plane offsets and areas */
function geomFaces(g) {
  if (g.face) return g.face;
  const n = g.ntri, p = g.pos, N = new Float32Array(n * 3), D = new Float32Array(n), A = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const b = t * 9;
    const c = V.cross([p[b + 3] - p[b], p[b + 4] - p[b + 1], p[b + 5] - p[b + 2]], [p[b + 6] - p[b], p[b + 7] - p[b + 1], p[b + 8] - p[b + 2]]);
    const l = V.len(c) || 1;
    N[t * 3] = c[0] / l; N[t * 3 + 1] = c[1] / l; N[t * 3 + 2] = c[2] / l;
    D[t] = N[t * 3] * p[b] + N[t * 3 + 1] * p[b + 1] + N[t * 3 + 2] * p[b + 2];
    A[t] = l / 2;
  }
  g.face = { N, D, A };
  return g.face;
}
/* weld vertices at 1 µm; corner -> vertex index, vertex -> triangles (CSR) */
function geomWeld(g) {
  if (g.weld) return g.weld;
  const p = g.pos, n = g.ntri, map = new Map(), corner = new Uint32Array(n * 3), verts = [];
  for (let i = 0; i < n * 3; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const key = Math.round(x * 1000) + ',' + Math.round(y * 1000) + ',' + Math.round(z * 1000);
    let id = map.get(key);
    if (id === undefined) { id = verts.length / 3; map.set(key, id); verts.push(x, y, z); }
    corner[i] = id;
  }
  const nv = verts.length / 3, off = new Uint32Array(nv + 1);
  for (let i = 0; i < n * 3; i++) off[corner[i] + 1]++;
  for (let i = 0; i < nv; i++) off[i + 1] += off[i];
  const fill = off.slice(0, nv), tri = new Uint32Array(n * 3);
  for (let i = 0; i < n * 3; i++) tri[fill[corner[i]]++] = (i / 3) | 0;
  g.weld = { verts: new Float32Array(verts), corner, off, tri, nv };
  return g.weld;
}

/* ---------- Built-in test shapes ---------- */
function boxTris(x0, y0, z0, x1, y1, z1, out = []) {
  const c = (i, j, k) => [i ? x1 : x0, j ? y1 : y0, k ? z1 : z0];
  const q = (a, b, cc, d) => out.push(...a, ...b, ...cc, ...a, ...cc, ...d);
  q(c(0, 0, 0), c(0, 1, 0), c(1, 1, 0), c(1, 0, 0)); q(c(0, 0, 1), c(1, 0, 1), c(1, 1, 1), c(0, 1, 1));
  q(c(0, 0, 0), c(1, 0, 0), c(1, 0, 1), c(0, 0, 1)); q(c(0, 1, 0), c(0, 1, 1), c(1, 1, 1), c(1, 1, 0));
  q(c(0, 0, 0), c(0, 0, 1), c(0, 1, 1), c(0, 1, 0)); q(c(1, 0, 0), c(1, 1, 0), c(1, 1, 1), c(1, 0, 1));
  return out;
}
function sampleShape(kind) {
  if (kind === 'box') return { name: 'box-2x1x1', pos: new Float32Array(boxTris(-1, -0.5, -0.5, 1, 0.5, 0.5)) };
  if (kind === 'rod') {
    const mb = new MeshBuilder(); frustum(mb, [0, 0, 0], [6, 0, 0], 0.4, 0.4, 32);
    return { name: 'rod-0.8x6', pos: new Float32Array(mb.a) };
  }
  if (kind === 'plate') {
    const t = boxTris(-3, -2, -0.15, 3, 2, 0.15), R = Q.toMat3(Q.fromEuler([28, -17, 9]));
    for (let i = 0; i < t.length; i += 3) { const v = m3v(R, [t[i], t[i + 1], t[i + 2]]); t[i] = v[0]; t[i + 1] = v[1]; t[i + 2] = v[2]; }
    return { name: 'tilted-plate', pos: new Float32Array(t) };
  }
  /* an "F" made of three touching, non-overlapping boxes: asymmetric in X and Y */
  const t = [];
  boxTris(0, 0, 0, 0.6, 3, 0.4, t); boxTris(0.6, 2.4, 0, 2.2, 3, 0.4, t); boxTris(0.6, 1.2, 0, 1.6, 1.8, 0.4, t);
  return { name: 'mirror-test-F', pos: new Float32Array(t) };
}
