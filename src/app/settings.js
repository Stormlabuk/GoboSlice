/* ---------- Printer settings ---------- */
let lockR = 1;
function rebuildProfileSelect() {
  const s = $('#profileSel');
  s.innerHTML = profiles.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
  s.value = String(profIdx);
}
function renderSettings() {
  const P = prof();
  lockR = P.resY / P.resX;
  const f = (label, key, val, unit, step = 'any', extra = '') => `<label class="fld"><span>${label}</span><span class="in"><input type="number" data-p="${key}" value="${val}" step="${step}" ${extra}>${unit ? `<em>${unit}</em>` : ''}</span></label>`;
  const s = (label, key, val, opts) => `<label class="fld"><span>${label}</span><span class="in"><select data-p="${key}">${opts.map(([v, t]) => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${t}</option>`).join('')}</select></span></label>`;
  const c = (label, key, on) => `<label class="chk"><input type="checkbox" data-p="${key}" ${on ? 'checked' : ''}> ${label}</label>`;
  $('#settingsBody').innerHTML = `
    <label class="fld" style="margin-top:10px"><span>Profile name</span><span class="in"><input type="text" data-p="name" value="${esc(P.name)}" maxlength="60"></span></label>
    <div class="subh">Projector</div>
    <div class="grid3">${f('Image width', 'resX', P.resX, 'px', '1', 'min="1"')}${f('Image height', 'resY', P.resY, 'px', '1', 'min="1"')}${s('Mirror image', 'mirror', P.mirror, [['none', 'None'], ['h', 'Left to right'], ['v', 'Front to back'], ['hv', 'Both']])}</div>
    ${c('Keep the width to height ratio when one changes', 'lockRatio', P.lockRatio)}
    <p class="note">Check the mirror with an asymmetric test print, such as the mirror test shape. If the F comes out reversed, change this setting.</p>
    <div class="subh">Build volume</div>
    <div class="grid3">${f('Width (X)', 'bx', num(P.bx, 4), 'mm', '0.1', 'min="0.01"')}${f('Depth (Y)', 'by', num(P.by, 4), 'mm', '0.1', 'min="0.01"')}${f('Height (Z)', 'bz', num(P.bz, 4), 'mm', '1', 'min="0.01"')}</div>
    <div class="grid2" style="margin-top:8px">${f('Plate centre X', 'offX', num(P.offX, 4), 'mm', '0.1')}${f('Plate centre Y', 'offY', num(P.offY, 4), 'mm', '0.1')}</div>
    <div class="subh">Output</div>
    <div class="grid2">${f('Layer height', 'layerUm', num(P.layerUm, 3), 'µm', '1', 'min="0.1"')}${s('Bit depth', 'bits', P.bits, [[8, '8-bit greyscale'], [1, '1-bit']])}
    ${f('First file number', 'firstNum', P.firstNum, '', '1', 'min="0"')}${f('Zero-pad to digits', 'pad', P.pad, '', '1', 'min="0" max="12"')}</div>
    ${c('Include preview.png in the ZIP', 'preview', P.preview)}
    <div class="subh">Tiling</div>
    ${c('The image is stitched from several exposure fields', 'tiling', P.tiling)}
    <div class="grid2" style="margin-top:8px">${f('Field width', 'fieldX', num(P.fieldX, 4), 'mm', '0.1', 'min="0.01"')}${f('Field depth', 'fieldY', num(P.fieldY, 4), 'mm', '0.1', 'min="0.01"')}
    ${f('Fields across (X)', 'fieldsX', P.fieldsX, '', '1', 'min="1"')}${f('Fields front to back (Y)', 'fieldsY', P.fieldsY, '', '1', 'min="1"')}</div>
    <div class="derived" id="setDerived" aria-live="polite"></div>`;
  for (const el of $$('#settingsBody [data-p^="field"]')) el.disabled = !P.tiling;
  updateDerived();
}
function updateDerived() {
  const P = prof(), D = derived(P), el = $('#setDerived');
  if (!el) return;
  const sq = Math.abs(D.pitchX / D.pitchY - 1) < 0.005;
  let h = `Pixel pitch <b>${fmt(D.pitchX * 1000, 3)} × ${fmt(D.pitchY * 1000, 3)} µm</b>${sq ? ', square' : ', <span style="color:var(--fault)">not square, check the image size and build area</span>'}.<br>`;
  if (P.tiling && (P.fieldsX > 1 || P.fieldsY > 1)) {
    const part = (n, o, opx, f) => n > 1 ? (o < -1e-9 ? `<span style="color:var(--fault)">gap of ${fmt(-o, 3)} mm</span>` : o >= f ? `<span style="color:var(--fault)">${fmt(o, 3)} mm, as wide as a field</span>` : `<b>${fmt(o, 3)} mm</b> (${fmt(opx, 1)} px)`) : 'none';
    h += `Tile overlap across ${part(P.fieldsX, D.ox, D.oxPx, P.fieldX)}, front to back ${part(P.fieldsY, D.oy, D.oyPx, P.fieldY)}.<br>`;
  }
  h += `Files are named ${fileName(P, 0)}, ${fileName(P, 1)}, ${fileName(P, 2)} and so on.`;
  el.innerHTML = h;
}
function onSettingsInput(e) {
  const el = e.target, k = el.dataset && el.dataset.p;
  if (!k) return;
  const P = Object.assign({}, prof());
  let v = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' ? el.value : el.type === 'number' ? parseFloat(el.value) : el.value;
  if (el.type === 'number' && !isFinite(v)) return;
  if (k === 'bits') v = +v;
  P[k] = v;
  if (k === 'lockRatio' && v) lockR = P.resY / P.resX;
  if (P.lockRatio && (k === 'resX' || k === 'resY') && v > 0) {
    const ok = k === 'resX' ? 'resY' : 'resX';
    P[ok] = Math.max(1, Math.round(k === 'resX' ? v * lockR : v / lockR));
    const other = $(`#settingsBody [data-p="${ok}"]`);
    if (other && document.activeElement !== other) other.value = P[ok];
  }
  profiles[profIdx] = normaliseProfile(P);
  saveProfiles();
  if (k === 'tiling') for (const f of $$('#settingsBody [data-p^="field"]')) f.disabled = !v;
  if (k === 'name') rebuildProfileSelect();
  updateDerived();
}
function applyProfile() {
  rebuildProfileSelect();
  buildPlate();
  invalidateSlice();
  refreshUI({ keepPanel: true });
  updatePreview();
  if (!parts.length) fitView();
  requestRender();
}
async function importProfiles(file) {
  try {
    const j = JSON.parse(await file.text());
    const arr = Array.isArray(j) ? j : Array.isArray(j.profiles) ? j.profiles : [j];
    const good = arr.filter((p) => p && typeof p === 'object' && (p.resX || p.bx || p.name)).map(normaliseProfile);
    if (!good.length) throw new Error('no printer profiles found');
    const first = profiles.length;
    profiles.push(...good);
    profIdx = first;
    saveProfiles(); renderSettings(); rebuildProfileSelect();
    toast(`Imported ${good.length} profile${good.length === 1 ? '' : 's'}.`);
  } catch (err) { toast('Could not import: ' + (err.message || err), 'warn'); }
}

