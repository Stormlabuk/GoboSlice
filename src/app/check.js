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
/* Part design: features of the parts themselves, whatever the orientation or supports.
   Print setup: how the plate is set up to print (orientation, supports, settings). */
const DESIGN_ORDER = ['size', 'volume', 'thin', 'gap', 'vhole', 'hhole', 'pin', 'channel'];
const SETUP_ORDER = ['island', 'ledge', 'angle', 'layer', 'supdims', 'pillar'];
const RULE_ORDER = DESIGN_ORDER.concat(SETUP_ORDER);
let checkResult = null, checkGroup = null, checkFocus = null, checkFeature = null;

function checkKey(P) { return JSON.stringify([normaliseProfile(clone(P)), checkCfg.level, activeRules()]); }
function checkValid() { return !!checkResult && checkResult.version === sceneVersion && checkResult.key === checkKey(prof()); }
function clearCheck() { checkResult = null; checkFocus = null; checkFeature = null; buildCheckMarks(); updateCheckUI(); }
/* "2 problems likely to fail and 1 warning", counted per rule, for one group */
function countText(order) {
  const r = checkResult; let e = 0, w = 0;
  for (const k of order) { if (r.rules[k].sev === 2) e++; else if (r.rules[k].sev === 1) w++; }
  const bits = [];
  if (e) bits.push(`${e} problem${e === 1 ? '' : 's'} likely to fail`);
  if (w) bits.push(`${w} warning${w === 1 ? '' : 's'}`);
  return bits.join(' and ');
}
function checkSummary() {
  const d = countText(DESIGN_ORDER), p = countText(SETUP_ORDER), bits = [];
  if (d) bits.push(`part design: ${d}`);
  if (p) bits.push(`print setup: ${p}`);
  return 'The check found ' + bits.join('; ');
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
  /* ---- part design: findings grouped across layers into features of the parts ---- */
  const features = [];
  const boxPx = (x0, y0, x1, y1, z0, z1) => {
    const a = pixelToWorld(P, W, H, x0, y0), b = pixelToWorld(P, W, H, x1, y1);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), z0, Math.max(a[0], b[0]), Math.max(a[1], b[1]), z1];
  };
  const owners = (box, pad) => parts.filter((p) => p.wb.min[0] <= box[3] + pad && p.wb.max[0] >= box[0] - pad && p.wb.min[1] <= box[4] + pad && p.wb.max[1] >= box[1] - pad && p.wb.min[2] <= box[5] + pad && p.wb.max[2] >= box[2] - pad);
  const feature = (k, s, l0, l1, box, extra) => {
    const own = owners(box, Math.max(v.clearance, 2 * pitch));
    const f = Object.assign({ id: features.length, k, s, l0, l1, box, parts: own.map((p) => p.id), names: own.map((p) => p.name) }, extra);
    features.push(f);
    return f;
  };
  /* thin, gap and hole findings that overlap on neighbouring layers are one feature */
  for (const k of ['thin', 'gap', 'vhole', 'hhole']) {
    const items = [];
    per.forEach((res, L) => res && res.issues.forEach((i) => { if (i.k === k) items.push({ L, i }); }));
    if (!items.length) continue;
    const par = items.map((_, n) => n), find = (n) => { while (par[n] !== n) { par[n] = par[par[n]]; n = par[n]; } return n; };
    const byL = new Map(); items.forEach((it, n) => { if (!byL.has(it.L)) byL.set(it.L, []); byL.get(it.L).push(n); });
    const touch = (a, b) => a.x0 <= b.x1 + 2 && b.x0 <= a.x1 + 2 && a.y0 <= b.y1 + 2 && b.y0 <= a.y1 + 2;
    items.forEach((it, n) => { for (const dl of [1, 2]) for (const m of byL.get(it.L - dl) || []) if (touch(it.i, items[m].i)) { const x = find(n), y = find(m); if (x !== y) par[x] = y; } });
    const groups = new Map();
    items.forEach((it, n) => { const g = find(n); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it); });
    for (const list of groups.values()) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, l0 = Infinity, l1 = -1, sv = 0, vmin = Infinity, gmax = 0;
      for (const { L, i } of list) {
        x0 = Math.min(x0, i.x0); y0 = Math.min(y0, i.y0); x1 = Math.max(x1, i.x1); y1 = Math.max(y1, i.y1);
        l0 = Math.min(l0, L); l1 = Math.max(l1, L); sv = Math.max(sv, i.s); vmin = Math.min(vmin, i.v); gmax = Math.max(gmax, i.v);
      }
      const z0 = k === 'hhole' ? Math.max(0, l0 - gmax) * lh : l0 * lh;
      feature(k, sv, l0, l1, boxPx(x0, y0, x1, y1, z0, (l1 + 1) * lh), { size: k === 'hhole' ? vmin * lh : vmin * pitch });
    }
  }
  /* pins and channels: slender regions tracked up the stack */
  const arLimit = (d, lim, recLim) => (adv && d > 0.1 ? lim : Math.min(lim, recLim));
  for (const [k, list, lim, recLim] of [['pin', 'pins', v.pinAR, rec.pinAR], ['channel', 'chans', v.channelAR, rec.channelAR]]) {
    for (const ch of Core.trackChains(per.map((r) => (r ? r[list] : [])))) {
      const len = (ch.l1 - ch.l0 + 1) * lh, ds = ch.d.slice().sort((a, b) => a - b), d = ds[ds.length >> 1] * pitch;
      if (!(d > 0)) continue;
      const ar = len / d, limit = arLimit(d, lim, recLim);
      if (ar <= limit) continue;
      const u = ch.ub;
      feature(k, 1, ch.l0, ch.l1, boxPx(u[0], u[1], u[2], u[3], ch.l0 * lh, (ch.l1 + 1) * lh), { size: d, len, ar, limit });
    }
  }
  /* part size: too big for the build volume, or too small to print */
  for (const p of parts) {
    const b = p.wb, box = [b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2]], vol = geoms.get(p.gid).vol * Math.abs(p.det);
    const lz = (z) => clamp(Math.floor(z / lh), 0, N - 1);
    if (computeOOB(p)) features.push({ id: features.length, k: 'size', s: 2, l0: lz(b.min[2]), l1: lz(b.max[2]), box, parts: [p.id], names: [p.name] });
    if (vol < v.minVolume) features.push({ id: features.length, k: 'volume', s: 1, l0: lz(b.min[2]), l1: lz(b.max[2]), box, parts: [p.id], names: [p.name], size: vol });
  }
  for (const f of features) f.label = featureLabel(f, v, P);
  const fs = (k) => features.filter((f) => f.k === k);
  /* what: [one, many] */
  const listText = (k, what, okText) => {
    const l = fs(k); if (!l.length) return okText;
    const nParts = new Set(l.flatMap((f) => f.parts)).size;
    return `${l.length} ${what[l.length === 1 ? 0 : 1]}${nParts && k !== 'size' && k !== 'volume' ? ` on ${nParts} part${nParts === 1 ? '' : 's'}` : ''}.`;
  };
  const sevOf = (k) => fs(k).reduce((a, f) => Math.max(a, f.s), 0);
  rule('size', sevOf('size'), listText('size', ['part outside the build volume', 'parts outside the build volume'], `Every part fits ${mm(P.bx)} × ${mm(P.by)} × ${mm(P.bz)} mm.`));
  rule('volume', sevOf('volume'), listText('volume', [`part under ${mm(v.minVolume)} mm³`, `parts under ${mm(v.minVolume)} mm³`], `Every part is at least ${mm(v.minVolume)} mm³.`));
  const tE = Math.max(v.minFeature, v.minWallSup), px3 = `three ${mm(pitch * 1000, 1)} µm pixels`;
  if (R.thinE + R.thinW === 0) rule('thin', 0, `Below ${px3} at these settings, so not checked.`);
  else rule('thin', sevOf('thin'), listText('thin', ['thin wall or feature', 'thin walls or features'], `No wall or feature thinner than ${mm(v.minWallUnsup)} mm.`) + (R.thinE === 0 ? ` The ${mm(tE)} mm limit is under ${px3}, so only ${mm(v.minWallUnsup)} mm is checked.` : ''));
  rule('gap', sevOf('gap'), listText('gap', ['narrow gap', 'narrow gaps'], `Every gap between features and parts is at least ${mm(v.clearance)} mm.`));
  rule('vhole', sevOf('vhole'), listText('vhole', ['small vertical hole', 'small vertical holes'], `No vertical hole under ${mm(v.minHoleV)} mm.`));
  rule('hhole', sevOf('hhole'), listText('hhole', ['low horizontal hole or gap', 'low horizontal holes or gaps'], `No horizontal hole or gap under ${mm(v.minHoleH)} mm high.`));
  rule('pin', sevOf('pin'), listText('pin', ['slender pin or pillar', 'slender pins or pillars'], `No pin longer than ${fmt(Math.min(v.pinAR, rec.pinAR), 0)} times its diameter${adv ? ` (${fmt(v.pinAR, 0)} above 0.1 mm)` : ''}.`));
  rule('channel', sevOf('channel'), listText('channel', ['slender channel', 'slender channels'], `No channel longer than ${fmt(Math.min(v.channelAR, rec.channelAR), 0)} times its diameter${adv ? ` (${fmt(v.channelAR, 0)} above 0.1 mm)` : ''}. Vertical channels only.`));
  for (const k of DESIGN_ORDER) rules[k].parts = [...new Set(fs(k).flatMap((f) => f.parts))];
  /* ---- print setup ---- */
  rule('island', count.island ? 2 : 0, count.island ? `${where('island')}. Add supports there.` : 'Every layer rests on the one below.');
  rule('ledge', count.ledge ? 2 : 0, count.ledge ? `${where('ledge')}. Worst: ${worst.ledge.b ? `a bridge of ${mm(worst.ledge.v, 2)} mm, limit ${mm(v.maxBridge)} mm` : `${worst.ledge.far ? 'more than ' : ''}${mm(worst.ledge.v, 2)} mm past its support, limit ${mm(v.maxLedge)} mm`}.` : `Nothing sticks out more than ${mm(v.maxLedge)} mm, or bridges more than ${mm(v.maxBridge)} mm, past its support.`);
  /* shallow overhangs on the mesh with no support near */
  const ov = shallowOverhangs(v, lh);
  for (const o of ov) add('angle', 2, Math.floor(o.z / lh), o.x, o.y, o.z, Math.max(0.1, o.r), { v: o.area });
  rule('angle', ov.length ? 2 : 0, ov.length ? `${ov.length} part${ov.length === 1 ? '' : 's'} with ${mm(ov.reduce((a, o) => a + o.area, 0), 2)} mm² of surface below ${mm(v.minAngle)}° and no support within ${mm(v.maxBridge / 2, 2)} mm.` : `Every surface below ${mm(v.minAngle)}° is supported or close to the plate.`);
  rules.angle.parts = ov.map((o) => o.part);
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
  for (const k of DESIGN_ORDER) rules[k].n = fs(k).length;
  let errors = 0, warnings = 0;
  for (const k of RULE_ORDER) { const r = rules[k]; if (r.sev === 2) errors++; else if (r.sev === 1) warnings++; }
  return { version: sceneVersion, key, P: JSON.stringify(P), N, W, H, lh, pitch, layers, features, rules, errors, warnings, level: checkCfg.level };
}
/* one line describing a feature: what it is, how big, and the limit it breaks */
function featureLabel(f, v, P) {
  const mm = (x, d = 3) => fmt(x, d).replace(/0+$/, '').replace(/\.$/, '');
  const b = f.box, dims = `${mm(b[3] - b[0], 2)} × ${mm(b[4] - b[1], 2)} × ${mm(b[5] - b[2], 2)} mm`;
  const tE = Math.max(v.minFeature, v.minWallSup);
  switch (f.k) {
    case 'thin': return f.s === 2 ? `Too thin: about ${mm(f.size)} mm, minimum ${mm(tE)} mm; ${dims}` : `Thin wall: about ${mm(f.size)} mm, under ${mm(v.minWallUnsup)} mm needs support on both sides; ${dims}`;
    case 'gap': return `Gap of about ${mm(f.size)} mm, minimum ${mm(v.clearance)} mm; ${dims}`;
    case 'vhole': return `Hole about ${mm(f.size)} mm across, minimum ${mm(v.minHoleV)} mm; ${mm(b[5] - b[2], 2)} mm deep`;
    case 'hhole': return `Horizontal hole or gap ${mm(f.size)} mm high, minimum ${mm(v.minHoleH)} mm; ${dims}`;
    case 'pin': return `Pin about ${mm(f.size)} mm across and ${mm(f.len, 2)} mm long: ${fmt(f.ar, 0)} : 1, limit ${fmt(f.limit, 0)} : 1`;
    case 'channel': return `Channel about ${mm(f.size)} mm across and ${mm(f.len, 2)} mm long: ${fmt(f.ar, 0)} : 1, limit ${fmt(f.limit, 0)} : 1`;
    case 'size': return `Outside the ${mm(P.bx)} × ${mm(P.by)} × ${mm(P.bz)} mm build volume; ${dims}`;
    case 'volume': return `${mm(f.size)} mm³, minimum ${mm(v.minVolume)} mm³`;
  }
  return '';
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
const isDesign = (k) => DESIGN_ORDER.includes(k);
function issuesOn(L) {
  if (!checkValid() || !checkResult.layers[L]) return [];
  return checkResult.layers[L].filter((i) => !checkFocus || i.k === checkFocus);
}
function featuresOn(L) {
  if (!checkValid()) return [];
  return checkResult.features.filter((f) => L >= f.l0 && L <= f.l1 && (!checkFocus || f.k === checkFocus) && (f.k === 'pin' || f.k === 'channel'));
}
/* coloured rings on the layer preview; returns a short description of this layer's problems */
function drawIssues(ctx, L, w) {
  const list = issuesOn(L), fl = featuresOn(L);
  if (!list.length && !fl.length) return '';
  const r = checkResult, k = w / r.W, css = w / Math.max(120, ctx.canvas.clientWidth || 320), n = {}, M = pixelMapper(JSON.parse(r.P), r.W, r.H);
  ctx.save(); ctx.lineWidth = 2 * css;
  const ring = (key, px, py, pr) => {
    const col = RULE_INFO[key].c, rad = Math.max(7 * css, pr * k + 4 * css);
    ctx.strokeStyle = col; ctx.fillStyle = col + '55';
    ctx.beginPath(); ctx.arc(px * k, py * k, rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    n[key] = (n[key] || 0) + 1;
  };
  for (const i of list) ring(i.k, i.px, i.py, i.pr);
  for (const f of fl) { const b = f.box; ring(f.k, M.x((b[0] + b[3]) / 2), M.y((b[1] + b[4]) / 2), Math.max(b[3] - b[0], b[4] - b[1]) / 2 / r.pitch); }
  ctx.restore();
  return Object.entries(n).map(([key, c]) => `${c} × ${RULE_INFO[key].t.split(':')[0].toLowerCase()}`).join(', ');
}
/* layers with something to show, for the Problem buttons */
function problemLayers() {
  const s = new Set();
  checkResult.layers.forEach((l, L) => { if (l.some((i) => !checkFocus || i.k === checkFocus)) s.add(L); });
  for (const f of checkResult.features) if (!checkFocus || f.k === checkFocus) s.add(Math.round((f.l0 + f.l1) / 2));
  return [...s].sort((a, b) => a - b);
}
/* step to the next (dir 1) or previous (dir -1) layer with a problem, wrapping round */
function jumpProblem(dir, fromStart) {
  if (!checkValid()) return;
  const ls = problemLayers();
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
  checkFeature = null;
  buildCheckMarks(); updateCheckUI();
  if (checkFocus && r.parts && r.parts.length) setSelection(r.parts);
  if ((k === 'supdims' || k === 'pillar') && checkFocus) { tool = 'supports'; renderToolPanel(); }
  if (checkFocus && problemLayers().length) jumpProblem(1, true); else drawLayer();
}
/* show one feature: select its parts, frame it in the 3D view and preview its middle layer */
function focusFeature(id) {
  const f = checkResult && checkResult.features[id];
  if (!f) return;
  checkFeature = checkFeature === id ? null : id;
  checkFocus = f.k;
  buildCheckMarks(); updateCheckUI();
  if (checkFeature === null) return;
  if (f.parts.length) setSelection(f.parts);
  const b = f.box, bb = { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] };
  view.target = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
  view.dist = Math.max(fitDistance(bb, camera) * 2.2, 2);
  updateCamera();
  setLayer(Math.round((f.l0 + f.l1) / 2));
}
/* clip a triangle to a box (Sutherland–Hodgman), returning a convex polygon */
function clipToBox(tri, box) {
  let poly = tri;
  for (let ax = 0; ax < 3 && poly.length; ax++) for (const [lim, sgn] of [[box[ax], 1], [box[ax + 3], -1]]) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], da = (a[ax] - lim) * sgn, db = (b[ax] - lim) * sgn;
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
    }
    poly = out;
    if (!poly.length) break;
  }
  return poly;
}
/* Part-design features painted onto the parts' surfaces in their rule's colour, with a box
   round each; print-setup problems as dots. Everything sits in the overlay, so it never
   reaches preview.png. */
