/* ---------- 3D scene ---------- */
let renderer = null, scene, camera, canvas, partsGroup, supGroup, plateGroup, overlayGroup, hemi, dirLight;
const vpEl = $('#vp');
const clipPlane = (typeof THREE !== 'undefined') ? new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e6) : null;
let clipOn = false;
const C = {};
const FONT_STACK = '"Atkinson Hyperlegible Next", system-ui, sans-serif';
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function readColours() {
  for (const k of ['viewport', 'plate', 'grid-minor', 'grid-major', 'overlap', 'part', 'part-sel', 'part-oob', 'section', 'support', 'ink', 'ink-2', 'amber', 'uv', 'fault'])
    C[k] = cssVar('--' + k) || '#888888';
}
const view = { target: [0, 0, 0], dist: 60, theta: -Math.PI / 2 + 0.6, phi: 0.55 };
let mats = null;
/* Back faces are drawn in the section colour, so a cut through a part shows a solid cap.
   Pushing them back in depth keeps them from showing through at the edges of front faces. */
const SECTION_OFFSET = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };

function initThree() {
  if (typeof THREE === 'undefined') throw new Error('three.js did not load');
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.localClippingEnabled = true;
  canvas = renderer.domElement;
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('aria-label', '3D build plate. Drag to orbit, right-drag to pan, scroll to zoom.');
  vpEl.prepend(canvas);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(32, 1, 0.01, 10000);
  camera.up.set(0, 0, 1);
  hemi = new THREE.HemisphereLight(0xffffff, 0x7f8c99, 0.62);
  hemi.position.set(0, 0, 1);
  scene.add(hemi);
  dirLight = new THREE.DirectionalLight(0xffffff, 0.72);
  dirLight.position.set(-0.6, 0.9, 1);
  dirLight.target.position.set(0, 0, -10);
  camera.add(dirLight); camera.add(dirLight.target);
  scene.add(camera);
  plateGroup = new THREE.Group(); partsGroup = new THREE.Group(); supGroup = new THREE.Group(); overlayGroup = new THREE.Group();
  scene.add(plateGroup, partsGroup, supGroup, overlayGroup);
  readColours();
  mats = {
    supFront: new THREE.MeshStandardMaterial({ color: C.support, roughness: 0.7, metalness: 0, clippingPlanes: [clipPlane] }),
    supBack: new THREE.MeshBasicMaterial({ color: C.section, side: THREE.BackSide, clippingPlanes: [clipPlane], ...SECTION_OFFSET }),
    hover: new THREE.MeshBasicMaterial({ color: C.amber, transparent: true, opacity: 0.7, depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide })
  };
  new ResizeObserver(resize).observe(vpEl);
  resize();
}
function makePartMats() {
  return {
    front: new THREE.MeshStandardMaterial({ color: C.part, roughness: 0.55, metalness: 0.02, clippingPlanes: [clipPlane] }),
    back: new THREE.MeshBasicMaterial({ color: C.section, side: THREE.BackSide, clippingPlanes: [clipPlane], ...SECTION_OFFSET })
  };
}
function applyTheme() {
  if (!renderer) return;
  readColours();
  renderer.setClearColor(new THREE.Color(C.viewport), 1);
  mats.supFront.color.set(C.support); mats.supBack.color.set(C.section); mats.hover.color.set(C.amber);
  for (const p of parts) { p.mats.back.color.set(C.section); paintPart(p); }
  buildPlate();
  requestRender();
}
function resize() {
  if (!renderer) return;
  const w = Math.max(1, vpEl.clientWidth), h = Math.max(1, vpEl.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  requestRender();
}
let renderQueued = false;
function requestRender() {
  if (!renderer || renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderer.render(scene, camera); });
}
function updateCamera() {
  if (!camera) return;
  const ce = Math.cos(view.phi), t = view.target;
  camera.position.set(t[0] + view.dist * ce * Math.cos(view.theta), t[1] + view.dist * ce * Math.sin(view.theta), t[2] + view.dist * Math.sin(view.phi));
  camera.near = Math.max(0.001, view.dist / 500); camera.far = view.dist * 60 + 500;
  camera.updateProjectionMatrix();
  camera.lookAt(t[0], t[1], t[2]);
  showRuler(view.phi < 1.3);
  requestRender();
}
/* the build-height ruler collapses into a pile of labels when seen from straight above */
function showRuler(on) {
  if (plateGroup) for (const o of plateGroup.children) if (o.userData.ruler) o.visible = on;
}
function sceneBounds(includePlate) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const add = (b) => { for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], b.min[k]); mx[k] = Math.max(mx[k], b.max[k]); } };
  for (const p of parts) { add(p.wb); if (p.supB) add(p.supB); }
  if (includePlate || !parts.length) { const D = derived(), P = prof(); add({ min: [D.x0, D.y0, 0], max: [D.x1, D.y1, parts.length ? 0 : P.bz] }); }
  return { min: mn, max: mx };
}
function fitDistance(b, cam) {
  const r = Math.max(0.05, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2);
  const vf = cam.fov * DEG / 2, hf = Math.atan(Math.tan(vf) * cam.aspect);
  return r / Math.sin(Math.min(vf, hf)) * 1.08;
}
function fitView() {
  if (!camera) return;
  const b = sceneBounds(!parts.length);
  view.target = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  view.dist = fitDistance(b, camera);
  updateCamera();
}
function setView(kind) {
  if (kind === 'fit') { fitView(); return; }
  if (kind === 'iso') { view.theta = -Math.PI / 2 + 0.6; view.phi = 0.55; }
  if (kind === 'top') { view.theta = -Math.PI / 2; view.phi = Math.PI / 2 - 0.0005; }
  if (kind === 'front') { view.theta = -Math.PI / 2; view.phi = 0.0005; }
  fitView();
}

