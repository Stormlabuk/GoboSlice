/* ---------- Design check ----------
   A pre-slice check against the design guide (Design rules, in profiles.js). The layer rules
   run at full resolution in the slicing workers (Core.checkRange); pins and channels are then
   tracked up the stack, and the rules about the mesh, the supports and the settings run here.
   Nothing here changes what is sliced. */
const RULE_INFO = {
  size: { t: 'Fits the build volume', c: '#FF4D3D' },
  island: { t: 'Islands: printing onto nothing', c: '#FF4D3D' },
  ledge: { t: 'Overhang length', c: '#FF8A00' },
  angle: { t: 'Shallow overhangs without support', c: '#FF5C8A' },
  thin: { t: 'Thin walls and features', c: '#E040FB' },
  gap: { t: 'Feature clearance and part spacing', c: '#2F8CFF' },
  vhole: { t: 'Vertical holes', c: '#00BCD4' },
  hhole: { t: 'Horizontal holes and gaps', c: '#00C853' },
  pin: { t: 'Pins and pillars: aspect ratio', c: '#FFC400' },
  channel: { t: 'Channels: aspect ratio', c: '#A1887F' },
  volume: { t: 'Minimum part size', c: '#90A4AE' },
  layer: { t: 'Layer height', c: '#90A4AE' },
  supdims: { t: 'Support cone sizes and shape', c: '#90A4AE' },
  pillar: { t: 'Support pillars: aspect ratio', c: '#FFC400' }
};
const RULE_ORDER = ['size', 'island', 'ledge', 'angle', 'thin', 'gap', 'vhole', 'hhole', 'pin', 'channel', 'volume', 'layer', 'supdims', 'pillar'];
let checkResult = null, checkGroup = null, checkFocus = null;

function checkKey(P) { return JSON.stringify([normaliseProfile(clone(P)), checkCfg.level, activeRules()]); }
function checkValid() { return !!checkResult && checkResult.version === sceneVersion && checkResult.key === checkKey(prof()); }
function clearCheck() { checkResult = null; checkFocus = null; buildCheckMarks(); updateCheckUI(); }
function checkSummary() {
  const r = checkResult, bits = [];
  if (r.errors) bits.push(`${r.errors} problem${r.errors === 1 ? '' : 's'} likely to fail`);
  if (r.warnings) bits.push(`${r.warnings} warning${r.warnings === 1 ? '' : 's'}`);
  /* counted per rule; each rule lists its places */
  return 'The design check found ' + bits.join(' and ');
}

/* image pixel position back to plate millimetres, undoing the mirror */
function pixelToWorld(P, W, H, cx, cy) {
  const D = derived(P), mh = P.mirror === 'h' || P.mirror === 'hv', mv = P.mirror === 'v' || P.mirror === 'hv';
  const c = mh ? W - cx : cx, r = mv ? H - cy : cy;
  return [D.x0 + c * P.bx / W, D.y1 - r * P.by / H];
}

