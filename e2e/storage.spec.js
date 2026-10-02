'use strict';
const { test, expect, openApp } = require('./fixtures');

const OLD_PROFILE = [{ name: 'Old bench printer', resX: 1000, resY: 500, bx: 10, by: 5, bz: 20, mirror: 'v' }];

test('settings saved under microslice.* carry over to goboslice.* on first load', async ({ page }) => {
  await page.addInitScript((prof) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.clear();
    localStorage.setItem('microslice.profiles', JSON.stringify(prof));
    localStorage.setItem('microslice.profileIdx', '0');
    localStorage.setItem('microslice.supports', JSON.stringify({ preset: 'heavy', density: 150 }));
    localStorage.setItem('microslice.gap', '2.5');
  }, OLD_PROFILE);
  await openApp(page);
  await expect(page.locator('#profileSel option:checked')).toHaveText('Old bench printer');
  const s = await page.evaluate(() => ({ sup: supCfg.preset, density: supCfg.density, gap: arrangeGap, prof: prof().mirror,
    keys: Object.keys(localStorage).filter((k) => k.startsWith('goboslice.')).sort() }));
  expect(s).toEqual({ sup: 'heavy', density: 150, gap: 2.5, prof: 'v', keys: ['goboslice.gap', 'goboslice.profileIdx', 'goboslice.profiles', 'goboslice.supports'] });
  /* new saves go to the new keys */
  await page.selectOption('#profileSel', { index: 0 });
  await page.evaluate(() => { supCfg.preset = 'light'; saveSup(); });
  await page.reload();
  await page.waitForFunction(() => typeof renderer !== 'undefined' && renderer);
  expect(await page.evaluate(() => [supCfg.preset, prof().name])).toEqual(['light', 'Old bench printer']);
});

test('existing goboslice.* keys are never overwritten by old ones', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.clear();
    localStorage.setItem('microslice.gap', '7');
    localStorage.setItem('goboslice.gap', '3');
  });
  await openApp(page);
  expect(await page.evaluate(() => [arrangeGap, localStorage.getItem('goboslice.gap')])).toEqual([3, '3']);
});
