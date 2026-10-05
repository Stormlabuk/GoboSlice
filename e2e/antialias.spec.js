'use strict';
const { test, expect, openApp } = require('./fixtures');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { readPNG, countLit } = require('../test/load');

async function openAdvanced(page) {
  await page.click('.tool[data-tool="advanced"]');
  await expect(page.locator('#toolTitle')).toHaveText('Advanced tools');
}
const level = (page) => page.locator('#toolBody select[data-k="aa.level"]');
async function slice(page) {
  await page.evaluate(() => { checkCfg.before = false; invalidateSlice(); });
  await page.click('#btnSlice');
  await expect(page.locator('#btnDownload')).toBeEnabled({ timeout: 120000 });
  return page.evaluate(() => ({ N: sliceResult.N, lit: sliceResult.lit, area: sliceResult.area, aa: sliceResult.aa, workers: sliceResult.workers }));
}

test('anti-aliasing: off by default, grey edges in the PNGs when on, workers and main thread agree', async ({ page }, ti) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  /* a round rod lying on its side and a box half a pixel off the grid */
  await page.evaluate(() => { addSample('rod'); addSample('box'); const b = parts[1]; translatePart(b, 0.005, 0.005); changed(); setSelection([]); });
  await openAdvanced(page);
  await expect(level(page)).toHaveValue('0');
  await expect(page.locator('#aanote')).toContainText('black or white');
  await expect(page.locator('#stats')).not.toContainText('Anti-aliasing');
  const plain = await slice(page);
  expect(plain.aa).toBe(null);
  expect(plain.area).toEqual(plain.lit);

  await level(page).selectOption('4');
  await expect(page.locator('#aanote')).toContainText('4 lines down each pixel');
  await expect(page.locator('#stats')).toContainText('4×, edge greys 1–255');
  await expect(page.locator('#layerInfo')).toContainText('anti-aliased 4×');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('goboslice.aa')))).toEqual({ level: 4, lo: 0 });
  const viaWorkers = await slice(page);
  expect(viaWorkers.workers).toBeGreaterThan(0);
  expect(viaWorkers.aa).toEqual({ S: 4, lo: 0 });
  expect(viaWorkers.N).toBe(plain.N);
  /* about the same material, with more pixels lit (the grey rim) */
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  expect(sum(viaWorkers.lit)).toBeGreaterThan(sum(plain.lit));
  expect(Math.abs(sum(viaWorkers.area) - sum(plain.lit)) / sum(plain.lit)).toBeLessThan(0.01);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
  const dir = ti.outputPath('zip'); fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, dl.suggestedFilename()); await dl.saveAs(zip);
  execFileSync('unzip', ['-q', '-o', zip, '-d', path.join(dir, 'x')]);
  const L = Math.floor(viaWorkers.N / 2);
  const png = readPNG(new Uint8Array(fs.readFileSync(path.join(dir, 'x', `${L + 1}.png`))));
  expect([png.bits, png.colour]).toEqual([8, 0]);
  expect(countLit(png)).toBe(viaWorkers.lit[L]);
  let grey = 0, greys = 0;
  for (let r = 0; r < png.H; r++) for (let c = 0; c < png.W; c++) { const v = png.raw[r * (png.W + 1) + 1 + c]; grey += v; if (v && v < 255) greys++; }
  expect(greys).toBeGreaterThan(100);
  expect(Math.abs(grey / 255 - viaWorkers.area[L])).toBeLessThan(1e-6 * grey);

  await page.evaluate(() => { window.makePool = async () => []; });
  const viaMain = await slice(page);
  expect(await page.evaluate(() => sliceResult.workers)).toBe(0);
  expect(viaMain.lit).toEqual(viaWorkers.lit);
  expect(viaMain.area.map((a) => +a.toFixed(6))).toEqual(viaWorkers.area.map((a) => +a.toFixed(6)));

  /* darkest edge grey */
  await page.fill('#toolBody input[data-k="aa.lo"]', '90');
  await page.locator('#toolBody input[data-k="aa.lo"]').dispatchEvent('change');
  await expect(page.locator('#stats')).toContainText('edge greys 90–255');
  await expect(page.locator('#aanote')).toContainText('at least grey 90');
  expect(page.errors).toEqual([]);
});

test('anti-aliasing: kept after a reload, and not applied to 1-bit masks', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => localStorage.setItem('goboslice.aa', JSON.stringify({ level: 8, lo: 300 })));
  await page.reload();
  await page.waitForFunction(() => typeof renderer !== 'undefined' && renderer);
  expect(await page.evaluate(() => aaCfg)).toEqual({ level: 8, lo: 254 });
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await openAdvanced(page);
  await expect(level(page)).toHaveValue('8');
  await expect(level(page)).toBeEnabled();
  await page.click('#btnSettings');
  await page.selectOption('#settingsBody [data-p="bits"]', '1');
  await page.click('#settingsDlg [data-close="ok"]');
  await expect(level(page)).toBeDisabled();
  await expect(page.locator('#aanote')).toContainText('1-bit');
  await expect(page.locator('#stats')).toContainText('not with 1-bit masks');
  await page.evaluate(() => { addSample('rod'); setSelection([]); });
  const r = await slice(page);
  expect(r.aa).toBe(null);
  expect(r.area).toEqual(r.lit);
  expect(page.errors).toEqual([]);
});
