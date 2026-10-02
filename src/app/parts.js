/* ---------- Parts ---------- */
let parts = [];
let sel = new Set();
let nextPartId = 1;
let tool = 'move', mode = null, showSupports = true, uniformScale = true;
let arrCount = 4, arrCols = 2, arrGap = 1, grpScale = 100;
let sceneVersion = 0;

function partById(id) { return parts.find((p) => p.id === id); }
function selected() { return parts.filter((p) => sel.has(p.id)); }
function targets() { const s = selected(); return s; }

function createPart(gid, id) {
  const g = geoms.get(gid);
  const p = { id: id != null ? id : nextPartId++, gid, name: g.name, x: 0, y: 0, zb: 0, rot: [0, 0, 0], scale: [1, 1, 1], mir: [false, false, false], sup: [], L: [1, 0, 0, 0, 1, 0, 0, 0, 1], det: 1, lb: null, wb: null, t: [0, 0, 0], supB: null, supData: null, oob: false, _supKey: '' };
  nextPartId = Math.max(nextPartId, p.id + 1);
  if (renderer) {
    const geo = geomThree(g);
    p.mats = makePartMats();
    p.mesh = new THREE.Mesh(geo, p.mats.front);
    p.back = new THREE.Mesh(geo, p.mats.back);
    p.mesh.matrixAutoUpdate = false; p.back.matrixAutoUpdate = false;
    p.mesh.userData.part = p;
    p.back.raycast = () => {};
    partsGroup.add(p.back, p.mesh);
  }
  recomputeLinear(p);
  return p;
}
function disposePart(p) {
  if (p.mesh) { partsGroup.remove(p.mesh, p.back); p.mats.front.dispose(); p.mats.back.dispose(); }
  if (p.supMesh) { supGroup.remove(p.supMesh, p.supBack); p.supMesh.geometry.dispose(); p.supMesh = p.supBack = null; }
  if (hover && hover.part === p) clearHover();
}
const linKey = (p) => p.rot.join(',') + '|' + p.scale.join(',') + '|' + p.mir.join(',');
function recomputeLinear(p) {
  const R = Q.toMat3(Q.fromEuler(p.rot));
  const s = [0, 1, 2].map((i) => p.scale[i] * (p.mir[i] ? -1 : 1));
  const L = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) L[r * 3 + c] = R[r * 3 + c] * s[c];
  p.L = L; p.det = s[0] * s[1] * s[2];
  const pos = geoms.get(p.gid).pos;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    const a = L[0] * x + L[1] * y + L[2] * z, b = L[3] * x + L[4] * y + L[5] * z, c = L[6] * x + L[7] * y + L[8] * z;
    if (a < mn[0]) mn[0] = a; if (a > mx[0]) mx[0] = a;
    if (b < mn[1]) mn[1] = b; if (b > mx[1]) mx[1] = b;
    if (c < mn[2]) mn[2] = c; if (c > mx[2]) mx[2] = c;
  }
  p.lb = { min: mn, max: mx };
  p._lin = linKey(p);
  updateWorld(p);
}
function updateWorld(p) {
  const tz = p.zb - p.lb.min[2];
  p.t = [p.x, p.y, tz];
  p.wb = { min: [p.lb.min[0] + p.x, p.lb.min[1] + p.y, p.zb], max: [p.lb.max[0] + p.x, p.lb.max[1] + p.y, p.lb.max[2] + tz] };
  if (p.mesh) {
    const L = p.L, t = p.t;
    const e = [L[0], L[3], L[6], 0, L[1], L[4], L[7], 0, L[2], L[5], L[8], 0, t[0], t[1], t[2], 1];
    p.mesh.matrix.fromArray(e); p.back.matrix.fromArray(e);
    p.mesh.matrixWorldNeedsUpdate = true; p.back.matrixWorldNeedsUpdate = true;
  }
}
/* world-space triangle soup with winding corrected for mirrored transforms */
function worldTris(p) {
  const src = geoms.get(p.gid).pos, L = p.L, t = p.t, out = new Float32Array(src.length);
  const order = p.det < 0 ? [0, 2, 1] : [0, 1, 2];
  for (let i = 0; i < src.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      const s = i + order[k] * 3, o = i + k * 3, x = src[s], y = src[s + 1], z = src[s + 2];
      out[o] = L[0] * x + L[1] * y + L[2] * z + t[0];
      out[o + 1] = L[3] * x + L[4] * y + L[5] * z + t[1];
      out[o + 2] = L[6] * x + L[7] * y + L[8] * z + t[2];
    }
  }
  return out;
}
function faceWorldNormal(p, f) {
  const a = geoms.get(p.gid).pos, b = f * 9, L = p.L;
  const v = (k) => m3v(L, [a[b + k * 3], a[b + k * 3 + 1], a[b + k * 3 + 2]]);
  const A = v(0), B = v(1), Cc = v(2);
  let n = V.norm(V.cross(V.sub(B, A), V.sub(Cc, A)));
  if (p.det < 0) n = V.mul(n, -1);
  return n;
}
function unionB(a, b) {
  if (!b) return a; if (!a) return b;
  return { min: [0, 1, 2].map((k) => Math.min(a.min[k], b.min[k])), max: [0, 1, 2].map((k) => Math.max(a.max[k], b.max[k])) };
}
function footprint(p) { return unionB(p.wb, p.supB); }
function groupBounds(list) { let b = null; for (const p of list) b = unionB(b, footprint(p)); return b; }
function computeOOB(p) {
  const P = prof(), D = derived(P), e = 1e-6, b = footprint(p);
  return b.min[0] < D.x0 - e || b.max[0] > D.x1 + e || b.min[1] < D.y0 - e || b.max[1] > D.y1 + e || b.min[2] < -e || b.max[2] > P.bz + e;
}
function paintPart(p, plain) {
  if (!p.mats) return;
  const c = p.oob ? C['part-oob'] : (!plain && sel.has(p.id)) ? C['part-sel'] : C.part;
  p.mats.front.color.set(c);
}
function translatePart(p, dx, dy) {
  if (!dx && !dy) return;
  p.x += dx; p.y += dy; updateWorld(p);
  for (const s of p.sup) { s.t[0] += dx; s.t[1] += dy; }
  if (p.supData) {
    const a = p.supData.pos;
    for (let i = 0; i < a.length; i += 3) { a[i] += dx; a[i + 1] += dy; }
    if (p.supMesh) { const at = p.supMesh.geometry.attributes.position; at.needsUpdate = true; p.supMesh.geometry.computeBoundingSphere(); p.supMesh.geometry.computeBoundingBox(); }
  }
  if (p.supB) { p.supB.min[0] += dx; p.supB.max[0] += dx; p.supB.min[1] += dy; p.supB.max[1] += dy; }
}
function dropSupports(list, why) {
  const hit = list.filter((p) => p.sup.length);
  for (const p of hit) { p.sup = []; rebuildSupportMesh(p); }
  if (hit.length) toast(`Supports removed from ${hit.length === 1 ? hit[0].name : hit.length + ' parts'} because the ${why} changed.`);
}

