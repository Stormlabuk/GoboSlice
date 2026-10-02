'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, readPNG, countLit } = require('./load');

const App = loadApp();
const { Core } = App;
const SINGLE = App.normaliseProfile(App.DEFAULT_PROFILES.find((p) => p.name === 'S140 Single'));
const Z = 1.505;

/* 2 × 1 × 1 mm box standing 1 mm above the plate, centred */
const box = () => App.boxTris(-1, -0.5, 1, 1, 0.5, 2);
const insideOut = (t) => {
  t = t.slice();
  for (let i = 0; i < t.length; i += 9) for (let k = 0; k < 3; k++) { const s = t[i + 3 + k]; t[i + 3 + k] = t[i + 6 + k]; t[i + 6 + k] = s; }
  return t;
};

/* Rasterise world-space triangles on a profile, the same way the slicer does. */
function slice(tris, P, z, mode, gids) {
  const W = P.resX, H = P.resY, ntri = tris.length / 9;
  const px = App.mapTris(tris, P, W, H);
  const out = new Uint8Array(mode === 2 ? W * H : Core.rawSize(W, H, mode === 1 ? 1 : 8));
  const lit = Core.rasterLayer(Core.makeRaster(), px, gids || new Uint32Array(ntri), ntri, z, W, H, out, mode);
  return { lit, out, W, H };
}

async function sliceToPNG(tris, P, z, bits) {
  const r = slice(tris, P, z, bits === 1 ? 1 : 0);
  const png = await Core.encodePNG(r.out, r.W, r.H, bits);
  return { lit: r.lit, png: readPNG(png) };
}

for (const bits of [8, 1]) {
  test(`2×1×1 mm box on S140 Single at z = ${Z} mm lights 20,000 px (${bits}-bit)`, async () => {
    const { lit, png } = await sliceToPNG(box(), SINGLE, Z, bits);
    assert.equal(lit, 20000);
    assert.deepEqual([png.W, png.H, png.bits, png.colour], [1920, 1080, bits, 0]);
    assert.equal(countLit(png), 20000, 'white pixels in the decoded PNG');
  });

  test(`inside-out box gives the same mask (${bits}-bit)`, async () => {
    const a = await sliceToPNG(box(), SINGLE, Z, bits);
    const b = await sliceToPNG(insideOut(box()), SINGLE, Z, bits);
    assert.equal(b.lit, 20000);
    assert.equal(countLit(b.png), 20000);
    assert.ok(a.png.raw.equals(b.png.raw), 'scanlines identical');
  });
}

test('two overlapping solids unite into 30,000 px with no holes', () => {
  const tris = [...box(), ...App.boxTris(0, -0.5, 1, 2, 0.5, 2)];
  const gids = new Uint32Array(24); gids.fill(1, 12);
  const { lit, out, W } = slice(tris, SINGLE, Z, 2, gids);
  assert.equal(lit, 30000);
  /* lit pixels must fill their bounding box exactly: 300 × 100 px, no gaps */
  let r0 = Infinity, r1 = -1, c0 = Infinity, c1 = -1, n = 0;
  for (let i = 0; i < out.length; i++) if (out[i]) { n++; const r = (i / W) | 0, c = i % W; r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
  assert.equal(n, 30000);
  assert.deepEqual([c1 - c0 + 1, r1 - r0 + 1], [300, 100]);
});

test('the same overlap with the second solid inside out still has no holes', () => {
  const tris = [...box(), ...insideOut(App.boxTris(0, -0.5, 1, 2, 0.5, 2))];
  const gids = new Uint32Array(24); gids.fill(1, 12);
  assert.equal(slice(tris, SINGLE, Z, 2, gids).lit, 30000);
});

/* Pins the documented mapping: row 0 = back (+Y), column 0 = left (−X), then the mirror. */
test('pixel mapping: row 0 is the back edge, column 0 the left edge, then the mirror', () => {
  const D = App.derived(SINGLE);
  /* 0.1 × 0.1 mm (10 × 10 px) post in the back-left corner of the plate */
  const post = App.boxTris(D.x0, D.y1 - 0.1, 0, D.x0 + 0.1, D.y1, 1);
  const where = (mirror) => {
    const P = App.normaliseProfile({ ...SINGLE, mirror });
    const { out, W } = slice(post, P, 0.5, 2);
    let r0 = Infinity, c0 = Infinity, r1 = -1, c1 = -1;
    for (let i = 0; i < out.length; i++) if (out[i]) { const r = (i / W) | 0, c = i % W; r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); }
    return [c0, c1, r0, r1];
  };
  assert.deepEqual(where('none'), [0, 9, 0, 9]);
  assert.deepEqual(where('h'), [1910, 1919, 0, 9]);
  assert.deepEqual(where('v'), [0, 9, 1070, 1079]);
  assert.deepEqual(where('hv'), [1910, 1919, 1070, 1079]);
});

test('a full 9400 × 5200 layer rasterises and encodes in well under 1 s', async (t) => {
  const W = 9400, H = 5200, st = Core.makeRaster();
  const tris = new Float32Array(App.boxTris(100, 100, 0, W - 100, H - 100, 10));
  const raw = new Uint8Array(Core.rawSize(W, H, 8));
  Core.rasterLayer(st, tris, new Uint32Array(12), 12, 0.005, W, H, raw, 0); /* warm-up */
  raw.fill(0);
  const t0 = performance.now();
  const lit = Core.rasterLayer(st, tris, new Uint32Array(12), 12, 0.005, W, H, raw, 0);
  const t1 = performance.now();
  const png = await Core.encodePNG(raw, W, H, 8);
  const t2 = performance.now();
  t.diagnostic(`raster ${(t1 - t0).toFixed(0)} ms, encode ${(t2 - t1).toFixed(0)} ms, ${(png.length / 1024).toFixed(0)} KB`);
  assert.equal(lit, (W - 200) * (H - 200));
  assert.ok(t2 - t0 < 1000, `took ${(t2 - t0).toFixed(0)} ms`);
  const dec = readPNG(png);
  assert.deepEqual([dec.W, dec.H, dec.bits], [W, H, 8]);
});

