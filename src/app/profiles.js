/* ---------- Printer profiles ---------- */
const PROFILE_FIELDS = {
  name: 'Printer', resX: 1920, resY: 1080, lockRatio: true, bx: 19.2, by: 10.8, bz: 45, mirror: 'h', offX: 0, offY: 0,
  layerUm: 10, bits: 8, firstNum: 1, pad: 0, preview: true, tiling: false, fieldX: 19.2, fieldY: 10.8, fieldsX: 1, fieldsY: 1
};
const DEFAULT_PROFILES = [
  { name: 'S140 Stitch', resX: 9400, resY: 5200, lockRatio: true, bx: 94, by: 52, bz: 45, mirror: 'h', offX: 0, offY: 0, layerUm: 10, bits: 8, firstNum: 1, pad: 0, preview: true, tiling: true, fieldX: 19.2, fieldY: 10.8, fieldsX: 5, fieldsY: 5 },
  { name: 'S140 Single', resX: 1920, resY: 1080, lockRatio: true, bx: 19.2, by: 10.8, bz: 45, mirror: 'h', offX: 0, offY: 0, layerUm: 10, bits: 8, firstNum: 1, pad: 0, preview: true, tiling: false, fieldX: 19.2, fieldY: 10.8, fieldsX: 1, fieldsY: 1 }
];
function normaliseProfile(p) {
  const o = {};
  for (const k in PROFILE_FIELDS) {
    const d = PROFILE_FIELDS[k];
    let v = p && p[k] !== undefined ? p[k] : d;
    if (typeof d === 'number') { v = +v; if (!isFinite(v)) v = d; }
    else if (typeof d === 'boolean') v = !!v;
    else v = String(v);
    o[k] = v;
  }
  o.resX = Math.max(1, Math.round(o.resX)); o.resY = Math.max(1, Math.round(o.resY));
  o.bx = Math.max(0.01, o.bx); o.by = Math.max(0.01, o.by); o.bz = Math.max(0.01, o.bz);
  o.layerUm = clamp(o.layerUm, 0.1, 1000); o.bits = o.bits === 1 ? 1 : 8;
  o.firstNum = Math.max(0, Math.round(o.firstNum)); o.pad = clamp(Math.round(o.pad), 0, 12);
  o.fieldsX = Math.max(1, Math.round(o.fieldsX)); o.fieldsY = Math.max(1, Math.round(o.fieldsY));
  o.fieldX = Math.max(0.01, o.fieldX); o.fieldY = Math.max(0.01, o.fieldY);
  if (!['none', 'h', 'v', 'hv'].includes(o.mirror)) o.mirror = 'none';
  return o;
}
let profiles = (LS.get('goboslice.profiles', null) || clone(DEFAULT_PROFILES)).map(normaliseProfile);
if (!profiles.length) profiles = clone(DEFAULT_PROFILES).map(normaliseProfile);
let profIdx = clamp(+LS.get('goboslice.profileIdx', 0) || 0, 0, profiles.length - 1);
const prof = () => profiles[profIdx];
function saveProfiles() { LS.set('goboslice.profiles', profiles); LS.set('goboslice.profileIdx', profIdx); }
function derived(P = prof()) {
  const ox = P.fieldsX > 1 ? (P.fieldsX * P.fieldX - P.bx) / (P.fieldsX - 1) : 0;
  const oy = P.fieldsY > 1 ? (P.fieldsY * P.fieldY - P.by) / (P.fieldsY - 1) : 0;
  const pitchX = P.bx / P.resX, pitchY = P.by / P.resY;
  return {
    pitchX, pitchY, x0: P.offX - P.bx / 2, x1: P.offX + P.bx / 2, y0: P.offY - P.by / 2, y1: P.offY + P.by / 2,
    cx: P.offX, cy: P.offY, ox, oy, oxPx: ox / pitchX, oyPx: oy / pitchY, lh: P.layerUm / 1000
  };
}
/* ---------- Field seams ----------
   A stitched image is exposed as a grid of fields that overlap in thin strips. A part lying
   across a strip is exposed partly by one field and partly by the next, so its features can
   show the seam. Strips are in plate millimetres; null when the profile is not tiled. */
