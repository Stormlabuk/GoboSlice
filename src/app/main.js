/* ---------- Wiring ---------- */
function wire() {
  for (const b of $$('.tool')) b.addEventListener('click', () => {
    tool = b.dataset.tool;
    const keep = (tool === 'rotate' && mode === 'layflat') || (tool === 'supports' && (mode === 'addsup' || mode === 'remsup'));
    if (mode && !keep) setMode(null);
    $('#toolSec').open = true;
    renderToolPanel();
  });
  $('#btnMagic').addEventListener('click', opMagic);
  $('#hotbar').addEventListener('click', (e) => { const b = e.target.closest('[data-hb]'); if (b && !b.disabled) onHotbar(b.dataset.hb); });
  for (const b of $$('.views button')) b.addEventListener('click', () => setView(b.dataset.view));
  for (const id of ['#btnOpen', '#btnOpen2']) $(id).addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; handleFiles(f); });
  for (const b of $$('[data-sample]')) b.addEventListener('click', () => addSample(b.dataset.sample));
  $('#btnUndo').addEventListener('click', undo);
  $('#btnRedo').addEventListener('click', redo);
  $('#btnSlice').addEventListener('click', startSlice);
  $('#btnCancel').addEventListener('click', () => { if (slicing) slicing.cancel('user'); });
  $('#btnDownload').addEventListener('click', downloadZip);
  $('#profileSel').addEventListener('change', (e) => { profIdx = clamp(+e.target.value, 0, profiles.length - 1); saveProfiles(); applyProfile(); });

  const dlg = $('#settingsDlg');
  /* close dialogs directly: form submission is blocked when the page runs in a sandboxed frame */
  for (const d of $$('dialog')) {
    d.addEventListener('click', (e) => { const b = e.target.closest('[data-close]'); if (b && d.contains(b)) { e.preventDefault(); d.close(b.dataset.close); } });
    let downOnBackdrop = false;
    d.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === d; });
    d.addEventListener('click', (e) => {
      if (e.target !== d || !downOnBackdrop) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(d.id === 'confirmDlg' ? 'no' : 'cancel');
    });
  }
  for (const f of $$('dialog form')) f.addEventListener('submit', (e) => e.preventDefault());
  $('#btnSettings').addEventListener('click', () => { renderSettings(); dlg.showModal(); });
  dlg.addEventListener('close', applyProfile);
  $('#settingsBody').addEventListener('input', onSettingsInput);
  $('#settingsBody').addEventListener('change', onSettingsInput);
  $('#settingsForm').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); e.target.blur(); } });
  $('#profNew').addEventListener('click', () => {
    profiles.splice(profIdx + 1, 0, normaliseProfile(Object.assign({}, prof(), { name: prof().name + ' copy' })));
    profIdx++; saveProfiles(); renderSettings(); rebuildProfileSelect();
  });
  $('#profDel').addEventListener('click', async () => {
    if (profiles.length <= 1) { toast('Keep at least one profile.'); return; }
    if (!(await confirmBox('Delete profile', `Delete "${prof().name}"? This cannot be undone.`, 'Delete'))) return;
    profiles.splice(profIdx, 1); profIdx = clamp(profIdx, 0, profiles.length - 1);
    saveProfiles(); renderSettings(); rebuildProfileSelect();
  });
  $('#profImport').addEventListener('click', () => $('#profFile').click());
  $('#profFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importProfiles(f); });
  $('#profExport').addEventListener('click', () => {
    saveBlob(new Blob([JSON.stringify({ format: 'goboslice-profiles', version: 1, profiles }, null, 2)], { type: 'application/json' }), 'goboslice-profiles.json');
  });
  $('#profRestore').addEventListener('click', async () => {
    if (!(await confirmBox('Restore defaults', 'Put the S140 Stitch and S140 Single presets back as shipped? Your other profiles are kept.', 'Restore'))) return;
    for (const d of DEFAULT_PROFILES.slice().reverse()) {
      const i = profiles.findIndex((p) => p.name === d.name);
      if (i >= 0) profiles[i] = normaliseProfile(d); else profiles.unshift(normaliseProfile(d));
    }
    profIdx = profiles.findIndex((p) => p.name === DEFAULT_PROFILES[0].name);
    saveProfiles(); renderSettings(); rebuildProfileSelect();
  });

  const tb = $('#toolBody');
  tb.addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.k) onToolField(e.target); });
  tb.addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && tb.contains(b)) onToolAction(b.dataset.act); });

  const pl = $('#partsList');
  pl.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { const p = partById(+del.dataset.del); if (p) opDelete([p]); return; }
    const li = e.target.closest('li[data-id]'); if (!li) return;
    const id = +li.dataset.id;
    if (isToggleMod(e)) toggleSel(id); else setSelection([id]);
  });
  pl.addEventListener('keydown', (e) => {
    const li = e.target.closest('li[data-id]'); if (!li || e.target !== li) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const id = +li.dataset.id; if (isToggleMod(e)) toggleSel(id); else setSelection([id]); }
  });

  $('#layerSlider').addEventListener('input', (e) => setLayer(+e.target.value - 1));
  $('#layerMinus').addEventListener('click', () => setLayer(LP.layer - 1));
  $('#layerPlus').addEventListener('click', () => setLayer(LP.layer + 1));
  $('#layerNum').addEventListener('change', (e) => { const v = +e.target.value; if (isFinite(v)) setLayer(v - 1); });
  $('#clipToggle').addEventListener('change', (e) => {
    clipOn = e.target.checked && !!clipPlane;
    if (!clipOn && clipPlane) clipPlane.constant = 1e6;
    drawLayer(); requestRender();
  });
  $('#overlayToggle').addEventListener('change', drawLayer);
  $('#btnSelfTest').addEventListener('click', runSelfTest);
  $('#btnCheck').addEventListener('click', () => runDesignCheck());
  $('#probPrev').addEventListener('click', () => jumpProblem(-1));
  $('#probNext').addEventListener('click', () => jumpProblem(1));
  $('#btnGuideSup').addEventListener('click', supportsToGuide);
  for (const b of $$('#checkSec [data-lvl]')) b.addEventListener('click', () => { checkCfg.level = b.dataset.lvl; saveCheckCfg(); if (checkResult) clearCheck(); else updateCheckUI(); });
  $('#chkRigid').addEventListener('change', (e) => { checkCfg.rigid = e.target.checked; saveCheckCfg(); if (checkResult) clearCheck(); else updateCheckUI(); });
  $('#chkBefore').addEventListener('change', (e) => { checkCfg.before = e.target.checked; saveCheckCfg(); updateCheckUI(); });
  $('#chkReset').addEventListener('click', () => { checkCfg.custom[checkCfg.level] = {}; saveCheckCfg(); if (checkResult) clearCheck(); else updateCheckUI(); });
  $('#chkRules').addEventListener('change', (e) => { const k = e.target.dataset && e.target.dataset.r; if (k) setRuleValue(k, parseFloat(e.target.value)); });
  for (const cl of [$('#chkList'), $('#setupList')]) {
    const act = (e) => {
      const fi = e.target.closest('li[data-f]'); if (fi) { focusFeature(+fi.dataset.f); return true; }
      const li = e.target.closest('li[data-rule]'); if (li) { focusRule(li.dataset.rule); return true; }
      return false;
    };
    cl.addEventListener('click', act);
    cl.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && act(e)) e.preventDefault(); });
  }

  const menu = $('#menu');
  menu.addEventListener('click', (e) => { const li = e.target.closest('li[role=menuitem]'); if (li) runMenuItem(li); });
  menu.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerdown', (e) => { if (menuOpen && !menu.contains(e.target)) closeMenu(); }, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
  document.addEventListener('keydown', onKeyDown);

  const vp = $('#vp');
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  vp.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; vp.classList.add('drag'); });
  vp.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  vp.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) vp.classList.remove('drag'); });
  vp.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; vp.classList.remove('drag'); handleFiles(e.dataTransfer.files); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  if (canvas) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', (e) => { ptr.touches.delete(e.pointerId); clearTimeout(ptr.lp); ptr.pinch = null; if (ptr.drag) { ptr.drag = false; changed({ keepPanel: true }); } ptr.down = null; });
    canvas.addEventListener('pointerleave', () => { if (!ptr.down) clearHover(); });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (ptr.touches.size) return;
      if (isMac && e.ctrlKey && e.button === 0) { contextAt(e.clientX, e.clientY); return; }
      if (e.button === 0 && !e.ctrlKey) { /* keyboard menu key */
        const r = canvas.getBoundingClientRect();
        const x = e.clientX || r.left + r.width / 2, y = e.clientY || r.top + r.height / 2;
        contextAt(x, y);
      }
    });
    canvas.addEventListener('keydown', (e) => {
      if (menuOpen || e.target !== canvas) return;
      const step = e.shiftKey ? 0.15 : 0.05;
      if (e.key === 'ArrowLeft') { orbit(-40, 0); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { orbit(40, 0); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { orbit(0, -40); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { orbit(0, 40); e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') zoom(1 - step * 4);
      else if (e.key === '-') zoom(1 + step * 4);
    });
  }
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq && mq.addEventListener) mq.addEventListener('change', () => { applyTheme(); drawLayer(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { buildPlate(); drawLayer(); });
}

/* ---------- Start-up ---------- */
function init() {
  rebuildProfileSelect();
  try {
    initThree();
    applyTheme();
  } catch (e) {
    console.error(e);
    renderer = null;
    const card = $('#empty .card');
    const p = document.createElement('p');
    p.className = 'note warn';
    p.textContent = 'The 3D view could not start (' + (e.message || e) + '). You can still load parts, slice and download masks, and check them in Layer preview.';
    card.appendChild(p);
  }
  wire();
  setView('iso');
  renderToolPanel(); renderPartsList(); updateHUD(); updateUndoButtons();
  updatePreview(); updateStats(); updateCheckUI();
}
init();