/* Camera-facing text label, h mm tall, kept between minPx and maxPx on screen so it stays
   readable at any zoom. Parts in front of a label hide it. */
let labelSS = 1; /* supersampling of the render target being drawn, for preview.png */
function textSprite(text, h, color, minPx = 10, maxPx = 16) {
  const fs = 64, c = document.createElement('canvas'), ctx = c.getContext('2d');
  ctx.font = `600 ${fs}px ${FONT_STACK}`;
  const w = Math.ceil(ctx.measureText(text).width) + 20;
  c.width = w; c.height = fs + 20;
  ctx.font = `600 ${fs}px ${FONT_STACK}`; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, depthWrite: false, transparent: true }));
  s.scale.set(h * w / c.height, h, 1);
  s.renderOrder = 30;
  /* the text fills fs of the c.height texture rows */
  s.userData = { label: true, h: h * c.height / fs, aspect: w / c.height, minPx: minPx * c.height / fs, maxPx: maxPx * c.height / fs };
  s.onBeforeRender = fitLabel;
  return s;
}
function fitLabel(r, sc, cam) {
  const u = this.userData, e = cam.matrixWorldInverse.elements, p = this.position;
  const depth = -(e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14]);
  if (!(depth > 0)) return;
  const rt = r.getRenderTarget(), hpx = rt ? rt.height / labelSS : (canvas.clientHeight || 1);
  const k = cam.projectionMatrix.elements[5] * hpx / 2; /* pixels per mm at unit depth */
  const hh = clamp(u.h * k / depth, u.minPx, u.maxPx) * depth / k;
  this.scale.set(hh * u.aspect, hh, 1);
  this.updateMatrixWorld();
}
/* Line segments, each split into pieces no longer than `step`. Some renderers (Chrome's software
   fallback among them) drop a whole segment when one end is behind the camera, which made the
   grid vanish when zoomed in close. */
function lineSeg(pts, color, opacity = 1, onTop = false, step = Infinity) {
  const out = [];
  for (let i = 0; i + 5 < pts.length; i += 6) {
    const ax = pts[i], ay = pts[i + 1], az = pts[i + 2], dx = pts[i + 3] - ax, dy = pts[i + 4] - ay, dz = pts[i + 5] - az;
    const n = Math.max(1, Math.min(4096, Math.ceil(Math.hypot(dx, dy, dz) / step)));
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n;
      out.push(ax + dx * t0, ay + dy * t0, az + dz * t0, ax + dx * t1, ay + dy * t1, az + dz * t1);
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  const m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1 || onTop, opacity, depthTest: !onTop, depthWrite: !onTop });
  const l = new THREE.LineSegments(g, m); if (onTop) l.renderOrder = 25; return l;
}
function disposeGroup(gr) {
  for (const o of gr.children.slice()) {
    gr.remove(o);
    o.traverse((x) => { if (x.geometry) x.geometry.dispose(); if (x.material) { if (x.material.map) x.material.map.dispose(); x.material.dispose(); } });
  }
}
function tileEdges(n, f, o) { const out = []; for (let i = 0; i < n; i++) { const s = i * (f - o); out.push([s, s + f]); } return out; }
const isMult = (x, m) => Math.abs(x / m - Math.round(x / m)) < 1e-6;

