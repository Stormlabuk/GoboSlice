/* ---------- Advanced tools ----------
   3D array: the selection is a unit cell, repeated along +X, +Y and +Z with no margins (the
   step is the cell's own size, less any overlap), so simple parts build larger solids and
   lattices. Combine: several parts become one part made of separate solids.
   Anti-aliasing: mask pixels along part edges get a grey level from how much of the pixel the
   part covers (Core.rasterLayerAA). Off by default; with it off the masks are unchanged. */
let arr3 = { x: 3, y: 3, z: 3, o: 0, combine: true };
const AA_LEVELS = [0, 2, 4, 8];
function normaliseAA(a) {
  a = a && typeof a === 'object' ? a : {};
  const level = AA_LEVELS.includes(+a.level) ? +a.level : 0;
  const lo = isFinite(+a.lo) ? clamp(Math.round(+a.lo), 0, 254) : 0;
  return { level, lo };
}
let aaCfg = normaliseAA(LS.get('goboslice.aa', null));
/* what a slice with profile P uses: null for plain masks (off, or 1-bit output) */
function aaFor(P) { return aaCfg.level && P.bits !== 1 ? { S: aaCfg.level, lo: aaCfg.lo } : null; }
function aaText(aa) { return aa ? `${aa.S}×, edge greys ${aa.lo ? `${aa.lo}–255` : '1–255'}` : 'off'; }
function setAA(key, v) {
  const was = JSON.stringify(aaCfg);
  aaCfg = normaliseAA({ ...aaCfg, [key]: v });
  if (JSON.stringify(aaCfg) === was) { if (key === 'lo') syncAANote(); return; }
  LS.set('goboslice.aa', aaCfg);
  invalidateSlice();
  drawLayer();
  if (key === 'level') renderToolPanel(); else syncAANote();
}
function aaNote() {
  const P = prof();
  if (P.bits === 1) return `This profile writes 1-bit masks, which have no greys, so anti-aliasing is not applied. Set 8-bit in Printer settings to use it.`;
  if (!aaCfg.level) return 'Off: every mask pixel is black or white, lit where its centre is inside the part.';
  return `Each edge pixel is lit in proportion to how much of it the part covers, measured exactly along each row and on ${aaCfg.level} lines down each pixel. `
    + (aaCfg.lo ? `Any pixel the part touches is at least grey ${aaCfg.lo}, so edges cure further out than with 0.` : 'A pixel half covered is grey 128.')
    + ' Whether a grey cures, and how far, depends on the resin and exposure: test it on your printer.';
}
function syncAANote() { const el = $('#aanote'); if (el) el.textContent = aaNote(); }
function cellBounds(list) {
  let b = null;
  for (const p of list) b = unionB(b, p.wb);
  return b;
}
function array3Note(list) {
  if (!list.length) return 'Select the part or parts to repeat.';
  const b = cellBounds(list), n = arr3.x * arr3.y * arr3.z;
  const size = [0, 1, 2].map((k) => { const c = b.max[k] - b.min[k], cnt = arr3['xyz'[k]]; return cnt * c - (cnt - 1) * Math.min(arr3.o, c); });
  const tris = list.reduce((a, p) => a + geoms.get(p.gid).ntri, 0) * n;
  return `${n} cell${n === 1 ? '' : 's'}, ${size.map((v) => num(v, 3)).join(' × ')} mm, ${tris.toLocaleString()} triangles.`;
}
function syncArray3Note() { const el = $('#a3note'); if (el) el.textContent = array3Note(selected()); }
function advancedPanelHTML(s) {
  const n = s.length;
  let h = `<div class="subh">3D array, no gaps</div>
    <p class="note">Repeats the selection along +X, +Y and +Z, each copy touching the last. Build a cell from simple parts, then grow it into a larger solid or lattice.</p>
    <div class="grid3">${F('X count', 'a3x', arr3.x, '', 'x', '1', 'min="1" max="200"')}${F('Y count', 'a3y', arr3.y, '', 'y', '1', 'min="1" max="200"')}${F('Z count', 'a3z', arr3.z, '', 'z', '1', 'min="1" max="200"')}</div>
    <div class="grid2" style="margin-top:8px">${F('Overlap', 'a3o', num(arr3.o, 4), 'mm', '', '0.01', 'min="0"')}</div>
    ${Chk('Combine into one part', 'a3c', arr3.combine)}
    <p class="note" id="a3note">${esc(array3Note(s))}</p>
    <div class="btns">${Btn('Make 3D array', 'array3d', 'primary', n ? '' : 'disabled')}</div>
    <div class="subh">Combine</div>
    <p class="note">Joins the selected parts into one part, keeping where they are. Each stays its own solid, so overlaps print solid.</p>
    <div class="btns">${Btn(n > 1 ? `Combine ${n} parts` : 'Combine', 'combine', '', n > 1 ? '' : 'disabled')}</div>`;
  if (s.some((p) => p.sup.length)) h += `<p class="note">Supports on the selection are removed by both; add supports to the result.</p>`;
  const one = prof().bits === 1 ? 'disabled' : '';
  h += `<div class="subh">Anti-aliasing</div>
    <p class="note">Smooths the masks: pixels along part edges get a grey level instead of only black or white. This changes the masks, so it is off unless you turn it on.</p>
    <div class="grid2">${Sel('Anti-aliasing', 'aa.level', String(aaCfg.level), AA_LEVELS.map((v) => [String(v), v ? `${v}×` : 'Off']), one)}${F('Darkest edge grey', 'aa.lo', aaCfg.lo, '', '', '1', `min="0" max="254" ${one}`)}</div>
    <p class="note" id="aanote">${esc(aaNote())}</p>`;
  return h;
}
/* one geometry from world-space copies of parts, each copy and each existing piece kept as a solid */
function combineGeometry(name, items) {
  let total = 0;
  for (const it of items) total += geoms.get(it.p.gid).ntri;
  const pos = new Float32Array(total * 9), pieces = [];
  let o = 0;
  for (const it of items) {
    const w = worldTris(it.p), g = geoms.get(it.p.gid), n = w.length / 9, d = it.d || [0, 0, 0];
    for (let i = 0; i < w.length; i += 3) { pos[o * 9 + i] = w[i] + d[0]; pos[o * 9 + i + 1] = w[i + 1] + d[1]; pos[o * 9 + i + 2] = w[i + 2] + d[2]; }
    if (g.pieces) for (let i = 0; i < g.pieces.length; i += 2) pieces.push(o + g.pieces[i], g.pieces[i + 1]);
    else pieces.push(o, n);
    o += n;
  }
  return addGeometry(name, pos, pieces);
}
/* a new part from a combined geometry, placed exactly where its pieces were */
function partFromCombined(g, b) {
  const p = createPart(g.id);
  p.zb = b.min[2]; updateWorld(p);
  translatePart(p, (b.min[0] + b.max[0]) / 2 - (p.wb.min[0] + p.wb.max[0]) / 2, (b.min[1] + b.max[1]) / 2 - (p.wb.min[1] + p.wb.max[1]) / 2);
  return p;
}
const MAX_ARRAY_TRIS = 6e6;
function opArray3D(list, A) {
  if (!list.length) { toast('Select the part or parts to repeat.'); return; }
  const n = A.x * A.y * A.z, tris = list.reduce((a, p) => a + geoms.get(p.gid).ntri, 0) * n;
  if (n < 2) { toast('Choose a count above 1 on at least one axis.'); return; }
  if (tris > MAX_ARRAY_TRIS) { toast(`That would be ${tris.toLocaleString()} triangles; keep it under ${MAX_ARRAY_TRIS.toLocaleString()}.`, 'warn'); return; }
  pushUndo();
  const b = cellBounds(list), step = [0, 1, 2].map((k) => Math.max(1e-6, b.max[k] - b.min[k] - A.o));
  for (const p of list) if (p.sup.length) { p.sup = []; rebuildSupportMesh(p); }
  const offsets = [];
  for (let k = 0; k < A.z; k++) for (let j = 0; j < A.y; j++) for (let i = 0; i < A.x; i++) offsets.push([i * step[0], j * step[1], k * step[2]]);
  let made;
  if (A.combine) {
    const items = [];
    for (const d of offsets) for (const p of list) items.push({ p, d });
    const base = list.length === 1 ? list[0].name : 'cell';
    const g = combineGeometry(`${base} ${A.x}×${A.y}×${A.z}`, items);
    const out = { min: b.min.slice(), max: [0, 1, 2].map((k) => b.min[k] + step[k] * (A['xyz'[k]] - 1) + (b.max[k] - b.min[k])) };
    const p = partFromCombined(g, out);
    for (const q of list) disposePart(q);
    const gone = new Set(list.map((q) => q.id));
    parts = parts.filter((q) => !gone.has(q.id));
    parts.push(p);
    made = [p];
  } else {
    made = [];
    for (const d of offsets.slice(1)) for (const src of list) {
      const c = clonePart(src);
      c.sup = []; rebuildSupportMesh(c);
      c.zb = src.zb + d[2]; updateWorld(c);
      translatePart(c, d[0], d[1]);
      made.push(c);
    }
    parts.push(...made);
    made = list.concat(made);
  }
  sel = new Set(made.map((p) => p.id));
  changed();
  toast(`Made a ${A.x} × ${A.y} × ${A.z} array${A.combine ? ' as one part' : ` of ${made.length} parts`}.` + (made.some((p) => computeOOB(p)) ? ' It does not all fit in the build volume.' : ''), made.some((p) => computeOOB(p)) ? 'warn' : '');
}
function opCombine(list) {
  if (list.length < 2) { toast('Select two or more parts to combine.'); return; }
  pushUndo();
  const b = cellBounds(list);
  const g = combineGeometry(`combined ${list.length}`, list.map((p) => ({ p })));
  const p = partFromCombined(g, b);
  for (const q of list) disposePart(q);
  const gone = new Set(list.map((q) => q.id));
  parts = parts.filter((q) => !gone.has(q.id));
  parts.push(p);
  sel = new Set([p.id]);
  changed();
  toast(`Combined ${list.length} parts into one.`);
}
