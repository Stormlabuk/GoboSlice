/* ---------- Undo / redo ---------- */
const undoStack = [], redoStack = [];
function snapshot() {
  return JSON.stringify({
    sup: supCfg, sel: [...sel],
    parts: parts.map((p) => ({ id: p.id, gid: p.gid, name: p.name, x: p.x, y: p.y, zb: p.zb, rot: p.rot, scale: p.scale, mir: p.mir, sup: p.sup }))
  });
}
function pushUndo() {
  const s = snapshot();
  if (undoStack.length && undoStack[undoStack.length - 1] === s) return;
  undoStack.push(s);
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function restore(s) {
  const o = JSON.parse(s);
  supCfg = normaliseSup(o.sup); saveSup();
  for (const p of parts) disposePart(p);
  parts = [];
  for (const q of o.parts) {
    if (!geoms.has(q.gid)) continue;
    const p = createPart(q.gid, q.id);
    Object.assign(p, { name: q.name, x: q.x, y: q.y, zb: q.zb, rot: q.rot, scale: q.scale, mir: q.mir, sup: q.sup });
    recomputeLinear(p);
    rebuildSupportMesh(p);
    parts.push(p);
  }
  sel = new Set(o.sel.filter((id) => parts.some((p) => p.id === id)));
  if (mode) setMode(null);
  changed();
}
function undo() {
  const cur = snapshot();
  while (undoStack.length && undoStack[undoStack.length - 1] === cur) undoStack.pop();
  if (!undoStack.length) { updateUndoButtons(); return; }
  redoStack.push(cur);
  restore(undoStack.pop());
}
function redo() {
  const cur = snapshot();
  while (redoStack.length && redoStack[redoStack.length - 1] === cur) redoStack.pop();
  if (!redoStack.length) { updateUndoButtons(); return; }
  undoStack.push(cur);
  restore(redoStack.pop());
}
function updateUndoButtons() {
  $('#btnUndo').disabled = !undoStack.length;
  $('#btnRedo').disabled = !redoStack.length;
}

