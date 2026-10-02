'use strict';
const { test, expect, openApp } = require('./fixtures');

/* parts from boxes [x0, y0, z0, x1, y1, z1]; each list is one part */
async function scene(page, profile, partsBoxes) {
  await page.selectOption('#profileSel', { label: profile });
  await page.evaluate((list) => {
    const gs = list.map((boxes, i) => { const t = []; for (const b of boxes) boxTris(...b, t); return addGeometry('p' + i, new Float32Array(t)); });
    addGeometriesAsParts(gs);
    /* addGeometry centres each part and placement moves it: put the boxes back where they were given */
    parts.forEach((p, i) => {
      const bs = list[i], mn = [0, 1, 2].map((k) => Math.min(...bs.map((b) => b[k]))), mx = [0, 1, 2].map((k) => Math.max(...bs.map((b) => b[k + 3])));
      p.zb = mn[2]; updateWorld(p); translatePart(p, (mn[0] + mx[0]) / 2 - p.x, (mn[1] + mx[1]) / 2 - p.y);
    });
    setSelection([]); changed();
  }, partsBoxes);
}
async function check(page) {
  await page.click('#btnCheck');
  await page.waitForFunction(() => !slicing && checkValid(), null, { timeout: 120000 });
  return page.evaluate(() => Object.fromEntries(RULE_ORDER.map((k) => [k, checkResult.rules[k].sev])));
}
const fails = (r) => Object.keys(r).filter((k) => r[k]);

test('a clean part passes every rule', async ({ page }) => {
  await openApp(page);
  await scene(page, 'S140 Single', [[[-1, -1, 0, 1, 1, 1]]]);
  expect(fails(await check(page))).toEqual([]);
  await expect(page.locator('#chkInfo')).toHaveText('All 14 rules pass (recommended).');
  await expect(page.locator('#chkList li.ok')).toHaveCount(14);
  expect(page.errors).toEqual([]);
});

test('a floating part: island and shallow overhang, found, shown, and fixed by supports', async ({ page }) => {
  await openApp(page);
  await scene(page, 'S140 Single', [[[-1, -0.5, 1, 1, 0.5, 1.6]]]);
  await expect(page.locator('#chkInfo')).toHaveText('Not checked yet. It runs before every slice.');
  expect(fails(await check(page))).toEqual(['island', 'angle']);
  await expect(page.locator('#chkList li.err')).toHaveCount(2);
  /* jumped to the first problem layer */
  await expect(page.locator('#layerNum')).toHaveValue('101');
  await expect(page.locator('#layerInfo')).toContainText('Design check on this layer: 1 × islands, 1 × shallow overhangs without support');
  expect(await page.evaluate(() => checkGroup.children[0].geometry.attributes.position.count)).toBe(2);
  /* focusing a rule shows only that rule */
  await page.click('#chkList li[data-rule="island"]');
  await expect(page.locator('#probInfo')).toHaveText('Showing: Islands: printing onto nothing');
  expect(await page.evaluate(() => checkGroup.children[0].geometry.attributes.position.count)).toBe(1);
  /* any change makes the result stale; supports fix both */
  await page.evaluate(() => opAutoSupport(parts));
  await expect(page.locator('#chkInfo')).toHaveText('Not checked yet. It runs before every slice.');
  expect(fails(await check(page))).toEqual([]);
  expect(page.errors).toEqual([]);
});

test('thin walls, clearance, vertical and horizontal holes, ledges, bridges and pins', async ({ page }) => {
  await openApp(page);
  await scene(page, 'S140 Single', [
    [[-8, -4, 0, -6, -3.97, 0.5]], /* a 0.03 mm wall */
    [[-5, -4, 0, -4, -3, 0.4]], [[-3.95, -4, 0, -3, -3, 0.4]], /* two parts 0.05 mm apart */
    [[-1, -4, 0, 1, -3.015, 0.3], [-1, -2.985, 0, 1, -2, 0.3], [-1, -3.015, 0, -0.015, -2.985, 0.3], [0.015, -3.015, 0, 1, -2.985, 0.3]], /* a 0.03 mm hole */
    [[3, -4, 0, 5, -3, 0.2], [3, -4, 0.3, 5, -3, 0.5], [3, -4, 0.2, 3.2, -3, 0.3]], /* a 0.1 mm slot */
    [[-8, 0, 0, -7.6, 0.4, 0.5], [-8.6, 0, 0.5, -7, 0.4, 0.6]], /* a cap 0.6 mm over its post */
    [[-5, 0, 0, -4.8, 0.4, 0.5], [-2.2, 0, 0, -2, 0.4, 0.5], [-5, 0, 0.5, -2, 0.4, 0.6]], /* a 2.6 mm bridge */
    [[2, 1, 0, 4, 3, 0.2], [2.95, 1.95, 0.2, 3.05, 2.05, 6.2]] /* a 0.1 × 6 mm pin */
  ]);
  const r = await check(page);
  /* the cap and bridge undersides are also flat and unsupported, and the thin wall is under 1 mm³ */
  expect(fails(r).sort()).toEqual(['angle', 'gap', 'hhole', 'ledge', 'pin', 'thin', 'vhole', 'volume']);
  const t = await page.evaluate(() => ({ ledge: checkResult.rules.ledge.text, pin: checkResult.rules.pin.text }));
  expect(t.pin).toMatch(/^1 pin longer than the limit\. Worst 5\d : 1, 0\.11\d mm across and 6 mm long \(limit 40 : 1\)/); /* a 0.1 mm square is 0.113 mm across as a circle */
  expect(page.errors).toEqual([]);
});