test('stored-block zlib fallback produces a valid stream', () => {
  const zlib = require('zlib');
  const d = new Uint8Array(200000); for (let i = 0; i < d.length; i++) d[i] = (i * 7) & 255;
  assert.ok(zlib.inflateSync(Core.zlibStored(d)).equals(Buffer.from(d)));
});

test('core is self-contained: its source runs with no globals, as in the worker blob', async () => {
  const { loadCore } = require('./load');
  const vm = require('vm');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'core.js'), 'utf8');
  /* only what a worker always has; no CompressionStream, so the stored-block fallback runs */
  const bare = vm.runInNewContext(src + '\ngobosliceCore();', {});
  const raw = new Uint8Array(bare.rawSize(16, 4, 8));
  const png = await bare.encodePNG(raw, 16, 4, 8);
  assert.deepEqual([readPNG(png).W, readPNG(png).H], [16, 4]);
  assert.equal(typeof loadCore().rasterLayer, 'function');
});

/* ---------- Islands ---------- */
function islandsPerLayer(tris, P, N, opts = {}) {
  const W = P.resX, H = P.resY, lh = P.layerUm / 1000, ntri = tris.length / 9;
  const px = App.mapTris(tris, P, W, H), gids = opts.gids || new Uint32Array(ntri), st = Core.makeRaster();
  const from = opts.from || 0, out = new Map();
  Core.islandsBegin(st);
  if (from > 0) Core.islandsPrime(st, px, gids, ntri, (from - 0.5) * lh, W, H);
  for (let L = from; L < N; L++) {
    Core.rasterLayer(st, px, gids, ntri, (L + 0.5) * lh, W, H, null, 3);
    const isl = Core.islandsTake(st, H, L === 0);
    if (isl.length) out.set(L, isl);
  }
  return out;
}

test('islands: a box on the plate has none', () => {
  assert.equal(islandsPerLayer(App.boxTris(-1, -0.5, 0, 1, 0.5, 1), SINGLE, 100).size, 0);
});

test('islands: a floating box is one island, on its first layer only', () => {
  const r = islandsPerLayer(box(), SINGLE, 200); /* box spans z 1 to 2 mm: layers 100 to 199 */
  assert.deepEqual([...r.keys()], [100]);
  const [i] = r.get(100);
  assert.equal(i.area, 20000);
  assert.deepEqual([i.x1 - i.x0, i.y1 - i.y0], [200, 100]);
  assert.ok(Math.abs(i.cx - 960) < 1e-9 && Math.abs(i.cy - 540) < 1e-9, `centre ${i.cx}, ${i.cy}`);
});

test('islands: a box on a post is supported; an overhang growing sideways is not an island', () => {
  const post = App.boxTris(-0.1, -0.1, 0, 0.1, 0.1, 1.005);
  assert.equal(islandsPerLayer([...post, ...box()], SINGLE, 200, { gids: new Uint32Array(24).fill(1, 12) }).size, 0);
  /* a 45° wedge: each layer reaches one pixel further than the one below */
  const wedge = [];
  const P = [[-1, -0.5, 0], [-1, 0.5, 0], [-0.5, -0.5, 0], [-0.5, 0.5, 0], [-1, -0.5, 1], [-1, 0.5, 1], [0.5, -0.5, 1], [0.5, 0.5, 1]];
  const q = (a, b, c, d) => wedge.push(...P[a], ...P[b], ...P[c], ...P[a], ...P[c], ...P[d]);
  q(0, 2, 3, 1); q(4, 5, 7, 6); q(0, 1, 5, 4); q(2, 6, 7, 3); q(0, 4, 6, 2); q(1, 3, 7, 5);
  assert.equal(islandsPerLayer(wedge, SINGLE, 100).size, 0);
});

test('islands: two floating boxes are two islands; each layer checks against the one below', () => {
  const two = [...App.boxTris(-3, -0.5, 1, -2, 0.5, 2), ...App.boxTris(2, -0.5, 1.5, 3, 0.5, 2)];
  const gids = new Uint32Array(24).fill(1, 12);
  const r = islandsPerLayer(two, SINGLE, 200, { gids });
  assert.deepEqual([...r.keys()], [100, 150]);
  assert.equal(r.get(100).length, 1);
  assert.equal(r.get(150).length, 1);
  /* starting part-way up (as a worker chunk does) gives the same answer for those layers */
  const late = islandsPerLayer(two, SINGLE, 200, { gids, from: 120 });
  assert.deepEqual([...late.keys()], [150]);
  const atStart = islandsPerLayer(two, SINGLE, 200, { gids, from: 100 });
  assert.deepEqual([...atStart.keys()], [100, 150]);
});

test('islands: recording runs does not change the mask', () => {
  const W = SINGLE.resX, H = SINGLE.resY, px = App.mapTris(box(), SINGLE, W, H);
  const a = new Uint8Array(Core.rawSize(W, H, 8)), b = new Uint8Array(a.length), st = Core.makeRaster();
  Core.rasterLayer(st, px, new Uint32Array(12), 12, Z, W, H, a, 0);
  Core.islandsBegin(st);
  Core.rasterLayer(st, px, new Uint32Array(12), 12, Z, W, H, b, 0);
  assert.ok(Buffer.from(a).equals(Buffer.from(b)));
  assert.equal(st.nr, 100);
});
