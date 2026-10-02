/* ---------- Pointer input ---------- */
const ptr = { down: null, touches: new Map(), pinch: null, lp: 0, drag: null, suppress: false };
const isToggleMod = (e) => e.shiftKey || (isMac ? e.metaKey : e.ctrlKey);
function orbit(dx, dy) { view.theta -= dx * 0.008; view.phi = clamp(view.phi + dy * 0.008, -1.45, Math.PI / 2 - 0.0005); updateCamera(); }
function pan(dx, dy) {
  const h = canvas.clientHeight || 1, k = 2 * view.dist * Math.tan(camera.fov * DEG / 2) / h;
  const e = camera.matrixWorld.elements, right = [e[0], e[1], e[2]], up = [e[4], e[5], e[6]];
  view.target = V.add(view.target, V.add(V.mul(right, -dx * k), V.mul(up, dy * k)));
  updateCamera();
}
function zoom(f) { view.dist = clamp(view.dist * f, 0.05, 20000); updateCamera(); }

function onPointerDown(e) {
  if (!renderer) return;
  closeMenu();
  canvas.focus({ preventScroll: true });
  if (e.pointerType === 'touch') {
    ptr.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (ptr.touches.size === 1) {
      ptr.down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, button: 0, moved: false, touch: true, e };
      clearTimeout(ptr.lp);
      ptr.lp = setTimeout(() => { if (ptr.down && !ptr.down.moved && ptr.touches.size === 1) { ptr.suppress = true; contextAt(ptr.down.x, ptr.down.y); } }, 550);
    } else { clearTimeout(ptr.lp); ptr.down = null; ptr.pinch = pinchState(); }
    return;
  }
  if (isMac && e.button === 0 && e.ctrlKey) return; /* macOS Ctrl-click: context menu */
  canvas.setPointerCapture(e.pointerId);
  const d = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, button: e.button, moved: false, shift: e.shiftKey, toggle: isToggleMod(e), hit: null };
  if (e.button === 0 && !mode && !d.toggle) {
    const h = pick(e.clientX, e.clientY);
    if (h && h.kind === 'part') {
      d.hit = h;
      if (!sel.has(h.part.id)) setSelection([h.part.id]);
      const at = rayPlane(e.clientX, e.clientY, h.point.z);
      if (at) d.grab = { z: h.point.z, last: at };
    }
  }
  ptr.down = d;
}
function pinchState() {
  const ps = [...ptr.touches.values()];
  if (ps.length < 2) return null;
  return { d: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), mx: (ps[0].x + ps[1].x) / 2, my: (ps[0].y + ps[1].y) / 2 };
}
function onPointerMove(e) {
  if (!renderer) return;
  if (e.pointerType === 'touch' && ptr.touches.has(e.pointerId)) {
    ptr.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptr.touches.size >= 2 && ptr.pinch) {
      const s = pinchState();
      if (s && s.d > 0) { zoom(ptr.pinch.d / s.d); pan(s.mx - ptr.pinch.mx, s.my - ptr.pinch.my); }
      ptr.pinch = s;
      return;
    }
  }
  const d = ptr.down;
  if (!d) {
    if (mode === 'layflat' && e.pointerType !== 'touch') {
      const h = pick(e.clientX, e.clientY);
      if (h && h.kind === 'part') setHover(h.part, h.face); else clearHover();
    }
    return;
  }
  const dx = e.clientX - d.lx, dy = e.clientY - d.ly;
  if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < (d.touch ? 8 : 4)) return;
  if (!d.moved) { d.moved = true; clearTimeout(ptr.lp); }
  d.lx = e.clientX; d.ly = e.clientY;
  if (d.grab) {
    const at = rayPlane(e.clientX, e.clientY, d.grab.z);
    if (!at) return;
    if (!ptr.drag) { pushUndo(); ptr.drag = true; canvas.style.cursor = 'grabbing'; }
    const mx = at[0] - d.grab.last[0], my = at[1] - d.grab.last[1];
    d.grab.last = at;
    for (const p of selected()) translatePart(p, mx, my);
    for (const p of selected()) { p.oob = computeOOB(p); paintPart(p); }
    updateHUD(); requestRender();
    return;
  }
  if (d.button === 1 || d.button === 2 || d.shift) pan(dx, dy);
  else if (d.button === 0) orbit(dx, dy);
}
function onPointerUp(e) {
  if (!renderer) return;
  if (e.pointerType === 'touch') {
    ptr.touches.delete(e.pointerId);
    clearTimeout(ptr.lp);
    if (ptr.touches.size < 2) ptr.pinch = null;
    const d = ptr.down;
    ptr.down = null;
    if (ptr.suppress) { ptr.suppress = false; return; }
    if (d && !d.moved && ptr.touches.size === 0) clickAt(e.clientX, e.clientY, { toggle: false });
    return;
  }
  const d = ptr.down;
  ptr.down = null;
  try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
  if (!d) return;
  if (ptr.drag) { ptr.drag = false; canvas.style.cursor = mode ? 'crosshair' : ''; changed({ keepPanel: true }); return; }
  if (d.moved) return;
  if (d.button === 2) { contextAt(e.clientX, e.clientY); return; }
  if (d.button === 0) clickAt(e.clientX, e.clientY, { toggle: d.toggle, hit: d.hit });
}
function clickAt(cx, cy, o) {
  const h = o.hit || pick(cx, cy);
  if (mode === 'layflat') { if (h && h.kind === 'part') opLayFlat(h.part, h.face); return; }
  if (mode === 'addsup') {
    if (h && h.kind === 'part') opAddSupportAt(h.part, h.point, h.normal);
    else toast('Click on a part, on a face that points down.');
    return;
  }
  if (mode === 'remsup') {
    if (h && h.kind === 'support') opRemoveOneSupport(h.part, h.si);
    else toast('Click a support to remove it.');
    return;
  }
  const id = h ? h.part.id : null;
  if (o.toggle) { if (id != null) toggleSel(id); return; }
  if (id == null) { if (sel.size) setSelection([]); return; }
  if (!(sel.size === 1 && sel.has(id))) setSelection([id]);
}
function onWheel(e) {
  if (!renderer) return;
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  if (e.ctrlKey && !isMac) { zoom(Math.exp(dy * 0.01)); return; }
  zoom(Math.exp(dy * 0.0015));
}

