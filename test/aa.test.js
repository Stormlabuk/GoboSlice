'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, readPNG, countLit } = require('./load');

const App = loadApp();
const { Core } = App;
const SINGLE = App.normaliseProfile(App.DEFAULT_PROFILES.find((p) => p.name === 'S140 Single'));
const W = SINGLE.resX, H = SINGLE.resY, Z = 1.505;

/* Rasterises world-space triangles on S140 Single into a plain mask, binary or anti-aliased. */
function mask(tris, aa, gids) {
  const ntri = tris.length / 9, px = App.mapTris(tris, SINGLE, W, H), st = Core.makeRaster();
  const out = new Uint8Array(W * H), g = gids || new Uint32Array(ntri);
  const lit = aa ? Core.rasterLayerAA(st, px, g, ntri, Z, W, H, out, 2, aa.S, aa.lo || 0) : Core.rasterLayer(st, px, g, ntri, Z, W, H, out, 2);
  return { lit, out, area: aa ? st.grey : lit };
}
const histogram = (out) => { const h = new Map(); for (const v of out) if (v) h.set(v, (h.get(v) || 0) + 1); return h; };

/* an n-sided prism of radius r mm from z 1 to 2 mm, centred */
function prism(r, n, cx = 0, cy = 0) {
  const t = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * 2 * Math.PI, a1 = ((i + 1) / n) * 2 * Math.PI;
    const p = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], q = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
    t.push(cx, cy, 1, ...q, 1, ...p, 1, cx, cy, 2, ...p, 2, ...q, 2, ...p, 1, ...q, 1, ...q, 2, ...p, 1, ...q, 2, ...p, 2);
  }
  return t;
}
const prismArea = (r, n) => 0.5 * n * (r * 100) ** 2 * Math.sin((2 * Math.PI) / n); /* in pixels at 10 µm */

for (const S of [2, 4, 8]) {
  test(`${S}×: a pixel-aligned box gives exactly the plain mask`, () => {
    const box = App.boxTris(-1, -0.5, 1, 1, 0.5, 2);
    const a = mask(box), b = mask(box, { S });
    assert.equal(b.lit, 20000);
    assert.equal(b.area, 20000);
    assert.ok(Buffer.from(a.out).equals(Buffer.from(b.out)), 'identical masks');
  });
}

test('a box edge half-way across a pixel is grey 128; a quarter-covered corner 64', () => {
  const { out, lit, area } = mask(App.boxTris(-1.005, -0.505, 1, 1.005, 0.505, 2), { S: 4 });
  const h = histogram(out);
  assert.deepEqual([...h.keys()].sort((x, y) => x - y), [64, 128, 255]);
  assert.equal(h.get(64), 4);
  assert.equal(h.get(128), 2 * 200 + 2 * 100);
  assert.equal(h.get(255), 200 * 100);
  assert.equal(lit, 202 * 102);
  assert.ok(Math.abs(area - 201 * 101) < 2, `area ${area}`);
});

test('a round part: the grey-weighted area matches the true area far better than the plain mask', () => {
  const r = 2, n = 256, exact = prismArea(r, n);
  const plain = mask(prism(r, n));
  for (const S of [4, 8]) {
    const aa = mask(prism(r, n), { S });
    assert.ok(Math.abs(aa.area - exact) / exact < 5e-5, `${S}×: ${aa.area} vs ${exact}`);
    assert.ok(Math.abs(aa.area - exact) < Math.abs(plain.area - exact), `${S}× closer than plain (${plain.area})`);
    /* greys only along the edge: every pixel the plain mask lights is lit, and a few more */
    for (let i = 0; i < W * H; i++) if (plain.out[i] && !aa.out[i]) assert.fail(`pixel ${i} lost`);
    assert.ok(aa.lit - plain.lit < 2 * Math.PI * r * 100, 'extra pixels fit in a one-pixel rim');
  }
});

test('darkest edge grey: every touched pixel is at least that grey, the inside stays 255', () => {
  const { out } = mask(prism(1, 64), { S: 4, lo: 100 });
  const h = histogram(out);
  assert.ok(Math.min(...h.keys()) >= 100);
  assert.ok(h.get(255) > 25000);
  assert.ok(h.size > 20, `${h.size} distinct greys`);
});

test('overlapping solids unite: coverage is never counted twice', () => {
  const tris = [...App.boxTris(-1.0025, -0.5025, 1, 0.5025, 0.5025, 2), ...App.boxTris(-0.5025, -0.5025, 1, 1.0025, 0.5025, 2)];
  const gids = new Uint32Array(24).fill(1, 12);
  const { out, area } = mask(tris, { S: 4 }, gids);
  const one = mask(App.boxTris(-1.0025, -0.5025, 1, 1.0025, 0.5025, 2), { S: 4 });
  assert.ok(Buffer.from(out).equals(Buffer.from(one.out)), 'same as one box over both');
  assert.ok(Math.abs(area - 200.5 * 100.5) < 1, `area ${area}`);
});

test('8-bit PNG output: greys survive encoding and lit pixels match', async () => {
  const px = App.mapTris(prism(1, 64), SINGLE, W, H), st = Core.makeRaster();
  const raw = new Uint8Array(Core.rawSize(W, H, 8));
  const lit = Core.rasterLayerAA(st, px, new Uint32Array(px.length / 9), px.length / 9, Z, W, H, raw, 0, 4, 0);
  const png = readPNG(await Core.encodePNG(raw, W, H, 8));
  assert.equal(countLit(png), lit);
  let greys = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const v = png.raw[r * (W + 1) + 1 + c]; if (v && v < 255) greys++; }
  assert.ok(greys > 400, `${greys} grey pixels`);
});

test('a full 9400 × 5200 layer at 8× rasterises in under 2 s', (t) => {
  const W2 = 9400, H2 = 5200, st = Core.makeRaster();
  /* edges a quarter of a pixel in, where 8 lines per pixel sample the coverage exactly */
  const tris = new Float32Array(App.boxTris(100.25, 100.25, 0, W2 - 100.25, H2 - 100.25, 10));
  const out = new Uint8Array(Core.rawSize(W2, H2, 8));
  Core.rasterLayerAA(st, tris, new Uint32Array(12), 12, 0.005, W2, H2, out, 0, 8, 0);
  out.fill(0);
  const t0 = performance.now();
  Core.rasterLayerAA(st, tris, new Uint32Array(12), 12, 0.005, W2, H2, out, 0, 8, 0);
  const ms = performance.now() - t0;
  t.diagnostic(`raster ${ms.toFixed(0)} ms`);
  /* each edge pixel's grey is rounded to 1/255, so allow half that per edge pixel */
  const exact = (W2 - 200.5) * (H2 - 200.5), edge = 2 * (W2 + H2);
  assert.ok(Math.abs(st.grey - exact) < edge * 0.5 / 255, `area ${st.grey} vs ${exact}`);
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
});
