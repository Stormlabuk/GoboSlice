'use strict';
/* The design check in core, on synthetic shapes at S140 Single resolution (10 µm pixels, 10 µm layers). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load');

const App = loadApp();
const { Core } = App;
const P = App.normaliseProfile(App.DEFAULT_PROFILES.find((p) => p.name === 'S140 Single'));
const W = P.resX, H = P.resY, lh = 0.01;
/* recommended values, in pixels and layers (see checkRules in the app) */
const R = { thinE: 2, thinW: 4, gap: 4, hole: 2, ledge: 30, bridge: 150, maxSteps: 182, gmax: 14, pinD: 113, chanD: 45, cap: 12 };

function check(solids, opts = {}, chunk = 0) {
  const tris = [], gids = [], kind = [];
  solids.forEach((s, i) => { const t = s.tris || s; tris.push(...t); for (let k = 0; k < t.length / 9; k++) { gids.push(i); kind.push(s.support ? 1 : 0); } });
  let maxZ = 0; for (let i = 2; i < tris.length; i += 3) maxZ = Math.max(maxZ, tris[i]);
  const N = Math.ceil(maxZ / lh - 1e-7), per = [];
  const m = { tris: App.mapTris(new Float32Array(tris), P, W, H), gids: Uint32Array.from(gids), kind: Uint8Array.from(kind), ntri: gids.length, l0: 0, l1: N, N, W, H, lh, check: { ...R, ...opts } };
  if (!chunk) Core.checkRange(m, (L, res) => { per[L] = res; });
  else for (let l0 = 0; l0 < N; l0 += chunk) Core.checkRange({ ...m, l0, l1: Math.min(N, l0 + chunk) }, (L, res) => { assert.equal(per[L], undefined); per[L] = res; });
  const count = {};
  per.forEach((r) => r && r.issues.forEach((i) => { const k = i.k + (i.s === 1 ? ':warn' : ''); count[k] = (count[k] || 0) + 1; }));
  return { per, count, N };
}
const box = (x0, y0, z0, x1, y1, z1) => App.boxTris(x0, y0, z0, x1, y1, z1);

test('every layer gets exactly one result', () => {
  const r = check([box(-1, -1, 0, 1, 1, 0.5)]);
  assert.equal(r.N, 50);
  assert.equal(r.per.filter(Boolean).length, 50);
  assert.deepEqual(r.count, {});
});

test('thin walls: 0.03 mm is an error, 0.08 mm a warning, 0.2 mm is fine', () => {
  assert.ok(check([box(-1, -0.015, 0, 1, 0.015, 0.5)]).count.thin > 0);
  const w = check([box(-1, -0.04, 0, 1, 0.04, 0.5)]).count;
  assert.ok(!w.thin && w['thin:warn'] > 0, JSON.stringify(w));
  assert.deepEqual(check([box(-1, -0.1, 0, 1, 0.1, 0.5)]).count, {});
});

test('clearance: parts 0.05 mm apart are flagged, 0.3 mm apart are not', () => {
  const close = check([box(-1, -0.5, 0, -0.025, 0.5, 0.3), box(0.025, -0.5, 0, 1, 0.5, 0.3)]).count;
  assert.ok(close['gap:warn'] > 0, JSON.stringify(close));
  assert.deepEqual(check([box(-1, -0.5, 0, -0.15, 0.5, 0.3), box(0.15, -0.5, 0, 1, 0.5, 0.3)]).count, {});
});

test('vertical holes: a 0.03 mm square hole is too small, 0.2 mm is fine', () => {
  const frame = (h) => [box(-1, -1, 0, 1, -h, 0.3), box(-1, h, 0, 1, 1, 0.3), box(-1, -h, 0, -h, h, 0.3), box(h, -h, 0, 1, h, 0.3)];
  const small = check(frame(0.015)).count;
  assert.ok(small.vhole > 0 && !small['gap:warn'], JSON.stringify(small));
  assert.deepEqual(check(frame(0.1)).count, {});
});

test('islands: a box floating 1 mm up is one island', () => {
  const r = check([box(-1, -0.5, 1, 1, 0.5, 1.2)]);
  assert.equal(r.count.island, 1);
  assert.equal(r.per[100].issues[0].k, 'island');
});

