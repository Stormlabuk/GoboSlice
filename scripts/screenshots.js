#!/usr/bin/env node
/* Drives dist/goboslice.html in Chromium with the real three.js r128 and saves a screenshot
   of each part of the 3D view, plus numeric checks of what each interaction did.
     node scripts/screenshots.js [outDir]          (default: screenshots/)
   Set FONT=0 to skip loading the web font, GOBOSLICE_HTML=path to shoot another build. */
'use strict';
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'screenshots'));
const ORIGIN = 'http://localhost:4173';
const HTML = path.resolve(process.env.GOBOSLICE_HTML || path.join(ROOT, 'dist/goboslice.html'));
const report = [];
const note = (name, data) => { report.push({ name, ...data }); console.log(name.padEnd(28), JSON.stringify(data)); };

async function newPage(browser, theme = 'light') {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 1, colorScheme: theme, acceptDownloads: true });
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', (r) =>
    r.fulfill({ path: path.join(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
  if (process.env.FONT === '0') await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
  await ctx.route(`${ORIGIN}/**`, (r) => r.fulfill({ path: HTML, contentType: 'text/html; charset=utf-8' }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('  console:', m.text()); });
  await page.goto(`${ORIGIN}/goboslice.html`);
  await page.waitForFunction(() => typeof renderer !== 'undefined' && renderer);
  await page.evaluate(() => document.fonts.ready);
  await settle(page);
  return page;
}
const settle = (page, ms = 250) => page.waitForTimeout(ms);
async function shot(page, name, clip) {
  await settle(page);
  const opts = { path: path.join(OUT, name + '.png') };
  if (clip === 'vp') opts.clip = await page.locator('#vp').boundingBox();
  else if (clip) opts.clip = clip;
  await page.screenshot(opts);
}
/* screen position (page pixels) of a world point */
function screenOf(page, p) {
  return page.evaluate(([x, y, z]) => {
    scene.updateMatrixWorld(true);
    const v = new THREE.Vector3(x, y, z).project(camera), r = canvas.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }, p);
}
const centreOf = (page, i = 0) => page.evaluate((i) => { const b = parts[i].wb; return [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2); }, i);
const viewState = (page) => page.evaluate(() => ({ target: view.target.map((v) => +v.toFixed(3)), dist: +view.dist.toFixed(3), theta: +view.theta.toFixed(3), phi: +view.phi.toFixed(3) }));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
    proxy: process.env.HTTPS_PROXY && process.env.FONT !== '0' ? { server: process.env.HTTPS_PROXY } : undefined
  });

  /* 1. plate and grid, both presets */
  let page = await newPage(browser);
  note('font', { loaded: await page.evaluate(() => document.fonts.check('16px "Atkinson Hyperlegible Next"')) });
  await shot(page, '01-plate-stitch', 'vp');
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await shot(page, '02-plate-single', 'vp');
  await page.click('[data-view="top"]');
  await page.selectOption('#profileSel', { label: 'S140 Stitch' });
  await shot(page, '03-plate-stitch-top', 'vp');

  /* 2. ruler and axis markers, close up on the front-left corner */
  await page.click('[data-view="iso"]');
  await page.evaluate(() => { const D = derived(); view.target = [D.x0, D.y0, prof().bz / 3]; view.dist = 70; updateCamera(); });
  await shot(page, '04-ruler-axes', 'vp');
  /* grid close up: every line must still be drawn with the camera right over the plate */
  await page.evaluate(() => { view.target = [0, 0, 0]; view.dist = 8; updateCamera(); });
  await page.evaluate(() => { $('#empty').style.visibility = 'hidden'; });
  await shot(page, '04b-grid-close', 'vp');
  await page.evaluate(() => { $('#empty').style.visibility = ''; });
  await page.close();

  /* 3. parts, orbit, pan, zoom */
  page = await newPage(browser);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="box"]');
  for (const k of ['rod', 'plate', 'mirror']) await page.evaluate((kind) => addSample(kind), k);
  await page.evaluate(() => setSelection([]));
  await page.click('[data-view="fit"]');
  await shot(page, '05-parts-iso', 'vp');
  const vb = await page.locator('#vp').boundingBox();
  const empty = { x: vb.x + 60, y: vb.y + vb.height - 60 };
  let v0 = await viewState(page);
  await page.mouse.move(empty.x, empty.y); await page.mouse.down(); await page.mouse.move(empty.x + 120, empty.y - 40, { steps: 8 }); await page.mouse.up();
  let v1 = await viewState(page);
  note('orbit (drag 120,-40)', { before: v0, after: v1 });
  await shot(page, '06-orbit', 'vp');
  await page.mouse.move(empty.x, empty.y); await page.mouse.down({ button: 'right' }); await page.mouse.move(empty.x + 100, empty.y + 50, { steps: 8 }); await page.mouse.up({ button: 'right' });
  const v2 = await viewState(page);
  note('pan (right-drag 100,50)', { before: v1, after: v2, menuOpen: await page.evaluate(() => menuOpen) });
  await shot(page, '07-pan', 'vp');
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
  const v3 = await viewState(page);
  note('zoom (wheel -800)', { before: v2.dist, after: v3.dist });
  await shot(page, '08-zoom', 'vp');

  /* 4. click-select and drag-move, on the mirror-test F (nothing in front of it) */
  await page.click('[data-view="fit"]');
  const fi = await page.evaluate(() => parts.findIndex((p) => p.name === 'mirror-test-F'));
  const top = await page.evaluate((i) => { const b = parts[i].wb; return [(b.min[0] + 0.3), (b.min[1] + b.max[1]) / 2, b.max[2]]; }, fi);
  const c0 = await centreOf(page, fi), s0 = await screenOf(page, top);
  await page.mouse.click(s0.x, s0.y);
  note('click-select', { clicked: c0.map((v) => +v.toFixed(2)), selected: await page.evaluate(() => selected().map((p) => p.name)) });
  await shot(page, '09-select', 'vp');
  const target = await screenOf(page, [top[0] - 3, top[1] - 1.5, top[2]]);
  await page.mouse.move(s0.x, s0.y); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 12 }); await page.mouse.up();
  const c1 = await centreOf(page, fi);
  note('drag-move (-3,-1.5) mm', { from: c0.map((v) => +v.toFixed(3)), to: c1.map((v) => +v.toFixed(3)), moved: [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]].map((v) => +v.toFixed(3)), view: await viewState(page) });
  await shot(page, '10-drag-move', 'vp');

  /* 5. lay-flat hover */
  await page.click('.tool[data-tool="rotate"]');
  await page.click('[data-act="mode-layflat"]');
  const pi = await page.evaluate(() => parts.findIndex((p) => p.name === 'tilted-plate'));
  const pc = await centreOf(page, pi), ps = await screenOf(page, [pc[0], pc[1], pc[2]]);
  await page.mouse.move(ps.x - 3, ps.y - 3); await page.mouse.move(ps.x, ps.y);
  note('lay-flat hover', { part: 'tilted-plate', hover: await page.evaluate(() => hover ? { part: hover.part.name, tris: hover.mesh.geometry.attributes.position.count / 3 } : null) });
  await shot(page, '11-layflat-hover', 'vp');
  await page.mouse.click(ps.x, ps.y);
  note('lay-flat click', { height: await page.evaluate((i) => +(parts[i].wb.max[2] - parts[i].wb.min[2]).toFixed(4), pi) });
  await page.keyboard.press('Escape');

  /* 6. supports: Magic stands every sample on the plate, so lift the plate and rod as loaded */
  await page.evaluate(() => { undo(); setSelection([]); arrangeAll(); opAutoSupport(parts.filter((p) => /plate|rod/.test(p.name))); setSelection([]); fitView(); });
  await page.click('.tool[data-tool="supports"]');
  await shot(page, '12-supports', 'vp');
  note('supports', await page.evaluate(() => ({ counts: parts.map((p) => [p.name, p.sup.length]), meshes: parts.filter((p) => p.supMesh).length })));
  await page.evaluate(() => { const b = sceneBounds(false); view.target = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 1]; view.dist = 18; view.phi = 0.25; updateCamera(); });
  await shot(page, '13-supports-close', 'vp');

  await page.evaluate(() => { view.phi = -0.35; updateCamera(); });
  await shot(page, '13b-supports-below', 'vp');

  /* 7. clip-at-layer cut view */
  await page.evaluate(() => { view.phi = 0.55; fitView(); });
  await page.check('#clipToggle');
  const N = await page.evaluate(() => LP.N);
  await page.evaluate((n) => setLayer(Math.round(n * 0.35)), N);
  note('clip', await page.evaluate(() => ({ layer: LP.layer + 1, of: LP.N, z: +((LP.layer + 0.5) * derived().lh).toFixed(4), plane: +clipPlane.constant.toFixed(4) })));
  await shot(page, '14-clip-view');

  /* 8. preview.png */
  await page.uncheck('#clipToggle');
  const pv = await page.evaluate(async () => { const pngBytes = await renderPreviewPNG(prof(), LP.N, sceneBounds(false)); return pngBytes ? Array.from(pngBytes) : null; });
  if (pv) fs.writeFileSync(path.join(OUT, '15-preview.png'), Buffer.from(pv));
  note('preview.png', { bytes: pv ? pv.length : 0 });
  await page.close();

  /* 9. dark theme */
  page = await newPage(browser, 'dark');
  await page.click('[data-sample="mirror"]');
  await page.evaluate(() => { addSample('plate'); setSelection([]); });
  await shot(page, '16-dark-stitch', 'vp');
  await page.close();

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
