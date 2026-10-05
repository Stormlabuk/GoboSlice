'use strict';
const { test, expect, openApp } = require('./fixtures');

const hb = (page, k) => page.locator(`#hotbar [data-hb="${k}"]`);
const centreOnScreen = (page, i) => page.evaluate((i) => {
  scene.updateMatrixWorld(true);
  const b = parts[i].wb, v = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2).project(camera), r = canvas.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
}, i);

test('hotbar: greyed out until there is something to act on', async ({ page }) => {
  await openApp(page);
  for (const k of ['layflat', 'arrange', 'drop', 'centre', 'rotz', 'support', 'dup', 'del']) await expect(hb(page, k)).toBeDisabled();
  await page.click('[data-sample="box"]');
  await page.evaluate(() => setSelection([]));
  for (const k of ['layflat', 'arrange', 'drop', 'centre', 'rotz', 'support']) await expect(hb(page, k)).toBeEnabled();
  for (const k of ['dup', 'del']) await expect(hb(page, k)).toBeDisabled();
  await expect(hb(page, 'drop')).toHaveAttribute('title', 'Drop every part to the plate');
  await page.evaluate(() => setSelection([parts[0].id]));
  await expect(hb(page, 'del')).toBeEnabled();
  await expect(hb(page, 'drop')).toHaveAttribute('title', 'Drop box-2x1x1 to the plate');
});

test('hotbar Lay flat: click a face from any tool, Esc to stop', async ({ page }) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="plate"]');
  await page.click('.tool[data-tool="supports"]');
  await hb(page, 'layflat').click();
  await expect(hb(page, 'layflat')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#hudMode')).toContainText('Lay flat');
  const c = await centreOnScreen(page, 0);
  await page.mouse.move(c.x - 3, c.y - 3); await page.mouse.move(c.x, c.y);
  await page.mouse.click(c.x, c.y);
  expect(await page.evaluate(() => +(parts[0].wb.max[2] - parts[0].wb.min[2]).toFixed(4))).toBe(0.3);
  await page.keyboard.press('Escape');
  await expect(hb(page, 'layflat')).toHaveAttribute('aria-pressed', 'false');
  expect(page.errors).toEqual([]);
});

test('hotbar Arrange all and the selection operations', async ({ page }) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="box"]');
  await page.evaluate(() => { addSample('rod'); addSample('mirror'); for (const p of parts) translatePart(p, -p.x, -p.y); setSelection([]); changed(); });
  await hb(page, 'arrange').click();
  const boxes = await page.evaluate(() => parts.map((p) => { const b = footprint(p); return [b.min[0], b.min[1], b.max[0], b.max[1]]; }));
  const ov = (a, b) => a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6;
  expect(boxes.some((a, i) => boxes.some((b, j) => i !== j && ov(a, b)))).toBe(false);
  /* on the selection only */
  await page.evaluate(() => { opSetZ(parts, 1); setSelection([parts[0].id]); });
  await hb(page, 'drop').click();
  expect(await page.evaluate(() => parts.map((p) => p.zb))).toEqual([0, 1, 1]);
  await hb(page, 'rotz').click();
  expect(await page.evaluate(() => parts.map((p) => p.rot[2]))).toEqual([90, 0, 0]);
  await hb(page, 'dup').click();
  expect(await page.evaluate(() => parts.length)).toBe(4);
  await hb(page, 'del').click();
  expect(await page.evaluate(() => parts.length)).toBe(3);
  /* nothing selected: every part */
  await page.evaluate(() => setSelection([]));
  await hb(page, 'drop').click();
  expect(await page.evaluate(() => parts.map((p) => p.zb))).toEqual([0, 0, 0]);
  await hb(page, 'support').click();
  await expect(page.locator('.toast').last()).toContainText('to 3 parts');
  expect(page.errors).toEqual([]);
});