async function runDesignCheck(opts = {}) {
  if (slicing) return;
  if (!parts.length) { if (!opts.quiet) toast('Add a part to check.'); return; }
  const P = normaliseProfile(clone(prof())), W = P.resX, H = P.resY, lh = P.layerUm / 1000, v = activeRules(), R = checkRules(P, v), key = checkKey(P);
  const job = { cancelled: false, reason: '', workers: [], reject: null, kind: 'check' };
  job.cancel = (why) => {
    job.cancelled = true; job.reason = why || 'user';
    for (const w of job.workers) w.terminate();
    job.workers = [];
    if (job.reject) job.reject(new Error('cancelled'));
  };
  slicing = job;
  $('#btnSlice').disabled = true; updateCheckUI();
  setProgress(0, 'Checking');
  await new Promise((r) => setTimeout(r, 20));
  try {
    const t0 = performance.now();
    const bk = bakeScene(W, H, P);
    const N = layerCount(bk.maxZ, lh, P);
    if (!N) throw new Error('nothing to check');
    const per = new Array(N).fill(null);
    let done = 0, lastUI = 0;
    await runLayers(bk, N, P, { check: R }, (L, res) => {
      per[L] = res; done++;
      const now = performance.now();
      if (now - lastUI > 80 || done === N) { lastUI = now; setProgress(done / N, `Checking ${done} of ${N}`); }
    }, job);
    if (job.cancelled) throw new Error('cancelled');
    checkResult = assembleCheck(P, N, W, H, per, v, R, key);
    checkResult.ms = performance.now() - t0;
    checkFocus = null;
    buildCheckMarks(); updateCheckUI(); drawLayer();
    $('#checkSec').open = true;
    if (!opts.quiet) {
      if (checkResult.errors || checkResult.warnings) { toast(checkSummary() + '.', checkResult.errors ? 'warn' : ''); jumpProblem(1, true); }
      else toast(`Design check passed: ${N} layers against the ${checkCfg.level} rules.`);
    }
  } catch (e) {
    if (job.cancelled) toast(job.reason === 'changed' ? 'The design check stopped because the scene changed.' : 'Design check cancelled.');
    else { console.error(e); toast('Design check failed: ' + (e && e.message || e), 'warn'); }
  } finally {
    for (const w of job.workers) w.terminate();
    if (slicing === job) slicing = null;
    $('#prog').classList.remove('on');
    $('#btnSlice').disabled = false;
    updateStats(); updateCheckUI();
  }
}

/* Gathers the layer results with the rules worked out here into one report:
   rules[id] = { sev, n, text }, issues per layer (with plate positions) for the views */