/* ---------- Change propagation ---------- */
function changed(opts = {}) {
  sceneVersion++;
  invalidateSlice();
  schedulePreview();
  refreshUI(opts);
  requestRender();
}
function refreshUI(opts = {}) {
  for (const p of parts) { p.oob = computeOOB(p); paintPart(p); }
  if (!opts.keepPanel) renderToolPanel(); else syncPanel();
  renderPartsList();
  updateHUD();
  $('#empty').style.display = parts.length ? 'none' : '';
  updateUndoButtons();
}
function updateHUD() {
  const s = selected();
  let t = '';
  if (s.length) {
    const b = groupBounds(s);
    const dims = `${fmt(b.max[0] - b.min[0])} × ${fmt(b.max[1] - b.min[1])} × ${fmt(b.max[2] - b.min[2])} mm`;
    t = s.length === 1 ? `${s[0].name}, ${dims}` : `${s.length} parts selected, ${dims}`;
  }
  $('#hudSel').textContent = t;
  const modes = {
    layflat: 'Lay flat: click a face to put it on the plate. Esc to stop.',
    addsup: 'Click a downward-facing point to add a support. Esc to stop.',
    remsup: 'Click a support to remove it. Esc to stop.'
  };
  $('#hudMode').textContent = mode ? modes[mode] : '';
}
let toastTimer = 0;
function toast(msg, kind) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'warn' ? ' warn' : '');
  el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), kind === 'warn' ? 5200 : 3400);
}
function setMode(m) {
  mode = (mode === m) ? null : m;
  if (mode !== 'layflat') clearHover();
  updateHUD();
  for (const b of $$('[data-act="mode-layflat"],[data-act="mode-addsup"],[data-act="mode-remsup"]')) b.setAttribute('aria-pressed', String(b.dataset.act === 'mode-' + mode));
  if (canvas) canvas.style.cursor = mode ? 'crosshair' : '';
}

