/* ===================================================================
   GoboSlice application
   =================================================================== */
'use strict';
const Core = gobosliceCore();
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DEG = Math.PI / 180;
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmt(v, d = 2) { let s = (+v).toFixed(d); if (/^-0(\.0*)?$/.test(s)) s = s.slice(1); return s; }
function num(v, d = 4) { const n = +(+v).toFixed(d); return String(Object.is(n, -0) ? 0 : n); }
function fmtBytes(b) { if (b < 1024) return b + ' B'; if (b < 1048576) return fmt(b / 1024, 1) + ' KB'; if (b < 1073741824) return fmt(b / 1048576, 1) + ' MB'; return fmt(b / 1073741824, 2) + ' GB'; }
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
};
/* Settings saved under this app's earlier name, Microslice, carry over the first time GoboSlice runs */
(function migrateStorage() {
  try {
    for (const k of ['profiles', 'profileIdx', 'supports', 'gap']) {
      const v = localStorage.getItem('microslice.' + k);
      if (v !== null && localStorage.getItem('goboslice.' + k) === null) localStorage.setItem('goboslice.' + k, v);
    }
  } catch (e) { /* storage unavailable */ }
})();

/* ---------- Small vector / quaternion maths ----------
   Quaternions are [x, y, z, w]. Euler angles use the XYZ convention
   (matrix = Rx · Ry · Rz), matching three.js. Matrices are row-major 3×3. */
const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
};
const Q = {
  mul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  },
  axis(ax, ang) { const s = Math.sin(ang / 2); return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(ang / 2)]; },
  norm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; },
  fromEuler(e) { return Q.mul(Q.mul(Q.axis([1, 0, 0], e[0] * DEG), Q.axis([0, 1, 0], e[1] * DEG)), Q.axis([0, 0, 1], e[2] * DEG)); },
  fromUnitVectors(f, t) {
    let r = V.dot(f, t) + 1, x, y, z;
    if (r < 1e-9) { r = 0; if (Math.abs(f[0]) > Math.abs(f[2])) { x = -f[1]; y = f[0]; z = 0; } else { x = 0; y = -f[2]; z = f[1]; } }
    else { const c = V.cross(f, t); x = c[0]; y = c[1]; z = c[2]; }
    return Q.norm([x, y, z, r]);
  },
  toMat3(q) {
    const [x, y, z, w] = q;
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
      2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
      2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)
    ];
  },
  toEuler(q) {
    const m = Q.toMat3(Q.norm(q));
    const y = Math.asin(clamp(m[2], -1, 1));
    let x, z;
    if (Math.abs(m[2]) < 0.9999999) { x = Math.atan2(-m[5], m[8]); z = Math.atan2(-m[1], m[0]); }
    else { x = Math.atan2(m[7], m[4]); z = 0; }
    const r = (a) => { let d = a / DEG; d = Math.round(d * 1e6) / 1e6; if (Object.is(d, -0)) d = 0; return d; };
    return [r(x), r(y), r(z)];
  }
};
function m3v(m, v) { return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]; }
function m3T(m) { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }

