'use strict';
const { test, expect, openApp } = require('./fixtures');

const state = (page) => page.evaluate(() => ({
  names: parts.map((p) => p.name), sel: selected().map((p) => p.id), ids: parts.map((p) => p.id),
  boxes: parts.map((p) => { const b = footprint(p); return [b.min[0], b.min[1], b.max[0], b.max[1]]; }),
  sup: parts.map((p) => p.sup.length), rot: parts.map((p) => p.rot.map((v) => +v.toFixed(3)))
}));
const overlap = (a, b) => a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6;
const noOverlaps = (boxes) => boxes.every((a, i) => boxes.every((b, j) => i === j || !overlap(a, b)));
async function keys(page, combo) { await page.locator('#vp canvas').focus(); await page.keyboard.press(combo); }

test('Ctrl+C / Ctrl+V copies the selection into free space, as often as you like, one undo step each', async ({ page }) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="plate"]');
  await page.evaluate(() => { opRot90(parts, 2, 1); opAutoSupport(parts); setSelection(parts.map((p) => p.id)); });
  const s0 = await state(page);
  await keys(page, 'Control+c');
  await expect(page.locator('.toast').last()).toContainText('Copied tilted-plate');
  await keys(page, 'Control+v');
  let s = await state(page);
  expect(s.names).toEqual(['tilted-plate', 'tilted-plate']);
  expect(s.sel).toEqual([s.ids[1]]);
  expect(s.rot[1]).toEqual(s0.rot[0]);
  expect(s.sup[1]).toBe(s0.sup[0]);
  expect(noOverlaps(s.boxes)).toBe(true);
  await keys(page, 'Control+v');
  await keys(page, 'Control+v');
  s = await state(page);
  expect(s.names.length).toBe(4);
  expect(noOverlaps(s.boxes)).toBe(true);
  await page.click('#btnUndo');
  expect((await state(page)).names.length).toBe(3);
  expect(page.errors).toEqual([]);
});

test('Copy is a snapshot: later moves and deletes do not change what is pasted', async ({ page }) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="box"]');
  await page.evaluate(() => addSample('rod'));
  await page.evaluate(() => setSelection(parts.map((p) => p.id)));
  await keys(page, 'Control+c');
  await page.evaluate(() => { opScaleBy(parts, 1.5); opDelete(parts); });
  expect((await state(page)).names).toEqual([]);
  await keys(page, 'Control+v');
  const s = await state(page);
  expect(s.names.sort()).toEqual(['box-2x1x1', 'rod-0.8x6']);
  expect(s.sel.length).toBe(2);
  expect(await page.evaluate(() => parts.map((p) => p.scale[0]))).toEqual([1, 1]);
  expect(noOverlaps(s.boxes)).toBe(true);
});

test('with nothing selected or copied the keys do nothing; the context menu has Copy and Paste', async ({ page }) => {
  await openApp(page);
  await page.click('[data-sample="box"]');
  await page.evaluate(() => setSelection([]));
  await keys(page, 'Control+v');
  await keys(page, 'Control+c');
  await keys(page, 'Control+v');
  expect((await state(page)).names.length).toBe(1);
  expect(await page.evaluate(() => clipboard.length)).toBe(0);
  /* right-click the part: Copy, then Paste in the menu */
  const at = await page.evaluate(() => {
    scene.updateMatrixWorld(true);
    const b = parts[0].wb, v = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]).project(camera), r = canvas.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  });
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect(page.locator('#menu li[role=menuitem]', { hasText: 'Paste' })).toHaveAttribute('aria-disabled', 'true');
  await page.locator('#menu li[role=menuitem]', { hasText: 'Copy' }).click();
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.locator('#menu li[role=menuitem]', { hasText: 'Paste' }).click();
  expect((await state(page)).names.length).toBe(2);
  /* typing in a number field still pastes text, not parts */
  await page.click('.tool[data-tool="move"]');
  await page.locator('#toolBody input[data-k="x"]').focus();
  await page.keyboard.press('Control+v');
  expect((await state(page)).names.length).toBe(2);
});