function buildCheckMarks() {
  if (!renderer) return;
  if (!checkGroup) { checkGroup = new THREE.Group(); overlayGroup.add(checkGroup); }
  disposeGroup(checkGroup);
  const r = checkResult;
  if (r) {
    const paint = new Map(), boxes = new Map(), wt = new Map(), e = Math.max(2 * r.pitch, 0.02), ez = r.lh * 0.6;
    for (const f of r.features) {
      if (checkFocus && f.k !== checkFocus) continue;
      if (checkFeature !== null && f.id !== checkFeature) continue;
      const b = f.box, box = [b[0] - e, b[1] - e, b[2] - ez, b[3] + e, b[4] + e, b[5] + ez], col = RULE_INFO[f.k].c;
      if (!paint.has(col)) { paint.set(col, []); boxes.set(col, []); }
      const out = paint.get(col);
      /* whole-part rules get the box only; painting the whole part would hide the real features */
      for (const id of (f.k === 'size' || f.k === 'volume' ? [] : f.parts)) {
        const p = partById(id); if (!p) continue;
        if (!wt.has(id)) wt.set(id, worldTris(p));
        const T = wt.get(id);
        for (let i = 0; i < T.length; i += 9) {
          if (Math.max(T[i], T[i + 3], T[i + 6]) < box[0] || Math.min(T[i], T[i + 3], T[i + 6]) > box[3] || Math.max(T[i + 1], T[i + 4], T[i + 7]) < box[1] || Math.min(T[i + 1], T[i + 4], T[i + 7]) > box[4] || Math.max(T[i + 2], T[i + 5], T[i + 8]) < box[2] || Math.min(T[i + 2], T[i + 5], T[i + 8]) > box[5]) continue;
          const poly = clipToBox([[T[i], T[i + 1], T[i + 2]], [T[i + 3], T[i + 4], T[i + 5]], [T[i + 6], T[i + 7], T[i + 8]]], box);
          for (let q = 1; q + 1 < poly.length; q++) out.push(...poly[0], ...poly[q], ...poly[q + 1]);
        }
      }
      const [x0, y0, z0, x1, y1, z1] = [b[0] - e, b[1] - e, b[2], b[3] + e, b[4] + e, b[5]], L = boxes.get(col);
      for (const [ya, yb] of [[y0, y0], [y1, y1]]) for (const z of [z0, z1]) L.push(x0, ya, z, x1, yb, z);
      for (const x of [x0, x1]) for (const z of [z0, z1]) L.push(x, y0, z, x, y1, z);
      for (const x of [x0, x1]) for (const y of [y0, y1]) L.push(x, y, z0, x, y, z1);
    }
    for (const [col, pos] of paint) {
      if (pos.length) {
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false }));
        m.renderOrder = 35; m.raycast = () => {};
        checkGroup.add(m);
      }
      const bl = lineSeg(boxes.get(col), col, checkFeature !== null ? 1 : 0.55, true);
      bl.renderOrder = 36; checkGroup.add(bl);
    }
    /* print setup: a dot at every problem */
    const pos = [], cols = [], c = new THREE.Color();
    if (checkFeature === null) for (const l of r.layers) for (const i of l) {
      if (isDesign(i.k) || (checkFocus && i.k !== checkFocus)) continue;
      if (pos.length >= 3 * 4000) break;
      c.set(RULE_INFO[i.k].c); pos.push(i.x, i.y, i.z); cols.push(c.r, c.g, c.b);
    }
    if (pos.length) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 32;
      const g2 = cv.getContext('2d'); g2.fillStyle = '#fff'; g2.strokeStyle = 'rgba(0,0,0,.55)'; g2.lineWidth = 4;
      g2.beginPath(); g2.arc(16, 16, 12, 0, Math.PI * 2); g2.fill(); g2.stroke();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      const m = new THREE.Points(geo, new THREE.PointsMaterial({ size: 13, sizeAttenuation: false, vertexColors: true, map: new THREE.CanvasTexture(cv), transparent: true, alphaTest: 0.3, depthTest: false, depthWrite: false }));
      m.renderOrder = 40; m.raycast = () => {};
      checkGroup.add(m);
    }
  }
  requestRender();
}
function ruleRows(order) {
  const r = checkResult;
  return order.map((k) => {
    const x = r.rules[k], cls = x.sev === 2 ? 'err' : x.sev === 1 ? 'warn' : 'ok';
    const fl = isDesign(k) ? r.features.filter((f) => f.k === k) : [];
    const feats = fl.length ? `<ul class="feats">${fl.slice(0, 12).map((f) => `<li data-f="${f.id}" class="${f.s === 2 ? 'err' : 'warn'}${checkFeature === f.id ? ' on' : ''}" tabindex="0" role="button"><b>${esc(f.names.length > 1 ? f.names.join(' and ') : f.names[0] || 'Part')}</b> ${esc(f.label)}</li>`).join('')}${fl.length > 12 ? `<li class="more">and ${fl.length - 12} more</li>` : ''}</ul>` : '';
    return `<li data-rule="${k}" class="${cls}${checkFocus === k ? ' on' : ''}" tabindex="0" role="button" aria-pressed="${checkFocus === k}">
      <span class="ic" style="--c:${RULE_INFO[k].c}">${x.sev === 2 ? '✕' : x.sev === 1 ? '!' : '✓'}</span>
      <div><div class="nm">${esc(RULE_INFO[k].t)}</div><div class="meta">${esc(x.text)}</div>${feats}</div></li>`;
  }).join('');
}
function updateCheckUI() {
  const ok = checkValid(), r = checkResult;
  for (const b of $$('#checkSec [data-lvl]')) b.setAttribute('aria-pressed', String(b.dataset.lvl === checkCfg.level));
  $('#chkRigid').checked = checkCfg.rigid; $('#chkRigid').disabled = checkCfg.level !== 'advanced';
  $('#chkBefore').checked = checkCfg.before;
  $('#btnCheck').disabled = !!slicing || !parts.length;
  for (const [infoSel, listSel, order, countSel, label] of [['#chkInfo', '#chkList', DESIGN_ORDER, '#chkCount', 'part design'], ['#setupInfo', '#setupList', SETUP_ORDER, '#setupCount', 'print setup']]) {
    const info = $(infoSel), list = $(listSel);
    info.classList.remove('warn', 'ok');
    let n = 0;
    if (!parts.length) { info.textContent = order === DESIGN_ORDER ? 'Add a part to check it against the design guide.' : ''; list.innerHTML = ''; }
    else if (!ok) { info.textContent = checkCfg.before ? 'Not checked yet. It runs before every slice.' : 'Not checked yet. Press Run check in Design check.'; list.innerHTML = ''; }
    else {
      const t = countText(order);
      for (const k of order) if (r.rules[k].sev) n++;
      if (t) { info.textContent = `${label[0].toUpperCase() + label.slice(1)}: ${t}.`; if (order.some((k) => r.rules[k].sev === 2)) info.classList.add('warn'); }
      else { info.textContent = `All ${order.length} ${label} rules pass (${r.level}).`; info.classList.add('ok'); }
      list.innerHTML = ruleRows(order);
    }
    $(countSel).textContent = n ? String(n) : '';
  }
  $('#probPrev').disabled = $('#probNext').disabled = !(ok && (r.errors || r.warnings));
  $('#probInfo').textContent = ok && checkFeature !== null ? `Showing one feature: ${r.features[checkFeature].label}` : ok && checkFocus ? `Showing: ${RULE_INFO[checkFocus].t}` : '';
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
