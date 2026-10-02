'use strict';
/* Regression checks for the 3D view, rendered with the real three.js. */
const { test, expect, openApp } = require('./fixtures');

/* distinct colours along the middle row of the 3D canvas */
const rowColours = (page) => page.evaluate(() => {
  renderer.render(scene, camera);
  const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, a = new Uint8Array(w * 4);
  gl.readPixels(0, h >> 1, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);
  const s = new Set(); for (let i = 0; i < a.length; i += 4) s.add(a[i] + ',' + a[i + 1] + ',' + a[i + 2]);
  return s.size;
});

async function loadSupported(page) {
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.evaluate(() => {
    for (const k of ['box', 'rod', 'plate', 'mirror']) addSample(k);
    setSelection([]);
    opAutoSupport(parts.filter((p) => /plate|rod/.test(p.name)));
    fitView();
    updatePreview(); /* normally debounced */
  });
}

test('grid lines are still drawn with the camera close over the plate', async ({ page }) => {
  await openApp(page);
  for (const profile of ['S140 Stitch', 'S140 Single']) {
    await page.selectOption('#profileSel', { label: profile });
    for (const dist of [4, 8, 40]) {
      await page.evaluate((d) => { view.target = [0, 0, 0]; view.dist = d; updateCamera(); }, dist);
      expect(await rowColours(page), `${profile} at ${dist} mm`).toBeGreaterThan(1);
    }
  }
});

test('labels are hidden by parts, readable in pixels, and the ruler hides in top view', async ({ page }) => {
  await openApp(page);
  const st = await page.evaluate(() => {
    const labels = plateGroup.children.filter((o) => o.isSprite);
    const plate = plateGroup.children.find((o) => o.isMesh && o.geometry.type === 'PlaneGeometry');
    renderer.render(scene, camera);
    const P11 = camera.projectionMatrix.elements[5], H = canvas.clientHeight;
    const px = labels.map((s) => {
      const v = s.position.clone().applyMatrix4(camera.matrixWorldInverse);
      return s.scale.y * P11 * H / 2 / -v.z * 64 / 84;
    });
    return { n: labels.length, depthTested: labels.every((s) => s.material.depthTest), plateWritesDepth: plate.material.depthWrite, minPx: Math.min(...px), maxPx: Math.max(...px) };
  });
  expect(st.n).toBeGreaterThan(10);
  expect(st.depthTested).toBe(true);
  expect(st.plateWritesDepth).toBe(false);
  expect(st.minPx).toBeGreaterThanOrEqual(9 - 0.01);
  expect(st.maxPx).toBeLessThanOrEqual(16 + 0.01);
  const ruler = () => page.evaluate(() => plateGroup.children.filter((o) => o.userData.ruler).map((o) => o.visible));
  expect(new Set(await ruler(page))).toEqual(new Set([true]));
  await page.click('[data-view="top"]');
  expect(new Set(await ruler(page))).toEqual(new Set([false]));
  await page.click('[data-view="front"]');
  expect(new Set(await ruler(page))).toEqual(new Set([true]));
});

test('section colour does not leak through at the edges of parts and supports', async ({ page }) => {
  await openApp(page);
  await loadSupported(page);
  const violet = await page.evaluate(() => {
    renderer.render(scene, camera);
    const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, a = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, a);
    let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i + 2] > a[i] + 60 && a[i + 2] > a[i + 1] + 60) n++;
    return n;
  });
  /* about 630 before the fix, about 70 after (cracks where support pieces meet) */
  expect(violet).toBeLessThan(250);
});

test('click selects the part under the pointer and dragging moves it exactly with the pointer', async ({ page }) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="mirror"]');
  await page.evaluate(() => { setSelection([]); setView('iso'); });
  const at = (p) => page.evaluate(([x, y, z]) => {
    scene.updateMatrixWorld(true);
    const v = new THREE.Vector3(x, y, z).project(camera), r = canvas.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }, p);
  const b0 = await page.evaluate(() => parts[0].wb);
  const grab = [b0.min[0] + 0.3, (b0.min[1] + b0.max[1]) / 2, b0.max[2]];
  const s0 = await at(grab);
  await page.mouse.click(s0.x, s0.y);
  expect(await page.evaluate(() => selected().map((p) => p.name))).toEqual(['mirror-test-F']);
  const s1 = await at([grab[0] + 2, grab[1] - 1, grab[2]]);
  await page.mouse.move(s0.x, s0.y); await page.mouse.down(); await page.mouse.move(s1.x, s1.y, { steps: 10 }); await page.mouse.up();
  const b1 = await page.evaluate(() => parts[0].wb);
  expect(b1.min[0] - b0.min[0]).toBeCloseTo(2, 2);
  expect(b1.min[1] - b0.min[1]).toBeCloseTo(-1, 2);
  expect(b1.min[2] - b0.min[2]).toBeCloseTo(0, 6);
  /* one undo step */
  await page.click('#btnUndo');
  expect((await page.evaluate(() => parts[0].wb)).min[0]).toBeCloseTo(b0.min[0], 6);
  /* clicking empty space clears the selection */
  const vb = await page.locator('#vp').boundingBox();
  await page.mouse.click(vb.x + 40, vb.y + vb.height - 40);
  expect(await page.evaluate(() => sel.size)).toBe(0);
});