/* ---------- Context menu ---------- */
let menuOpen = false, menuItems = [];
function contextAt(cx, cy) {
  const h = pick(cx, cy);
  if (h && h.kind === 'support') {
    const p = h.part;
    openMenu(cx, cy, [
      { hd: `Support on ${p.name}` },
      { label: h.si >= 0 ? 'Remove this support' : 'This is the raft', fn: () => opRemoveOneSupport(p, h.si), disabled: h.si < 0 },
      { label: 'Remove all from this part', fn: () => opRemoveSupports([p]) },
      { label: 'Hide supports', fn: toggleSupports }
    ]);
    return;
  }
  if (h && h.kind === 'part') {
    const p = h.part;
    if (!sel.has(p.id)) setSelection([p.id]);
    const list = selected(), n = list.length, many = n > 1, grp = many ? ` (${n} parts)` : '';
    const down = h.normal[2] < -0.05;
    openMenu(cx, cy, [
      { hd: many ? `${n} parts selected` : p.name },
      { label: 'Lay flat on this face', fn: () => opLayFlat(p, h.face) },
      { label: 'Drop to plate' + grp, fn: () => opSetZ(list, 0) },
      { label: many ? 'Centre group on plate' : 'Centre on plate', fn: () => opCentre(list) },
      { sep: 1 },
      { label: 'Rotate 90° about X' + grp, fn: () => opRot90(list, 0, 1) },
      { label: 'Rotate 90° about Y' + grp, fn: () => opRot90(list, 1, 1) },
      { label: 'Rotate 90° about Z' + grp, fn: () => opRot90(list, 2, 1) },
      { label: 'Mirror X' + grp, fn: () => opMirror(list, 0) },
      { label: 'Mirror Y' + grp, fn: () => opMirror(list, 1) },
      { label: 'Mirror Z' + grp, fn: () => opMirror(list, 2) },
      { label: 'Reset transform' + grp, fn: () => opResetTransform(list) },
      { sep: 1 },
      { label: 'Auto-support' + grp, fn: () => opAutoSupport(list) },
      { label: 'Add support here', fn: () => opAddSupportAt(p, h.point, h.normal), disabled: !down },
      { label: 'Remove supports' + grp, fn: () => opRemoveSupports(list), disabled: !list.some((q) => q.sup.length) },
      { sep: 1 },
      { label: 'Duplicate' + grp, kbd: kb('D'), fn: () => opDuplicate(list) },
      { label: 'Make array…', fn: () => { tool = 'array'; setSelection([p.id]); }, disabled: many },
      { label: 'Select all', kbd: kb('A'), fn: () => setSelection(parts.map((q) => q.id)) },
      { label: 'Delete' + grp, kbd: 'Del', fn: () => opDelete(list) },
      { sep: 1 },
      { label: 'Undo', kbd: kb('Z'), fn: undo, disabled: !undoStack.length },
      { label: 'Redo', kbd: isMac ? '⇧⌘Z' : 'Ctrl+Y', fn: redo, disabled: !redoStack.length }
    ]);
    return;
  }
  const any = parts.length > 0;
  openMenu(cx, cy, [
    { label: 'Magic wand', fn: opMagic, disabled: !any },
    { label: 'Open STL files…', fn: () => $('#fileInput').click() },
    { label: 'Arrange all', fn: () => arrangeAll(), disabled: !any },
    { label: 'Auto-support all', fn: () => opAutoSupport(parts), disabled: !any },
    { label: 'Remove all supports', fn: () => opRemoveSupports(parts), disabled: !parts.some((q) => q.sup.length) },
    { label: showSupports ? 'Hide supports' : 'Show supports', fn: toggleSupports },
    { sep: 1 },
    { label: 'Fit view', fn: fitView },
    { label: 'Reset view', fn: () => setView('iso') },
    { label: 'Select all', kbd: kb('A'), fn: () => setSelection(parts.map((q) => q.id)), disabled: !any },
    { label: 'Select none', kbd: 'Esc', fn: () => setSelection([]), disabled: !sel.size },
    { sep: 1 },
    { label: 'Undo', kbd: kb('Z'), fn: undo, disabled: !undoStack.length },
    { label: 'Redo', kbd: isMac ? '⇧⌘Z' : 'Ctrl+Y', fn: redo, disabled: !redoStack.length }
  ]);
}
function kb(k) { return isMac ? '⌘' + k : 'Ctrl+' + k; }
function openMenu(x, y, items) {
  const m = $('#menu');
  menuItems = items;
  m.innerHTML = items.map((it, i) => it.sep ? '<li class="sep" role="separator"></li>' : it.hd ? `<li class="hd" role="presentation">${esc(it.hd)}</li>`
    : `<li role="menuitem" tabindex="-1" data-i="${i}" aria-disabled="${!!it.disabled}"><span>${esc(it.label)}</span>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</li>`).join('');
  m.classList.add('on');
  menuOpen = true;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
  const first = m.querySelector('li[role=menuitem][aria-disabled="false"]');
  if (first) first.focus();
}
function closeMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  $('#menu').classList.remove('on');
  if (canvas && document.activeElement && $('#menu').contains(document.activeElement)) canvas.focus({ preventScroll: true });
}
function runMenuItem(li) {
  const it = menuItems[+li.dataset.i];
  if (!it || it.disabled) return;
  closeMenu();
  it.fn();
}
function menuKey(e) {
  const items = $$('#menu li[role=menuitem][aria-disabled="false"]');
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); (items[(i + 1) % items.length] || items[0]).focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); (items[(i - 1 + items.length) % items.length] || items[0]).focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0] && items[0].focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1] && items[items.length - 1].focus(); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (i >= 0) runMenuItem(items[i]); }
  else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(); }
}