function assembleCheck(P, N, W, H, per, v, R, key) {
  const D = derived(P), pitch = (D.pitchX + D.pitchY) / 2, lh = D.lh, M = pixelMapper(P, W, H);
  const layers = Array.from({ length: N }, () => []), rules = {};
  const rec = DESIGN_RULES.recommended, adv = checkCfg.level === 'advanced';
  const mm = (x, d = 3) => fmt(x, d).replace(/0+$/, '').replace(/\.$/, '');
  const add = (k, s, L, x, y, z, rad, extra) => {
    const i = Object.assign({ k, s, L: clamp(L, 0, N - 1), x, y, z, r: rad }, extra || {});
    i.px = M.x(x); i.py = M.y(y); i.pr = rad / pitch;
    layers[i.L].push(i);
    return i;
  };
  const rule = (k, sev, text) => { rules[k] = { sev, text, n: rules[k] ? rules[k].n : 0 }; };
  const count = {}, worst = {};
  /* layer rules from the workers */
  for (let L = 0; L < N; L++) {
    const res = per[L]; if (!res) continue;
    for (const i of res.issues) {
      const [x, y] = pixelToWorld(P, W, H, i.cx, i.cy), rad = Math.max(i.x1 - i.x0, i.y1 - i.y0) * pitch / 2;
      const key2 = i.k + (i.k === 'thin' ? i.s : '');
      add(i.k, i.s, L, x, y, (L + 0.5) * lh, rad, { v: i.v, b: i.b });
      count[key2] = (count[key2] || 0) + 1;
      if (i.k === 'ledge') {
        const far = !i.b && !(i.v < R.maxSteps), val = (i.b ? i.v : Math.min(i.v, R.maxSteps)) * pitch, w = worst.ledge;
        if (!w || val > w.v) worst.ledge = { v: val, b: i.b, far };
      }
      if (i.k === 'hhole') { const val = i.v * lh; if (!worst.hhole || val < worst.hhole) worst.hhole = val; }
    }
  }
  const layersWith = (k) => { const s = new Set(); layers.forEach((l, L) => l.some((i) => i.k === k) && s.add(L)); return s.size; };
  const where = (k) => { const n = layers.reduce((a, l) => a + l.filter((i) => i.k === k).length, 0), nl = layersWith(k); const f = layers.findIndex((l) => l.some((i) => i.k === k)); return `${n} place${n === 1 ? '' : 's'} on ${nl} layer${nl === 1 ? '' : 's'}, first on layer ${f + 1}`; };
  /* size */
  const oob = parts.filter((p) => computeOOB(p));
  rule('size', oob.length ? 2 : 0, oob.length ? `${oob.map((p) => p.name).slice(0, 3).join(', ')}${oob.length > 3 ? ` and ${oob.length - 3} more` : ''} outside the ${mm(P.bx)} × ${mm(P.by)} × ${mm(P.bz)} mm build volume.` : `Everything is inside ${mm(P.bx)} × ${mm(P.by)} × ${mm(P.bz)} mm.`);
  rules.size.parts = oob.map((p) => p.id);
  for (const p of oob) { const b = p.wb; add('size', 2, Math.floor(Math.max(0, b.min[2]) / lh), (b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, Math.max(0, b.min[2]), Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2); }
  /* raster rules */
  rule('island', count.island ? 2 : 0, count.island ? `${where('island')}. Add supports there.` : 'Every layer rests on the one below.');
  rule('ledge', count.ledge ? 2 : 0, count.ledge ? `${where('ledge')}. Worst: ${worst.ledge.b ? `a bridge of ${mm(worst.ledge.v, 2)} mm, limit ${mm(v.maxBridge)} mm` : `${worst.ledge.far ? 'more than ' : ''}${mm(worst.ledge.v, 2)} mm past its support, limit ${mm(v.maxLedge)} mm`}.` : `Nothing sticks out more than ${mm(v.maxLedge)} mm, or bridges more than ${mm(v.maxBridge)} mm, past its support.`);
  const tE = Math.max(v.minFeature, v.minWallSup);
  if (R.thinE + R.thinW === 0) rule('thin', 0, `Below the ${mm(pitch * 1000, 1)} µm pixel at these settings, so not checked.`);
  else {
    const e = count.thin2 || 0, w = count.thin1 || 0;
    const note = R.thinE === 0 ? ` The ${mm(tE)} mm limit is under three ${mm(pitch * 1000, 1)} µm pixels, so only ${mm(v.minWallUnsup)} mm is checked.` : '';
    rule('thin', e ? 2 : w ? 1 : 0, (e || w ? `${where('thin')}. ${e ? `${e} thinner than ${mm(tE)} mm` : ''}${e && w ? '; ' : ''}${w ? `${w} under ${mm(v.minWallUnsup)} mm, which needs support on both sides` : ''}.` : `Nothing thinner than ${mm(v.minWallUnsup)} mm.`) + note);
  }
  rule('gap', count.gap ? 1 : 0, count.gap ? `${where('gap')}. Gaps under ${mm(v.clearance)} mm between features or parts may close up.` : `Every gap between features and parts is at least ${mm(v.clearance)} mm.`);
  rule('vhole', count.vhole ? 2 : 0, count.vhole ? `${where('vhole')}. Holes under ${mm(v.minHoleV)} mm across close up.` : `No vertical hole under ${mm(v.minHoleV)} mm.`);
  rule('hhole', count.hhole ? 2 : 0, count.hhole ? `${where('hhole')}. Smallest ${mm(worst.hhole, 3)} mm high; under ${mm(v.minHoleH)} mm closes up.` : `No horizontal hole or gap under ${mm(v.minHoleH)} mm high.`);
  /* pins and channels, tracked up the stack */
  const arLimit = (d, lim, recLim) => (adv && d > 0.1 ? lim : Math.min(lim, recLim));
  for (const [k, list, lim, recLim, what] of [['pin', 'pins', v.pinAR, rec.pinAR, 'pin'], ['channel', 'chans', v.channelAR, rec.channelAR, 'channel']]) {
    const chains = Core.trackChains(per.map((r) => (r ? r[list] : [])));
    let n = 0, w = null;
    for (const ch of chains) {
      const len = (ch.l1 - ch.l0 + 1) * lh, ds = ch.d.slice().sort((a, b) => a - b), d = ds[ds.length >> 1] * pitch;
      if (!(d > 0)) continue;
      const ar = len / d, limit = arLimit(d, lim, recLim);
      if (ar <= limit) continue;
      n++;
      const b = ch.box, [x, y] = pixelToWorld(P, W, H, b[0], b[1]);
      add(k, 1, ch.l1, x, y, (ch.l1 + 0.5) * lh, Math.max(d, 0.05), { v: ar });
      if (!w || ar > w.ar) w = { ar, d, len };
    }
    rule(k, n ? 1 : 0, n ? `${n} ${what}${n === 1 ? '' : 's'} longer than the limit. Worst ${fmt(w.ar, 0)} : 1, ${mm(w.d, 3)} mm across and ${mm(w.len, 2)} mm long (limit ${fmt(arLimit(w.d, lim, recLim), 0)} : 1).`
      : `No ${what} longer than ${fmt(Math.min(lim, recLim), 0)} times its diameter${adv ? ` (${fmt(lim, 0)} above 0.1 mm)` : ''}.` + (k === 'channel' ? ' Vertical channels only.' : ''));
  }
  /* shallow overhangs on the mesh with no support near */
  const ov = shallowOverhangs(v, lh);
  for (const o of ov) add('angle', 2, Math.floor(o.z / lh), o.x, o.y, o.z, Math.max(0.1, o.r), { v: o.area });
  rule('angle', ov.length ? 2 : 0, ov.length ? `${ov.length} part${ov.length === 1 ? '' : 's'} with ${mm(ov.reduce((a, o) => a + o.area, 0), 2)} mm² of surface below ${mm(v.minAngle)}° and no support within ${mm(v.maxBridge / 2, 2)} mm.` : `Every surface below ${mm(v.minAngle)}° is supported or close to the plate.`);
  rules.angle.parts = ov.map((o) => o.part);
  /* part volume */
  const small = parts.filter((p) => geoms.get(p.gid).vol * Math.abs(p.det) < v.minVolume);
  rule('volume', small.length ? 1 : 0, small.length ? `${small.map((p) => `${p.name} is ${mm(geoms.get(p.gid).vol * Math.abs(p.det), 3)} mm³`).slice(0, 3).join(', ')}; the minimum is ${mm(v.minVolume)} mm³.` : `Every part is at least ${mm(v.minVolume)} mm³.`);
  rules.volume.parts = small.map((p) => p.id);
  /* layer height */
  const okL = lh >= v.layerMin - 1e-9 && lh <= v.layerMax + 1e-9;
  rule('layer', okL ? 0 : 1, `${mm(lh * 1000, 2)} µm layers; the guide gives ${mm(v.layerMin)} to ${mm(v.layerMax)} mm.`);
  /* supports */
  const supported = parts.filter((p) => p.sup.length);
  if (!supported.length) { rule('supdims', 0, 'No supports to check.'); rule('pillar', 0, 'No supports to check.'); }
  else {
    const S = supDims(), top = S.upR * 2, base = S.lowR * 2, tip = S.tipR * 2, bad = [];
    if (top < v.supTopMin - 1e-9 || top > v.supTopMax + 1e-9) bad.push(`cone top ${mm(top)} mm (guide ${mm(v.supTopMin)} to ${mm(v.supTopMax)} mm)`);
    if (supCfg.tipShape === 'sphere' && (tip < v.supTopMin - 1e-9 || tip > v.supTopMax + 1e-9)) bad.push(`contact ${mm(tip)} mm (guide ${mm(v.supTopMin)} to ${mm(v.supTopMax)} mm)`);
    if (base < v.supBaseMin - 1e-9 || base > v.supBaseMax + 1e-9) bad.push(`cone base ${mm(base)} mm (guide ${mm(v.supBaseMin)} to ${mm(v.supBaseMax)} mm)`);
    if (supCfg.conn !== 'cone') bad.push('cylinder connections; the guide uses cones');
    rule('supdims', bad.length ? 1 : 0, bad.length ? bad.join('; ') + '.' : `Cone top ${mm(top)} mm and base ${mm(base)} mm are within the guide.`);
    const pd = S.pilR * 2, lim = arLimit(pd, v.pinAR, rec.pinAR);
    let n = 0, w = 0;
    for (const p of supported) for (const s of p.sup) {
      if (s.l != null) continue;
      const len = s.t[2] - (S.platZ + S.baseH), ar = len / pd;
      if (ar <= lim) continue;
      n++; w = Math.max(w, ar);
      add('pillar', 1, Math.floor(s.t[2] / lh), s.t[0], s.t[1], s.t[2], 0.15, { v: ar });
    }
    rule('pillar', n ? 1 : 0, n ? `${n} pillar${n === 1 ? '' : 's'} longer than ${fmt(lim, 0)} times their ${mm(pd)} mm diameter (${mm(lim * pd, 1)} mm); worst ${fmt(w, 0)} : 1. Thicker pillars or a lower lift height help.` : `Every pillar is within ${fmt(lim, 0)} times its ${mm(pd)} mm diameter.`);
  }
  for (const L of layers) for (const i of L) rules[i.k].n = (rules[i.k].n || 0) + 1;
  let errors = 0, warnings = 0;
  for (const k of RULE_ORDER) { const r = rules[k]; if (r.sev === 2) errors++; else if (r.sev === 1) warnings++; }
  return { version: sceneVersion, key, P: JSON.stringify(P), N, W, H, lh, layers, rules, errors, warnings, level: checkCfg.level };
}

/* Surfaces flatter than the minimum overhang angle that face down need support. A point on
   one is fine when it is within half a bridge of a support contact, or so close to the plate
   or to the part below that it fuses to it (the horizontal hole rule covers that). */
function shallowOverhangs(v, lh) {
  const cosA = Math.cos(v.minAngle * DEG), reach = v.maxBridge / 2, out = [];
  for (const p of parts) {
    const W = worldTris(p), n = W.length / 9, pts = p.sup.map((s) => s.t);
    let G = null, area = 0, sx = 0, sy = 0, sz = 0, cnt = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let t = 0; t < n; t++) {
      const b = t * 9;
      const c = V.cross([W[b + 3] - W[b], W[b + 4] - W[b + 1], W[b + 5] - W[b + 2]], [W[b + 6] - W[b], W[b + 7] - W[b + 1], W[b + 8] - W[b + 2]]);
      const l = V.len(c); if (!(l > 0) || c[2] / l >= -cosA) continue;
      const A = l / 2, k = Math.max(1, Math.min(12, Math.ceil(Math.sqrt(A) / 0.15))), each = A / (k * k);
      for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) for (const up of [0, 1]) {
        if (up && j === k - i - 1) continue;
        const u = up ? (i + 2 / 3) / k : (i + 1 / 3) / k, w2 = up ? (j + 2 / 3) / k : (j + 1 / 3) / k, z0 = 1 - u - w2;
        const x = z0 * W[b] + u * W[b + 3] + w2 * W[b + 6], y = z0 * W[b + 1] + u * W[b + 4] + w2 * W[b + 7], z = z0 * W[b + 2] + u * W[b + 5] + w2 * W[b + 8];
        if (z < v.minHoleH) continue;
        if (pts.some((q) => Math.hypot(q[0] - x, q[1] - y, q[2] - z) <= reach)) continue;
        if (!G) G = buildRayGrid(W, 0.05);
        const below = rayHits(G, x, y).filter((h) => h.z < z - 1e-4);
        if (below.length && z - below[below.length - 1].z < v.minHoleH) continue;
        area += each; sx += x * each; sy += y * each; sz += z * each; cnt++;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    if (area > 1e-3) out.push({ part: p.id, area, x: sx / area, y: sy / area, z: sz / area, r: Math.max(x1 - x0, y1 - y0) / 2 });
  }
  return out;
}

/* ---------- Design check: views ---------- */
function issuesOn(L) {
  if (!checkValid() || !checkResult.layers[L]) return [];
  return checkFocus ? checkResult.layers[L].filter((i) => i.k === checkFocus) : checkResult.layers[L];
}
/* coloured rings on the layer preview; returns a short description of this layer's problems */
function drawIssues(ctx, L, w) {
  const list = issuesOn(L);
  if (!list.length) return '';
  const r = checkResult, k = w / r.W, css = w / Math.max(120, ctx.canvas.clientWidth || 320), n = {};
  ctx.save(); ctx.lineWidth = 2 * css;
  for (const i of list) {
    const col = RULE_INFO[i.k].c, rad = Math.max(7 * css, i.pr * k + 4 * css);
    ctx.strokeStyle = col; ctx.fillStyle = col + '55';
    ctx.beginPath(); ctx.arc(i.px * k, i.py * k, rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    n[i.k] = (n[i.k] || 0) + 1;
  }
  ctx.restore();
  return Object.entries(n).map(([key, c]) => `${c} × ${RULE_INFO[key].t.split(':')[0].toLowerCase()}`).join(', ');
}
/* step to the next (dir 1) or previous (dir -1) layer with a problem, wrapping round */
function jumpProblem(dir, fromStart) {
  if (!checkValid()) return;
  const ls = [];
  checkResult.layers.forEach((l, L) => { if (l.some((i) => !checkFocus || i.k === checkFocus)) ls.push(L); });
  if (!ls.length) return;
  const cur = fromStart ? -1 : LP.layer;
  let L = dir > 0 ? ls.find((x) => x > cur) : [...ls].reverse().find((x) => x < cur);
  if (L === undefined) L = dir > 0 ? ls[0] : ls[ls.length - 1];
  setLayer(L);
}
function focusRule(k) {
  const r = checkResult && checkResult.rules[k];
  if (!r) return;
  checkFocus = checkFocus === k ? null : k;
  buildCheckMarks(); updateCheckUI();
  if (r.parts && r.parts.length) setSelection(r.parts);
  if ((k === 'supdims' || k === 'pillar') && checkFocus) { tool = 'supports'; renderToolPanel(); }
  if (checkFocus && checkResult.layers.some((l) => l.some((i) => i.k === k))) jumpProblem(1, true); else drawLayer();
}
/* a dot in the 3D view at every problem, in its rule's colour, drawn over everything */
function buildCheckMarks() {
  if (!renderer) return;
  if (!checkGroup) { checkGroup = new THREE.Group(); overlayGroup.add(checkGroup); }
  disposeGroup(checkGroup);
  const r = checkResult;
  if (r) {
    const pos = [], col = [], c = new THREE.Color();
    for (const l of r.layers) for (const i of l) {
      if (checkFocus && i.k !== checkFocus) continue;
      if (pos.length >= 3 * 4000) break;
      c.set(RULE_INFO[i.k].c); pos.push(i.x, i.y, i.z); col.push(c.r, c.g, c.b);
    }
    if (pos.length) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 32;
      const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 4;
      g.beginPath(); g.arc(16, 16, 12, 0, Math.PI * 2); g.fill(); g.stroke();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      const m = new THREE.Points(geo, new THREE.PointsMaterial({ size: 13, sizeAttenuation: false, vertexColors: true, map: new THREE.CanvasTexture(cv), transparent: true, alphaTest: 0.3, depthTest: false, depthWrite: false }));
      m.renderOrder = 40; m.raycast = () => {};
      checkGroup.add(m);
    }
  }
  requestRender();
}
function updateCheckUI() {
  const ok = checkValid(), r = checkResult, info = $('#chkInfo'), list = $('#chkList');
  for (const b of $$('#checkSec [data-lvl]')) b.setAttribute('aria-pressed', String(b.dataset.lvl === checkCfg.level));
  $('#chkRigid').checked = checkCfg.rigid; $('#chkRigid').disabled = checkCfg.level !== 'advanced';
  $('#chkBefore').checked = checkCfg.before;
  $('#btnCheck').disabled = !!slicing || !parts.length;
  info.classList.remove('warn', 'ok');
  if (!parts.length) { info.textContent = 'Add a part to check it against the design guide.'; list.innerHTML = ''; }
  else if (!ok) { info.textContent = checkCfg.before ? 'Not checked yet. It runs before every slice.' : 'Not checked yet.'; list.innerHTML = ''; }
  else {
    if (r.errors || r.warnings) { info.textContent = checkSummary() + '.'; info.classList.add(r.errors ? 'warn' : 'ok'); if (!r.errors) info.classList.remove('ok'); }
    else { info.textContent = `All ${RULE_ORDER.length} rules pass (${r.level}).`; info.classList.add('ok'); }
    list.innerHTML = RULE_ORDER.map((k) => {
      const x = r.rules[k], cls = x.sev === 2 ? 'err' : x.sev === 1 ? 'warn' : 'ok';
      return `<li data-rule="${k}" class="${cls}${checkFocus === k ? ' on' : ''}" tabindex="0" role="button" aria-pressed="${checkFocus === k}">
        <span class="ic" style="--c:${RULE_INFO[k].c}">${x.sev === 2 ? '✕' : x.sev === 1 ? '!' : '✓'}</span>
        <div><div class="nm">${esc(RULE_INFO[k].t)}</div><div class="meta">${esc(x.text)}</div></div></li>`;
    }).join('');
  }
  $('#chkCount').textContent = ok && (r.errors || r.warnings) ? String(r.errors + r.warnings) : '';
  $('#probPrev').disabled = $('#probNext').disabled = !(ok && (r.errors || r.warnings));
  $('#probInfo').textContent = ok && checkFocus ? `Showing: ${RULE_INFO[checkFocus].t}` : '';
  renderRuleFields();
}
function renderRuleFields() {
  const el = $('#chkRules'), v = activeRules();
  if (!el || el.dataset.lvl === checkCfg.level + JSON.stringify(v)) return;
  el.dataset.lvl = checkCfg.level + JSON.stringify(v);
  el.innerHTML = RULE_FIELDS.map(([k, label, unit]) => `<label class="fld"><span>${esc(label)}</span><span class="in"><input type="number" data-r="${k}" value="${num(v[k], 4)}" step="any" min="0"><em>${unit}</em></span></label>`).join('');
}
function setRuleValue(k, val) {
  if (!(val >= 0) || !isFinite(val)) return;
  checkCfg.custom[checkCfg.level][k] = val; saveCheckCfg();
  if (checkResult) clearCheck(); else updateCheckUI();
}
/* support settings matching the design guide, with the overhang angle of the current level */
function supportsToGuide() {
  const v = activeRules();
  pushUndo();
  Object.assign(supCfg, { preset: 'medium', tipShape: 'sphere', tipD: 0.1, upD: 0.1, lowD: 0.25, conn: 'cone', overhang: v.minAngle });
  supCfg = normaliseSup(supCfg); saveSup();
  for (const p of parts) if (p.sup.length) rebuildSupportMesh(p);
  changed({ keepPanel: false });
  toast(`Supports set to the guide: 0.1 mm cone tops, 0.25 mm cone bases, supports under faces flatter than ${fmt(v.minAngle, 0)}°. Run Auto-support to place them again.`);
}
