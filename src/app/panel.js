/* ---------- Tool panel ---------- */
const TOOL_TITLES = { move: 'Move', rotate: 'Rotate', scale: 'Scale', mirror: 'Mirror', supports: 'Supports', array: 'Array', advanced: 'Advanced tools' };
function F(label, key, val, unit, cls = '', step = 'any', extra = '') {
  return `<label class="fld ${cls}"><span>${label}</span><span class="in"><input type="number" data-k="${key}" value="${val}" step="${step}" ${extra}>${unit ? `<em>${unit}</em>` : ''}</span></label>`;
}
function Btn(label, act, cls = '', extra = '') { return `<button type="button" class="btn small ${cls}" data-act="${act}" ${extra}>${label}</button>`; }
function Chk(label, key, on) { return `<label class="chk"><input type="checkbox" data-k="${key}" ${on ? 'checked' : ''}> ${label}</label>`; }
function Sel(label, key, val, opts, extra = '') { return `<label class="fld"><span>${label}</span><span class="in"><select data-k="${key}" ${extra}>${opts.map(([v, t]) => `<option value="${v}" ${v === val ? 'selected' : ''}>${t}</option>`).join('')}</select></span></label>`; }

function renderToolPanel() {
  $('#toolTitle').textContent = TOOL_TITLES[tool];
  for (const b of $$('.tool')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  const s = selected(), one = s.length === 1 ? s[0] : null, many = s.length > 1;
  const n = s.length;
  let h = '';
  const selNote = many ? `<p class="note">${n} parts selected. Actions apply to all of them.</p>` : '';
  if (tool === 'move') {
    if (one) {
      const b = footprint(one);
      h += `<div class="grid3">${F('X centre', 'x', num((b.min[0] + b.max[0]) / 2, 3), 'mm', 'x', '0.1')}${F('Y centre', 'y', num((b.min[1] + b.max[1]) / 2, 3), 'mm', 'y', '0.1')}${F('Z bottom', 'zb', num(one.zb, 3), 'mm', 'z', '0.1')}</div>`;
      h += `<div class="btns">${Btn('Centre on plate', 'centre')}${Btn('Drop to plate', 'drop')}</div>`;
    } else if (many) {
      h += selNote + `<div class="btns">${Btn('Centre group on plate', 'centre')}${Btn(`Drop ${n} parts to plate`, 'drop')}</div>`;
    } else h += `<p class="note">Select a part to move it. Drag a selected part in the view to slide it across the plate.</p>`;
    h += `<div class="subh">Arrange</div><div class="axisrow">${F('Gap between parts', 'gap', num(arrangeGap, 3), 'mm', '', '0.1', 'min="0"')}${Btn('Arrange all', 'arrange')}<span></span></div>`;
    if (seamStrips()) h += Chk('Keep parts clear of field seams', 'seams', seamAware) + `<p class="note">Arrange, Magic and new parts avoid the overlap strips between exposure fields where a part fits inside one field.</p>`;
  } else if (tool === 'rotate') {
    if (one) h += `<div class="grid3">${F('X', 'rx', num(one.rot[0], 3), '°', 'x', '1')}${F('Y', 'ry', num(one.rot[1], 3), '°', 'y', '1')}${F('Z', 'rz', num(one.rot[2], 3), '°', 'z', '1')}</div>`;
    else if (many) h += selNote;
    else h += `<p class="note">Select a part to rotate it, or use Lay flat and click any face.</p>`;
    if (n) {
      h += `<div class="subh">Turn by 90° about the plate axes</div>`;
      for (const [i, a] of ['X', 'Y', 'Z'].entries()) h += `<div class="btns tight"><span class="fld ${a.toLowerCase()}" style="width:44px;justify-content:center"><span>${a}</span></span>${Btn('−90°', `rot-${i}--1`)}${Btn('+90°', `rot-${i}-1`)}</div>`;
      h += `<div class="btns">${Btn('Reset rotation', 'resetrot')}</div>`;
    }
    h += `<div class="btns">${Btn('Lay flat: click a face', 'mode-layflat', '', `aria-pressed="${mode === 'layflat'}"`)}</div>`;
  } else if (tool === 'scale') {
    if (one) {
      const g = geoms.get(one.gid);
      h += `<div class="grid3">${F('X', 'sx', num(one.scale[0] * 100, 3), '%', 'x', '1', 'min="0"')}${F('Y', 'sy', num(one.scale[1] * 100, 3), '%', 'y', '1', 'min="0"')}${F('Z', 'sz', num(one.scale[2] * 100, 3), '%', 'z', '1', 'min="0"')}</div>`;
      h += `<div class="grid3" style="margin-top:8px">${F('X size', 'mx', num(g.size[0] * one.scale[0], 4), 'mm', 'x', '0.1', 'min="0"')}${F('Y size', 'my', num(g.size[1] * one.scale[1], 4), 'mm', 'y', '0.1', 'min="0"')}${F('Z size', 'mz', num(g.size[2] * one.scale[2], 4), 'mm', 'z', '0.1', 'min="0"')}</div>`;
      h += Chk('Uniform', 'uniform', uniformScale);
    } else if (many) {
      h += selNote + `<div class="axisrow">${F('Scale every part by', 'grpScale', num(grpScale, 3), '%', '', '1', 'min="0"')}${Btn('Apply', 'grpscale')}<span></span></div>`;
    } else h += `<p class="note">Select a part to scale it.</p>`;
    if (n) h += `<div class="btns">${Btn('Reset', 'resetscale')}${Btn('×1000 (file in metres)', 'scale-1000')}${Btn('×25.4 (file in inches)', 'scale-25.4')}</div>`;
  } else if (tool === 'mirror') {
    h += `<p class="note">Flips the part itself. The projector image mirror is a printer setting, in Printer settings.</p>`;
    if (n) {
      h += selNote + `<div class="btns">${['X', 'Y', 'Z'].map((a, i) => Btn('Mirror ' + a, 'mir-' + i, '', one ? `aria-pressed="${one.mir[i]}"` : '')).join('')}</div>`;
    } else h += `<p class="note">Select a part to mirror it.</p>`;
  } else if (tool === 'supports') {
    h += supportPanelHTML(s);
  } else if (tool === 'advanced') {
    h += advancedPanelHTML(s);
  } else if (tool === 'array') {
    if (one) {
      h += `<div class="grid3">${F('Total count', 'arrCount', arrCount, '', '', '1', 'min="2"')}${F('Columns', 'arrCols', arrCols, '', '', '1', 'min="1"')}${F('Gap', 'arrGap', num(arrGap, 3), 'mm', '', '0.1', 'min="0"')}</div>`;
      h += `<p class="note">Copies are placed along +X and towards the front, supports included.</p><div class="btns">${Btn('Make array', 'array', 'primary')}${Btn('Duplicate', 'dup')}${Btn('Delete', 'del', 'danger')}</div>`;
    } else if (many) h += selNote + `<p class="note">Select one part to make an array.</p><div class="btns">${Btn(`Duplicate ${n} parts`, 'dup')}${Btn(`Delete ${n} parts`, 'del', 'danger')}</div>`;
    else h += `<p class="note">Select a part to copy it into a grid.</p>`;
  }
  $('#toolBody').innerHTML = h;
}
function supportPanelHTML(s) {
  const c = supCfg, D = supDims(), n = s.length;
  const tgt = n ? (n === 1 ? 'selected part' : `${n} selected parts`) : 'all parts';
  return `
    <div class="seg" role="group" aria-label="Support preset">${['light', 'medium', 'heavy'].map((k) => `<button type="button" data-act="preset-${k}" aria-pressed="${c.preset === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
    <p class="note">Diameters below are multiplied by ${PRESET_MULT[c.preset]} for this preset.</p>
    <div class="subh">Supports stand on</div>
    <div class="seg" role="group" aria-label="Where supports may stand"><button type="button" data-act="land-platform" aria-pressed="${c.platformOnly}">Platform only</button><button type="button" data-act="land-any" aria-pressed="${!c.platformOnly}">Platform or part</button></div>
    <p class="note">${c.platformOnly ? 'Every support goes straight down to the platform, clear of the part. Nothing is placed inside cavities or on the part itself.' : 'Overhangs above other parts of the model get short supports that rest on the model, including inside cavities.'}</p>
    <div class="btns">${Btn('Auto-support ' + tgt, 'autosup', 'primary')}</div>
    <div class="btns tight">${Btn('Click to add', 'mode-addsup', '', `aria-pressed="${mode === 'addsup'}"`)}${Btn('Click to remove', 'mode-remsup', '', `aria-pressed="${mode === 'remsup'}"`)}${Btn(showSupports ? 'Hide supports' : 'Show supports', 'togglesup')}</div>
    <div class="btns tight">${n ? Btn('Remove from selected', 'remsel') : ''}${Btn('Remove all', 'remall', 'danger')}</div>
    <div class="subh">Automatic placement</div>
    <div class="grid2">${F('Density', 'sup.density', num(c.density, 2), '%', '', '5', 'min="1"')}${F('Overhang angle', 'sup.overhang', num(c.overhang, 2), '°', '', '1', 'min="0" max="89"')}</div>
    <p class="note">Grid spacing ${fmt(D.spacing, 3)} mm.</p>
    ${Chk('Skip contacts lower than the height below', 'sup.minZOn', c.minZOn)}
    <div class="grid2" style="margin-top:8px">${F('Lowest contact', 'sup.minZ', num(c.minZ, 3), 'mm', '', '0.05', 'min="0"')}${F('Z lift height', 'sup.lift', num(c.lift, 3), 'mm', '', '0.05', 'min="0"')}</div>
    <div class="subh">Tip</div>
    <div class="grid2">${Sel('Contact shape', 'sup.tipShape', c.tipShape, [['none', 'None'], ['sphere', 'Sphere']])}${Sel('Connection', 'sup.conn', c.conn, [['cone', 'Cone'], ['cylinder', 'Cylinder']])}
    ${F('Contact diameter', 'sup.tipD', num(c.tipD, 3), 'mm', '', '0.01', 'min="0"')}${F('Contact depth', 'sup.tipDepth', num(c.tipDepth, 3), 'mm', '', '0.01', 'min="0"')}
    ${F('Upper diameter', 'sup.upD', num(c.upD, 3), 'mm', '', '0.01', 'min="0"')}${F('Lower diameter', 'sup.lowD', num(c.lowD, 3), 'mm', '', '0.01', 'min="0"')}
    ${F('Connection length', 'sup.connLen', num(c.connLen, 3), 'mm', '', '0.1', 'min="0"')}</div>
    <div class="subh">Pillar</div>
    <div class="grid2">${F('Diameter', 'sup.pilD', num(c.pilD, 3), 'mm', '', '0.01', 'min="0"')}</div>
    ${Chk('Zig-zag 45° braces between neighbours', 'sup.braces', c.braces)}
    <div class="grid2" style="margin-top:8px">${F('Brace reach', 'sup.braceReach', num(c.braceReach, 3), 'mm', '', '0.5', 'min="0"')}${F('Braces start at', 'sup.braceStart', num(c.braceStart, 3), 'mm', '', '0.5', 'min="0"')}</div>
    <div class="subh">Base</div>
    <div class="grid2">${F('Diameter', 'sup.baseD', num(c.baseD, 3), 'mm', '', '0.05', 'min="0"')}${F('Height', 'sup.baseH', num(c.baseH, 3), 'mm', '', '0.05', 'min="0"')}</div>
    ${Chk('Raft under platform supports', 'sup.raft', c.raft)}
    <div class="grid2" style="margin-top:8px">${F('Raft thickness', 'sup.raftT', num(c.raftT, 3), 'mm', '', '0.05', 'min="0"')}${F('Raft margin', 'sup.raftMargin', num(c.raftMargin, 3), 'mm', '', '0.1', 'min="0"')}</div>`;
}
/* refresh numeric fields without rebuilding the panel (keeps focus) */
function syncPanel() {
  const s = selected(), one = s.length === 1 ? s[0] : null;
  if (!one) { renderToolPanel(); return; }
  const g = geoms.get(one.gid), b = footprint(one);
  const vals = {
    x: num((b.min[0] + b.max[0]) / 2, 3), y: num((b.min[1] + b.max[1]) / 2, 3), zb: num(one.zb, 3),
    rx: num(one.rot[0], 3), ry: num(one.rot[1], 3), rz: num(one.rot[2], 3),
    sx: num(one.scale[0] * 100, 3), sy: num(one.scale[1] * 100, 3), sz: num(one.scale[2] * 100, 3),
    mx: num(g.size[0] * one.scale[0], 4), my: num(g.size[1] * one.scale[1], 4), mz: num(g.size[2] * one.scale[2], 4)
  };
  for (const inp of $$('#toolBody input[data-k]')) {
    if (inp === document.activeElement) continue;
    if (vals[inp.dataset.k] !== undefined) inp.value = vals[inp.dataset.k];
  }
  for (let i = 0; i < 3; i++) { const b2 = $(`#toolBody [data-act="mir-${i}"]`); if (b2) b2.setAttribute('aria-pressed', String(one.mir[i])); }
}
function onToolField(el) {
  const k = el.dataset.k;
  const v = el.type === 'checkbox' ? el.checked : (el.tagName === 'SELECT' ? el.value : parseFloat(el.value));
  if (el.type === 'number' && !isFinite(v)) { syncPanel(); return; }
  if (k.startsWith('sup.')) { setSupCfg(k.slice(4), v); return; }
  if (k.startsWith('aa.')) { setAA(k.slice(3), v); return; }
  const one = selected()[0];
  switch (k) {
    case 'x': opSetCentre(0, v); break;
    case 'y': opSetCentre(1, v); break;
    case 'zb': opSetZ(selected(), Math.max(0, v)); break;
    case 'rx': opSetRot(0, v); break;
    case 'ry': opSetRot(1, v); break;
    case 'rz': opSetRot(2, v); break;
    case 'sx': case 'sy': case 'sz': opSetScale('xyz'.indexOf(k[1]), v / 100); break;
    case 'mx': case 'my': case 'mz': { if (!one) break; const ax = 'xyz'.indexOf(k[1]), sz = geoms.get(one.gid).size[ax]; if (sz > 0) opSetScale(ax, v / sz); break; }
    case 'uniform': uniformScale = v; break;
    case 'gap': arrangeGap = Math.max(0, v); LS.set('goboslice.gap', arrangeGap); break;
    case 'seams': seamAware = v; LS.set('goboslice.seams', v); break;
    case 'grpScale': grpScale = v; break;
    case 'arrCount': arrCount = Math.max(2, Math.round(v)); break;
    case 'arrCols': arrCols = Math.max(1, Math.round(v)); break;
    case 'arrGap': arrGap = Math.max(0, v); break;
    case 'a3x': case 'a3y': case 'a3z': arr3[k[2]] = clamp(Math.round(v), 1, 200); syncArray3Note(); break;
    case 'a3o': arr3.o = Math.max(0, v); syncArray3Note(); break;
    case 'a3c': arr3.combine = v; break;
  }
}
function setSupCfg(key, v) {
  pushUndo();
  supCfg[key] = v;
  supCfg = normaliseSup(supCfg);
  saveSup();
  for (const p of parts) if (p.sup.length) rebuildSupportMesh(p);
  changed({ keepPanel: !['density'].includes(key) });
  if (key === 'density') { /* spacing text */ }
}
function onToolAction(act) {
  const s = selected(), one = s.length === 1 ? s[0] : null;
  const list = s;
  if (act === 'centre') opCentre(list);
  else if (act === 'drop') opSetZ(list, 0);
  else if (act === 'arrange') arrangeAll();
  else if (act.startsWith('rot-')) { const [, a, sg] = act.match(/^rot-(\d)-(-?1)$/); opRot90(list, +a, +sg); }
  else if (act === 'resetrot') opResetRot(list);
  else if (act === 'resetscale') opResetScale(list);
  else if (act === 'scale-1000') opScaleBy(list, 1000);
  else if (act === 'scale-25.4') opScaleBy(list, 25.4);
  else if (act === 'grpscale') opScaleBy(list, grpScale / 100);
  else if (act.startsWith('mir-')) opMirror(list, +act.slice(4));
  else if (act.startsWith('mode-')) setMode(act.slice(5));
  else if (act.startsWith('preset-')) setSupCfg('preset', act.slice(7));
  else if (act === 'land-platform' || act === 'land-any') setLanding(act === 'land-platform');
  else if (act === 'autosup') opAutoSupport(list.length ? list : parts);
  else if (act === 'togglesup') toggleSupports();
  else if (act === 'remsel') opRemoveSupports(list);
  else if (act === 'remall') opRemoveSupports(parts);
  else if (act === 'array') opArray(one, arrCount, arrCols, arrGap);
  else if (act === 'array3d') opArray3D(list, arr3);
  else if (act === 'combine') opCombine(list);
  else if (act === 'dup') opDuplicate(list);
  else if (act === 'del') opDelete(list);
  if (act.startsWith('mode-')) renderToolPanel();
}
/* switching where supports may stand regenerates the supports already placed */
function setLanding(platformOnly) {
  if (supCfg.platformOnly === platformOnly) return;
  pushUndo();
  supCfg.platformOnly = platformOnly; saveSup();
  const redo = parts.filter((p) => p.sup.length);
  const D = supDims();
  let n = 0;
  for (const p of redo) n += p.zb < 1e-9 ? autoSupport(p, { onBed: true, minZ: D.platZ + D.baseH + 0.1 }) : autoSupport(p);
  changed();
  if (redo.length) toast(`Supports redone for ${redo.length === 1 ? redo[0].name : redo.length + ' parts'}: ${n} in total, ${platformOnly ? 'all standing on the platform' : 'some resting on the part'}.`);
}
function toggleSupports() {
  showSupports = !showSupports;
  if (supGroup) supGroup.visible = showSupports;
  if (!showSupports && mode === 'remsup') setMode(null);
  renderToolPanel(); requestRender();
}

/* ---------- Parts list ---------- */
function renderPartsList() {
  const ul = $('#partsList');
  ul.innerHTML = parts.map((p) => `<li data-id="${p.id}" class="${sel.has(p.id) ? 'on' : ''}" tabindex="0" aria-selected="${sel.has(p.id)}">
      <div><div class="nm" title="${esc(p.name)}">${esc(p.name)}</div><div class="meta">${geoms.get(p.gid).ntri.toLocaleString()} triangles, ${p.sup.length} support${p.sup.length === 1 ? '' : 's'}</div></div>
      <span class="tags">${p.oob ? '<span class="oob" title="Outside the build volume">Outside</span>' : ''}${p.seam ? '<span class="seam" title="Lies across a field seam, the overlap strip between two exposure fields">Seam</span>' : ''}</span>
      <button class="del" data-del="${p.id}" aria-label="Delete ${esc(p.name)}" title="Delete"><svg class="i"><use href="#i-trash"/></svg></button></li>`).join('');
  $('#partsEmpty').style.display = parts.length ? 'none' : '';
  $('#partsCount').textContent = parts.length ? String(parts.length) : '';
}
