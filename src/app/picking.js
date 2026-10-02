/* ---------- Picking ---------- */
let raycaster = null, pickMat = null, hover = null;
function ndc(cx, cy) { const r = canvas.getBoundingClientRect(); return { x: ((cx - r.left) / r.width) * 2 - 1, y: -((cy - r.top) / r.height) * 2 + 1 }; }
function pick(cx, cy) {
  if (!renderer) return null;
  if (!raycaster) { raycaster = new THREE.Raycaster(); pickMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }); }
  scene.updateMatrixWorld(true);
  const n = ndc(cx, cy);
  raycaster.setFromCamera(n, camera);
  const objs = parts.map((p) => p.mesh);
  if (showSupports) for (const p of parts) if (p.supMesh) objs.push(p.supMesh);
  const saved = objs.map((o) => o.material);
  for (const o of objs) o.material = pickMat;
  let hits;
  try { hits = raycaster.intersectObjects(objs, false); } finally { objs.forEach((o, i) => { o.material = saved[i]; }); }
  const zc = clipOn ? clipPlane.constant + 1e-6 : Infinity;
  for (const h of hits) {
    if (h.point.z > zc) continue;
    const pt = { x: h.point.x, y: h.point.y, z: h.point.z };
    if (h.object.userData.part) {
      const p = h.object.userData.part;
      return { kind: 'part', part: p, face: h.faceIndex, point: pt, normal: faceWorldNormal(p, h.faceIndex) };
    }
    if (h.object.userData.supPart) {
      const p = h.object.userData.supPart, si = p.supData ? p.supData.triSup[h.faceIndex] : -1;
      return { kind: 'support', part: p, si, point: pt };
    }
  }
  return null;
}
/* intersection of the pointer ray with the horizontal plane z = z0 */
function rayPlane(cx, cy, z0) {
  if (!raycaster) raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc(cx, cy), camera);
  const o = raycaster.ray.origin, d = raycaster.ray.direction;
  if (Math.abs(d.z) < 1e-9) return null;
  const t = (z0 - o.z) / d.z;
  if (t < 0) return null;
  return [o.x + d.x * t, o.y + d.y * t];
}

/* ---------- Lay-flat hover: highlight every coplanar triangle ---------- */
function coplanarSet(p, f) {
  const g = geoms.get(p.gid), F = geomFaces(g), N = F.N, Dd = F.D;
  const nx = N[f * 3], ny = N[f * 3 + 1], nz = N[f * 3 + 2], d0 = Dd[f];
  const tol = Math.max(1e-5, Math.hypot(...g.size) * 2e-5);
  const out = [];
  for (let t = 0; t < g.ntri; t++) if (N[t * 3] * nx + N[t * 3 + 1] * ny + N[t * 3 + 2] * nz > 0.99995 && Math.abs(Dd[t] - d0) < tol) out.push(t);
  return out;
}
function setHover(p, f) {
  if (!renderer) return;
  const F = geomFaces(geoms.get(p.gid));
  const key = p.id + ':' + Math.round(F.N[f * 3] * 1e4) + ',' + Math.round(F.N[f * 3 + 1] * 1e4) + ',' + Math.round(F.N[f * 3 + 2] * 1e4) + ':' + Math.round(F.D[f] * 1e4);
  if (hover && hover.key === key) return;
  clearHover();
  const set = coplanarSet(p, f), src = geoms.get(p.gid).pos, pos = new Float32Array(set.length * 9);
  set.forEach((t, i) => pos.set(src.subarray(t * 9, t * 9 + 9), i * 9));
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.Mesh(geo, mats.hover);
  m.matrixAutoUpdate = false; m.matrix.copy(p.mesh.matrix); m.raycast = () => {};
  overlayGroup.add(m);
  hover = { part: p, key, mesh: m };
  requestRender();
}
function clearHover() {
  if (!hover) return;
  overlayGroup.remove(hover.mesh); hover.mesh.geometry.dispose();
  hover = null;
  requestRender();
}
function opLayFlat(p, f) {
  const n = faceWorldNormal(p, f);
  pushUndo();
  p.rot = Q.toEuler(Q.mul(Q.fromUnitVectors(n, [0, 0, -1]), Q.fromEuler(p.rot)));
  p.zb = 0;
  recomputeLinear(p);
  dropSupports([p], 'rotation');
  clearHover();
  changed({ keepPanel: true });
}