test('ledges: a cap overhanging its post by 0.5 mm is flagged, by 0.2 mm not', () => {
  const t = (o) => [box(-0.2, -0.2, 0, 0.2, 0.2, 0.5), box(-0.2 - o, -0.2, 0.5, 0.2 + o, 0.2, 0.6)];
  const far = check(t(0.5));
  assert.ok(far.count.ledge > 0, JSON.stringify(far.count));
  const i = far.per[50].issues.find((x) => x.k === 'ledge');
  assert.equal(i.b, 0);
  assert.deepEqual(check(t(0.2)).count, {});
});

test('bridges: a beam between posts 1 mm apart is fine, 2.4 mm apart is too long', () => {
  const b = (gap) => [box(-gap / 2 - 0.2, -0.2, 0, -gap / 2, 0.2, 0.5), box(gap / 2, -0.2, 0, gap / 2 + 0.2, 0.2, 0.5), box(-gap / 2 - 0.2, -0.2, 0.5, gap / 2 + 0.2, 0.2, 0.6)];
  assert.deepEqual(check(b(1)).count, {});
  const long = check(b(2.4));
  const i = long.per[50].issues.find((x) => x.k === 'ledge');
  assert.ok(i && i.b === 1 && i.v > 150, JSON.stringify(i));
});

test('horizontal gaps: a slot 0.1 mm high is flagged, 0.3 mm high is not', () => {
  const slot = (h) => [box(-1, -0.5, 0, 1, 0.5, 0.2), box(-1, -0.5, 0.2 + h, 1, 0.5, 0.4 + h), box(-1, -0.5, 0.2, -0.8, 0.5, 0.2 + h)];
  const narrow = check(slot(0.1)).count;
  assert.ok(narrow.hhole > 0, JSON.stringify(narrow));
  assert.ok(!check(slot(0.3)).count.hhole);
});

test('supports do not count for the part rules', () => {
  /* a support cone right under a part would otherwise read as a thin feature and a horizontal gap */
  const part = box(-1, -1, 1, 1, 1, 1.3), post = { tris: box(-0.03, -0.03, 0, 0.03, 0.03, 1.02), support: true };
  const r = check([part, post]);
  assert.ok(!r.count.thin && !r.count.hhole && !r.count['thin:warn'], JSON.stringify(r.count));
  assert.ok(r.count.ledge > 0, 'one 0.06 mm post under a 2 mm square leaves most of it overhanging');
});

test('pins: a 0.1 mm pin 6 mm tall is tracked as one slender chain', () => {
  const r = check([box(-1, -1, 0, 1, 1, 0.2), box(-0.05, -0.05, 0.2, 0.05, 0.05, 6.2)]);
  const chains = Core.trackChains(r.per.map((x) => x.pins)).filter((c) => c.l1 - c.l0 > 10);
  assert.equal(chains.length, 1);
  const c = chains[0], hmm = (c.l1 - c.l0 + 1) * lh, d = c.d[Math.floor(c.d.length / 2)] * 0.01;
  assert.ok(Math.abs(hmm - 6) < 0.02 && d > 0.1 && d < 0.12 && hmm / d > 40, `${hmm} mm tall, ${d} mm across`);
});

test('checking in chunks of 7 layers gives exactly the same results as one pass', () => {
  const scene = [box(-1, -0.5, 0, 1, 0.5, 0.2), box(-1, -0.5, 0.3, 1, 0.5, 0.5), box(-1, -0.5, 0.2, -0.8, 0.5, 0.3),
    box(-0.2, -0.2, 0.5, 0.2, 0.2, 0.9), box(-0.7, -0.2, 0.9, 0.7, 0.2, 1.0), box(1.5, -0.015, 0, 2.5, 0.015, 0.4), box(-2, -0.5, 0.65, -1.5, 0.5, 0.8)];
  const one = check(scene), split = check(scene, {}, 7);
  assert.ok(Object.keys(one.count).length >= 4, JSON.stringify(one.count));
  assert.deepEqual(split.per, one.per);
});
