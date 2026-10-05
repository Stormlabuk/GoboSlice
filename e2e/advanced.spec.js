'use strict';
const { test, expect, openApp } = require('./fixtures');

/* lit pixels at height z, rasterising the whole plate the way the slicer does */
const litAt = (page, z) => page.evaluate((z) => {
  const P = prof(), W = P.resX, H = P.resY, bk = bakeScene(W, H, P), out = new Uint8Array(W * H);
  return Core.rasterLayer(Core.makeRaster(), bk.tris, bk.gids, bk.ntri, z, W, H, out, 2);
}, z);
async function openAdvanced(page) {
  await page.click('.tool[data-tool="advanced"]');
  await expect(page.locator('#toolTitle')).toHaveText('Advanced tools');
}
async function setField(page, k, v) {
  await page.fill(`#toolBody input[data-k="${k}"]`, String(v));
  await page.locator(`#toolBody input[data-k="${k}"]`).dispatchEvent('change');
}

test('3D array with no gaps: one solid part, cells touching in X, Y and Z', async ({ page }) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="box"]');
  const b0 = await page.evaluate(() => parts[0].wb);
  await openAdvanced(page);
  await setField(page, 'a3x', 3); await setField(page, 'a3y', 2); await setField(page, 'a3z', 2);
  await expect(page.locator('#a3note')).toHaveText('12 cells, 6 × 2 × 2 mm, 144 triangles.');
  await page.click('[data-act="array3d"]');
  const r = await page.evaluate(() => ({ n: parts.length, name: parts[0].name, wb: parts[0].wb, pieces: geoms.get(parts[0].gid).pieces.length / 2, sel: selected().length }));
  expect(r).toMatchObject({ n: 1, name: 'box-2x1x1 3×2×2', pieces: 12, sel: 1 });
  for (let k = 0; k < 3; k++) expect(r.wb.min[k]).toBeCloseTo(b0.min[k], 6);
  expect([0, 1, 2].map((k) => +(r.wb.max[k] - r.wb.min[k]).toFixed(6))).toEqual([6, 2, 2]);
  /* solid all through: 600 × 200 px on a layer in each row of cells, no seams */
  expect(await litAt(page, 0.505)).toBe(120000);
  expect(await litAt(page, 1.505)).toBe(120000);
  /* undo brings the single box back */
  await page.click('#btnUndo');
  expect(await page.evaluate(() => [parts.length, parts[0].name])).toEqual([1, 'box-2x1x1']);
  expect(page.errors).toEqual([]);
});

test('overlap fuses the cells; the overlapping solids still slice solid', async ({ page }) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="box"]');
  await openAdvanced(page);
  await setField(page, 'a3x', 3); await setField(page, 'a3y', 2); await setField(page, 'a3z', 1); await setField(page, 'a3o', 0.2);
  await page.click('[data-act="array3d"]');
  const w = await page.evaluate(() => [0, 1, 2].map((k) => +(parts[0].wb.max[k] - parts[0].wb.min[k]).toFixed(6)));
  expect(w).toEqual([5.6, 1.8, 1]);
  /* 5.6 × 1.8 mm: overlaps are counted once, never as holes */
  expect(await litAt(page, 0.505)).toBe(560 * 180);
});

test('without Combine the copies are separate parts; Combine joins parts; supports are cleared', async ({ page }) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="box"]');
  await page.evaluate(() => { opSetZ(parts, 1); opAutoSupport(parts); });
  expect(await page.evaluate(() => parts[0].sup.length)).toBeGreaterThan(0);
  await openAdvanced(page);
  await setField(page, 'a3x', 2); await setField(page, 'a3y', 2); await setField(page, 'a3z', 2);
  await page.uncheck('#toolBody input[data-k="a3c"]');
  await page.click('[data-act="array3d"]');
  const r = await page.evaluate(() => ({ n: parts.length, sup: parts.reduce((a, p) => a + p.sup.length, 0), z: [...new Set(parts.map((p) => +p.zb.toFixed(6)))].sort() }));
  expect(r).toEqual({ n: 8, sup: 0, z: [1.1, 2.1] }); /* auto-support lifted the box to its 1.1 mm lift height */
  const before = await litAt(page, 1.505);
  expect(before).toBe(400 * 200);
  await page.evaluate(() => setSelection(parts.map((p) => p.id)));
  await page.click('[data-act="combine"]');
  expect(await page.evaluate(() => [parts.length, parts[0].name, geoms.get(parts[0].gid).pieces.length / 2])).toEqual([1, 'combined 8', 8]);
  expect(await litAt(page, 1.505)).toBe(before);
  expect(await litAt(page, 2.505)).toBe(before);
  /* the combined part can be arrayed again */
  await setField(page, 'a3x', 2); await setField(page, 'a3y', 1); await setField(page, 'a3z', 1); await page.check('#toolBody input[data-k="a3c"]');
  await page.click('[data-act="array3d"]');
  expect(await page.evaluate(() => [parts.length, geoms.get(parts[0].gid).pieces.length / 2])).toEqual([1, 16]);
  expect(await litAt(page, 1.505)).toBe(800 * 200);
  expect(page.errors).toEqual([]);
});