test('Advanced allows what Recommended flags; edited values are kept and stale the result', async ({ page }) => {
  await openApp(page);
  await scene(page, 'S140 Single', [[[-4, -0.04, 0, 4, 0.04, 2]]]); /* a 0.08 mm wall, 1.28 mm³ */
  expect(await check(page)).toMatchObject({ thin: 1 });
  await page.click('#checkSec [data-lvl="advanced"]');
  await expect(page.locator('#chkInfo')).toHaveText('Not checked yet. It runs before every slice.');
  expect(fails(await check(page))).toEqual([]);
  await page.click('#checkSec details.rules summary');
  await page.fill('#chkRules input[data-r="minWallUnsup"]', '0.12');
  await page.locator('#chkRules input[data-r="minWallUnsup"]').dispatchEvent('change');
  expect(await page.evaluate(() => [checkValid(), JSON.parse(localStorage.getItem('goboslice.check')).custom.advanced.minWallUnsup])).toEqual([false, 0.12]);
  expect(await check(page)).toMatchObject({ thin: 1 });
  await page.click('#chkReset');
  expect(fails(await check(page))).toEqual([]);
});

test('settings rules: part volume, layer height, support cones, pillars, and Supports to guide values', async ({ page }) => {
  await openApp(page);
  await scene(page, 'S140 Single', [[[-0.4, -0.4, 0, 0.4, 0.4, 0.4]], [[2, -1, 15, 4, 1, 15.5]]]);
  await page.evaluate(() => { setSupCfg('preset', 'light'); opAutoSupport([parts[1]]); });
  await page.click('#btnSettings');
  await page.fill('#settingsBody [data-p="layerUm"]', '60');
  await page.click('#settingsDlg [data-close="ok"]');
  const r = await check(page);
  expect(r).toMatchObject({ volume: 1, layer: 1, supdims: 1, pillar: 1 });
  await page.click('#chkList li[data-rule="volume"]');
  expect(await page.evaluate(() => selected().map((p) => p.name))).toEqual(['p0']);
  await page.click('#btnGuideSup');
  expect(await page.evaluate(() => [supCfg.preset, supCfg.overhang, supCfg.upD, supCfg.lowD])).toEqual(['medium', 30, 0.1, 0.25]);
  expect(await check(page)).toMatchObject({ supdims: 0 });
});

test('Slice runs the check first and asks before slicing a design with problems', async ({ page }) => {
  await openApp(page);
  await scene(page, 'S140 Single', [[[-1, -0.5, 1, 1, 0.5, 1.2]]]);
  await page.click('#btnSlice');
  await expect(page.locator('#confirmDlg[open] #cfTitle')).toHaveText('Design check');
  await expect(page.locator('#cfText')).toContainText('likely to fail');
  await page.click('#cfNo');
  expect(await page.evaluate(() => sliceResult)).toBe(null);
  await page.click('#btnSlice');
  await page.click('#cfYes');
  await expect(page.locator('#btnDownload')).toBeEnabled({ timeout: 60000 });
  /* with the check off, Slice goes straight ahead */
  await page.uncheck('#chkBefore');
  await page.evaluate(() => changed());
  await page.click('#btnSlice');
  await expect(page.locator('#btnDownload')).toBeEnabled({ timeout: 60000 });
  expect(await page.locator('#confirmDlg[open]').count()).toBe(0);
  expect(page.errors).toEqual([]);
});

test('workers and the main-thread fallback give the same report on S140 Stitch', async ({ page }) => {
  await openApp(page);
  await scene(page, 'S140 Stitch', [
    [[-20, -10, 0, -18, -9.97, 0.6]], [[-15, -10, 1, -13, -9, 1.2]], [[0, 0, 0, 2, 1, 0.2], [0, 0, 0.3, 2, 1, 0.5], [0, 0, 0.2, 0.2, 1, 0.3]],
    [[10, 5, 0, 10.4, 5.4, 0.5], [9.4, 5, 0.5, 11, 5.4, 0.6]]
  ]);
  await check(page);
  const viaWorkers = await page.evaluate(() => JSON.stringify([checkResult.rules, checkResult.layers]));
  await page.evaluate(() => { window.makePool = async () => []; changed(); });
  await check(page);
  const viaMain = await page.evaluate(() => JSON.stringify([checkResult.rules, checkResult.layers]));
  expect(viaMain).toEqual(viaWorkers);
  expect(JSON.parse(viaWorkers)[0].island.sev).toBe(2);
});
