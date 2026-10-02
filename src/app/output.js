/* ---------- preview.png ---------- */
async function renderPreviewPNG(P, N, bounds) {
  if (!renderer || !parts.length) return null;
  const OW = 1280, OH = 800, CAP = 84, RH = OH - CAP, S = 2, tw = OW * S, th = RH * S;
  const saved = { clip: clipPlane.constant, sup: supGroup.visible, ov: overlayGroup.visible, pos: camera.position.clone(), q: camera.quaternion.clone(), aspect: camera.aspect, near: camera.near, far: camera.far };
  clipPlane.constant = 1e6; supGroup.visible = true; overlayGroup.visible = false;
  for (const p of parts) paintPart(p, true);
  let px;
  try {
    camera.aspect = tw / th; camera.updateProjectionMatrix();
    const b = sceneBounds(false), t = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const dist = fitDistance(b, camera), th0 = -Math.PI / 2 + 0.6, ph = 0.55;
    camera.position.set(t[0] + dist * Math.cos(ph) * Math.cos(th0), t[1] + dist * Math.cos(ph) * Math.sin(th0), t[2] + dist * Math.sin(ph));
    camera.near = Math.max(0.001, dist / 500); camera.far = dist * 60 + 500; camera.updateProjectionMatrix();
    camera.lookAt(t[0], t[1], t[2]);
    scene.updateMatrixWorld(true);
    const rt = new THREE.WebGLRenderTarget(tw, th, { depthBuffer: true });
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    px = new Uint8Array(tw * th * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, tw, th, px);
    renderer.setRenderTarget(null);
    rt.dispose();
  } finally {
    camera.aspect = saved.aspect; camera.near = saved.near; camera.far = saved.far;
    camera.position.copy(saved.pos); camera.quaternion.copy(saved.q); camera.updateProjectionMatrix();
    clipPlane.constant = saved.clip; supGroup.visible = saved.sup; overlayGroup.visible = saved.ov;
    for (const p of parts) paintPart(p);
    requestRender();
  }
  const big = document.createElement('canvas'); big.width = tw; big.height = th;
  const bx = big.getContext('2d'), img = bx.createImageData(tw, th), row = tw * 4;
  for (let y = 0; y < th; y++) img.data.set(px.subarray((th - 1 - y) * row, (th - y) * row), y * row);
  bx.putImageData(img, 0, 0);
  const out = document.createElement('canvas'); out.width = OW; out.height = OH;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, tw, th, 0, 0, OW, RH);
  ctx.fillStyle = '#16191F'; ctx.fillRect(0, RH, OW, CAP);
  ctx.fillStyle = '#7B5CE6'; ctx.fillRect(0, RH, OW, 3);
  const names = parts.map((p) => p.name);
  let line1 = names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');
  ctx.textBaseline = 'top';
  ctx.font = `600 17px ${FONT_STACK}`; ctx.fillStyle = '#9C88F2'; ctx.textAlign = 'right';
  const credit = 'GoboSlice', creditW = ctx.measureText(credit).width;
  ctx.fillText(credit, OW - 24, RH + 20);
  ctx.textAlign = 'left';
  ctx.font = `600 22px ${FONT_STACK}`; ctx.fillStyle = '#F2F4F7';
  while (ctx.measureText(line1).width > OW - 72 - creditW && line1.length > 4) line1 = line1.slice(0, -4) + '…';
  ctx.fillText(line1, 24, RH + 16);
  const sz = `${fmt(bounds.max[0] - bounds.min[0])} × ${fmt(bounds.max[1] - bounds.min[1])} × ${fmt(bounds.max[2] - bounds.min[2])} mm`;
  const line2 = `${P.name}   ${num(P.layerUm, 2)} µm layers   ${N} layers   ${sz}   ${new Date().toISOString().slice(0, 10)}`;
  ctx.font = `400 17px ${FONT_STACK}`; ctx.fillStyle = '#B6BDC8';
  ctx.fillText(line2, 24, RH + 48);
  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/* ---------- Output stats ---------- */
function updateStats() {
  const el = $('#stats'); if (!el) return;
  const P = prof(), D = derived(P), r = sliceResult;
  const rows = [['Profile', esc(P.name)], ['Image size', `${P.resX} × ${P.resY} px, ${P.bits}-bit`], ['Pixel pitch', `${fmt(D.pitchX * 1000, 2)} × ${fmt(D.pitchY * 1000, 2)} µm`]];
  const N = r ? r.N : LP.N;
  if (N) { rows.push(['Layers', `${N} at ${num(P.layerUm, 2)} µm`]); rows.push(['Height', `${fmt(N * D.lh, 3)} mm of ${num(P.bz, 3)} mm`]); }
  else rows.push(['Build height', `${num(P.bz, 3)} mm, up to ${maxLayers(P)} layers`]);
  if (r) {
    const vol = r.totalLit * (r.P.bx / r.W) * (r.P.by / r.H) * (r.P.layerUm / 1000);
    rows.push(['Resin volume', `${fmt(vol, vol < 10 ? 3 : 1)} mm³ (µL)`]);
    rows.push(['ZIP size', fmtBytes(r.blob.size)]);
    rows.push(['Slice time', `${fmt(r.ms / 1000, 2)} s, ${r.workers ? r.workers + ' worker' + (r.workers === 1 ? '' : 's') : 'main thread'}`]);
    rows.push(['Files', `${r.files[0]} to ${r.files[1]}${r.preview ? ' and preview.png' : ''}`]);
  }
  el.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const note = $('#statsNote');
  if (slicing) note.textContent = 'Slicing…';
  else note.textContent = r ? '' : parts.length ? 'Not sliced yet. Press Slice to make the masks.' : '';
}

