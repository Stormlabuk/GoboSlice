/* ---------- Islands ----------
   Regions of a layer that touch nothing in the layer below would be exposed onto nothing
   and drift off or spoil the print. They are found at full resolution while slicing, or by
   Check for islands, which rasterises every layer without writing PNGs. */
let islandResult = null, islandGroup = null;
function islandsValid() {
  const r = islandResult;
  return !!r && r.version === sceneVersion && r.P === JSON.stringify(normaliseProfile(clone(prof())));
}
function setIslands(P, N, W, H, perLayer) {
  const layers = [];
  let total = 0;
  for (let L = 0; L < perLayer.length; L++) if (perLayer[L] && perLayer[L].length) { layers.push(L); total += perLayer[L].length; }
  islandResult = { version: sceneVersion, P: JSON.stringify(P), N, W, H, per: perLayer, layers, total };
  buildIslandMarks(); updateIslandUI(); drawLayer();
}
function clearIslands() { islandResult = null; buildIslandMarks(); updateIslandUI(); }
function islandSummary() {
  const r = islandResult, n = r.total, nl = r.layers.length;
  return `Found ${n} unsupported island${n === 1 ? '' : 's'} on ${nl} layer${nl === 1 ? '' : 's'}, the first on layer ${r.layers[0] + 1}`;
}

async function checkIslands() {
  if (slicing) return;
  if (!parts.length) { toast('Add a part to check.'); return; }
  const P = normaliseProfile(clone(prof())), W = P.resX, H = P.resY, lh = P.layerUm / 1000;
  const job = { cancelled: false, reason: '', workers: [], reject: null, kind: 'islands' };
  job.cancel = (why) => {
    job.cancelled = true; job.reason = why || 'user';
    for (const w of job.workers) w.terminate();
    job.workers = [];
    if (job.reject) job.reject(new Error('cancelled'));
  };
  slicing = job;
  $('#btnSlice').disabled = true; updateIslandUI();
  setProgress(0, 'Preparing');
  await new Promise((r) => setTimeout(r, 20));
  try {
    const bk = bakeScene(W, H, P);
    const N = layerCount(bk.maxZ, lh, P);
    if (!N) throw new Error('nothing to check');
    const per = new Array(N).fill(null);
    let done = 0, lastUI = 0;
    await runLayers(bk, N, P, { encode: false, islands: true }, (L, lit, isl) => {
      per[L] = isl; done++;
      const now = performance.now();
      if (now - lastUI > 80 || done === N) { lastUI = now; setProgress(done / N, `Checking ${done} of ${N}`); }
    }, job);
    if (job.cancelled) throw new Error('cancelled');
    setIslands(P, N, W, H, per);
    if (islandResult.total) { toast(islandSummary() + '.', 'warn'); setLayer(islandResult.layers[0]); }
    else toast(`No islands: every layer of ${N} rests on the one below.`);
  } catch (e) {
    if (job.cancelled) toast(job.reason === 'changed' ? 'Island check stopped because the scene changed.' : 'Island check cancelled.');
    else { console.error(e); toast('Island check failed: ' + (e && e.message || e), 'warn'); }
  } finally {
    for (const w of job.workers) w.terminate();
    if (slicing === job) slicing = null;
    $('#prog').classList.remove('on');
    $('#btnSlice').disabled = false;
    updateStats(); updateIslandUI();
  }
}

function updateIslandUI() {
  const info = $('#islInfo'), ok = islandsValid(), r = islandResult;
  $('#btnIslands').disabled = !!slicing || !parts.length;
  info.classList.remove('warn', 'ok');
  if (!ok) info.textContent = parts.length ? 'Not checked yet. Slicing checks too.' : '';
  else if (!r.total) { info.textContent = 'No islands.'; info.classList.add('ok'); }
  else { info.textContent = `${r.total} island${r.total === 1 ? '' : 's'} on ${r.layers.length} layer${r.layers.length === 1 ? '' : 's'}`; info.classList.add('warn'); }
  $('#islPrev').disabled = $('#islNext').disabled = !(ok && r.total);
}
/* jump to the next (dir 1) or previous (dir -1) layer that has islands, wrapping round */
function jumpIsland(dir) {
  if (!islandsValid() || !islandResult.total) return;
  const ls = islandResult.layers, cur = LP.layer;
  let L = dir > 0 ? ls.find((x) => x > cur) : [...ls].reverse().find((x) => x < cur);
  if (L === undefined) L = dir > 0 ? ls[0] : ls[ls.length - 1];
  setLayer(L);
}
function layerIslands(L) { return islandsValid() && islandResult.per[L] ? islandResult.per[L] : []; }
/* red circles on the layer preview canvas; returns how many islands this layer has */
function drawIslands(ctx, L, w) {
  const list = layerIslands(L);
  if (!list.length) return 0;
  const k = w / islandResult.W, css = w / Math.max(120, ctx.canvas.clientWidth || 320);
  ctx.save();
  ctx.strokeStyle = '#FF4D3D'; ctx.fillStyle = 'rgba(255,77,61,.35)'; ctx.lineWidth = 2 * css;
  for (const i of list) {
    const r = Math.max(7 * css, Math.hypot(i.x1 - i.x0, i.y1 - i.y0) * k / 2 + 4 * css);
    ctx.beginPath(); ctx.arc(i.cx * k, i.cy * k, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
  return list.length;
}
/* image pixel position back to plate millimetres, undoing the mirror */
function pixelToWorld(P, W, H, cx, cy) {
  const D = derived(P), mh = P.mirror === 'h' || P.mirror === 'hv', mv = P.mirror === 'v' || P.mirror === 'hv';
  const c = mh ? W - cx : cx, r = mv ? H - cy : cy;
  return [D.x0 + c * P.bx / W, D.y1 - r * P.by / H];
}
/* a red dot in the 3D view at every island, drawn on top of everything */
function buildIslandMarks() {
  if (!renderer) return;
  if (!islandGroup) { islandGroup = new THREE.Group(); overlayGroup.add(islandGroup); }
  disposeGroup(islandGroup);
  const r = islandResult;
  if (r && r.total) {
    const P = JSON.parse(r.P), lh = P.layerUm / 1000, pts = [];
    for (const L of r.layers) for (const i of r.per[L]) { const [x, y] = pixelToWorld(P, r.W, r.H, i.cx, i.cy); pts.push(x, y, L * lh); }
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d'); g.fillStyle = '#FF4D3D'; g.strokeStyle = '#fff'; g.lineWidth = 4;
    g.beginPath(); g.arc(16, 16, 12, 0, Math.PI * 2); g.fill(); g.stroke();
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const m = new THREE.Points(geo, new THREE.PointsMaterial({ size: 14, sizeAttenuation: false, map: new THREE.CanvasTexture(c), transparent: true, alphaTest: 0.3, depthTest: false, depthWrite: false }));
    m.renderOrder = 40; m.raycast = () => {};
    islandGroup.add(m);
  }
  requestRender();
}