/* ---------- Selection ---------- */
function setSelection(ids) { sel = new Set(ids); afterSelect(); }
function toggleSel(id) { if (sel.has(id)) sel.delete(id); else sel.add(id); afterSelect(); }
function afterSelect() {
  for (const p of parts) paintPart(p);
  renderToolPanel(); renderPartsList(); updateHUD(); requestRender();
}

/* ---------- Operations (each is one undo step) ---------- */
function opMove(list, dx, dy) { if (!list.length) return; pushUndo(); for (const p of list) translatePart(p, dx, dy); changed({ keepPanel: true }); }
function opSetCentre(axis, v) {
  const p = selected()[0]; if (!p) return;
  const b = footprint(p), c = (b.min[axis] + b.max[axis]) / 2;
  opMove([p], axis === 0 ? v - c : 0, axis === 1 ? v - c : 0);
}
function opSetZ(list, z) {
  if (!list.length) return;
  pushUndo();
  const moved = [];
  for (const p of list) if (Math.abs(p.zb - z) > 1e-9) { p.zb = z; updateWorld(p); moved.push(p); }
  dropSupports(moved, 'height');
  changed({ keepPanel: true });
}
function opCentre(list) {
  if (!list.length) return;
  pushUndo();
  const b = groupBounds(list), D = derived();
  const dx = D.cx - (b.min[0] + b.max[0]) / 2, dy = D.cy - (b.min[1] + b.max[1]) / 2;
  for (const p of list) translatePart(p, dx, dy);
  changed({ keepPanel: true });
}
function applyLinear(list, fn, why) {
  if (!list.length) return;
  pushUndo();
  for (const p of list) { fn(p); recomputeLinear(p); }
  dropSupports(list, why);
  changed({ keepPanel: true });
}
function opRot90(list, axis, sign) {
  const ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]][axis];
  applyLinear(list, (p) => { p.rot = Q.toEuler(Q.mul(Q.axis(ax, sign * 90 * DEG), Q.fromEuler(p.rot))); }, 'rotation');
}
function opSetRot(axis, v) { const p = selected()[0]; if (!p || !isFinite(v)) return; applyLinear([p], (q) => { q.rot[axis] = v; }, 'rotation'); }
function opResetTransform(list) { applyLinear(list, (p) => { p.rot = [0, 0, 0]; p.scale = [1, 1, 1]; p.mir = [false, false, false]; }, 'transform'); }
function opResetRot(list) { applyLinear(list, (p) => { p.rot = [0, 0, 0]; }, 'rotation'); }
function opResetScale(list) { applyLinear(list, (p) => { p.scale = [1, 1, 1]; }, 'scale'); }
function opScaleBy(list, f) { if (!(f > 0) || !isFinite(f)) return; applyLinear(list, (p) => { p.scale = p.scale.map((s) => s * f); }, 'scale'); }
function opSetScale(axis, s) {
  const p = selected()[0]; if (!p || !(s > 0) || !isFinite(s)) return;
  applyLinear([p], (q) => {
    if (uniformScale) { const f = s / q.scale[axis]; q.scale = q.scale.map((v) => v * f); } else q.scale[axis] = s;
  }, 'scale');
}
function opMirror(list, axis) { applyLinear(list, (p) => { p.mir[axis] = !p.mir[axis]; }, 'mirror'); }
function opDelete(list) {
  if (!list.length) return;
  pushUndo();
  const ids = new Set(list.map((p) => p.id));
  for (const p of list) disposePart(p);
  parts = parts.filter((p) => !ids.has(p.id));
  for (const id of ids) sel.delete(id);
  changed();
}
function clonePart(src) {
  const p = createPart(src.gid);
  p.name = src.name; p.rot = src.rot.slice(); p.scale = src.scale.slice(); p.mir = src.mir.slice();
  p.x = src.x; p.y = src.y; p.zb = src.zb;
  recomputeLinear(p);
  p.sup = clone(src.sup);
  rebuildSupportMesh(p);
  return p;
}
function opDuplicate(list) {
  if (!list.length) return;
  pushUndo();
  const made = [];
  for (const src of list) {
    const p = clonePart(src);
    const b = footprint(src);
    const spot = findFreeSpot(p, [...parts, ...made], [(b.min[0] + b.max[0]) / 2 + (b.max[0] - b.min[0]) + arrangeGap, (b.min[1] + b.max[1]) / 2]);
    const f = footprint(p);
    translatePart(p, spot[0] - (f.min[0] + f.max[0]) / 2, spot[1] - (f.min[1] + f.max[1]) / 2);
    made.push(p);
  }
  parts.push(...made);
  sel = new Set(made.map((p) => p.id));
  changed();
}
function opArray(p, count, cols, gap) {
  count = Math.max(1, Math.round(count)); cols = Math.max(1, Math.round(cols));
  if (!p || count < 2) { toast('Choose a count of 2 or more.'); return; }
  pushUndo();
  const b = footprint(p), w = b.max[0] - b.min[0], d = b.max[1] - b.min[1];
  const made = [p];
  for (let i = 1; i < count; i++) {
    const c = clonePart(p), col = i % cols, row = Math.floor(i / cols);
    translatePart(c, col * (w + gap), -row * (d + gap));
    made.push(c);
  }
  parts.push(...made.slice(1));
  sel = new Set(made.map((q) => q.id));
  changed();
  toast(`Made an array of ${count}.`);
}

