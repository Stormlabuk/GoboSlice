'use strict';
const { test, expect, openApp } = require('./fixtures');

const info = (page) => page.locator('#islInfo');
async function check(page) {
  await page.click('#btnIslands');
  await page.waitForFunction(() => !slicing && islandsValid(), null, { timeout: 120000 });
  return page.evaluate(() => ({ total: islandResult.total, layers: islandResult.layers, marks: islandGroup.children.length ? islandGroup.children[0].geometry.attributes.position.count : 0 }));
}

test('a part floating above the plate is flagged, and supports fix it', async ({ page }) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="box"]');
  await expect(info(page)).toHaveText('Not checked yet. Slicing checks too.');
  await page.evaluate(() => opSetZ(parts, 1));
  const r = await check(page);
  expect(r).toEqual({ total: 1, layers: [100], marks: 1 });
  await expect(info(page)).toHaveText('1 island on 1 layer');
  /* the preview jumped to it */
  await expect(page.locator('#layerNum')).toHaveValue('101');
  await expect(page.locator('#layerInfo')).toContainText('1 unsupported island on this layer, circled in red');
  await page.click('#layerPlus');
  await expect(page.locator('#layerInfo')).not.toContainText('island');
  await page.click('#islPrev');
  await expect(page.locator('#layerNum')).toHaveValue('101');
  /* the marker sits under the box, at the bottom of layer 101 */
  const m = await page.evaluate(() => Array.from(islandGroup.children[0].geometry.attributes.position.array));
  expect(m[0]).toBeCloseTo(0, 3); expect(m[1]).toBeCloseTo(0, 3); expect(m[2]).toBeCloseTo(1, 6);
  /* any change makes the result stale */
  await page.evaluate(() => opAutoSupport(parts));
  await expect(info(page)).toHaveText('Not checked yet. Slicing checks too.');
  expect(await page.evaluate(() => islandGroup.children.length)).toBe(0);
  expect(await check(page)).toEqual({ total: 0, layers: [], marks: 0 });
  await expect(info(page)).toHaveText('No islands.');
  expect(page.errors).toEqual([]);
});

test('slicing reports islands too', async ({ page }) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="box"]');
  await page.evaluate(() => opSetZ(parts, 1));
  await page.click('#btnSlice');
  await expect(page.locator('#btnDownload')).toBeEnabled({ timeout: 60000 });
  await expect(page.locator('.toast.warn').last()).toContainText('Found 1 unsupported island on 1 layer, the first on layer 101');
  await expect(info(page)).toHaveText('1 island on 1 layer');
  expect(page.errors).toEqual([]);
});

test('workers (with chunk boundaries) and the main-thread fallback find the same islands on S140 Stitch', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    /* first layers 101 (a chunk start) and 152 (inside a chunk); a third box resting on the second */
    const a = addGeometry('a', new Float32Array(boxTris(-1, -1, 0, 1, 1, 1)));
    const b = addGeometry('b', new Float32Array(boxTris(-1, -1, 0, 1, 1, 1)));
    addGeometriesAsParts([a, b]);
    parts[0].zb = 1.0; parts[1].zb = 1.515; for (const p of parts) updateWorld(p);
    translatePart(parts[0], -10 - parts[0].x, 0); translatePart(parts[1], 10 - parts[1].x, 0);
    changed();
  });
  const viaWorkers = await check(page);
  expect(viaWorkers.layers).toEqual([100, 151]);
  expect(await page.evaluate(() => sliceResult === null && islandResult.per[100][0].area)).toBe(200 * 200);
  await page.evaluate(() => { window.makePool = async () => []; changed(); });
  const viaMain = await check(page);
  expect(viaMain).toEqual(viaWorkers);
});
