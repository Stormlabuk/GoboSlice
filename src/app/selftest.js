/* ---------- Self-test ---------- */
function parsePNGHeader(png) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (png[i] !== sig[i]) return null;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8, ok = true, info = null;
  while (o + 12 <= png.length) {
    const len = dv.getUint32(o), type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    if (Core.crc32(png.subarray(o + 4, o + 8 + len)) !== dv.getUint32(o + 8 + len)) ok = false;
    if (type === 'IHDR') info = { W: dv.getUint32(o + 8), H: dv.getUint32(o + 12), bits: png[o + 16] };
    o += 12 + len;
    if (type === 'IEND') break;
  }
  return info && ok ? info : null;
}
async function runSelfTest() {
  const btn = $('#btnSelfTest'); btn.disabled = true;
  const res = [];
  const add = (name, pass, detail) => res.push({ name, pass, detail });
  try {
    const P = normaliseProfile(DEFAULT_PROFILES[1]), W = P.resX, H = P.resY;
    const st = Core.makeRaster(), buf = new Uint8Array(W * H);
    const box = boxTris(-1, -0.5, 1, 1, 0.5, 2), boxPx = mapTris(box, P, W, H);
    const lit1 = Core.rasterLayer(st, boxPx, new Uint32Array(12), 12, 1.505, W, H, buf, 2);
    add('2×1×1 mm box at z 1.505 mm on S140 Single', lit1 === 20000, `${lit1} px lit, expected 20000`);
    const inv = box.slice();
    for (let i = 0; i < inv.length; i += 9) for (let k = 0; k < 3; k++) { const s = inv[i + 3 + k]; inv[i + 3 + k] = inv[i + 6 + k]; inv[i + 6 + k] = s; }
    buf.fill(0);
    const lit2 = Core.rasterLayer(st, mapTris(inv, P, W, H), new Uint32Array(12), 12, 1.505, W, H, buf, 2);
    add('Inside-out box', lit2 === 20000, `${lit2} px lit`);
    const two = mapTris([...box, ...boxTris(0, -0.5, 1, 2, 0.5, 2)], P, W, H), g2 = new Uint32Array(24); g2.fill(1, 12);
    buf.fill(0);
    const lit3 = Core.rasterLayer(st, two, g2, 24, 1.505, W, H, buf, 2);
    add('Two overlapping solids unite without holes', lit3 === 30000, `${lit3} px lit, expected 30000`);
    let pngs = [];
    for (const bits of [8, 1]) {
      const raw = new Uint8Array(Core.rawSize(W, H, bits));
      Core.rasterLayer(st, boxPx, new Uint32Array(12), 12, 1.505, W, H, raw, bits === 1 ? 1 : 0);
      const png = await Core.encodePNG(raw, W, H, bits), h = parsePNGHeader(png);
      let dec = 'not checked';
      try { const bm = await createImageBitmap(new Blob([png], { type: 'image/png' })); dec = `${bm.width} × ${bm.height}`; if (bm.close) bm.close(); } catch (e) { dec = 'browser could not decode'; }
      add(`${bits}-bit PNG`, !!h && h.W === W && h.H === H && h.bits === bits && dec === `${W} × ${H}`, h ? `${fmtBytes(png.length)}, IHDR ${h.W} × ${h.H} at ${h.bits} bit, decodes as ${dec}` : 'bad chunk or CRC');
      pngs.push(png);
    }
    const zb = new Uint8Array(await makeZip([{ name: '1.png', data: pngs[0] }, { name: '2.png', data: pngs[1] }]).arrayBuffer());
    const zv = new DataView(zb.buffer), eo = zb.length - 22;
    let zok = zv.getUint32(eo, true) === 0x06054b50 && zv.getUint16(eo + 10, true) === 2;
    let co = zv.getUint32(eo + 16, true);
    for (let k = 0; k < 2 && zok; k++) {
      zok = zv.getUint32(co, true) === 0x02014b50;
      const crc = zv.getUint32(co + 16, true), size = zv.getUint32(co + 20, true), nl = zv.getUint16(co + 28, true), lo = zv.getUint32(co + 42, true);
      const ln = zv.getUint16(lo + 26, true), dstart = lo + 30 + ln;
      zok = zok && zv.getUint32(lo, true) === 0x04034b50 && Core.crc32(zb.subarray(dstart, dstart + size)) === crc;
      co += 46 + nl;
    }
    add('ZIP structure and CRCs', zok, `${zb.length} bytes, 2 entries`);
    {
      const isl = (tris, n) => {
        const px = mapTris(tris, P, W, H), s2 = Core.makeRaster(); let found = 0;
        Core.islandsBegin(s2);
        for (let L = 0; L < n; L++) { Core.rasterLayer(s2, px, new Uint32Array(12), 12, (L + 0.5) * 0.01, W, H, null, 3); found += Core.islandsTake(s2, H, L === 0).length; }
        return found;
      };
      const a = isl(box, 210), b = isl(boxTris(-1, -0.5, 0, 1, 0.5, 1), 110);
      add('Island check', a === 1 && b === 0, `floating box ${a} island${a === 1 ? '' : 's'}, box on the plate ${b}`);
    }
    {
      /* design check: a 0.03 mm wall is too thin at Recommended, a 0.2 mm wall is fine */
      const R = checkRules(P, DESIGN_RULES.recommended), thin = (t) => {
        const tris = mapTris(new Float32Array(boxTris(-1, -t / 2, 0, 1, t / 2, 0.3)), P, W, H); let n = 0;
        Core.checkRange({ tris, gids: new Uint32Array(12), kind: new Uint8Array(12), ntri: 12, l0: 0, l1: 30, N: 30, W, H, lh: 0.01, check: R }, (L, r) => { n += r.issues.filter((i) => i.k === 'thin' && i.s === 2).length; });
        return n;
      };
      const a = thin(0.03), b = thin(0.2);
      add('Design check', a > 0 && b === 0, `0.03 mm wall flagged on ${a} layers, 0.2 mm wall on ${b}`);
    }
    const SW = 9400, SH = 5200, big = new Float32Array(boxTris(100, 100, 0, SW - 100, SH - 100, 10)), sraw = new Uint8Array(Core.rawSize(SW, SH, 8));
    const t0 = performance.now();
    Core.rasterLayer(st, big, new Uint32Array(12), 12, 0.005, SW, SH, sraw, 0);
    const t1 = performance.now();
    const spng = await Core.encodePNG(sraw, SW, SH, 8);
    const t2 = performance.now();
    add('Full S140 Stitch layer, raster and encode', t2 - t0 < 1000, `${fmt(t1 - t0, 0)} ms + ${fmt(t2 - t1, 0)} ms, ${fmtBytes(spng.length)}`);
    const pool = await makePool(1);
    add('Web Workers', pool.length === 1, pool.length ? 'available' : 'blocked, slicing will use the main thread');
    for (const w of pool) w.terminate();
    for (const kind of ['plate', 'rod']) {
      const sh = sampleShape(kind), g = addGeometry(sh.name, sh.pos);
      const pp = { gid: g.id, x: 0, y: 0, zb: 0, rot: [0, 0, 0], scale: [1, 1, 1], mir: [false, false, false] };
      magicOrient(pp); recomputeLinear(pp);
      const hgt = pp.wb.max[2] - pp.wb.min[2], want = kind === 'plate' ? 0.3 : 6;
      add(kind === 'plate' ? 'Magic lays the tilted plate flat' : 'Magic stands the rod on its end', Math.abs(hgt - want) < 0.01, `height after orienting ${fmt(hgt, 3)} mm`);
      geoms.delete(g.id);
    }
  } catch (e) { add('Self-test', false, String(e && e.message || e)); }
  btn.disabled = false;
  const pass = res.every((r) => r.pass);
  $('#statsNote').innerHTML = `<b>${pass ? 'All checks passed.' : 'Some checks failed.'}</b><br>` + res.map((r) => `${r.pass ? '✓' : '✗'} ${esc(r.name)}: ${esc(r.detail)}`).join('<br>');
  toast(pass ? `Self-test passed, ${res.length} checks.` : 'Self-test found a problem. See Output.', pass ? '' : 'warn');
  window.__selfTest = res;
  return res;
}