/* free space near a point: spiral search over candidate centres */
function findFreeSpot(p, others, near) {
  const D = derived(), f = footprint(p), w = f.max[0] - f.min[0], d = f.max[1] - f.min[1];
  const gap = Math.max(0.2, arrangeGap);
  const centre = near || [D.cx, D.cy];
  const boxes = others.filter((o) => o !== p).map(footprint);
  const free = (cx, cy) => boxes.every((b) => cx + w / 2 + gap <= b.min[0] || cx - w / 2 - gap >= b.max[0] || cy + d / 2 + gap <= b.min[1] || cy - d / 2 - gap >= b.max[1]);
  if (free(centre[0], centre[1])) return centre;
  const step = Math.max(0.25, Math.min(w, d) / 3, Math.max(w, d) / 8);
  const R = Math.max(prof().bx, prof().by, w * 4, d * 4) * 1.5;
  const cand = [];
  for (let r = step; r <= R; r += step) {
    const n = Math.max(8, Math.round(2 * Math.PI * r / step));
    for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2; cand.push([centre[0] + r * Math.cos(a), centre[1] + r * Math.sin(a)]); }
  }
  const inPlate = (x, y) => x - w / 2 >= D.x0 && x + w / 2 <= D.x1 && y - d / 2 >= D.y0 && y + d / 2 <= D.y1;
  for (const pass of [true, false]) for (const c of cand) if ((!pass || inPlate(c[0], c[1])) && free(c[0], c[1])) return c;
  return centre;
}