function buildPlate() {
  if (!renderer) return;
  disposeGroup(plateGroup);
  const P = prof(), D = derived(P);
  const { bx, by, bz } = P, x0 = D.x0, y0 = D.y0, x1 = D.x1, y1 = D.y1;
  const big = Math.max(bx, by), eps = big * 1e-4;
  const step = Math.max(0.25, big / 100);
  /* drawn first and without depth, so the plate never hides the labels and lines around it */
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(bx, by), new THREE.MeshBasicMaterial({ color: C.plate, side: THREE.DoubleSide, depthWrite: false }));
  plate.position.set(D.cx, D.cy, 0);
  plate.renderOrder = -1;
  plateGroup.add(plate);
  const minor = Math.min(bx, by) < 8 ? 0.5 : 1, major = big > 40 ? 10 : 5;
  const minorPts = [], majorPts = [];
  const tiled = P.tiling && (P.fieldsX > 1 || P.fieldsY > 1);
  for (let x = 0; x <= bx + 1e-9; x += minor) {
    const isMaj = !tiled && isMult(x, major);
    (isMaj ? majorPts : minorPts).push(x0 + x, y0, eps, x0 + x, y1, eps);
  }
  for (let y = 0; y <= by + 1e-9; y += minor) {
    const isMaj = !tiled && isMult(y, major);
    (isMaj ? majorPts : minorPts).push(x0, y0 + y, eps, x1, y0 + y, eps);
  }
  majorPts.push(x0, y0, eps, x1, y0, eps, x1, y0, eps, x1, y1, eps, x1, y1, eps, x0, y1, eps, x0, y1, eps, x0, y0, eps);
  const lh = Math.max(0.25, big * 0.022);
  const labels = [];
  if (tiled) {
    const fx = tileEdges(P.fieldsX, P.fieldX, D.ox), fy = tileEdges(P.fieldsY, P.fieldY, D.oy);
    for (const [s, e] of fx) { majorPts.push(x0 + s, y0, eps, x0 + s, y1, eps, x0 + e, y0, eps, x0 + e, y1, eps); }
    for (const [s, e] of fy) { majorPts.push(x0, y0 + s, eps, x1, y0 + s, eps, x0, y0 + e, eps, x1, y0 + e, eps); }
    const shade = new THREE.MeshBasicMaterial({ color: C.overlap, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
    for (let i = 1; i < fx.length; i++) {
      const s = fx[i][0], e = fx[i - 1][1], w = e - s;
      if (w > 0) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, by), shade); m.position.set(x0 + s + w / 2, D.cy, eps * 2); plateGroup.add(m); }
    }
    for (let j = 1; j < fy.length; j++) {
      const s = fy[j][0], e = fy[j - 1][1], h = e - s;
      if (h > 0) { const m = new THREE.Mesh(new THREE.PlaneGeometry(bx, h), shade); m.position.set(D.cx, y0 + s + h / 2, eps * 2); plateGroup.add(m); }
    }
    const xs = [0, ...fx.slice(1).map(([s], i) => (s + fx[i][1]) / 2), bx];
    const ys = [0, ...fy.slice(1).map(([s], i) => (s + fy[i][1]) / 2), by];
    for (const x of xs) labels.push([fmt(x, x % 1 ? 2 : 0), x0 + x, y1 + lh * 0.9]);
    for (const y of ys) labels.push([fmt(y, y % 1 ? 2 : 0), x1 + lh * 0.6, y0 + y, 0]);
  } else {
    for (let x = 0; x <= bx + 1e-9; x += major) labels.push([fmt(x, 0), x0 + x, y1 + lh * 0.9]);
    for (let y = 0; y <= by + 1e-9; y += major) labels.push([fmt(y, 0), x1 + lh * 0.6, y0 + y, 0]);
  }
  plateGroup.add(lineSeg(minorPts, C['grid-minor'], 0.85, false, step));
  plateGroup.add(lineSeg(majorPts, C['grid-major'], 1, false, step));
  for (const [t, x, y, ax] of labels) { const s = textSprite(t, lh * 0.75, C['ink-2'], 10, 15); s.position.set(x, y, 0); if (ax != null) s.center.set(ax, 0.5); plateGroup.add(s); }
  /* build volume */
  const edges = [];
  for (const [ya, yb] of [[y0, y0], [y1, y1]]) for (const z of [0, bz]) edges.push(x0, ya, z, x1, yb, z);
  for (const x of [x0, x1]) for (const z of [0, bz]) edges.push(x, y0, z, x, y1, z);
  for (const x of [x0, x1]) for (const y of [y0, y1]) edges.push(x, y, 0, x, y, bz);
  plateGroup.add(lineSeg(edges, C['grid-major'], 0.45, false, step));
  /* axis markers at the front-left corner */
  const al = Math.max(0.6, big * 0.06);
  plateGroup.add(lineSeg([x0, y0, eps * 3, x0 + al, y0, eps * 3], '#D25B4D', 1, true));
  plateGroup.add(lineSeg([x0, y0, eps * 3, x0, y0 + al, eps * 3], '#3E9A61', 1, true));
  const sx = textSprite('X', lh * 0.8, '#D25B4D', 11, 16); sx.position.set(x0 + al + lh * 0.5, y0, 0); plateGroup.add(sx);
  const sy = textSprite('Y', lh * 0.8, '#3E9A61', 11, 16); sy.position.set(x0, y0 + al + lh * 0.5, 0); plateGroup.add(sy);
  plateGroup.add(lineSeg([x0, y0, 0, x0, y0, Math.min(al, bz)], '#4A7FD6', 1, true));
  const sz = textSprite('Z', lh * 0.8, '#4A7FD6', 11, 16); sz.position.set(x0, y0, Math.min(al, bz) + lh * 0.5); plateGroup.add(sz);
  /* dimension lines outside the front and left edges */
  const m = lh * 1.2, tk = lh * 0.35;
  const dims = [x0, y0 - m, 0, x1, y0 - m, 0, x0, y0 - m - tk, 0, x0, y0 - m + tk, 0, x1, y0 - m - tk, 0, x1, y0 - m + tk, 0,
    x0 - m, y0, 0, x0 - m, y1, 0, x0 - m - tk, y0, 0, x0 - m + tk, y0, 0, x0 - m - tk, y1, 0, x0 - m + tk, y1, 0];
  /* build height: vertical dimension line with a ruler, outside the front-left corner */
  const zx = x0 - m, zy = y0 - m;
  const ruler = [zx, zy, 0, zx, zy, bz, zx - tk, zy, 0, zx + tk, zy, 0, zx - tk, zy, bz, zx + tk, zy, bz];
  const zstep = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => bz / s <= 10) || 1000;
  const onRuler = (o) => { o.userData.ruler = true; plateGroup.add(o); };
  for (let z = zstep; z < bz - zstep * 0.25; z += zstep) {
    ruler.push(zx - tk * 0.6, zy, z, zx + tk * 0.6, zy, z);
    const zl = textSprite(fmt(z, 0), lh * 0.7, C['ink-2'], 9, 13); zl.position.set(zx - tk * 1.6, zy, z); zl.center.set(1, 0.5); onRuler(zl);
  }
  plateGroup.add(lineSeg(dims, C.ink, 0.9, false, step));
  onRuler(lineSeg(ruler, C.ink, 0.9, false, step));
  const dz = textSprite(`${fmt(bz, bz % 1 ? 2 : 0)} mm`, lh * 0.85, C.ink, 11, 16); dz.position.set(zx - lh * 1.5, zy, bz + lh * 0.9); onRuler(dz);
  const dw = textSprite(fmt(bx, bx % 1 ? 2 : 0) + ' mm', lh * 0.85, C.ink, 11, 16); dw.position.set(D.cx, y0 - m - lh * 0.75, 0); plateGroup.add(dw);
  const dl = textSprite(fmt(by, by % 1 ? 2 : 0) + ' mm', lh * 0.85, C.ink, 11, 16); dl.position.set(x0 - m - tk * 1.6, D.cy, 0); dl.center.set(1, 0.5); plateGroup.add(dl);
  showRuler(view.phi < 1.3);
  requestRender();
}
