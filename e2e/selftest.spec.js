'use strict';
const { test, expect, openApp } = require('./fixtures');

test('built-in self-test reports every check passing', async ({ page }) => {
  await openApp(page);
  await page.click('#btnSelfTest');
  await page.waitForFunction(() => Array.isArray(window.__selfTest), null, { timeout: 60000 });
  const res = await page.evaluate(() => window.__selfTest);
  const failed = res.filter((r) => !r.pass).map((r) => `${r.name}: ${r.detail}`);
  expect(failed).toEqual([]);
  expect(res.length).toBeGreaterThanOrEqual(10);
  await expect(page.locator('#statsNote')).toContainText('All checks passed.');
  expect(page.errors).toEqual([]);
});
