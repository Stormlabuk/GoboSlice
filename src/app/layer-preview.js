/* ---------- Layer preview ---------- */
const LP = { bake: null, full: null, W: 0, H: 0, N: 0, layer: 0, st: Core.makeRaster(), fst: Core.makeRaster(), buf: null, fbuf: null, timer: 0 };
function schedulePreview() { clearTimeout(LP.timer); LP.timer = setTimeout(updatePreview, 120); }
function updatePreview() {
  const P = prof(), s = Math.min(1, 1200 / P.resX);
  LP.W = Math.max(1, Math.round(P.resX * s)); LP.H = Math.max(1, Math.round(P.resY * s));
  LP.bake = parts.length ? bakeScene(LP.W, LP.H, P) : null;
  LP.full = null;
  LP.N = LP.bake ? layerCount(LP.bake.maxZ, derived(P).lh, P) : 0;
  LP.cut = LP.bake ? cutByHeight(LP.bake.maxZ, P) : false;
  LP.layer = clamp(LP.layer, 0, Math.max(0, LP.N - 1));
  const sl = $('#layerSlider'), nb = $('#layerNum');
  sl.max = String(Math.max(1, LP.N)); nb.max = String(Math.max(1, LP.N));
  drawLayer();
  updateStats();
}
function setLayer(i) {
  if (!LP.N) return;
  LP.layer = clamp(Math.round(i), 0, LP.N - 1);
  drawLayer();
}
function drawLayer() {
  const cv = $('#layerCanvas'), P = prof(), D = derived(P);
  if (cv.width !== LP.W || cv.height !== LP.H) { cv.width = LP.W || 400; cv.height = LP.H || 220; }
  const ctx = cv.getContext('2d');
  const info = $('#layerInfo'), sl = $('#layerSlider'), nb = $('#layerNum');
  sl.disabled = nb.disabled = !LP.N; $('#layerMinus').disabled = $('#layerPlus').disabled = !LP.N;
  if (!LP.bake || !LP.N) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
    if ($('#overlayToggle').checked && LP.W) drawOverlay(ctx, P, LP.W, LP.H);
    info.textContent = parts.length ? 'Nothing to cut yet.' : 'Load a part to preview its masks.';
    if (clipOn) { clipPlane.constant = 1e6; requestRender(); }
    return;
  }
  const i = LP.layer, z = (i + 0.5) * D.lh, W = LP.W, H = LP.H;
  if (!LP.buf || LP.buf.length !== W * H) LP.buf = new Uint8Array(W * H); else LP.buf.fill(0);
  const lit = Core.rasterLayer(LP.st, LP.bake.tris, LP.bake.gids, LP.bake.ntri, z, W, H, LP.buf, 2);
  const img = ctx.createImageData(W, H), d = img.data, b = LP.buf;
  for (let k = 0, o = 0; k < b.length; k++, o += 4) { const v = b[k] ? 255 : 0; d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  if ($('#overlayToggle').checked) drawOverlay(ctx, P, W, H);
  const probs = drawIssues(ctx, i, W);
  /* lit area: exact where we can afford it */
  let area, exact = true;
  const r = sliceResult;
  if (r && r.version === sceneVersion && JSON.stringify(r.P) === JSON.stringify(P) && i < r.N) area = r.lit[i] * D.pitchX * D.pitchY;
  else if (P.resX * P.resY <= 4.2e6) {
    if (!LP.full) LP.full = bakeScene(P.resX, P.resY, P);
    const n = P.resX * P.resY;
    if (!LP.fbuf || LP.fbuf.length !== n) LP.fbuf = new Uint8Array(n); else LP.fbuf.fill(0);
    area = Core.rasterLayer(LP.fst, LP.full.tris, LP.full.gids, LP.full.ntri, z, P.resX, P.resY, LP.fbuf, 2) * D.pitchX * D.pitchY;
  } else { area = lit * (P.bx / W) * (P.by / H); exact = false; }
  info.textContent = `${fileName(P, i)}, layer ${i + 1} of ${LP.N}, z = ${fmt(z, 4)} of ${num(P.bz, 3)} mm, lit area ${exact ? '' : 'about '}${fmt(area, 3)} mm²`
    + (LP.cut ? `. The parts are taller than the ${num(P.bz, 3)} mm build height, so layers stop there.` : '')
    + (probs ? `. Design check on this layer: ${probs}.` : '');
  info.classList.toggle('warn', !!LP.cut || !!probs);
  sl.value = String(i + 1);
  if (document.activeElement !== nb) nb.value = String(i + 1);
  if (clipOn) { clipPlane.constant = z; requestRender(); }
}
function drawOverlay(ctx, P, W, H) {
  const D = derived(P), M = pixelMapper(P, W, H), cv = ctx.canvas;
  const k = W / Math.max(120, cv.clientWidth || 320);
  ctx.save();
  const rect = (xa, ya, xb, yb) => { const a = M.x(xa), b = M.x(xb), c = M.y(ya), d = M.y(yb); return [Math.min(a, b), Math.min(c, d), Math.abs(b - a), Math.abs(d - c)]; };
  const label = (t, x, y, size, col) => {
    ctx.font = `600 ${size}px ${FONT_STACK}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * k; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(t, x, y);
    ctx.fillStyle = col; ctx.fillText(t, x, y);
  };
  if (P.tiling && (P.fieldsX > 1 || P.fieldsY > 1)) {
    const fx = tileEdges(P.fieldsX, P.fieldX, D.ox), fy = tileEdges(P.fieldsY, P.fieldY, D.oy);
    ctx.fillStyle = 'rgba(232,160,48,.5)';
    for (let i = 1; i < fx.length; i++) { const s = fx[i][0], e = fx[i - 1][1]; if (e > s) ctx.fillRect(...rect(D.x0 + s, D.y0, D.x0 + e, D.y1)); }
    for (let j = 1; j < fy.length; j++) { const s = fy[j][0], e = fy[j - 1][1]; if (e > s) ctx.fillRect(...rect(D.x0, D.y0 + s, D.x1, D.y0 + e)); }
    ctx.strokeStyle = 'rgba(160,130,255,.9)'; ctx.lineWidth = Math.max(1, k * 1.2);
    let n = 1;
    for (let j = fy.length - 1; j >= 0; j--) for (let i = 0; i < fx.length; i++) {
      const R = rect(D.x0 + fx[i][0], D.y0 + fy[j][0], D.x0 + fx[i][1], D.y0 + fy[j][1]);
      ctx.strokeRect(R[0] + 0.5 * k, R[1] + 0.5 * k, R[2] - k, R[3] - k);
      label(String(n++), R[0] + R[2] / 2, R[1] + R[3] / 2, 13 * k, 'rgba(255,206,120,.95)');
    }
  } else {
    const ppm = W / P.bx;
    const minor = ppm * 1 >= 3 * k ? 1 : 5;
    for (let x = 0; x <= P.bx + 1e-9; x += minor) {
      const maj = isMult(x, 5), X = M.x(D.x0 + x);
      ctx.strokeStyle = maj ? 'rgba(232,160,48,.75)' : 'rgba(232,160,48,.28)'; ctx.lineWidth = Math.max(1, k * (maj ? 1 : 0.6));
      ctx.beginPath(); ctx.moveTo(X, 0); ctx.lineTo(X, H); ctx.stroke();
      if (maj) label(fmt(x, 0), clamp(X, 8 * k, W - 8 * k), 9 * k, 10 * k, 'rgba(255,206,120,.95)');
    }
    for (let y = 0; y <= P.by + 1e-9; y += minor) {
      const maj = isMult(y, 5), Y = M.y(D.y0 + y);
      ctx.strokeStyle = maj ? 'rgba(232,160,48,.75)' : 'rgba(232,160,48,.28)'; ctx.lineWidth = Math.max(1, k * (maj ? 1 : 0.6));
      ctx.beginPath(); ctx.moveTo(0, Y); ctx.lineTo(W, Y); ctx.stroke();
      if (maj && y > 0) label(fmt(y, 0), 10 * k, clamp(Y, 8 * k, H - 8 * k), 10 * k, 'rgba(255,206,120,.95)');
    }
  }
  ctx.restore();
}

