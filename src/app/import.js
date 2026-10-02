/* ---------- Import ---------- */
async function handleFiles(files) {
  files = [...files].filter((f) => f && f.size !== undefined);
  if (!files.length) return;
  const loaded = [];
  for (const f of files) {
    try {
      if (!/\.stl$/i.test(f.name)) throw new Error('only STL files are supported');
      const buf = await f.arrayBuffer();
      loaded.push(addGeometry(f.name.replace(/\.stl$/i, ''), parseSTL(buf)));
    } catch (err) { toast(`Could not open ${f.name}: ${err.message || err}.`, 'warn'); }
  }
  addGeometriesAsParts(loaded);
}
function addGeometriesAsParts(list) {
  if (!list.length) return;
  const wasEmpty = !parts.length;
  pushUndo();
  const made = [];
  for (const g of list) {
    const p = createPart(g.id);
    const spot = findFreeSpot(p, [...parts, ...made]);
    const f = footprint(p);
    translatePart(p, spot[0] - (f.min[0] + f.max[0]) / 2, spot[1] - (f.min[1] + f.max[1]) / 2);
    made.push(p);
    if (g.flipped) toast(`${g.name} was inside out, so its faces were turned the right way round.`);
  }
  parts.push(...made);
  sel = new Set(made.map((p) => p.id));
  changed();
  if (wasEmpty) fitView();
  const big = made.find((p) => Math.max(...geoms.get(p.gid).size) < 0.2);
  if (big) toast(`${big.name} is tiny. If it was exported in metres, use ×1000 in Scale.`, 'warn');
  else if (made.some((p) => p.oob)) toast('Some parts are bigger than the build area or did not fit on the plate.', 'warn');
}
function addSample(kind) {
  const s = sampleShape(kind);
  addGeometriesAsParts([addGeometry(s.name, s.pos)]);
}
