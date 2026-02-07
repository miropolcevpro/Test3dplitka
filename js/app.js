
(function(){
  const S=window.PhotoPaveState,API=window.PhotoPaveAPI,ED=window.PhotoPaveEditor;
  const {state,makeZone,makeCutout,pushHistory,undo,redo}=S;
  const el=(id)=>document.getElementById(id);
  const escapeHtml=(s)=>String(s||"").replace(/[&<>'"]/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;" }[c]));
  const ESC_ATTR_MAP={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};
  const escapeAttr=(s)=>String(s||"").replace(/[&<>"']/g,(c)=>ESC_ATTR_MAP[c]);

  // Patch B: keep separate material params for base and ultra modes.
  // We avoid refactoring the whole codebase by keeping z.material.params as a pointer
  // to either params_base or params_ultra depending on state.ai.enabled.
  // Horizon UX (v2.2.93): bias the horizon control towards pushing the pattern "into the distance"
  // (down/away) and reduce the range that lifts the pattern up. Users frequently see the
  // default fill look "tilted up" and have to drag the slider far to correct it.
  //
  // We keep WebGL pipeline unchanged: no UV warp, no anisotropic scaling, no skew.
  // Only a UI remap and a slightly better default.
  // Material params (active set: base/ultra). Keep defaults stable and backwards-compatible.
  // offsetU/offsetV are tile-space phase shifts used to align seams between zones.
  const DEFAULT_MAT_PARAMS={scale:12.0,rotation:0,offsetU:0.0,offsetV:0.0,opacity:1.0,blendMode:"source-over",opaqueFill:true,perspective:0.75,horizon:0.18};

  // Slider mapping: ui in [-1..1] -> horizon internal in [H_UP_MIN..H_DOWN_MAX], centered at H_NEUTRAL.
  // - Negative UI range is compressed (less "lift up")
  // - Positive UI range is expanded (more "into the distance")
  const H_NEUTRAL = 0.18;
  const H_UP_MIN  = -0.35;
  const H_DOWN_MAX = 1.00;
  const _clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  function uiToHorizon(ui){
    ui = _clamp(+ui || 0, -1, 1);
    if(ui<=0){
      const k = (H_NEUTRAL - H_UP_MIN); // ui=-1 => H_UP_MIN
      return _clamp(H_NEUTRAL + ui*k, H_UP_MIN, H_DOWN_MAX);
    }else{
      const k = (H_DOWN_MAX - H_NEUTRAL); // ui=+1 => H_DOWN_MAX
      return _clamp(H_NEUTRAL + ui*k, H_UP_MIN, H_DOWN_MAX);
    }
  }
  function horizonToUi(h){
    h = _clamp(+h || 0, H_UP_MIN, H_DOWN_MAX);
    if(h<=H_NEUTRAL){
      const k = (H_NEUTRAL - H_UP_MIN);
      return _clamp((h - H_NEUTRAL)/k, -1, 1);
    }else{
      const k = (H_DOWN_MAX - H_NEUTRAL);
      return _clamp((h - H_NEUTRAL)/k, -1, 1);
    }
  }
  const _clone=(o)=>JSON.parse(JSON.stringify(o));
  function ensureZoneMaterialParams(z){
    if(!z || !z.material) return;
    const m=z.material;
    // Migration for older states: if only material.params exists, treat it as base.
    if(!m.params_base && !m.params_ultra){
      const base=_clone(m.params || DEFAULT_MAT_PARAMS);
      m.params_base=base;
      m.params_ultra=_clone(base);
    }else{
      if(!m.params_base) m.params_base=_clone(m.params || m.params_ultra || DEFAULT_MAT_PARAMS);
      if(!m.params_ultra) m.params_ultra=_clone(m.params_base);
    }
    // Always re-point active params based on current ultra toggle.
    const ultraOn = !!(state.ai && state.ai.enabled!==false);
    m.params = ultraOn ? m.params_ultra : m.params_base;

    // Patch D: track whether the user has manually tuned horizon/perspective in Ultra.
    // Auto-calibration is applied ONLY while these flags are false.
    if(!m._ultraTuned || typeof m._ultraTuned !== "object"){
      m._ultraTuned = { horizon:false, perspective:false };
    }else{
      if(typeof m._ultraTuned.horizon !== "boolean") m._ultraTuned.horizon = false;
      if(typeof m._ultraTuned.perspective !== "boolean") m._ultraTuned.perspective = false;
    }
  }
  function normalizeAllZones(){
    (state.zones||[]).forEach(ensureZoneMaterialParams);
  }
  // Contour visibility helpers (shared across UI + auto-hide behaviors).
  function isContourShown(){ return !(state.ui && state.ui.showContour === false); }
  function updateContourToggleBtn(){
    const b = document.getElementById("toggleContourBtn");
    if(!b) return;
    b.textContent = isContourShown() ? "Скрыть контур" : "Показать контур";
  }



  function setBuildInfo(){el("buildInfo").textContent=`${state.build.version} • ${state.build.ts}`;}
  function setActiveStep(step){
    state.ui.activeStep=step;
    document.querySelectorAll(".stepper .step").forEach(s=>s.classList.toggle("step--active",s.dataset.step===step));
  }
  function ensureActiveZone(){
    if(!state.zones.length){
      const z=makeZone();
      state.zones.push(z);
      state.ui.activeZoneId=z.id;
      // Z-D: first zone is master by default
      state.ui.masterZoneId = z.id;
      ensureZoneLinkFields(z);
    }else if(!state.ui.activeZoneId){
      state.ui.activeZoneId=state.zones[0].id;
    }
    // Fix master id if missing
    if(state.ui && !state.ui.masterZoneId && state.zones[0]) state.ui.masterZoneId = state.zones[0].id;
    // Ensure material params are migrated and mode-pointers are correct.
    normalizeAllZones();
  }

  function addZoneAndArmContour(){
    // Z-A: Atomic Add Zone Arm — create a new zone and immediately start contouring it.
    // Must be the single entry point for "+ Zone" to avoid state races.
    try{
      if(document.body && document.body.classList.contains("isFullscreenViewer")){
        _exitFullscreenViewer();
      }
    }catch(_){}

    pushHistory();

    // Z-B: Inherit master zone tiling/material parameters for the new zone.
    // Product intent: additional zones usually cover remaining fragments and must
    // keep the same world/perspective/scale to avoid "inversion" artifacts.
    const master = getMasterZone();
    if(state.ui && !state.ui.masterZoneId && master) state.ui.masterZoneId = master.id;

    const z = makeZone();
    ensureZoneLinkFields(z);

    if(master && master.material && z.material){
      try{
        // Copy only paving/appearance settings; keep geometry empty.
        z.material.shapeId   = master.material.shapeId ?? z.material.shapeId;
        z.material.textureId = master.material.textureId ?? z.material.textureId;
        z.material.textureUrl= master.material.textureUrl ?? z.material.textureUrl;
        // Deep-clone params to avoid shared references.
        if(master.material.params_base) z.material.params_base = JSON.parse(JSON.stringify(master.material.params_base));
        if(master.material.params_ultra) z.material.params_ultra = JSON.parse(JSON.stringify(master.material.params_ultra));
        // Preserve per-zone tuning flags if present (kept off by default).
        if(master.material._ultraTuned) z.material._ultraTuned = JSON.parse(JSON.stringify(master.material._ultraTuned));
        // Re-point active params according to current mode.
        ensureZoneMaterialParams(z);
      }catch(_){
        // If anything goes wrong, fall back to default makeZone() params.
      }
    }

    state.zones.push(z);
    state.ui.activeZoneId = z.id;
    state.ui.activeCutoutId = null;

    // Force contour editing mode
    state.ui.showContour = true;
    if(typeof updateContourToggleBtn === "function") updateContourToggleBtn();

    // Reset any sticky interaction state (drag/hover/pointer capture)
    if(ED && typeof ED.resetInteraction === "function") ED.resetInteraction();

    renderZonesUI();
    setActiveStep("zones");
    ED.setMode("contour");
    syncCloseButtonUI();
    ED.render();
  }

  // Z-S: Split subzone inside master zone (safe impl: cutout + new zone).
  // Principle: one scene plane per photo, zones are masks. Splitting should not re-infer perspective.
  function updateSplitZoneBtnUI(){
    const b = document.getElementById("splitZoneBtn");
    if(!b) return;
    const isSplit = (state.ui && state.ui.mode === "split");
    b.textContent = isSplit ? "Отменить разделение" : "Разделить зону";
  }

  function startOrCancelSplit(){
    const master = getMasterZone();
    if(!master){ API.setStatus("Нет зоны для разделения"); return; }
    // Toggle off if already in split mode
    if(state.ui && state.ui.mode === "split"){
      pushHistory();
      state.ui.splitDraft = null;
      state.ui.mode = "contour";
      if(ED && typeof ED.resetInteraction === "function") ED.resetInteraction();
      setActiveStep("zones");
      ED.setMode("contour");
      updateSplitZoneBtnUI();
      syncCloseButtonUI();
      ED.render();
      return;
    }
    // Guard: master must be closed to support reliable split workflow.
    if(!master.closed || (master.contour||[]).length<3){
      API.setStatus("Сначала замкните контур основной (мастер) зоны");
      return;
    }

    pushHistory();
    state.ui.splitDraft = {points:[], closed:false, parentZoneId: master.id};
    state.ui.activeCutoutId = null;
    state.ui.showContour = true;
    updateContourToggleBtn();
    if(ED && typeof ED.resetInteraction === "function") ED.resetInteraction();
    setActiveStep("zones");
    state.ui.mode = "split";
    ED.setMode("split");
    updateSplitZoneBtnUI();
    syncCloseButtonUI();
    ED.render();
  }

  function _cloneZoneMaterialFromMaster(z, master){
    if(!master || !master.material || !z || !z.material) return;
    try{
      z.material.shapeId   = master.material.shapeId ?? z.material.shapeId;
      z.material.textureId = master.material.textureId ?? z.material.textureId;
      z.material.textureUrl= master.material.textureUrl ?? z.material.textureUrl;
      if(master.material.maps) z.material.maps = JSON.parse(JSON.stringify(master.material.maps));
      if(master.material.pbrParams) z.material.pbrParams = JSON.parse(JSON.stringify(master.material.pbrParams));
      if(master.material.tileSizeM!=null) z.material.tileSizeM = master.material.tileSizeM;
      if(master.material.params_base) z.material.params_base = JSON.parse(JSON.stringify(master.material.params_base));
      if(master.material.params_ultra) z.material.params_ultra = JSON.parse(JSON.stringify(master.material.params_ultra));
      if(master.material._ultraTuned) z.material._ultraTuned = JSON.parse(JSON.stringify(master.material._ultraTuned));
      ensureZoneMaterialParams(z);
    }catch(_){ }
  }

  function applySplitDraft(){
    const d = state.ui && state.ui.splitDraft;
    if(!d || !d.points || d.points.length<3){
      API.setStatus("Контур подзоны слишком короткий");
      return;
    }
    const parent = (state.zones||[]).find(z=>z.id===d.parentZoneId) || getMasterZone();
    if(!parent){ API.setStatus("Не найдена мастер-зона для разделения"); return; }

    pushHistory();

    // 1) Add cutout to parent zone (subtract subzone area)
    const cut = makeCutout((parent.cutouts||[]).length+1);
    cut.polygon = JSON.parse(JSON.stringify(d.points));
    cut.closed = true;
    parent.cutouts = parent.cutouts || [];
    parent.cutouts.push(cut);

    // 2) Create new zone with the same contour (new material can be chosen)
    const master = getMasterZone();
    const z = makeZone();
    ensureZoneLinkFields(z);
    z.contour = JSON.parse(JSON.stringify(d.points));
    z.closed = true;
    z.cutouts = [];
    // New zones are linked by default to keep continuity
    z.linked = true;
    z.baseParams = null;
    resetZoneOverrides(z);
    _cloneZoneMaterialFromMaster(z, master);

    state.zones.push(z);
    state.ui.activeZoneId = z.id;
    state.ui.activeCutoutId = null;

    // 3) Exit split mode
    state.ui.splitDraft = null;
    state.ui.mode = "contour";
    updateSplitZoneBtnUI();

    renderZonesUI();
    syncSettingsUI();
    setActiveStep("zones");
    if(ED && typeof ED.resetInteraction === "function") ED.resetInteraction();
    ED.setMode("contour");
    syncCloseButtonUI();
    ED.render();
  }


  function renderCutoutsUI(){
    const wrap=el("cutoutsList");wrap.innerHTML="";
    const zone=S.getActiveZone();
    if(!zone){wrap.innerHTML=`<div class="note">Сначала создайте зону.</div>`;return;}
    for(const c of (zone.cutouts||[])){
      const div=document.createElement("div");
      div.className="listItem"+(c.id===state.ui.activeCutoutId?" listItem--active":"");
      div.innerHTML=`<div class="listItem__meta"><div class="listItem__title">${escapeHtml(c.name)}</div><div class="listItem__sub">${(c.polygon?.length||0)} точек</div></div>`;
      div.addEventListener("click",()=>{pushHistory();state.ui.activeCutoutId=c.id;renderCutoutsUI();ED.render();});
      wrap.appendChild(div);
    }
    // Keep the cutouts list clean: when there are no cutouts, render nothing (no extra helper text).
    // This avoids UI clutter while preserving stable DOM bindings.
    if(!(zone.cutouts||[]).length) return;
  }

  function renderZonesUI(){
    const wrap=el("zonesList");
    wrap.innerHTML="";
    const master = getMasterZone();
    if(master && state.ui && !state.ui.masterZoneId) state.ui.masterZoneId = master.id;

    for(const z of (state.zones||[])){
      ensureZoneLinkFields(z);
      const isActive = (z.id===state.ui.activeZoneId);
      const isMaster = (master && z.id===master.id);
      const hasMatOv = !!(z.overrides && z.overrides.materialOverride);
      const linkText = isMaster ? "★" : (z.linked ? "🔗" : "⛓");
      const linkTitle = isMaster ? "Мастер-зона" : (z.linked ? "Связана с мастер-зоной" : "Отвязана (свои настройки)");

      const div=document.createElement("div");
      div.className="listItem"+(isActive?" listItem--active":"");
      const title = escapeHtml(z.name)+(hasMatOv?" *":"");
      const matLabel = z.material.textureId ? ("Материал: "+escapeHtml(z.material.textureId)) : "Материал: не выбран";

      div.innerHTML=`
        <div class="listItem__meta">
          <div class="listItem__title">${title}</div>
          <div class="listItem__sub">${matLabel}</div>
        </div>
        <div class="listItem__controls">
          <button type="button" class="badge linkBadge" title="${escapeAttr(linkTitle)}" data-zone="${escapeAttr(z.id)}">${linkText}</button>
          <label class="badge"><input type="checkbox" ${z.enabled?"checked":""}/> видно</label>
        </div>`;

      div.addEventListener("click",(e)=>{
        const t=e.target;
        if(t && (t.type==="checkbox" || (t.classList && t.classList.contains("linkBadge")))) return;
        pushHistory();
        state.ui.activeZoneId=z.id;
        state.ui.activeCutoutId=(z.cutouts&&z.cutouts[0])?z.cutouts[0].id:null;
        renderZonesUI();
        syncSettingsUI();
        ED.render();
      });

      const chk = div.querySelector('input[type="checkbox"]');
      if(chk) chk.addEventListener("change",(e)=>{pushHistory();z.enabled=e.target.checked;ED.render();});

      const linkBtn = div.querySelector('.linkBadge');
      if(linkBtn){
        linkBtn.addEventListener("click",(e)=>{
          e.stopPropagation();
          if(isMaster) return;
          pushHistory();
          toggleZoneLink(z);
          renderZonesUI();
          syncSettingsUI();
          ED.render();
        });
      }

      wrap.appendChild(div);
    }
    renderCutoutsUI();
  }

  function renderShapesUI(){
    const wrap=el("shapesList");wrap.innerHTML="";
    for(const sh of (state.catalog.shapes||[])){
      const shapeId=sh.id||sh.shapeId||sh.slug;
      const title=sh.title||sh.name||shapeId;
      const preview=sh.preview||sh.previewUrl||sh.image||sh.icon||sh.iconUrl||null;
      const card=document.createElement("div");
      card.className="card"+(shapeId===state.catalog.activeShapeId?" card--active":"");
      card.innerHTML=`<div class="thumb">${preview?`<img src="${escapeAttr(preview)}" alt="${escapeAttr(title)}"/>`:""}</div>`;

      // Adapt the thumbnail frame to the intrinsic image aspect ratio to remove empty bars,
      // without changing the image fitting policy (still object-fit: contain).
      const img = card.querySelector("img");
      const applyShapeAr = () => {
        try{
          if(!img || !img.naturalWidth || !img.naturalHeight) return;
          const ar = img.naturalWidth / img.naturalHeight;
          if(isFinite(ar) && ar > 0) card.style.setProperty("--shape-ar", String(ar));
        }catch(e){}
      };
      if(img){
        if(img.complete) applyShapeAr();
        img.addEventListener("load", applyShapeAr, { once: true });
      }
      card.addEventListener("click",async ()=>{
        pushHistory();
        state.catalog.activeShapeId=shapeId;
        // Z-C: apply shape change to active zone or all zones based on editScope
        applyMaterialChange(shapeId, null);
        // AUTO_HIDE_CONTOUR_ON_TEXTURE
        try{
          const scope = _getEditScope();
          const zs = (scope==="all") ? (state.zones||[]) : [S.getActiveZone()].filter(Boolean);
          if(zs.some(z=>z && z.closed)){
            state.ui = state.ui || {};
            state.ui.showContour = false;
            updateContourToggleBtn();
          }
        }catch(e){}
        renderShapesUI();
        await loadTexturesForActiveShape();
        renderZonesUI();
        ED.render();
      });
      wrap.appendChild(card);
    }
    // After DOM is updated, adaptively size shape cards so the strip fits without clipping.
    requestAnimationFrame(fitShapesToBottomMenu);
  }


  // Ensure the shapes strip never gets visually clipped by the bottom bar height in fixed-layout iframe contexts.
  // We preserve the "frame hugs the image" logic (aspect-ratio per preview), and only adaptively reduce the overall
  // preview size (card width), so the thumbnails fully fit into the allocated bottom area.
  function fitShapesToBottomMenu(){
    try{
      const list = el("shapesList");
      const bottomMenu = document.querySelector(".bottomMenu");
      if(!list || !bottomMenu) return;

      // Measure available height for thumbnails inside the bottom menu.
      const titleEl = bottomMenu.querySelector(".bottomTitle");
      const titleH = titleEl ? titleEl.getBoundingClientRect().height : 0;

      const cs = getComputedStyle(bottomMenu);
      const padTop = parseFloat(cs.paddingTop || "0") || 0;
      const padBottom = parseFloat(cs.paddingBottom || "0") || 0;

      // Reserve some space for gaps, the scrollbar, and breathing room.
      const reserved = 28; // px
      const avail = Math.max(90, bottomMenu.clientHeight - padTop - padBottom - titleH - reserved);

      // Clamp the target thumbnail height to keep a stable look across screens.
      const targetH = Math.max(96, Math.min(156, avail));

      // Adapt card width per intrinsic aspect ratio so that resulting thumb height <= targetH.
      const cards = list.querySelectorAll(".card");
      cards.forEach((card)=>{
        let ar = 0;
        try{
          const arStr = getComputedStyle(card).getPropertyValue("--shape-ar").trim();
          ar = parseFloat(arStr);
        }catch(e){}
        if(!isFinite(ar) || ar <= 0){
          const img = card.querySelector("img");
          if(img && img.naturalWidth && img.naturalHeight){
            ar = img.naturalWidth / img.naturalHeight;
          }
        }
        if(!isFinite(ar) || ar <= 0) ar = 4/3;

        let w = Math.round(targetH * ar);
        // Keep reasonable bounds so it stays usable and consistent with existing layout.
        w = Math.max(120, Math.min(180, w));

        card.style.setProperty("--shape-card-w", w + "px");
      });
    }catch(e){}
  }

  // Left textures panel: make its height fit exactly 3 texture cards (no vertical clipping),
  // then keep the panel anchored to the bottom-left. Does not change preview image sizes.
  function fitLeftTexturesPanelForThree(){
    try{
      const left = document.getElementById("leftPane");
      const panel = document.getElementById("texturesPanel");
      if(!left || !panel) return;
      if(panel.parentElement !== left) return;
      const body = panel.querySelector(".panel__body--textures");
      const list = document.getElementById("texturesList");
      if(!body || !list) return;
      const cards = list.querySelectorAll(".card");
      if(!cards || !cards.length){
        panel.style.removeProperty("--left-textures-panel-h");
        return;
      }
      const count = Math.min(3, cards.length);
      const cardRect = cards[0].getBoundingClientRect();
      const cardH = Math.max(0, Math.round(cardRect.height));
      if(!cardH){
        panel.style.removeProperty("--left-textures-panel-h");
        return;
      }

      const listCS = getComputedStyle(list);
      const gap = parseFloat(listCS.rowGap || listCS.gap || "8") || 8;
      const listNeeded = (cardH * count) + (gap * Math.max(0, count - 1));

      const bodyCS = getComputedStyle(body);
      const padTop = parseFloat(bodyCS.paddingTop) || 0;
      const padBot = parseFloat(bodyCS.paddingBottom) || 0;

      const header = panel.querySelector(".panel__title");
      const headerH = header ? Math.round(header.getBoundingClientRect().height) : 0;

      // Border compensation (panel has 1px border on top/bottom)
      let desired = headerH + padTop + padBot + listNeeded + 2;

      // If left column is smaller (e.g. small viewport), cap to available space.
      let avail = Math.floor(left.getBoundingClientRect().height);
      // subtract the export panel height and the column gap
      const exp = left.querySelector(".panel:not(#texturesPanel)");
      if(exp){
        const gapCol = parseFloat(getComputedStyle(left).gap || "10") || 10;
        avail = Math.max(0, avail - Math.round(exp.getBoundingClientRect().height) - gapCol);
      }
      if(avail > 0) desired = Math.min(desired, avail);

      panel.style.setProperty("--left-textures-panel-h", desired + "px");
    }catch(e){
      // never break app on layout helpers
    }
  }

  function resolveTextureUrl(t){ return t.albedoUrl || t.previewUrl || null; }

  function renderTexturesUI(){
    const wrap=el("texturesList");wrap.innerHTML="";
    const shapeId=state.catalog.activeShapeId;
    const list=state.catalog.texturesByShape[shapeId]||[];
    const zone=S.getActiveZone();
    for(const t of list){
      const url=resolveTextureUrl(t);
      const active=zone && zone.material.textureId===t.textureId;
      const thumb=(t.previewUrl||url);
      const card=document.createElement("div");
      card.className="card"+(active?" card--active":"");
      card.innerHTML=`<div class="thumb">${thumb?`<img src="${escapeAttr(thumb)}" alt="">`:""}</div><div class="card__label"><span>${escapeHtml(t.title||t.textureId||"")}</span><span class="badge">${escapeHtml(t.textureId||"")}</span></div>`;
      card.addEventListener("click",()=>{
        if(!zone) return;
        pushHistory();
        // Z-C: apply material to active zone or all zones based on editScope
        applyMaterialChange(shapeId, { textureId: t.textureId, url, maps: t.maps, tileSizeM: t.tileSizeM, params: t.params });
        renderTexturesUI();renderZonesUI();ED.render();
      });
      wrap.appendChild(card);
    }
    if(!list.length) wrap.innerHTML=`<div class="note">Нет текстур для этой формы или палитра пуста.</div>`;

    // After DOM is updated, adjust the left textures panel height to show 3 cards fully.
    requestAnimationFrame(fitLeftTexturesPanelForThree);
  }

  async function loadTexturesForActiveShape(){
    const shapeId=state.catalog.activeShapeId;
    if(!shapeId) return;
    if(!state.catalog.texturesByShape[shapeId]) await API.loadPalette(shapeId);
    renderTexturesUI();
  }

  
  function _pp_computePhotoExposure(bitmap){
    try{
      if(!bitmap) return {avgLum:0.5, exposure:1.0};
      const S=64;
      const cv=document.createElement('canvas');
      cv.width=S; cv.height=S;
      const ctx=cv.getContext('2d',{willReadFrequently:true});
      if(!ctx) return {avgLum:0.5, exposure:1.0};
      ctx.drawImage(bitmap,0,0,S,S);
      const im=ctx.getImageData(0,0,S,S).data;
      let sum=0, n=0;
      for(let i=0;i<im.length;i+=4){
        const r=im[i]/255, g=im[i+1]/255, b=im[i+2]/255;
        // approximate sRGB->linear for luminance
        const rl=Math.pow(r,2.2), gl=Math.pow(g,2.2), bl=Math.pow(b,2.2);
        const lum=0.2126*rl + 0.7152*gl + 0.0722*bl;
        sum += lum; n++;
      }
      const avg = (n>0)? (sum/n) : 0.5;
      // target mid-gray in linear; keep range tight to avoid visible shifts
      const target=0.42;
      let exp = target / Math.max(0.08, avg);
      exp = Math.max(0.85, Math.min(1.15, exp));
      return {avgLum: avg, exposure: exp};
    }catch(_){ return {avgLum:0.5, exposure:1.0}; }
  }

  // Estimate a reasonable directional light preset from the photo.
  // This is NOT AI: a tiny luminance-gradient heuristic to get a stable default.
  // Output is in degrees: azimuth (0..360), elevation (0..89).
  function _pp_estimatePhotoLight(bitmap){
    try{
      if(!bitmap) return { azimuth: 120, elevation: 35, lightStrength: 1.0, ambientStrength: 0.32 };
      const S=64;
      const cv=document.createElement('canvas');
      cv.width=S; cv.height=S;
      const ctx=cv.getContext('2d',{willReadFrequently:true});
      if(!ctx) return { azimuth: 120, elevation: 35, lightStrength: 1.0, ambientStrength: 0.32 };
      ctx.drawImage(bitmap,0,0,S,S);
      const im=ctx.getImageData(0,0,S,S).data;
      const lum=new Float32Array(S*S);
      for(let y=0;y<S;y++){
        for(let x=0;x<S;x++){
          const i=(y*S+x)*4;
          const r=im[i]/255, g=im[i+1]/255, b=im[i+2]/255;
          // approximate sRGB->linear for luminance
          const rl=Math.pow(r,2.2), gl=Math.pow(g,2.2), bl=Math.pow(b,2.2);
          lum[y*S+x]=0.2126*rl + 0.7152*gl + 0.0722*bl;
        }
      }
      let gx=0, gy=0, wsum=0;
      for(let y=1;y<S-1;y++){
        for(let x=1;x<S-1;x++){
          const lxm=lum[y*S+(x-1)], lxp=lum[y*S+(x+1)];
          const lym=lum[(y-1)*S+x], lyp=lum[(y+1)*S+x];
          const dx=(lxp-lxm);
          const dy=(lyp-lym);
          const mag=Math.hypot(dx,dy);
          if(mag>1e-6){
            // Image Y is down; map to a conventional up-axis by flipping dy.
            gx += dx*mag;
            gy += (-dy)*mag;
            wsum += mag;
          }
        }
      }
      if(wsum < 1e-6) return { azimuth: 120, elevation: 35, lightStrength: 1.0, ambientStrength: 0.32 };
      gx/=wsum; gy/=wsum;
      let az = Math.atan2(gy, gx) * 180/Math.PI; // direction towards brighter side
      az = ((az % 360) + 360) % 360;

      // Conservative defaults: do not swing elevation wildly (keeps stability).
      // You can override per material in palette JSON.
      const elevation = 35;

      return { azimuth: az, elevation, lightStrength: 1.0, ambientStrength: 0.32 };
    }catch(_){
      return { azimuth: 120, elevation: 35, lightStrength: 1.0, ambientStrength: 0.32 };
    }
  }

async function handlePhotoFile(file){
    if(!file) return;
    API.setStatus("Загрузка фото…");
    const maxSide=3072;
    const prevBitmap = state.assets ? state.assets.photoBitmap : null;
    const bmp=await createImageBitmap(file);
    let w=bmp.width,h=bmp.height;
    let sc=1,longSide=Math.max(w,h);
    if(longSide>maxSide) sc=maxSide/longSide;
    const nw=Math.round(w*sc),nh=Math.round(h*sc);
    const off=document.createElement("canvas");off.width=nw;off.height=nh;
    off.getContext("2d").drawImage(bmp,0,0,nw,nh);
    try{ if(bmp && bmp.close) bmp.close(); }catch(_){ }

    const resized=await createImageBitmap(off);

    pushHistory();
    state.assets.photoBitmap=resized;state.assets.photoW=nw;state.assets.photoH=nh;
    // Precompute global photo exposure (Ultra photofit). Keeps stability under horizon changes.
    try{
      const st = _pp_computePhotoExposure(resized);
      state.assets.photoAvgLum = st.avgLum;
      state.assets.photoExposure = st.exposure;
    }catch(_){ state.assets.photoAvgLum = 0.5; state.assets.photoExposure = 1.0; }

    // Precompute a stable default light preset from the photo (Ultra PBR).
    // Material JSON can override this per palette/texture.
    try{
      state.assets.photoLight = _pp_estimatePhotoLight(resized);
    }catch(_){ state.assets.photoLight = { azimuth:120, elevation:35, lightStrength:1.0, ambientStrength:0.32 }; }
    try{ if(prevBitmap && prevBitmap.close) prevBitmap.close(); }catch(_){ }

    // New photo must start a clean contour scenario.
    // We fully reset zones, cutouts, and interaction state to avoid carrying stale settings
    // (materials, tuned horizon/perspective, hidden contour toggle, dragging/selection, etc.).
    // This keeps UX stable: user can immediately start placing contour points on the same photo.
    try{
      // Reset editor interaction flags (safety)
      state.ui.draggingPoint=null;
      state.ui.selectedPoint=null;
      state.ui.isPointerDown=false;
      // Always show contour after a new photo is loaded (otherwise it looks "broken")
      state.ui.showContour=true;
      state.ui.activeCutoutId=null;

      // Reset all zones (materials + params + tuned flags) to defaults by recreating.
      state.zones.length=0;
      state.ui.activeZoneId=null;
      // Reset floor plane too (if enabled in future)
      if(state.floorPlane){ state.floorPlane.points=[]; state.floorPlane.closed=false; }
      const z=makeZone();
      state.zones.push(z);
      state.ui.activeZoneId=z.id;
    }catch(_){
      // Fallback: at least clear contour/cutouts if something unexpected happens.
      (state.zones||[]).forEach(z=>{ z.contour=[]; z.closed=false; z.cutouts=[]; });
      state.ui.activeCutoutId=null;
      state.ui.showContour=true;
      state.ui.draggingPoint=null;
      state.ui.selectedPoint=null;
      state.ui.isPointerDown=false;
    }

    // Reset 3D calibration (manual/auto) when a new photo is loaded to avoid carrying stale lines/results.
    try{
      if(state.ai && state.ai.calib3d){
        const c3 = state.ai.calib3d;
        c3.active = null;
        c3.lines = {A1:null,A2:null,B1:null,B2:null};
        c3.result = null;
        c3.lastGoodResult = null;
        c3.status = "idle";
        c3.error = null;
        c3.warn = null;
        // Keep enabled flag as-is, but hide overlays by default.
        c3.showLines = false;
      }
      try{ window.dispatchEvent(new Event("calib3d:change")); }catch(_){ }
    }catch(_){}

    API.setStatus(`Фото загружено (${nw}×${nh})`);
    setActiveStep("zones");
    ED.setMode("contour");
    try{ updateContourToggleBtn(); }catch(_){ }
    try{ renderZonesUI(); syncSettingsUI(); }catch(_){ }
    // Resize canvas to the new photo size to avoid any aspect distortion
    if(ED.resize) ED.resize(); else ED.render();

    // Ultra AI (skeleton): run once after photo load. Does not affect rendering in Patch 1.
    try{
      if(window.AIUltraPipeline && typeof window.AIUltraPipeline.onPhotoLoaded==="function"){
        window.AIUltraPipeline.onPhotoLoaded({ file, bitmap: resized, width: nw, height: nh });
      }
    }catch(e){ console.warn("[AI] onPhotoLoaded failed:", e); }

  }

  function syncSettingsUI(){
    const z=S.getActiveZone(); if(!z) return;
    ensureZoneMaterialParams(z);
		// Scale slider range is intentionally constrained (pro-friendly defaults).
		// Clamp stored values to the UI range to avoid sudden jumps when opening older projects.
		{
			const sr = el("scaleRange");
			const v = (z.material.params.scale ?? 12.0);
			const mn = parseFloat(sr.min||"0");
			const mx = parseFloat(sr.max||"9999");
			sr.value = Math.min(mx, Math.max(mn, +v));
			// Keep model in sync with the clamped UI value.
			z.material.params.scale = parseFloat(sr.value);
		}
    el("rotRange").value=z.material.params.rotation??0;
    // Z-E: seam alignment offsets (tile-space phase shifts)
    {
      const u = el("offsetURange");
      if(u){
        const v = (z.material.params.offsetU ?? 0.0);
        const mn = parseFloat(u.min||"-9999");
        const mx = parseFloat(u.max||"9999");
        u.value = Math.min(mx, Math.max(mn, +v));
        z.material.params.offsetU = parseFloat(u.value);
      }
      const vEl = el("offsetVRange");
      if(vEl){
        const v = (z.material.params.offsetV ?? 0.0);
        const mn = parseFloat(vEl.min||"-9999");
        const mx = parseFloat(vEl.max||"9999");
        vEl.value = Math.min(mx, Math.max(mn, +v));
        z.material.params.offsetV = parseFloat(vEl.value);
      }
    }
    // Defaults tuned for visibility; users can lower opacity or switch to Multiply.
    el("opacityRange").value=z.material.params.opacity??1.0;
    const oc=el("opaqueFillChk"); if(oc) oc.checked=!!(z.material.params.opaqueFill);
    const bs=el("blendSelect"); if(bs && oc){ bs.disabled=oc.checked; if(oc.checked) bs.value="source-over"; }
    const bs2=el("blendSelect"); if(bs2){ bs2.value = (oc && oc.checked) ? "source-over" : (z.material.params.blendMode??"source-over"); }
    el("perspectiveRange").value=z.material.params.perspective??0.75;
    // Show UI value (shifted/bias-mapped) while keeping internal value stored in material params.
    el("horizonRange").value = horizonToUi(z.material.params.horizon??H_NEUTRAL);
  }

  // Z-C: edit scope helpers (pro-style global edits)
  function _getEditScope(){
    try{ return (state.ui && state.ui.editScope) ? state.ui.editScope : "active"; }catch(_){ return "active"; }
  }
  function _targetsForScope(){
    const scope=_getEditScope();
    if(scope==="all") return state.zones || [];
    const z=S.getActiveZone();
    return z ? [z] : [];
  }
  

  // Z-D: Linked zones (pro) — master zone parameters + per-zone overrides.
  function _zClamp(v, lo, hi){ v=+v; if(!isFinite(v)) v=0; return Math.min(hi, Math.max(lo, v)); }
  function _zClamp01(v){ return _zClamp(v, 0, 1); }

  function ensureZoneLinkFields(z){
    if(!z) return;
    if(typeof z.linked !== 'boolean') z.linked = true;
    if(!z.overrides) z.overrides = {
      scaleMult:1, rotOffset:0, offsetU:0, offsetV:0, opacityMult:1,
      perspectiveOffset:0, horizonOffset:0,
      blendModeOverride:null, opaqueFillOverride:null,
      materialOverride:null, shapeOverride:null
    };
    if(typeof z.baseParams === 'undefined') z.baseParams = null;
  }

  function resetZoneOverrides(z){
    if(!z) return;
    z.overrides = {
      scaleMult:1, rotOffset:0, offsetU:0, offsetV:0, opacityMult:1,
      perspectiveOffset:0, horizonOffset:0,
      blendModeOverride:null, opaqueFillOverride:null,
      materialOverride:null, shapeOverride:null
    };
  }

  function toggleZoneLink(z){
    if(!z) return;
    const master = getMasterZone();
    if(master && z.id===master.id) return; // master is always linked
    ensureZoneLinkFields(z);
    if(z.linked){
      // unlink: snapshot current state so visuals stay identical
      z.baseParams = getZoneParamsSnapshot(z);
      z.linked = false;
      resetZoneOverrides(z);
    }else{
      // relink: drop per-zone base, return to master+overrides
      z.baseParams = null;
      z.linked = true;
      resetZoneOverrides(z);
      syncLinkedZones();
    }
  }


  function getMasterZone(){
    try{
      const mid = state.ui && state.ui.masterZoneId;
      if(mid){
        const mz = (state.zones||[]).find(z=>z.id===mid);
        if(mz) return mz;
      }
    }catch(_){ }
    return (state.zones && state.zones.length) ? state.zones[0] : null;
  }

  function getZoneParamsSnapshot(z){
    if(!z || !z.material) return null;
    return {
      shapeId: z.material.shapeId ?? null,
      textureId: z.material.textureId ?? null,
      textureUrl: z.material.textureUrl ?? null,
      maps: z.material.maps ? JSON.parse(JSON.stringify(z.material.maps)) : null,
      pbrParams: z.material.pbrParams ? JSON.parse(JSON.stringify(z.material.pbrParams)) : null,
      tileSizeM: z.material.tileSizeM ?? null,
      params_base: z.material.params_base ? JSON.parse(JSON.stringify(z.material.params_base)) : null,
      params_ultra: z.material.params_ultra ? JSON.parse(JSON.stringify(z.material.params_ultra)) : null,
      _ultraTuned: z.material._ultraTuned ? JSON.parse(JSON.stringify(z.material._ultraTuned)) : null,
    };
  }

  function applyZoneParamsSnapshot(z, snap){
    if(!z || !z.material || !snap) return;
    z.material.shapeId = snap.shapeId;
    z.material.textureId = snap.textureId;
    z.material.textureUrl = snap.textureUrl;
    z.material.maps = snap.maps;
    z.material.pbrParams = snap.pbrParams;
    if(snap.tileSizeM!=null) z.material.tileSizeM = snap.tileSizeM;
    if(snap.params_base) z.material.params_base = snap.params_base;
    if(snap.params_ultra) z.material.params_ultra = snap.params_ultra;
    if(snap._ultraTuned) z.material._ultraTuned = snap._ultraTuned;
    ensureZoneMaterialParams(z);
  }

  function applyOverridesToParams(base, ov){
    const b = base || {};
    const o = ov || {};
    const scale = (b.scale ?? 12.0) * (o.scaleMult ?? 1);
    const rotation = (b.rotation ?? 0) + (o.rotOffset ?? 0);
    const offsetU = (b.offsetU ?? 0.0) + (o.offsetU ?? 0.0);
    const offsetV = (b.offsetV ?? 0.0) + (o.offsetV ?? 0.0);
    const opacity = (b.opacity ?? 1.0) * (o.opacityMult ?? 1);
    const perspective = _zClamp01((b.perspective ?? 0.75) + (o.perspectiveOffset ?? 0));
    const horizon = _zClamp((b.horizon ?? 0.0) + (o.horizonOffset ?? 0), -1, 1);
    return {
      ...b,
      scale: _zClamp(scale, 0.05, 200),
      rotation,
      offsetU: _zClamp(offsetU, -50, 50),
      offsetV: _zClamp(offsetV, -50, 50),
      opacity: _zClamp(opacity, 0, 1),
      perspective,
      horizon,
      blendMode: (o.blendModeOverride ?? b.blendMode ?? 'source-over'),
      opaqueFill: (o.opaqueFillOverride != null ? !!o.opaqueFillOverride : !!(b.opaqueFill))
    };
  }

  function recomputeLinkedZoneFromMaster(zone, master){
    if(!zone || !master) return;
    ensureZoneLinkFields(zone);
    ensureZoneMaterialParams(master);
    ensureZoneMaterialParams(zone);

    // Material override (local exception) — pro behavior
    const ov = zone.overrides || {};
    // Guard rail: perspective/horizon are scene-global. Do not allow per-zone offsets on linked zones.
    // This prevents rare "inversion" artifacts on very small / degenerate secondary zones.
    const ovSafe = { ...ov, perspectiveOffset: 0, horizonOffset: 0 };
    const baseShapeId = master.material.shapeId;
    const baseMaterialSnap = null;

    // Apply base params from master
    try{
      if(master.material.params_base && zone.material.params_base){
        const base = applyOverridesToParams(master.material.params_base, ovSafe);
        zone.material.params_base = JSON.parse(JSON.stringify(base));
      }
      if(master.material.params_ultra && zone.material.params_ultra){
        const ultra = applyOverridesToParams(master.material.params_ultra, ovSafe);
        zone.material.params_ultra = JSON.parse(JSON.stringify(ultra));
      }
      ensureZoneMaterialParams(zone);
      // Mirror base material by default
      if(!ov.shapeOverride) zone.material.shapeId = master.material.shapeId;
      if(!ov.materialOverride){
        zone.material.textureId = master.material.textureId;
        zone.material.textureUrl = master.material.textureUrl;
        zone.material.maps = master.material.maps ? JSON.parse(JSON.stringify(master.material.maps)) : null;
        zone.material.pbrParams = master.material.pbrParams ? JSON.parse(JSON.stringify(master.material.pbrParams)) : null;
        if(master.material.tileSizeM!=null) zone.material.tileSizeM = master.material.tileSizeM;
      }else{
        // materialOverride stores only material selection (not tiling params).
        const mo = ov.materialOverride;
        if(mo){
          if(mo.shapeId!=null) zone.material.shapeId = mo.shapeId;
          zone.material.textureId = mo.textureId ?? null;
          zone.material.textureUrl = mo.textureUrl ?? null;
          zone.material.maps = mo.maps ? JSON.parse(JSON.stringify(mo.maps)) : null;
          zone.material.pbrParams = mo.pbrParams ? JSON.parse(JSON.stringify(mo.pbrParams)) : null;
          if(mo.tileSizeM!=null) zone.material.tileSizeM = mo.tileSizeM;
        }
      }
      if(ov.shapeOverride) zone.material.shapeId = ov.shapeOverride;
    }catch(e){
      console.warn('[Z-D] recompute linked zone failed', e);
    }
  }

  function syncLinkedZones(){
    const master = getMasterZone();
    if(!master) return;
    // Ensure master id is fixed
    if(state.ui && !state.ui.masterZoneId) state.ui.masterZoneId = master.id;
    for(const z of (state.zones||[])){
      if(!z || z.id===master.id) continue;
      ensureZoneLinkFields(z);
      if(z.linked) recomputeLinkedZoneFromMaster(z, master);
    }
  }

function applyChangeToTiling(change){
    const scope=_getEditScope();
    const master = getMasterZone();
    if(scope==="all"){
      if(!master) return;
      ensureZoneMaterialParams(master);
      ensureZoneLinkFields(master);
      // Apply change to master active params
      const p = master.material && master.material.params ? master.material.params : (master.material.params={});
      for(const k in change){ p[k]=change[k]; }
      // Keep Ultra manual tuning flags consistent when user tweaks horizon/perspective.
      if(state.ai && state.ai.enabled!==false && master.material){
        if(master.material._ultraTuned && ("perspective" in change)) master.material._ultraTuned.perspective = true;
        if(master.material._ultraTuned && ("horizon" in change)) master.material._ultraTuned.horizon = true;
      }
      // Recompute all linked zones from master + overrides.
      syncLinkedZones();
      return;
    }

    // scope: active
    const z = S.getActiveZone();
    if(!z) return;
    ensureZoneMaterialParams(z);
    ensureZoneLinkFields(z);

    // If this is the master zone (or unlinked), write directly.
    if(!master || z.id===master.id || z.linked===false){
      const p = z.material && z.material.params ? z.material.params : (z.material.params={});
      for(const k in change){ p[k]=change[k]; }
      if(state.ai && state.ai.enabled!==false && z.material){
        if(z.material._ultraTuned && ("perspective" in change)) z.material._ultraTuned.perspective = true;
        if(z.material._ultraTuned && ("horizon" in change)) z.material._ultraTuned.horizon = true;
      }
      // If master changed directly, sync linked zones.
      if(master && z.id===master.id) syncLinkedZones();
      return;
    }

    // Linked non-master zone: store local deltas (overrides) relative to master's active params.
    ensureZoneMaterialParams(master);
    const mp = master.material && master.material.params ? master.material.params : {};
    const ov = z.overrides;
    let sceneParamTouched = false;
    for(const k in change){
      const v = change[k];
      if(k==="scale"){
        const m = mp.scale ?? 12.0;
        ov.scaleMult = (m ? (v / m) : 1);
      }else if(k==="rotation"){
        ov.rotOffset = (v - (mp.rotation ?? 0));
      }else if(k==="offsetU"){
        ov.offsetU = (v - (mp.offsetU ?? 0.0));
      }else if(k==="offsetV"){
        ov.offsetV = (v - (mp.offsetV ?? 0.0));
      }else if(k==="opacity"){
        const m = mp.opacity ?? 1.0;
        ov.opacityMult = (m ? (v / m) : 1);
      }else if(k==="perspective" || k==="horizon"){
        // Guard rail: perspective/horizon are scene-global. Even in "active" scope,
        // changing them must affect the master (photo plane), not a small secondary zone.
        const pMaster = master.material && master.material.params ? master.material.params : (master.material.params={});
        pMaster[k] = v;
        if(state.ai && state.ai.enabled!==false && master.material && master.material._ultraTuned){
          if(k==="perspective") master.material._ultraTuned.perspective = true;
          if(k==="horizon") master.material._ultraTuned.horizon = true;
        }
        sceneParamTouched = true;
      }else if(k==="blendMode"){
        ov.blendModeOverride = v;
      }else if(k==="opaqueFill"){
        ov.opaqueFillOverride = !!v;
      }else{
        // Unknown key: write directly to active params to preserve backward compatibility.
        const p = z.material && z.material.params ? z.material.params : (z.material.params={});
        p[k]=v;
      }
    }
    if(sceneParamTouched){
      // Recompute all linked zones from updated master.
      syncLinkedZones();
      return;
    }
    // Apply effective params immediately for this zone.
    recomputeLinkedZoneFromMaster(z, master);
  }

  // Z-C guard rail: single entry point for PBR parameter changes (reserved for future UI controls).
  // Does NOT touch user tiling controls (scale/rotation/opacity/horizon/perspective).
  function applyChangeToPBR(change){
    const targets=_targetsForScope();
    if(!targets.length) return;
    for(const z of targets){
      if(!z || !z.material) continue;
      z.material.pbrParams = z.material.pbrParams || {};
      for(const k in change){
        z.material.pbrParams[k] = change[k];
      }
    }
  }
  function applyMaterialChange(shapeId, tex){
    const scope=_getEditScope();
    const master = getMasterZone();

    if(scope==="all"){
      if(!master) return;
      ensureZoneMaterialParams(master);
      // Apply to master as before
      master.material.shapeId = shapeId || master.material.shapeId;
      if(tex===null){
        master.material.textureId = null;
        master.material.textureUrl = null;
        master.material.maps = null;
        master.material.pbrParams = null;
      }else if(tex){
        master.material.textureId = tex.textureId;
        master.material.textureUrl = tex.url;
        if(tex.maps){
          master.material.maps = {...tex.maps};
          if(tex.tileSizeM!=null) master.material.tileSizeM = tex.tileSizeM;
        }else{
          master.material.maps = {albedo: tex.url};
        }
        master.material.pbrParams = (tex.params ? {...tex.params} : null);
      }
      // Recompute linked zones (keeps their local materialOverride if present)
      syncLinkedZones();
      return;
    }

    // scope: active
    const z = S.getActiveZone();
    if(!z) return;
    ensureZoneLinkFields(z);
    ensureZoneMaterialParams(z);

    if(z.linked && master && z.id!==master.id){
      // Store local material override (light payload).
      if(tex===null){
        z.overrides.shapeOverride = shapeId || z.overrides.shapeOverride;
        z.overrides.materialOverride = null;
      }else if(tex){
        z.overrides.shapeOverride = shapeId || z.overrides.shapeOverride;
        z.overrides.materialOverride = {
          shapeId: shapeId || master.material.shapeId || z.material.shapeId,
          textureId: tex.textureId,
          textureUrl: tex.url,
          maps: tex.maps ? {...tex.maps} : {albedo: tex.url},
          pbrParams: (tex.params ? {...tex.params} : null),
          tileSizeM: (tex.tileSizeM!=null ? tex.tileSizeM : null)
        };
      }
      recomputeLinkedZoneFromMaster(z, master);
      return;
    }

    // Unlinked or master: apply directly
    z.material.shapeId = shapeId || z.material.shapeId;
    if(tex===null){
      z.material.textureId = null;
      z.material.textureUrl = null;
      z.material.maps = null;
      z.material.pbrParams = null;
    }else if(tex){
      z.material.textureId = tex.textureId;
      z.material.textureUrl = tex.url;
      if(tex.maps){
        z.material.maps = {...tex.maps};
        if(tex.tileSizeM!=null) z.material.tileSizeM = tex.tileSizeM;
      }else{
        z.material.maps = {albedo: tex.url};
      }
      z.material.pbrParams = (tex.params ? {...tex.params} : null);
    }
  }

  function syncCloseButtonUI(){
    const btn=el("closePolyBtn");
    if(!btn) return;
    if(state.ui.mode==="cutout") btn.textContent="Замкнуть вырез";
    else if(state.ui.mode==="split") btn.textContent="Замкнуть подзону";
    else btn.textContent="Замкнуть контур";
  }

  function makeSummaryText(){
    const zones=state.zones.map((z,i)=>`${i+1}) ${z.name}: форма=${z.material.shapeId||"—"}, текстура=${z.material.textureId||"—"}, точки=${z.contour?.length||0}, вырезы=${z.cutouts?.length||0}`).join("\n");
    return ["Визуализация мощения (фото-конструктор):",zones,"","Приложите сохранённое изображение и напишите, нужна ли консультация."].join("\n");
  }
  function openMessenger(kind){
    const txt=encodeURIComponent(makeSummaryText());
    if(kind==="wa") window.open("https://api.whatsapp.com/send?text="+txt,"_blank");
    else window.open("https://t.me/share/url?text="+txt,"_blank");
  }
  async function share(){
    const txt=makeSummaryText();
    if(navigator.share){try{await navigator.share({title:"Визуализация плитки",text:txt});}catch(e){}}
    else{await navigator.clipboard.writeText(txt).catch(()=>{});API.setStatus("Web Share недоступен — описание скопировано");}
  }

  function bindUI(){
    // Z-C: edit scope toggle (active zone vs all zones)
    try{
      const a = document.getElementById("editScopeActive");
      const b = document.getElementById("editScopeAll");
      const scope = _getEditScope();
      if(a) a.checked = (scope !== "all");
      if(b) b.checked = (scope === "all");
      const onChange = ()=>{
        state.ui = state.ui || {};
        state.ui.editScope = (b && b.checked) ? "all" : "active";
      };
      if(a) a.addEventListener("change", onChange);
      if(b) b.addEventListener("change", onChange);
    }catch(_){ }

    // Contour visibility toggle (overlay)
    const toggleContourBtn = document.getElementById("toggleContourBtn");
    if(toggleContourBtn){
      toggleContourBtn.addEventListener("click", () => {
        state.ui = state.ui || {};
        state.ui.showContour = !isContourShown();
        updateContourToggleBtn();
        ED.render();
      });
      updateContourToggleBtn();
    }


    // Ultra AI toggle (skeleton)
    const aiChk = document.getElementById("aiUltraChk");
    const aiStatusEl = document.getElementById("aiStatusText");

    // Premium occlusion controls (Patch 4)
    const aiOccChk = document.getElementById("aiOccChk");
    const aiOccPickBtn = document.getElementById("aiOccPickBtn");
    const aiOccClearBtn = document.getElementById("aiOccClearBtn");
    const aiOccHint = document.getElementById("aiOccHint");

    // Premium 3D calibration (Variant B - MVP)
    const calib3dEnableChk = document.getElementById("calib3dEnableChk");
    const calib3dApplyChk = document.getElementById("calib3dApplyChk");
    const calib3dStatusText = document.getElementById("calib3dStatusText");
    const calib3dA1Btn = document.getElementById("calib3dA1Btn");
    const calib3dA2Btn = document.getElementById("calib3dA2Btn");
    const calib3dB1Btn = document.getElementById("calib3dB1Btn");
    const calib3dB2Btn = document.getElementById("calib3dB2Btn");
    const calib3dResetBtn = document.getElementById("calib3dResetBtn");
    const calib3dExitBtn = document.getElementById("calib3dExitBtn");
    const calib3dAutoContourBtn = document.getElementById("calib3dAutoContourBtn");
    const calib3dToggleLinesBtn = document.getElementById("calib3dToggleLinesBtn");
    function renderAiStatus(){
      if(!aiStatusEl) return;
      const a = state.ai || {};
      const st = a.status || "idle";
      const q = a.quality || "basic";
      const tier = a.device && a.device.tier ? a.device.tier : "";
      const wg = (a.device && a.device.webgpu) ? "WebGPU" : "no WebGPU";
      const depth = (a.depthMap && a.depthReady) ? "depth" : "";
      const occ = (a.occlusionMask && a.occlusionMask.canvas) ? "occ" : "";
      let txt = `AI: ${st}`;
      if(q) txt += ` • ${q}`;
      if(tier) txt += ` • ${tier}`;
      txt += ` • ${wg}`;
      if(depth) txt += ` • ${depth}`;
      if(occ) txt += ` • ${occ}`;
      aiStatusEl.textContent = txt;
    }
    if(aiChk){
      aiChk.checked = (state.ai && state.ai.enabled !== false);
      aiChk.addEventListener("change", ()=>{
        state.ai = state.ai || {};
        state.ai.enabled = aiChk.checked;
        if(window.AIUltraPipeline && typeof window.AIUltraPipeline.setEnabled==="function"){
          window.AIUltraPipeline.setEnabled(aiChk.checked);
        }
        // Patch B: re-point all zone material params so base/ultra stay independent.
        normalizeAllZones();
        syncSettingsUI();
        ED.render();
        renderAiStatus();
      });
    }

    // Occlusion toggle (enabled by default, but does nothing until user creates a mask).
    if(aiOccChk){
      aiOccChk.checked = !(state.ai && state.ai.occlusionEnabled === false);
      aiOccChk.addEventListener("change", ()=>{
        state.ai = state.ai || {};
        state.ai.occlusionEnabled = aiOccChk.checked;
        renderAiStatus();
        ED.render();
      });
    }

    // Enter/exit pick mode (click on photo to select an object).
    if(aiOccPickBtn){
      aiOccPickBtn.addEventListener("click", ()=>{
        state.ai = state.ai || {};
        state.ai._occPickMode = !(state.ai._occPickMode);
        if(aiOccHint) aiOccHint.style.display = state.ai._occPickMode ? "block" : "none";
        aiOccPickBtn.classList.toggle("btn--active", !!state.ai._occPickMode);
      });
    }

    function _ensureCalib3DState(){
      state.ai = state.ai || {};
      state.ai.calib3d = state.ai.calib3d || {enabled:false, use3DRenderer:true, forceBottomUp:true, contourDefinesAxis:true, disableAiQuad:true, allowFallbackK:true, applyToActiveZone:false, active:null, lines:{A1:null,A2:null,B1:null,B2:null}, result:null, status:"idle", error:null};
      return state.ai.calib3d;
    }

    function _enterCalibMode(key){
      const c3 = _ensureCalib3DState();
      if(c3.enabled !== true){ c3.enabled = true; if(calib3dEnableChk) calib3dEnableChk.checked = true; }
      c3.active = key;
      c3.status = "editing";
      c3.showLines = true;
      // Remember the previous mode for a clean exit
      if(!state.ui._prevMode) state.ui._prevMode = state.ui.mode;
      ED.setMode("calib");
      try{ window.dispatchEvent(new Event("calib3d:change")); }catch(_){ }
    }

    function _exitCalibMode(){
      const prev = state.ui._prevMode || "contour";
      state.ui._prevMode = null;
      if(state.ui.mode === "calib") ED.setMode(prev);
      const c3 = _ensureCalib3DState();
      c3.active = null;
      try{ window.dispatchEvent(new Event("calib3d:change")); }catch(_){ }
    }

    function _resetCalib3D(){
      const c3 = _ensureCalib3DState();
      c3.lines = {A1:null,A2:null,B1:null,B2:null};
      c3.result = null;
      c3.status = "idle";
      c3.error = null;
      try{ window.dispatchEvent(new Event("calib3d:change")); }catch(_){ }
      ED.render();
    }

    function _syncCalib3DUI(){
      const c3 = _ensureCalib3DState();
      if(calib3dEnableChk) calib3dEnableChk.checked = !!c3.enabled;
      if(calib3dApplyChk) calib3dApplyChk.checked = (c3.applyToActiveZone !== false);
      const setActive = (btn, k)=>{ if(btn) btn.classList.toggle("btn--active", c3.active===k); };
      setActive(calib3dA1Btn, "A1");
      setActive(calib3dA2Btn, "A2");
      setActive(calib3dB1Btn, "B1");
      setActive(calib3dB2Btn, "B2");
      if(calib3dStatusText){
        let msg = "";
        if(c3.enabled !== true){
          msg = "Калибровка выключена.";
        }else if(c3.status === "ready" && c3.result && c3.result.ok){
          const f = c3.result.K && c3.result.K.f ? Math.round(c3.result.K.f) : null;
          const applied = (c3.applyToActiveZone !== false) ? " Параметры применены к активной зоне." : "";
          msg = "Калибровка готова" + (f? (" • f≈"+f+"px") : "") + "." + applied;
        }else if(c3.status === "ready" && c3.result && !c3.result.ok){
          msg = "Линии неустойчивы — используется безопасная перспектива (fallback)." + (c3.warn ? (" ("+c3.warn+")") : "");
        }else if(c3.status === "error"){
          msg = "Ошибка калибровки: " + (c3.error || "не удалось вычислить");
        }else{
          msg = "Без линий калибровки режим обычно не меняет картинку (используется базовая камера). "
              + "Чтобы получить эффект, задайте линии A1, A2, B1, B2 (по 2 точки каждая)."
              + (c3.active? (" Активная: "+c3.active) : "");
        }
        calib3dStatusText.textContent = msg;
      }
    
      if(calib3dToggleLinesBtn){
        const hasAnyLine = !!(c3.lines && (c3.lines.A1 || c3.lines.A2 || c3.lines.B1 || c3.lines.B2));
        // In calibration editing mode we always show lines; outside allow toggle.
        const forceShow = (state.ui && state.ui.mode === "calib");
        calib3dToggleLinesBtn.textContent = (forceShow || c3.showLines) ? "Скрыть линии" : "Показать линии";
        calib3dToggleLinesBtn.disabled = (!hasAnyLine && !forceShow);
      }
}

    if(calib3dEnableChk){
      calib3dEnableChk.addEventListener("change", ()=>{
        const c3 = _ensureCalib3DState();
        c3.enabled = !!calib3dEnableChk.checked;
        if(!c3.enabled){ _exitCalibMode(); }
        _syncCalib3DUI();
        ED.render();
      });
    }
    if(calib3dApplyChk){
      calib3dApplyChk.addEventListener("change", ()=>{
        const c3 = _ensureCalib3DState();
        c3.applyToActiveZone = !!calib3dApplyChk.checked;
        _syncCalib3DUI();
      });
    }
    if(calib3dA1Btn) calib3dA1Btn.addEventListener("click", ()=>_enterCalibMode("A1"));
    if(calib3dA2Btn) calib3dA2Btn.addEventListener("click", ()=>_enterCalibMode("A2"));
    if(calib3dB1Btn) calib3dB1Btn.addEventListener("click", ()=>_enterCalibMode("B1"));
    if(calib3dB2Btn) calib3dB2Btn.addEventListener("click", ()=>_enterCalibMode("B2"));
    if(calib3dResetBtn) calib3dResetBtn.addEventListener("click", _resetCalib3D);
    if(calib3dExitBtn) calib3dExitBtn.addEventListener("click", _exitCalibMode);

    // Auto calibration from the already drawn contour (test)
    async function _autoCalibFromContour(){
      const c3 = _ensureCalib3DState();
      if(c3.enabled !== true){ c3.enabled = true; if(calib3dEnableChk) calib3dEnableChk.checked = true; }

      // Need a closed contour
      const z = S.getActiveZone && S.getActiveZone();
      if(!z || !z.closed || !Array.isArray(z.contour) || z.contour.length < 4){
        c3.status = "error";
        c3.error = "Сначала замкните контур зоны (минимум 4 точки).";
        try{ window.dispatchEvent(new Event("calib3d:change")); }catch(_){ }
        ED.render();
        return;
      }

      if(!window.PhotoPaveCameraCalib || typeof window.PhotoPaveCameraCalib.autoLinesFromContour !== "function" || typeof window.PhotoPaveCameraCalib.computeFromLines !== "function"){
        c3.status = "error";
        c3.error = "Модуль калибровки не готов.";
        try{ window.dispatchEvent(new Event("calib3d:change")); }catch(_){ }
        ED.render();
        return;
      }

      c3.status = "editing";
      c3.error = null;

      const r = window.PhotoPaveCameraCalib.autoLinesFromContour(z.contour, state.assets.photoW, state.assets.photoH);
      if(!r || !r.ok || !r.lines){
        c3.status = "error";
        c3.error = "Авто по контуру не удалось (" + (r && r.reason ? r.reason : "weak") + "). Попробуйте ручные линии.";
        try{ window.dispatchEvent(new Event("calib3d:change")); }catch(_){ }
        ED.render();
        return;
      }

      // Set synthetic lines and compute
      c3.lines = r.lines;
      // Auto mode: hide lines by default after applying, user can toggle them.
      c3.showLines = false;
      const prevOk = (c3.result && c3.result.ok) ? c3.result : (c3.lastGoodResult && c3.lastGoodResult.ok ? c3.lastGoodResult : null);
      const res = window.PhotoPaveCameraCalib.computeFromLines(c3.lines, state.assets.photoW, state.assets.photoH);
      if(res && res.ok){
        c3.result = res;
        c3.lastGoodResult = res;
        c3.status = "ready";

        if(c3.applyToActiveZone !== false){
          if(z && z.material && z.material.params){
            z.material.params.horizon = res.autoHorizon;
            z.material.params.perspective = res.autoPerspective;
            z.material._ultraTuned = z.material._ultraTuned || {horizon:false, perspective:false};
            z.material._ultraTuned.horizon = false;
            z.material._ultraTuned.perspective = false;
          }
        }
        c3.error = null;
        // Surface non-fatal issues as a warning (e.g. B lines near-parallel => A-only fallback).
        const warns = [];
        if(r && r.warn) warns.push(String(r.warn));
        if(res && res.warn) warns.push(String(res.warn));
        if(res && res.partial && warns.length === 0) warns.push("partial");
        c3.warn = warns.length ? (warns.join("; ") + (res && res.partial ? " (A-only)" : "")) : null;
      }else{
        c3.result = prevOk || {ok:false, reason:(res && res.reason) ? String(res.reason) : "calibration_weak", fallback:true};
        c3.status = "ready";
        c3.error = null;
        c3.warn = (res && res.reason) ? String(res.reason) : (r && r.warn ? String(r.warn) : "calibration_weak");
      }
      try{ window.dispatchEvent(new Event("calib3d:change")); }catch(_){ }
      ED.render();
    }

    if(calib3dAutoContourBtn) calib3dAutoContourBtn.addEventListener("click", _autoCalibFromContour);
if(calib3dToggleLinesBtn){
      calib3dToggleLinesBtn.addEventListener("click", ()=>{
        const c3 = _ensureCalib3DState();
        c3.showLines = !(c3.showLines);
        try{ window.dispatchEvent(new Event("calib3d:change")); }catch(_){ }
        ED.render();
      });
    }

    window.addEventListener("calib3d:change", ()=>{
      try{ syncSettingsUI(); }catch(_){ }
      _syncCalib3DUI();
    });

    // Initial render
    try{ _syncCalib3DUI(); }catch(_){ }

    // Clear occlusion mask
    if(aiOccClearBtn){
      aiOccClearBtn.addEventListener("click", ()=>{
        state.ai = state.ai || {};
        state.ai.occlusionMask = null;
        state.ai._occPickMode = false;
        if(aiOccHint) aiOccHint.style.display = "none";
        if(aiOccPickBtn) aiOccPickBtn.classList.remove("btn--active");
        renderAiStatus();
        ED.render();
      });
    }
    function _onUltraProgress(e){
      // Only show the indicator when Ultra AI is enabled.
      const enabled = !!(state.ai && state.ai.enabled!==false);
      if(!enabled){ UltraLoadUI.hide(); return; }

      if(e && e.type==="ai:status"){
        const st = e.detail && e.detail.status ? String(e.detail.status) : "";
        if(st==="loading" || st==="running") UltraLoadUI.start();
        if(st==="ready") UltraLoadUI.stop(true);
        return;
      }
      if(e && e.type==="ai:depthReady"){
        UltraLoadUI.start();
        UltraLoadUI.setProgress(Math.max(0.86, 0.0));
        UltraLoadUI.setText("Загрузка глубины текстуры");
        return;
      }
      if(e && e.type==="ai:occlusionReady"){
        // Not always present, but if it happens, it means CV stage is done.
        UltraLoadUI.start();
        UltraLoadUI.setProgress(Math.max(0.92, 0.0));
        UltraLoadUI.setText("Оптимизация компьютерного зрения");
        return;
      }
      if(e && e.type==="ai:ready"){
        UltraLoadUI.stop(true);
        return;
      }
      if(e && e.type==="ai:error"){
        UltraLoadUI.stop(false);
        return;
      }
    }

    window.addEventListener("ai:status", (e)=>{ renderAiStatus(e); _onUltraProgress(e); });
    window.addEventListener("ai:ready", (e)=>{ renderAiStatus(e); _onUltraProgress(e); });
    window.addEventListener("ai:error", (e)=>{ renderAiStatus(e); _onUltraProgress(e); });
    window.addEventListener("ai:depthReady", (e)=>{ renderAiStatus(e); _onUltraProgress(e); });
    window.addEventListener("ai:occlusionReady", (e)=>{ renderAiStatus(e); _onUltraProgress(e); });
    renderAiStatus();

    // AI debug overlay (Patch 3.1)
    // Enable via URL param ?aidebug=1 or Ctrl+Shift+D. Hidden by default to avoid UX changes.
    const aiDbgWrap = document.getElementById("aiDebugOverlay");
    const aiDbgCanvas = document.getElementById("aiDebugCanvas");
    const aiDepthThumb = document.getElementById("aiDepthThumb");

    function _aiMixFromConf(conf){
      // Must match webgl_compositor.js
      const c0 = 0.18, c1 = 0.55;
      const t = Math.max(0, Math.min(1, (conf - c0) / ((c1 - c0) || 1e-6)));
      return t*t*(3 - 2*t);
    }

    function setAiDebugOverlayEnabled(v){
      state.ai = state.ai || {};
      state.ai.debugOverlay = !!v;
      if(aiDbgWrap){
        aiDbgWrap.classList.toggle("aiDebugOverlay--on", !!v);
        aiDbgWrap.setAttribute("aria-hidden", v ? "false" : "true");
      }
      drawAiDebugOverlay();
    }

    function drawAiDebugOverlay(){
      if(!(state.ai && state.ai.debugOverlay)) return;
      const a = state.ai || {};
      const conf = isFinite(a.confidence) ? a.confidence : 0;
      const mix = isFinite(a._lastMix) ? a._lastMix : _aiMixFromConf(conf);
      const dir = a.planeDir || null;

      if(aiDbgCanvas){
        const ctx = aiDbgCanvas.getContext("2d");
        const W = aiDbgCanvas.width|0, H = aiDbgCanvas.height|0;
        ctx.clearRect(0,0,W,H);

        // Text
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.font = "12px ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial";
        const farHigh = (a.depthFarHigh === false) ? "inv" : "ok";
        const qg = a._quadGuard ? a._quadGuard : "n/a";
        const calibStr = (a._calibUsed) ? (`   calib=${a._calibUsed}`) : "";
        ctx.fillText(`AI depth: ${a.depthReady ? "ready" : "off"}   conf=${conf.toFixed(2)}   mix=${mix.toFixed(2)}   quad=${qg}   far=${farHigh}${calibStr}`, 10, 18);

        // Arrow (planeDir). dir is normalized in image space: x right, y down (far tends to negative y).
        const cx = 120, cy = 48;
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI*2);
        ctx.stroke();

        if(dir && isFinite(dir.x) && isFinite(dir.y)){
          const scale = 28;
          const ex = cx + dir.x * scale;
          const ey = cy + dir.y * scale;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(ex, ey);
          ctx.stroke();

          // Arrow head
          const ang = Math.atan2(ey-cy, ex-cx);
          const ah = 7;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - ah*Math.cos(ang - 0.6), ey - ah*Math.sin(ang - 0.6));
          ctx.lineTo(ex - ah*Math.cos(ang + 0.6), ey - ah*Math.sin(ang + 0.6));
          ctx.closePath();
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.fill();

          ctx.fillStyle = "rgba(255,255,255,0.75)";
          ctx.fillText(`dir=(${dir.x.toFixed(2)}, ${dir.y.toFixed(2)})`, 10, 66);
        }else{
          ctx.fillStyle = "rgba(255,255,255,0.65)";
          ctx.fillText("dir=(n/a)", 10, 66);
        }
      }

      if(aiDepthThumb){
        const ctx2 = aiDepthThumb.getContext("2d");
        const W2 = aiDepthThumb.width|0, H2 = aiDepthThumb.height|0;
        ctx2.clearRect(0,0,W2,H2);
        if(a.depthMap && a.depthMap.canvas){
          try{ ctx2.drawImage(a.depthMap.canvas, 0, 0, W2, H2); }catch(_){}
        }
      }
    }

    // URL flags
    try{
      const qs = new URLSearchParams(location.search);
      if(qs.get("aidebug")==="1"){ setAiDebugOverlayEnabled(true); }
      if(qs.get("debugMetrics")==="1"){
        // Dev-only near-metric overlay (B2). Does not affect rendering.
        window.__PP_DEBUG_METRICS = true;
        setAiDebugOverlayEnabled(true);
      }
      // PhotoFit mode: ?photofit=legacy (per-pixel) or default global exposure
      const pf = qs.get('photofit');
      if(pf==='legacy'){ window.__PP_PHOTOFIT_MODE = 'legacy'; }
      else if(pf==='global'){ window.__PP_PHOTOFIT_MODE = 'global'; }
      else { window.__PP_PHOTOFIT_MODE = 'global'; }

      // GGX specular (Ultra/PBR): enabled by default.
      // Use ?ggx=0 to force-disable (fallback to legacy spec), or ?ggx=1 to force-enable.
      const ggx = qs.get('ggx');
      if(ggx === '0'){ window.__PP_GGX = 0; }
      else if(ggx === '1'){ window.__PP_GGX = 1; }
      else { window.__PP_GGX = 1; }

      // Stochastic tiling (Ultra-only): breaks visible repetition by applying a large-scale random phase/rotation per super-tile.
      // Default is OFF (safe). Enable with ?stoch=1. Optional: ?stochTier=low|mid|high, ?stochRot=1.
      const st = qs.get('stoch');
      if(st === '1'){ window.__PP_STOCH = 1; }
      else { window.__PP_STOCH = 0; }
      const stTier = qs.get('stochTier');
      if(stTier === 'low' || stTier === 'mid' || stTier === 'high'){ window.__PP_STOCH_TIER = stTier; }
      const stRot = qs.get('stochRot');
      if(stRot === '1'){ window.__PP_STOCH_ROT = 1; }
      else if(stRot === '0'){ window.__PP_STOCH_ROT = 0; }

      // Micro-variation (Ultra-only): subtle per-tile variations to reduce "wallpaper" look.
      // Default: AUTO (enabled when stochastic tiling is enabled). Override: ?micro=0 or ?micro=1.
      const micro = qs.get('micro');
      if(micro === '0'){ window.__PP_MICRO = 0; }
      else if(micro === '1'){ window.__PP_MICRO = 1; }
      // Optional tuning (safe ranges): ?microAlbedo=0.035&microRough=0.06&microSpec=0.04
      const mA = qs.get('microAlbedo');
      const mR = qs.get('microRough');
      const mS = qs.get('microSpec');
      if(mA !== null && mA !== ''){ const v = parseFloat(mA); if(isFinite(v)) window.__PP_MICRO_A = v; }
      if(mR !== null && mR !== ''){ const v = parseFloat(mR); if(isFinite(v)) window.__PP_MICRO_R = v; }
      if(mS !== null && mS !== ''){ const v = parseFloat(mS); if(isFinite(v)) window.__PP_MICRO_S = v; }

      // Stochastic Level B (3-tap blend) control. Intended for desktop/high tier only.
      // Default is AUTO (enabled on desktop when stochTier=high).
      // Force-enable: ?stoch3=1, force-disable: ?stoch3=0.
      const st3 = qs.get('stoch3');
      if(st3 === '1'){ window.__PP_STOCH_3TAP = 1; }
      else if(st3 === '0'){ window.__PP_STOCH_3TAP = 0; }

    }catch(_){}

    // Dev-only near-metric overlay loop (B2).
    function drawNearMetricOverlay(){
      try{
        if(!window.__PP_DEBUG_METRICS) return;
        const C = window.PhotoPaveCompositor;
        if(!C || typeof C.getDebugMetrics!=="function") return;
        const data = C.getDebugMetrics();
        if(!data) return;

        const cv = document.getElementById("aiDebugCanvas");
        if(!cv) return;
        const ctx = cv.getContext("2d");
        if(!ctx) return;

        // Clear with a translucent dark background for readability.
        ctx.clearRect(0,0,cv.width,cv.height);
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(0,0,cv.width,cv.height);

        ctx.fillStyle = "#fff";
        ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx.textBaseline = "top";

        const m = data.metrics;
        const a = (m && m.anchors) ? m.anchors : [];
        const fmt = (v)=> (isFinite(v) ? v.toFixed(2) : "—");
        const fmt1 = (v)=> (isFinite(v) ? v.toFixed(1) : "—");

        const rL = a[0], rC = a[1], rR = a[2];
        // Show symmetric anisotropy (max(rho,1/rho)), which correlates better with perceived "squash".
        const anLine  = `an  L:${fmt(rL?.anis)}  C:${fmt(rC?.anis)}  R:${fmt(rR?.anis)} |w:${fmt(m?.worst?.anis)}`;
        const shLine  = `sh° L:${fmt1(rL?.shearDeg)} C:${fmt1(rC?.shearDeg)} R:${fmt1(rR?.shearDeg)} |w:${fmt1(m?.worst?.shearDeg)}`;
        const h = data.horizon || {};
        const p = data.perspective || {};
        const g = data.guard || {};

        const pitchDesDeg = (isFinite(h.pitchDes) ? (h.pitchDes*57.2958) : 0);
        const pitchEffDeg = (isFinite(h.pitchEff) ? (h.pitchEff*57.2958) : pitchDesDeg);
        const distDes = isFinite(p.distDes) ? p.distDes : (isFinite(p.distScale) ? p.distScale : NaN);
        const distEff = isFinite(p.distEff) ? p.distEff : distDes;

        const flatK = (isFinite(g.flattenKEff) ? g.flattenKEff : (isFinite(g.flattenK) ? g.flattenK : NaN));
        const meta = `pW:${fmt(h.pitchW)} p°:${fmt1(pitchEffDeg)} d:${fmt(distEff)} st:${g.stage||'—'} k:${fmt(flatK)}`;

        ctx.fillText("Near metrics (tile basis)", 6, 4);
        ctx.fillText(anLine, 6, 20);
        ctx.fillText(shLine, 6, 34);
        ctx.fillText(meta, 6, 50);
      }catch(_){}
    }

    // When enabled, update overlay at a low rate (requestAnimationFrame).
    (function overlayLoop(){
      if(window.__PP_DEBUG_METRICS){
        drawNearMetricOverlay();
        requestAnimationFrame(overlayLoop);
      }
    })();

    window.addEventListener("ai:ready", drawAiDebugOverlay);
    window.addEventListener("ai:depthReady", drawAiDebugOverlay);
    window.addEventListener("ai:status", drawAiDebugOverlay);
    window.addEventListener("ai:error", drawAiDebugOverlay);

    // Ctrl+Shift+D toggles debug overlay
    window.addEventListener("keydown",(e)=>{
      if(e.ctrlKey && e.shiftKey && (e.key==="D" || e.key==="d")){
        setAiDebugOverlayEnabled(!(state.ai && state.ai.debugOverlay));
        e.preventDefault();
      }
    });

    // Horizontal wheel scrolling for the shapes strip (keep orientation horizontal, allow mouse wheel).
    const shapesStrip = document.getElementById("shapesList");
    if(shapesStrip){
      shapesStrip.addEventListener("wheel", (e)=>{
        // Only translate vertical wheel to horizontal scroll when user is not already doing horizontal.
        const dy = e.deltaY || 0;
        const dx = e.deltaX || 0;
        if(Math.abs(dy) > Math.abs(dx)){
          shapesStrip.scrollLeft += dy;
          e.preventDefault();
        }
      }, { passive:false });
    }

    // Recompute adaptive shape thumbnail sizing on resize (iframe layouts can clip the bottom bar).
    window.addEventListener("resize", ()=>{
      requestAnimationFrame(fitShapesToBottomMenu);
      requestAnimationFrame(fitLeftTexturesPanelForThree);
    });

    el("modePhoto").addEventListener("click",()=>{setActiveStep("photo");ED.setMode("photo");syncCloseButtonUI();});
    const btnPlane=el("modePlane");
    if(btnPlane){btnPlane.addEventListener("click",()=>{setActiveStep("zones");ED.setMode("contour");syncCloseButtonUI();});}
    el("modeContour").addEventListener("click",()=>{setActiveStep("zones");ED.setMode("contour");syncCloseButtonUI();});
    el("modeCutout").addEventListener("click",()=>{setActiveStep("cutouts");ED.setMode("cutout");syncCloseButtonUI();});
    // "Просмотр" is a quick clean preview: it also hides the contour overlay automatically.
    el("modeView").addEventListener("click",()=>{
      setActiveStep("export");
      // Auto-hide contour on entering view so user sees the pure material render.
      state.ui.showContour = false;
      updateContourToggleBtn();
      ED.setMode("view");
      ED.render();
      syncCloseButtonUI();
    });

    // Fullscreen viewer: opens a clean preview using the existing canvases (no snapshot/CORS risk).
    const canvasWrap = document.getElementById("canvasWrap");
    const btnFs = document.getElementById("openFullscreenBtn");
    const btnFsClose = document.getElementById("fullscreenCloseBtn");
    const btnFsDl = document.getElementById("fullscreenDownloadBtn");
    // NOTE: We intentionally keep the fullscreen viewer UI minimal.
    // It always opens with a smart-fit transform (no "remember" mode).

    const VIEWER_MIN_ZOOM = 0.25;
    const VIEWER_MAX_ZOOM = 4.0;

    // Fullscreen viewer gestures: pan/zoom (touch + mouse) without touching render pipeline.
    // Implemented by CSS variables on canvasWrap (used in css transform for canvases).
    let _viewerZoom = 1.0;
    let _viewerPanX = 0.0;
    let _viewerPanY = 0.0;
    let _viewerBaseW = 0.0; // canvas visual size at zoom=1 in px
    let _viewerBaseH = 0.0;
    let _viewerUiHideT = 0;

    function _viewerIsOn(){
      return !!(canvasWrap && canvasWrap.classList.contains("isFullscreen"));
    }

    function _viewerSetVars(){
      if(!canvasWrap) return;
      canvasWrap.style.setProperty("--viewer-zoom", String(_viewerZoom));
      canvasWrap.style.setProperty("--viewer-pan-x", `${_viewerPanX}px`);
      canvasWrap.style.setProperty("--viewer-pan-y", `${_viewerPanY}px`);
    }

    function _viewerMeasureBase(){
      if(!canvasWrap) return;
      // Measure current canvas visual size at zoom=1 (we only call this when zoom=1 in fullscreen entry).
      const gl = document.getElementById("glCanvas");
      if(gl){
        const r = gl.getBoundingClientRect();
        _viewerBaseW = Math.max(1, r.width);
        _viewerBaseH = Math.max(1, r.height);
      }
    }

    function _viewerMeasureBaseDynamic(){
      if(!canvasWrap) return;
      const gl = document.getElementById("glCanvas");
      if(gl){
        const r = gl.getBoundingClientRect();
        const z = Math.max(1e-6, _viewerZoom || 1);
        _viewerBaseW = Math.max(1, r.width / z);
        _viewerBaseH = Math.max(1, r.height / z);
      }
    }

    function _viewerComputeFitZoom(){
      if(!canvasWrap) return 1.0;
      // Base size is measured at zoom=1.
      _viewerMeasureBase();
      const vw = Math.max(1, canvasWrap.clientWidth);
      const vh = Math.max(1, canvasWrap.clientHeight);
      const zFit = Math.min(vw / Math.max(1, _viewerBaseW), vh / Math.max(1, _viewerBaseH)) * 0.98;
      // Do not upscale by default; only downscale to fit.
      return Math.max(VIEWER_MIN_ZOOM, Math.min(1.0, zFit));
    }

    function _viewerApplyFit(){
      _viewerZoom = _viewerComputeFitZoom();
      _viewerPanX = 0.0;
      _viewerPanY = 0.0;
      _viewerClampPan();
      _viewerSetVars();
    }

    // (No "1:1" / "remember" actions in minimal viewer UI.)

    function _viewerClampPan(){
      if(!canvasWrap) return;
      const vw = canvasWrap.clientWidth || 1;
      const vh = canvasWrap.clientHeight || 1;
      const cw = (_viewerBaseW || vw) * _viewerZoom;
      const ch = (_viewerBaseH || vh) * _viewerZoom;
      const maxX = Math.max(0, (cw - vw) * 0.5);
      const maxY = Math.max(0, (ch - vh) * 0.5);
      if(_viewerPanX > maxX) _viewerPanX = maxX;
      if(_viewerPanX < -maxX) _viewerPanX = -maxX;
      if(_viewerPanY > maxY) _viewerPanY = maxY;
      if(_viewerPanY < -maxY) _viewerPanY = -maxY;
    }

    function _viewerZoomAt(newZoom, clientX, clientY){
      if(!canvasWrap) return;
      newZoom = Math.max(VIEWER_MIN_ZOOM, Math.min(VIEWER_MAX_ZOOM, newZoom));
      const oldZoom = _viewerZoom || 1.0;
      if(Math.abs(newZoom - oldZoom) < 1e-6) return;

      const rect = canvasWrap.getBoundingClientRect();
      const qx = (clientX - rect.left);
      const qy = (clientY - rect.top);
      const vcx = rect.width * 0.5;
      const vcy = rect.height * 0.5;

      // Keep screen point (qx,qy) stable while changing zoom (pan in screen px).
      const k = newZoom / oldZoom;
      _viewerPanX = (1 - k) * (qx - vcx - _viewerPanX) + _viewerPanX;
      _viewerPanY = (1 - k) * (qy - vcy - _viewerPanY) + _viewerPanY;

      _viewerZoom = newZoom;
      _viewerClampPan();
      _viewerSetVars();
    }

    function _viewerShowUi(){
      if(!canvasWrap) return;
      canvasWrap.classList.remove("viewerUiHidden");
      if(_viewerUiHideT) clearTimeout(_viewerUiHideT);
      _viewerUiHideT = window.setTimeout(()=>{
        if(_viewerIsOn()) canvasWrap.classList.add("viewerUiHidden");
      }, 2000);
    }

    function _enterFullscreenViewer(){
      if(!canvasWrap) return;
      // Ensure we are in clean preview mode (same semantics as pressing "Просмотр").
      try{ el("modeView").click(); }catch(_){ /* ignore */ }

      // Robust scroll-lock (esp. iOS Safari). Prevents the page from scrolling while the viewer is open.
      // This also avoids cases where 100vh exceeds the visual viewport and the user needs to scroll to see the whole photo.
      if(!_enterFullscreenViewer._scrollLocked){
        _enterFullscreenViewer._scrollLocked = true;
        _enterFullscreenViewer._scrollY = (window.scrollY || window.pageYOffset || 0);
        document.documentElement.classList.add("isFullscreenViewer");
        document.body.style.position = "fixed";
        document.body.style.top = (-_enterFullscreenViewer._scrollY) + "px";
        document.body.style.left = "0";
        document.body.style.right = "0";
        document.body.style.width = "100%";
      }

      document.body.classList.add("isFullscreenViewer");
      canvasWrap.classList.add("isFullscreen");

      // Recompute canvas layout for the fullscreen viewport (otherwise the photo can stay at the old panel size).
      try{ ED.resize(); }catch(_){ }

      // Reset viewer transform state before measuring fit.
      _viewerZoom = 1.0;
      _viewerPanX = 0.0;
      _viewerPanY = 0.0;
      canvasWrap.classList.remove("viewerUiHidden");
      _viewerSetVars();
      _viewerShowUi();

      // Measure base size after layout settles, then apply smart-fit.
      requestAnimationFrame(()=>{
        if(!_viewerIsOn()) return;
        try{ ED.resize(); }catch(_){ }
        _viewerMeasureBase();
        _viewerApplyFit();
      });

      // NOTE: We intentionally do NOT call requestFullscreen() here.
      // In many deployments (iframes / strict permissions policy) it is blocked and logs noisy violations.
      // Our CSS pseudo-fullscreen is sufficient and works consistently across browsers.
    }
    function _exitFullscreenViewer(){
      if(!canvasWrap) return;
      try{
        if(document.fullscreenElement){
          document.exitFullscreen().catch(()=>{});
        }
      }catch(_){ }
      canvasWrap.classList.remove("isFullscreen");
      document.body.classList.remove("isFullscreenViewer");

      // Restore scroll position and unlock scrolling.
      if(_enterFullscreenViewer._scrollLocked){
        const y = _enterFullscreenViewer._scrollY || 0;
        _enterFullscreenViewer._scrollLocked = false;
        _enterFullscreenViewer._scrollY = 0;
        document.body.style.position = "";
        document.body.style.top = "";
        document.body.style.left = "";
        document.body.style.right = "";
        document.body.style.width = "";
        document.documentElement.classList.remove("isFullscreenViewer");
        try{ window.scrollTo(0, y); }catch(_){ }
      }

      // Restore canvas layout to the normal UI viewport.
      try{ ED.resize(); }catch(_){ }

      // Clear viewer transform.
      canvasWrap.classList.remove("viewerUiHidden");
      if(_viewerUiHideT) clearTimeout(_viewerUiHideT);
      _viewerUiHideT = 0;
      _viewerZoom = 1.0;
      _viewerPanX = 0.0;
      _viewerPanY = 0.0;
      _viewerSetVars();
    }

    // Gesture handlers (registered once; they are no-ops unless fullscreen viewer is active).
    const _vp = new Map(); // pointerId -> {x,y,t0, moved}
    let _drag = null; // {sx,sy,panX,panY}
    let _pinch = null; // {dist, zoom, panX, panY}
    let _lastTap = { t:0, x:0, y:0 };

    function _getTwoPointers(){
      const arr = Array.from(_vp.values());
      if(arr.length < 2) return null;
      return [arr[0], arr[1]];
    }
    function _dist(a,b){
      const dx = (a.x - b.x);
      const dy = (a.y - b.y);
      return Math.sqrt(dx*dx + dy*dy);
    }
    function _mid(a,b){
      return { x:(a.x+b.x)*0.5, y:(a.y+b.y)*0.5 };
    }

    function _toggleUi(){
      if(!canvasWrap) return;
      if(canvasWrap.classList.contains("viewerUiHidden")){
        _viewerShowUi();
      }else{
        canvasWrap.classList.add("viewerUiHidden");
        if(_viewerUiHideT) clearTimeout(_viewerUiHideT);
        _viewerUiHideT = 0;
      }
    }

    function _toggleZoomAt(clientX, clientY){
      const target = (_viewerZoom > 1.05) ? 1.0 : 2.0;
      if(target === 1.0){
        _viewerZoom = 1.0;
        _viewerPanX = 0.0;
        _viewerPanY = 0.0;
        _viewerSetVars();
        return;
      }
      _viewerZoomAt(target, clientX, clientY);
    }

    if(canvasWrap){
      canvasWrap.addEventListener("wheel", (e)=>{
        if(!_viewerIsOn()) return;
        // Let UI controls receive native events.
        if(e.target && e.target.closest && e.target.closest('.fullscreenTopbar')) return;
        _viewerShowUi();
        // Trackpad/mouse wheel zoom. Use exponential scaling for smoothness.
        const dy = (e.deltaY || 0);
        const factor = Math.exp(-dy * 0.0015);
        const nz = _viewerZoom * factor;
        _viewerZoomAt(nz, e.clientX, e.clientY);
        e.preventDefault();
      }, { passive:false });

      canvasWrap.addEventListener("dblclick", (e)=>{
        if(!_viewerIsOn()) return;
        if(e.target && e.target.closest && e.target.closest('.fullscreenTopbar')) return;
        _viewerShowUi();
        _toggleZoomAt(e.clientX, e.clientY);
        e.preventDefault();
      });

      canvasWrap.addEventListener("pointerdown", (e)=>{
        if(!_viewerIsOn()) return;
        if(e.target && e.target.closest && e.target.closest('.fullscreenTopbar')) return;
        _viewerShowUi();
        try{ canvasWrap.setPointerCapture(e.pointerId); }catch(_){ }
        _vp.set(e.pointerId, { x:e.clientX, y:e.clientY, t0: (e.timeStamp||Date.now()), moved:false });

        if(_vp.size === 1){
          _drag = { sx:e.clientX, sy:e.clientY, panX:_viewerPanX, panY:_viewerPanY };
          _pinch = null;
        }else if(_vp.size === 2){
          const tp = _getTwoPointers();
          if(tp){
            const d = _dist(tp[0], tp[1]);
            _pinch = { dist: Math.max(1e-6, d), zoom: _viewerZoom, panX: _viewerPanX, panY: _viewerPanY };
            _drag = null;
          }
        }
        e.preventDefault();
      }, { passive:false });

      canvasWrap.addEventListener("pointermove", (e)=>{
        if(!_viewerIsOn()) return;
        if(e.target && e.target.closest && e.target.closest('.fullscreenTopbar')) return;
        const p = _vp.get(e.pointerId);
        if(!p) return;
        const dxm = e.clientX - p.x;
        const dym = e.clientY - p.y;
        if((dxm*dxm + dym*dym) > 100) p.moved = true; // >10px
        p.x = e.clientX; p.y = e.clientY;
        _vp.set(e.pointerId, p);

        if(_pinch && _vp.size >= 2){
          const tp = _getTwoPointers();
          if(tp){
            const d = _dist(tp[0], tp[1]);
            const center = _mid(tp[0], tp[1]);
            const newZoom = Math.max(VIEWER_MIN_ZOOM, Math.min(VIEWER_MAX_ZOOM, _pinch.zoom * (d / _pinch.dist)));

            const rect = canvasWrap.getBoundingClientRect();
            const qx = (center.x - rect.left);
            const qy = (center.y - rect.top);
            const vcx = rect.width * 0.5;
            const vcy = rect.height * 0.5;
            const k = newZoom / (_pinch.zoom || 1.0);

            _viewerZoom = newZoom;
            _viewerPanX = k * (_pinch.panX || 0.0) + (1 - k) * (qx - vcx);
            _viewerPanY = k * (_pinch.panY || 0.0) + (1 - k) * (qy - vcy);
            _viewerClampPan();
            _viewerSetVars();
          }
          e.preventDefault();
          return;
        }

        if(_drag && _vp.size === 1 && _viewerZoom > 1.01){
          _viewerPanX = _drag.panX + (e.clientX - _drag.sx);
          _viewerPanY = _drag.panY + (e.clientY - _drag.sy);
          _viewerClampPan();
          _viewerSetVars();
          e.preventDefault();
        }
      }, { passive:false });

      function _onPointerUpLike(e){
        if(!_viewerIsOn()) return;
        if(e.target && e.target.closest && e.target.closest('.fullscreenTopbar')) return;
        const p = _vp.get(e.pointerId);
        _vp.delete(e.pointerId);
        if(_vp.size < 2) _pinch = null;
        if(_vp.size === 0) _drag = null;

        // Tap / double-tap (touch): tap toggles UI, double tap toggles 2x zoom.
        if(p && (e.pointerType === "touch" || e.pointerType === "pen")){
          const dt = (e.timeStamp||Date.now()) - (p.t0||0);
          if(!p.moved && dt < 260){
            const now = (e.timeStamp||Date.now());
            const ddx = (e.clientX - _lastTap.x);
            const ddy = (e.clientY - _lastTap.y);
            const near = (ddx*ddx + ddy*ddy) < (30*30);
            if(now - _lastTap.t < 320 && near){
              _lastTap.t = 0;
              _toggleZoomAt(e.clientX, e.clientY);
            }else{
              _lastTap = { t: now, x: e.clientX, y: e.clientY };
              _toggleUi();
            }
          }
        }
      }

      canvasWrap.addEventListener("pointerup", _onPointerUpLike);
      canvasWrap.addEventListener("pointercancel", _onPointerUpLike);

      // Keep pan limits sane on resize/orientation changes.
      window.addEventListener("resize", ()=>{
        if(!_viewerIsOn()) return;
        _viewerMeasureBaseDynamic();
        _viewerClampPan();
        _viewerSetVars();
      });
    }

    if(btnFs){
      btnFs.addEventListener("click", (e)=>{
        e.preventDefault();
        _enterFullscreenViewer();
      });
    }
    if(btnFsClose){
      btnFsClose.addEventListener("click", (e)=>{
        e.preventDefault();
        _exitFullscreenViewer();
      });
    }
    if(btnFsDl){
      btnFsDl.addEventListener("click", (e)=>{
        e.preventDefault();
        // Do not swallow errors: exportPNG already reports status to the user.
        ED.exportPNG();
        _viewerShowUi();
      });
    }

    // Keep CSS state in sync with Fullscreen API exit (Esc/F11 etc.)
    document.addEventListener("fullscreenchange", ()=>{
      if(!document.fullscreenElement){
        // If user exited real fullscreen, keep the viewer open in CSS fullscreen?
        // UX: exit the viewer entirely (simple + predictable).
        if(canvasWrap && canvasWrap.classList.contains("isFullscreen")){
          _exitFullscreenViewer();
        }
      }
    });

    // Escape closes CSS viewer even when Fullscreen API isn't active.
    window.addEventListener("keydown", (e)=>{
      if(e.key === "Escape"){
        if(canvasWrap && canvasWrap.classList.contains("isFullscreen")){
          _exitFullscreenViewer();
        }
      }
    });

    el("undoBtn").addEventListener("click",()=>{if(undo()){normalizeAllZones();ED.render();renderZonesUI();renderShapesUI();renderTexturesUI();syncSettingsUI();}});
    el("redoBtn").addEventListener("click",()=>{if(redo()){normalizeAllZones();ED.render();renderZonesUI();renderShapesUI();renderTexturesUI();syncSettingsUI();}});
    window.addEventListener("keydown",(e)=>{
      if(e.ctrlKey&&e.key.toLowerCase()==="z"){if(undo()){normalizeAllZones();ED.render();renderZonesUI();renderShapesUI();renderTexturesUI();syncSettingsUI();}e.preventDefault();}
      if(e.ctrlKey&&(e.key.toLowerCase()==="y"||(e.shiftKey&&e.key.toLowerCase()==="z"))){if(redo()){normalizeAllZones();ED.render();renderZonesUI();renderShapesUI();renderTexturesUI();syncSettingsUI();}e.preventDefault();}
    });

    const btnResetPlane=el("resetPlaneBtn");
    // Reset active zone contour/cutouts and also drop any 3D-calibration influence.
    // Important UX: after reset user must be able to re-draw the contour on the same photo.
    el("resetZoneBtn").addEventListener("click",()=>{
      const z=S.getActiveZone();
      if(!z) return;
      pushHistory();

      // 1) Clear geometry
      z.contour=[];
      z.closed=false;
      z.cutouts=[];
      state.ui.activeCutoutId=null;

      // 2) Reset per-zone perspective params that could have been auto-applied by 3D calibration.
      // Keep the rest of the material settings intact (texture/scale/rotation/etc.).
      if(z.material){
        if(z.material.params_base){
          if(typeof z.material.params_base.horizon === "number") z.material.params_base.horizon = 0.0;
          if(typeof z.material.params_base.perspective === "number") z.material.params_base.perspective = 0.75;
        }
        if(z.material.params_ultra){
          if(typeof z.material.params_ultra.horizon === "number") z.material.params_ultra.horizon = 0.0;
          if(typeof z.material.params_ultra.perspective === "number") z.material.params_ultra.perspective = 0.75;
        }
        // Also clear "manual tuned" flags so future auto-calibration isn't suppressed.
        z.material._ultraTuned = {horizon:false, perspective:false};
      }

      // 3) Reset global 3D-calibration state (lines/result/errors) — it is tied to the photo+zone.
      try{ if(typeof _resetCalib3D === "function") _resetCalib3D(); }catch(_){ }

      // 4) Ensure editor is in contour mode so user can immediately re-draw.
      setActiveStep("zones");
      ED.setMode("contour");

      // 4b) After reset, re-arm UI interaction state for building a NEW contour.
      // If the user previously hid the contour overlay while tuning materials,
      // they would otherwise see "nothing happens" when placing points.
      state.ui = state.ui || {};
      state.ui.showContour = true;
      state.ui.selectedPoint = null;
      state.ui.draggingPoint = null;
      state.ui.isPointerDown = false;
      updateContourToggleBtn();

      syncCloseButtonUI();
      renderZonesUI();
      ED.render();
    });

    const closeBtn=el("closePolyBtn");
    if(closeBtn){
      closeBtn.addEventListener("click",()=>{
        const z=S.getActiveZone();
        if(!z) return;
        // Explicit close helps on mobile, where tapping the first point may be finicky.
        if(state.ui.mode==="split"){
          const d = state.ui && state.ui.splitDraft;
          if(!d || d.closed || (d.points||[]).length<3) return;
          pushHistory();
          d.closed = true;
          try{ window.dispatchEvent(new Event("pp:splitClosed")); }catch(_){ }
          return;
        }
        if(state.ui.mode==="cutout"){
          const c=S.getActiveCutout(z);
          if(!c || c.closed || (c.polygon||[]).length<3) return;
          pushHistory();
          c.closed=true;
        }else{
          if(z.closed || (z.contour||[]).length<3) return;
          pushHistory();
          z.closed=true;
        }
        renderZonesUI();
        ED.render();
      });
    }

    el("photoInput").addEventListener("change",(e)=>handlePhotoFile(e.target.files[0]));
    el("replacePhotoBtn").addEventListener("click",()=>el("photoInput").click());
    const ovBtn=document.getElementById("uploadOverlayBtn");
    if(ovBtn){ovBtn.addEventListener("click",()=>el("photoInput").click());}
    const cw=document.getElementById("canvasWrap");
    if(cw){
      cw.addEventListener("dragover",(e)=>{e.preventDefault();e.dataTransfer.dropEffect="copy";});
      cw.addEventListener("drop",(e)=>{e.preventDefault();const f=e.dataTransfer.files&&e.dataTransfer.files[0];if(f)handlePhotoFile(f);});
    }

        el("resetProjectBtn").addEventListener("click",()=>{
      pushHistory();
      state.assets.photoBitmap=null;state.assets.photoW=0;state.assets.photoH=0;
      state.zones=[];state.ui.activeZoneId=null;state.ui.activeCutoutId=null;
      ensureActiveZone();renderZonesUI();ED.render();
      setActiveStep("photo");ED.setMode("photo");
      syncCloseButtonUI();
    });

    el("addZoneBtn").addEventListener("click",()=>{ addZoneAndArmContour(); });

    const splitBtn = document.getElementById("splitZoneBtn");
    if(splitBtn){
      splitBtn.addEventListener("click",()=>{ startOrCancelSplit(); });
    }

    // Listen for split draft completion from the editor.
    window.addEventListener("pp:splitClosed",()=>{
      // Apply only if we are in split mode and there is a draft.
      try{
        if(state.ui && state.ui.mode==="split" && state.ui.splitDraft && state.ui.splitDraft.closed){
          applySplitDraft();
        }
      }catch(e){ console.warn(e); }
    });
    el("dupZoneBtn").addEventListener("click",()=>{
      const z=S.getActiveZone();if(!z)return;pushHistory();
      const copy=JSON.parse(JSON.stringify(z));
      copy.id=S.uid("zone");copy.name=z.name+" (копия)";
      copy.cutouts=(copy.cutouts||[]).map((c,i)=>({...c,id:S.uid("cut"),name:c.name||("Вырез "+(i+1))}));
      state.zones.push(copy);state.ui.activeZoneId=copy.id;state.ui.activeCutoutId=copy.cutouts[0]?.id||null;
      renderZonesUI();syncSettingsUI();ED.render();
    });
    el("delZoneBtn").addEventListener("click",()=>{
      if(state.zones.length<=1)return;
      const id=state.ui.activeZoneId;if(!id)return;pushHistory();
      state.zones=state.zones.filter(z=>z.id!==id);
      state.ui.activeZoneId=state.zones[0]?.id||null;
      state.ui.activeCutoutId=state.zones[0]?.cutouts?.[0]?.id||null;
      renderZonesUI();syncSettingsUI();ED.render();
    });

    el("addCutoutBtn").addEventListener("click",()=>{
      const z=S.getActiveZone();if(!z)return;pushHistory();
      const c=makeCutout((z.cutouts.length+1));z.cutouts.push(c);state.ui.activeCutoutId=c.id;
      renderZonesUI();setActiveStep("cutouts");ED.setMode("cutout");
      syncCloseButtonUI();
    });
    el("delCutoutBtn").addEventListener("click",()=>{
      const z=S.getActiveZone();if(!z)return;const cid=state.ui.activeCutoutId;if(!cid)return;pushHistory();
      z.cutouts=z.cutouts.filter(c=>c.id!==cid);state.ui.activeCutoutId=z.cutouts[0]?.id||null;
      renderZonesUI();ED.render();
    });

	el("scaleRange").addEventListener("input",()=>{
		const z=S.getActiveZone(); if(!z) return;
		const sr = el("scaleRange");
		let v = parseFloat(sr.value);
		const mn = parseFloat(sr.min||"0");
		const mx = parseFloat(sr.max||"9999");
		if(isFinite(mn) && isFinite(mx)){
			v = Math.min(mx, Math.max(mn, v));
			sr.value = String(v);
		}
		applyChangeToTiling({scale:v});
		ED.render();
	});
    el("rotRange").addEventListener("input",()=>{const z=S.getActiveZone();if(!z)return;applyChangeToTiling({rotation:parseFloat(el("rotRange").value)});ED.render();});
    const offU = el("offsetURange");
    if(offU){
      offU.addEventListener("input",()=>{const z=S.getActiveZone();if(!z)return;applyChangeToTiling({offsetU:parseFloat(el("offsetURange").value)});ED.render();});
    }
    const offV = el("offsetVRange");
    if(offV){
      offV.addEventListener("input",()=>{const z=S.getActiveZone();if(!z)return;applyChangeToTiling({offsetV:parseFloat(el("offsetVRange").value)});ED.render();});
    }
    el("opacityRange").addEventListener("input",()=>{const z=S.getActiveZone();if(!z)return;applyChangeToTiling({opacity:parseFloat(el("opacityRange").value)});ED.render();});
    const oc=el("opaqueFillChk");
    if(oc){
      oc.addEventListener("change",()=>{
        const z=S.getActiveZone(); if(!z) return;
		applyChangeToTiling({opaqueFill:!!oc.checked});
        const bs=el("blendSelect");
        if(bs){
          bs.disabled=oc.checked;
          if(oc.checked){
            bs.value="source-over";
				applyChangeToTiling({blendMode:"source-over"});
          }
        }
        ED.render();
      });
    }
el("blendSelect").addEventListener("change",()=>{const z=S.getActiveZone();if(!z)return;applyChangeToTiling({blendMode:el("blendSelect").value});ED.render();});

    
    el("perspectiveRange").addEventListener("input",()=>{
      const z=S.getActiveZone();if(!z)return;
      applyChangeToTiling({perspective:parseFloat(el("perspectiveRange").value)});
      ED.render();
    });
    el("horizonRange").addEventListener("input",()=>{
      const z=S.getActiveZone();if(!z)return;
      const uiVal = parseFloat(el("horizonRange").value);
      applyChangeToTiling({horizon: uiToHorizon(uiVal)});
      ED.render();
    });
el("exportPngBtn").addEventListener("click",()=>ED.exportPNG());
    el("copySummaryBtn").addEventListener("click",async ()=>{const t=makeSummaryText();await navigator.clipboard.writeText(t).catch(()=>{});API.setStatus("Описание скопировано");});
    el("waBtn").addEventListener("click",()=>openMessenger("wa"));
    el("tgBtn").addEventListener("click",()=>openMessenger("tg"));
    el("shareBtn").addEventListener("click",()=>share());
  }

  // Ultra (ONNX/CV) loading indicator under the photo (next to "Формы").
  // This is intentionally UX-only: it never changes any rendering logic.
  const UltraLoadUI = (function(){
    const box = document.getElementById("ultraLoadBox");
    const txt = document.getElementById("ultraLoadText");
    const fill = document.getElementById("ultraLoadFill");
    if(!box || !txt || !fill) return { start:()=>{}, stop:()=>{}, setProgress:()=>{}, setText:()=>{}, hide:()=>{} };

    const messages = [
      "Загрузка режима ультра‑реализма",
      "Оптимизация компьютерного зрения",
      "Загрузка глубины текстуры",
      "Калибровка автоконтура",
      "Загрузка 3D‑технологий",
      "Сканирование фотографии"
    ];
    let running = false;
    let msgTimer = null;
    let progTimer = null;
    let msgIdx = 0;
    let p = 0;
    let startedAt = 0;

    function _show(){
      box.classList.add("ultraLoad--on");
      box.setAttribute("aria-hidden", "false");
    }
    function hide(){
      running = false;
      if(msgTimer) { clearInterval(msgTimer); msgTimer=null; }
      if(progTimer){ clearInterval(progTimer); progTimer=null; }
      box.classList.remove("ultraLoad--on");
      box.setAttribute("aria-hidden", "true");
    }
    function setProgress(v){
      p = Math.max(0, Math.min(1, +v));
      fill.style.width = Math.round(p*100) + "%";
    }
    function setText(s){
      if(!s) return;
      txt.textContent = s;
    }

    function start(){
      // Avoid flicker on fast connections: once shown, keep at least ~900ms.
      startedAt = performance.now();
      if(running) return;
      running = true;
      msgIdx = 0;
      setText(messages[0]);
      setProgress(Math.max(p, 0.06));
      _show();

      if(msgTimer) clearInterval(msgTimer);
      msgTimer = setInterval(()=>{
        if(!running) return;
        msgIdx = (msgIdx + 1) % messages.length;
        // soft fade between messages
        txt.classList.add("isFading");
        setTimeout(()=>{
          if(!running) return;
          setText(messages[msgIdx]);
          txt.classList.remove("isFading");
        }, 160);
      }, 1350);

      // Pseudo-progress towards 90% while ONNX is downloading/initializing.
      // Real milestones (ai:depthReady/ai:ready) will snap it forward.
      if(progTimer) clearInterval(progTimer);
      progTimer = setInterval(()=>{
        if(!running) return;
        const target = 0.90;
        p = p + (target - p) * 0.018;
        setProgress(p);
      }, 140);
    }

    function stop(ok){
      if(!running) { hide(); return; }
      running = false;
      if(msgTimer) { clearInterval(msgTimer); msgTimer=null; }
      if(progTimer){ clearInterval(progTimer); progTimer=null; }
      setProgress(1);
      const minShownMs = 900;
      const dt = performance.now() - startedAt;
      const delay = Math.max(0, minShownMs - dt);
      setTimeout(()=>{
        if(ok===false){
          setText("Ошибка загрузки режима ультра‑реализма");
          setTimeout(hide, 2200);
          return;
        }
        setText("Готово");
        setTimeout(()=>{ setText("Режим ультра‑реализма загружен"); }, 500);
        setTimeout(hide, 1600);
      }, delay);
    }

    return { start, stop, setProgress, setText, hide };
  })();

  async function bootstrap(){
    setBuildInfo();
    ensureActiveZone();

    ED.init(el("editorCanvas"), el("glCanvas"));
    ED.bindInput();
    bindUI();
    syncCloseButtonUI();
    pushHistory();

    try{
      // Config endpoint may be protected by JWT in production.
      // This photo-editor widget uses public shapes.json and public Object Storage palettes,
      // so we do not require /config here.
      await API.loadShapes();
      renderShapesUI();
      await loadTexturesForActiveShape();
      renderZonesUI();
      updateSplitZoneBtnUI();
      syncSettingsUI();
      await ED.render();
      API.setStatus("Готово");
    }catch(e){
      console.error(e);
      API.setStatus("Ошибка инициализации API (см. консоль)");
      renderZonesUI();
      updateSplitZoneBtnUI();
      await ED.render();
    }
  }

  bootstrap();
})();