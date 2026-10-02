'use strict';
const { test, expect, openApp } = require('./fixtures');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { readPNG, countLit } = require('../test/load');

const SAMPLES = ['box', 'rod', 'plate', 'mirror'];

async function loadSamples(page) {
  /* the first through the empty-plate link, the rest the same way the link does it */
  await page.click('[data-sample="box"]');
  for (const k of SAMPLES.slice(1)) await page.evaluate((kind) => addSample(kind), k);
  await expect(page.locator('#partsList li')).toHaveCount(SAMPLES.length);
}

async function selectProfile(page, name) {
  await page.selectOption('#profileSel', { label: name });
  await expect(page.locator('#stats')).toContainText(name);
}

/* Slices, downloads, extracts. Returns the extracted directory and what the app reported. */
async function sliceAndDownload(page, dir) {
  await page.click('#btnSlice');
  const cf = page.locator('#confirmDlg[open]');
  await expect(page.locator('#btnDownload')).toBeEnabled({ timeout: 200000 });
  expect(await cf.count(), 'no parts outside the build area').toBe(0);
  const info = await page.evaluate(() => {
    const r = sliceResult, b = sceneBounds(false);
    return { N: r.N, W: r.W, H: r.H, bits: r.P.bits, lh: r.P.layerUm / 1000, maxZ: b.max[2], lit: r.lit, workers: r.workers, preview: r.preview };
  });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnDownload')]);
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, dl.suggestedFilename());
  await dl.saveAs(zip);
  const t = execFileSync('unzip', ['-t', zip], { encoding: 'utf8' });
  expect(t).toMatch(/No errors detected/);
  const out = path.join(dir, 'x');
  execFileSync('unzip', ['-q', '-o', zip, '-d', out]);
  return { info, zip, out };
}

function checkPNGs(out, info, decodeEvery) {
  const files = fs.readdirSync(out).sort((a, b) => parseInt(a) - parseInt(b));
  const masks = files.filter((f) => /^\d+\.png$/.test(f));
  expect(masks.length).toBe(info.N);
  expect(masks).toEqual(Array.from({ length: info.N }, (_, i) => `${i + 1}.png`));
  expect(files.filter((f) => !masks.includes(f))).toEqual(['preview.png']);
  for (let i = 0; i < masks.length; i++) {
    const buf = fs.readFileSync(path.join(out, masks[i]));
    if (i % decodeEvery === 0) {
      const png = readPNG(new Uint8Array(buf));
      expect([png.W, png.H, png.bits, png.colour]).toEqual([info.W, info.H, info.bits, 0]);
      expect(countLit(png), `lit pixels in ${masks[i]}`).toBe(info.lit[i]);
    } else {
      /* IHDR only: width, height, bit depth, colour type */
      expect([buf.readUInt32BE(16), buf.readUInt32BE(20), buf[24], buf[25]]).toEqual([info.W, info.H, info.bits, 0]);
    }
  }
  const pv = readPNG(new Uint8Array(fs.readFileSync(path.join(out, 'preview.png'))));
  expect([pv.W, pv.H]).toEqual([1280, 800]);
  return masks.length;
}

const CASES = [
  { profile: 'S140 Single', bits: 8, decodeEvery: 1 },
  { profile: 'S140 Single', bits: 1, decodeEvery: 1 },
  { profile: 'S140 Stitch', bits: 8, decodeEvery: 40 }
];

for (const c of CASES) {
  test(`sample shapes on ${c.profile}, ${c.bits}-bit: ZIP passes unzip -t, PNG count, size and depth`, async ({ page }, ti) => {
    await openApp(page);
    await selectProfile(page, c.profile);
    if (c.bits !== 8) {
      await page.click('#btnSettings');
      await page.selectOption('#settingsBody [data-p="bits"]', String(c.bits));
      await page.click('#settingsDlg [data-close="ok"]');
      await expect(page.locator('#stats')).toContainText(`${c.bits}-bit`);
    }
    await loadSamples(page);
    const { info, out } = await sliceAndDownload(page, ti.outputPath('zip'));
    expect(info.N).toBe(Math.ceil(info.maxZ / info.lh - 1e-7));
    expect(info.workers).toBeGreaterThan(0);
    expect(info.preview).toBe(true);
    const n = checkPNGs(out, info, c.decodeEvery);
    ti.annotations.push({ type: 'layers', description: `${n} layers of ${info.W} × ${info.H}` });
    expect(page.errors).toEqual([]);
  });
}