/* ---------- Keyboard shortcuts ---------- */
function onKeyDown(e) {
  if (menuOpen) { menuKey(e); return; }
  if (document.querySelector('dialog[open]')) return;
  const t = e.target, tag = t && t.tagName;
  const isNum = tag === 'INPUT' && t.type === 'number';
  const isText = (tag === 'INPUT' && !isNum && !['checkbox', 'radio', 'range', 'button'].includes(t.type)) || tag === 'TEXTAREA' || (t && t.isContentEditable);
  const mod = isMac ? e.metaKey : e.ctrlKey, k = e.key.toLowerCase();
  if (isText) return;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); if (isNum) t.blur(); undo(); return; }
  if ((mod && k === 'z' && e.shiftKey) || (!isMac && e.ctrlKey && k === 'y')) { e.preventDefault(); if (isNum) t.blur(); redo(); return; }
  if (isNum || tag === 'SELECT') return;
  if (mod && k === 'a') { e.preventDefault(); setSelection(parts.map((p) => p.id)); return; }
  if (mod && k === 'd') { e.preventDefault(); opDuplicate(selected()); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) { e.preventDefault(); opDelete(selected()); return; }
  if (e.key === 'Escape') {
    if (mode) { setMode(null); renderToolPanel(); }
    else if (sel.size) setSelection([]);
  }
}