let seamAware = LS.get('goboslice.seams', true) !== false;
function seamStrips(P = prof()) {
  if (!P.tiling || (P.fieldsX < 2 && P.fieldsY < 2)) return null;
  const D = derived(P), xs = [], ys = [];
  const strips = (n, f, o, base, out) => {
    for (let i = 1; i < n; i++) { const s = (i * (f - o)), e = (i - 1) * (f - o) + f; out.push([base + Math.min(s, e), base + Math.max(s, e)]); }
  };
  strips(P.fieldsX, P.fieldX, D.ox, D.x0, xs);
  strips(P.fieldsY, P.fieldY, D.oy, D.y0, ys);
  return { xs, ys };
}
/* does the box [x0, x1] × [y0, y1] cut into any strip? touching an edge is fine */
function crossesSeam(x0, x1, y0, y1, S = seamStrips()) {
  if (!S) return false;
  const e = 1e-6, hit = (a, b, list) => list.some(([s0, s1]) => b > s0 + e && a < s1 - e);
  return hit(x0, x1, S.xs) || hit(y0, y1, S.ys);
}
function fileName(P, i) { let s = String(P.firstNum + i); if (P.pad > 0) s = s.padStart(P.pad, '0'); return s + '.png'; }

/* ---------- Support settings ---------- */
const DEFAULT_SUP = {
  preset: 'medium', lift: 1.10,
  tipShape: 'sphere', tipD: 0.10, tipDepth: 0.02, conn: 'cone', upD: 0.10, lowD: 0.25, connLen: 1.00,
  pilD: 0.30, braces: false, braceReach: 4.0, braceStart: 3.0,
  baseD: 0.60, baseH: 0.20,
  raft: false, raftT: 0.30, raftMargin: 0.50,
  density: 100, overhang: 45, platformOnly: false, minZOn: false, minZ: 0
};
const PRESET_MULT = { light: 0.7, medium: 1, heavy: 1.45 };
function normaliseSup(s) {
  const o = {};
  for (const k in DEFAULT_SUP) {
    const d = DEFAULT_SUP[k]; let v = s && s[k] !== undefined ? s[k] : d;
    if (typeof d === 'number') { v = +v; if (!isFinite(v)) v = d; } else if (typeof d === 'boolean') v = !!v; else v = String(v);
    o[k] = v;
  }
  if (!PRESET_MULT[o.preset]) o.preset = 'medium';
  if (!['none', 'sphere'].includes(o.tipShape)) o.tipShape = 'sphere';
  if (!['cone', 'cylinder'].includes(o.conn)) o.conn = 'cone';
  o.density = clamp(o.density, 1, 1000); o.overhang = clamp(o.overhang, 0, 89);
  for (const k of ['lift', 'tipD', 'tipDepth', 'upD', 'lowD', 'connLen', 'pilD', 'braceReach', 'braceStart', 'baseD', 'baseH', 'raftT', 'raftMargin']) o[k] = Math.max(0, o[k]);
  return o;
}
let supCfg = normaliseSup(LS.get('goboslice.supports', null));
function saveSup() { LS.set('goboslice.supports', supCfg); }
function supDims(c = supCfg) {
  const m = PRESET_MULT[c.preset] || 1;
  return {
    m, tipR: Math.max(0.002, c.tipD * m / 2), depth: c.tipDepth, upR: Math.max(0.002, c.upD * m / 2), lowR: Math.max(0.002, c.lowD * m / 2),
    connLen: c.connLen, pilR: Math.max(0.002, c.pilD * m / 2), baseR: Math.max(0.002, c.baseD * m / 2), baseH: c.baseH,
    platZ: c.raft ? c.raftT : 0, raft: c.raft, raftT: c.raftT, margin: c.raftMargin,
    spacing: 0.5 * 100 / c.density, gapMin: Math.max(0.15, 1.5 * c.lowD * m)
  };
}
let arrangeGap = +LS.get('goboslice.gap', 1) || 1;

