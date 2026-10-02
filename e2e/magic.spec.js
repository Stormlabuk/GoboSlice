'use strict';
const { test, expect, openApp } = require('./fixtures');

const height = (page) => page.evaluate(() => { const p = parts[0]; return p.wb.max[2] - p.wb.min[2]; });

for (const [kind, want, what] of [['plate', 0.3, 'lays the tilted plate flat'], ['rod', 6, 'stands the rod on its end']]) {
  test(`Magic ${what} (${want} mm tall)`, async ({ page }) => {
    await openApp(page);
    await page.click(`[data-sample="${kind}"]`);
    await expect(page.locator('#partsList li')).toHaveCount(1);
    const before = await height(page);
    await page.click('#btnMagic');
    await expect(page.locator('.toast').last()).toContainText('Magic done');
    const after = await height(page);
    expect(Math.abs(after - want), `height ${after.toFixed(4)} mm (was ${before.toFixed(3)} mm)`).toBeLessThan(0.01);
    /* the part ends up inside the build area, and Magic is one undo step */
    expect(await page.evaluate(() => parts[0].oob)).toBe(false);
    await page.click('#btnUndo');
    expect(Math.abs((await height(page)) - before)).toBeLessThan(1e-6);
    expect(page.errors).toEqual([]);
  });
}