test('orbit, pan and zoom move the camera the right way', async ({ page }) => {
  await openApp(page);
  const vb = await page.locator('#vp').boundingBox(), x = vb.x + 60, y = vb.y + vb.height - 60;
  const v = () => page.evaluate(() => ({ t: view.target.slice(), d: view.dist, th: view.theta, ph: view.phi }));
  const a = await v();
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 100, y - 50, { steps: 5 }); await page.mouse.up();
  const b = await v();
  expect(b.th).toBeCloseTo(a.th - 100 * 0.008, 6);
  expect(b.ph).toBeCloseTo(a.ph - 50 * 0.008, 6);
  /* pan: the point under the pointer stays under the pointer */
  const under = () => page.evaluate(([cx, cy]) => rayPlane(cx, cy, 0), [x, y]);
  const p0 = await under();
  await page.mouse.move(x, y); await page.mouse.down({ button: 'right' }); await page.mouse.move(x + 80, y + 30, { steps: 5 }); await page.mouse.up({ button: 'right' });
  expect(await page.evaluate(() => menuOpen)).toBe(false);
  const p1 = await page.evaluate(([cx, cy]) => rayPlane(cx, cy, 0), [x + 80, y + 30]);
  expect(Math.hypot(p1[0] - p0[0], p1[1] - p0[1])).toBeLessThan(0.05 * (await v()).d);
  const d0 = (await v()).d;
  await page.mouse.move(x, y); /* clear of the empty-plate card */
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await v()).d).toBeLessThan(d0 * 0.9);
});

test('lay-flat hover highlights the whole face, and clicking lays it on the plate', async ({ page }) => {
  await openApp(page);
  await page.selectOption('#profileSel', { label: 'S140 Single' });
  await page.click('[data-sample="plate"]');
  await page.click('.tool[data-tool="rotate"]');
  await page.click('[data-act="mode-layflat"]');
  const c = await page.evaluate(() => {
    const b = parts[0].wb, v = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2).project(camera), r = canvas.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  });
  await page.mouse.move(c.x - 4, c.y - 4); await page.mouse.move(c.x, c.y);
  expect(await page.evaluate(() => hover && hover.mesh.geometry.attributes.position.count / 3)).toBe(2);
  await page.mouse.click(c.x, c.y);
  expect(await page.evaluate(() => parts[0].wb.max[2] - parts[0].wb.min[2])).toBeCloseTo(0.3, 3);
  expect(await page.evaluate(() => hover)).toBe(null);
});

test('clip-at-layer cut follows the layer slider and switches off cleanly', async ({ page }) => {
  await openApp(page);
  await loadSupported(page);
  await page.check('#clipToggle');
  await page.evaluate(() => setLayer(150));
  const [plane, z] = await page.evaluate(() => [clipPlane.constant, (LP.layer + 0.5) * derived().lh]);
  expect(plane).toBe(z);
  expect(z).toBeCloseTo(1.505, 9);
  await page.uncheck('#clipToggle');
  expect(await page.evaluate(() => clipPlane.constant)).toBe(1e6);
});

test('preview.png renders the scene with its caption', async ({ page }) => {
  await openApp(page);
  await loadSupported(page);
  const r = await page.evaluate(async () => {
    const png = await renderPreviewPNG(prof(), LP.N, sceneBounds(false));
    const bm = await createImageBitmap(new Blob([png], { type: 'image/png' }));
    const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
    const x = c.getContext('2d'); x.drawImage(bm, 0, 0);
    const d = x.getImageData(0, 0, c.width, 716).data;
    let part = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[i + 2]) < 40 && d[i + 2] > 120 && d[i + 2] < 200 && d[i] < d[i + 2]) part++;
    return { w: bm.width, h: bm.height, cap: Array.from(x.getImageData(5, 760, 1, 1).data), labelSS, ruler: plateGroup.children.filter((o) => o.userData.ruler).every((o) => o.visible) };
  });
  expect([r.w, r.h]).toEqual([1280, 800]);
  expect(r.cap.slice(0, 3)).toEqual([22, 25, 31]);
  expect(r.labelSS).toBe(1);
  expect(page.errors).toEqual([]);
});
