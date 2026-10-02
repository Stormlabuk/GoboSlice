'use strict';
const { test, expect, openApp } = require('./fixtures');

/* S140 Stitch: 5 × 5 fields of 19.2 × 10.8 mm over 94 × 52 mm, so 0.5 mm overlap strips.
   Worked out here from the preset numbers, not taken from the app. */
const STRIPS_X = [1, 2, 3, 4].map((i) => [-47 + i * 18.7, -47 + (i - 1) * 18.7 + 19.2]);
const STRIPS_Y = [1, 2, 3, 4].map((i) => [-26 + i * 10.3, -26 + (i - 1) * 10.3 + 10.8]);
const cuts = (a, b, strips) => strips.some(([s0, s1]) => b > s0 + 1e-6 && a < s1 - 1e-6);
const footprints = (page) => page.evaluate(() => parts.map((p) => { const b = footprint(p); return { name: p.name, x0: b.min[0], x1: b.max[0], y0: b.min[1], y1: b.max[1], seam: p.seam, oob: p.oob }; }));
const crossing = (fs) => fs.filter((f) => cuts(f.x0, f.x1, STRIPS_X) || cuts(f.y0, f.y1, STRIPS_Y));

test('the app puts the overlap strips where the preset says', async ({ page }) => {
  await openApp(page);
  const S = await page.evaluate(() => seamStrips());
  S.xs.forEach(([a, b], i) => { expect(a).toBeCloseTo(STRIPS_X[i][0], 9); expect(b).toBeCloseTo(STRIPS_X[i][1], 9); });
  S.ys.forEach(([a, b], i) => { expect(a).toBeCloseTo(STRIPS_Y[i][0], 9); expect(b).toBeCloseTo(STRIPS_Y[i][1], 9); });
});

test('a part across a seam is badged; Arrange and Magic clear every seam', async ({ page }) => {
  await openApp(page);
  await page.click('[data-sample="box"]');
  /* straddle the strip at x = -9.6 .. -9.1 */
  await page.evaluate(() => { const b = footprint(parts[0]); opMove(parts, -9.35 - (b.min[0] + b.max[0]) / 2, 0); });
  await expect(page.locator('#partsList .seam')).toHaveCount(1);
  await expect(page.locator('#hudSel')).toContainText('crosses a field seam');
  for (const k of ['rod', 'plate', 'mirror', 'plate', 'rod']) await page.evaluate((kind) => addSample(kind), k);
  await page.evaluate(() => opArray(parts.find((p) => p.name === 'box-2x1x1'), 16, 8, 0.4));
  await page.click('.tool[data-tool="move"]');
  await expect(page.locator('#toolBody input[data-k="seams"]')).toBeChecked();
  await page.click('[data-act="arrange"]');
  let fs = await footprints(page);
  expect(crossing(fs).map((f) => f.name)).toEqual([]);
  expect(fs.filter((f) => f.oob)).toEqual([]);
  await expect(page.locator('#partsList .seam')).toHaveCount(0);
  await page.click('#btnMagic');
  fs = await footprints(page);
  expect(crossing(fs).map((f) => f.name)).toEqual([]);
  expect(fs.filter((f) => f.oob)).toEqual([]);
  expect(page.errors).toEqual([]);
});

test('Magic keeps supported parts, supports included, clear of seams', async ({ page }) => {
  await openApp(page);
  /* spheres have no flat face, so Magic lifts them onto supports */
  const sup = await page.evaluate(() => {
    const gs = [];
    for (let i = 0; i < 6; i++) { const mb = new MeshBuilder(); sphere(mb, [0, 0, 0], 2.2, 16, 24); gs.push(addGeometry('ball' + i, new Float32Array(mb.a))); }
    addGeometriesAsParts(gs);
    opMagic();
    return parts.map((p) => p.sup.length);
  });
  expect(sup).not.toContain(0);
  const fs = await footprints(page);
  expect(crossing(fs)).toEqual([]);
  expect(fs.filter((f) => f.oob)).toEqual([]);
});

test('new parts land clear of seams; the setting can be turned off and is remembered', async ({ page }) => {
  await openApp(page);
  await page.click('[data-sample="rod"]');
  for (let i = 0; i < 8; i++) await page.evaluate(() => addSample('plate'));
  expect(crossing(await footprints(page))).toEqual([]);
  await page.click('.tool[data-tool="move"]');
  await page.uncheck('#toolBody input[data-k="seams"]');
  expect(await page.evaluate(() => [seamAware, localStorage.getItem('goboslice.seams')])).toEqual([false, 'false']);
  await page.reload();
  await page.waitForFunction(() => typeof renderer !== 'undefined' && renderer);
  expect(await page.evaluate(() => seamAware)).toBe(false);
});

test('profiles without tiling have no seams, badge or setting', async ({ page }) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="plate"]');
  await page.evaluate(() => { addSample('rod'); addSample('box'); arrangeAll(); });
  expect(await page.evaluate(() => [seamStrips(), parts.some((p) => p.seam)])).toEqual([null, false]);
  await page.click('.tool[data-tool="move"]');
  await expect(page.locator('#toolBody input[data-k="seams"]')).toHaveCount(0);
});
