
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
  const DEFAULT_MAT_PARAMS={scale:12.0,rotation:0,opacity:1.0,blendMode:"source-over",opaqueFill:true,perspective:0.75,horizon:0.18};

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
      const z=makeZone();state.zones.push(z);state.ui.activeZoneId=z.id;
    }else if(!state.ui.activeZoneId){
      state.ui.activeZoneId=state.zones[0].id;
    }
    // Ensure material params are migrated and mode-pointers are correct.
    normalizeAllZones();
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
    const wrap=el("zonesList");wrap.innerHTML="";
    for(const z of state.zones){
      const div=document.createElement("div");
      div.className="listItem"+(z.id===state.ui.activeZoneId?" listItem--active":"");
      div.innerHTML=`
        <div class="listItem__meta">
          <div class="listItem__title">${escapeHtml(z.name)}</div>
          <div class="listItem__sub">${z.material.textureId?("Материал: "+escapeHtml(z.material.textureId)):"Материал: не выбран"}</div>
        </div>
        <div><label class="badge"><input type="checkbox" ${z.enabled?"checked":""}/> видно</label></div>`;
      div.addEventListener("click",(e)=>{
        if(e.target && e.target.type==="checkbox") return;
        pushHistory();
        state.ui.activeZoneId=z.id;
        state.ui.activeCutoutId=(z.cutouts&&z.cutouts[0])?z.cutouts[0].id:null;
        renderZonesUI();syncSettingsUI();ED.render();
      });
      div.querySelector('input[type="checkbox"]').addEventListener("change",(e)=>{pushHistory();z.enabled=e.target.checked;ED.render();});
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
        const zone=S.getActiveZone();
        if(zone){
          zone.material.shapeId=shapeId;
          zone.material.textureId=null;
          zone.material.textureUrl=null;
          // AUTO_HIDE_CONTOUR_ON_TEXTURE
          try{
            if(zone.closed){
              state.ui = state.ui || {};
              state.ui.showContour = false;
              updateContourToggleBtn();
            }
          }catch(e){}
        }
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
        zone.material.shapeId=shapeId;
        zone.material.textureId=t.textureId;
        zone.material.textureUrl=url; // legacy (albedo)
        // New: keep full maps bundle for PBR (loaded from palette JSON in Object Storage)
        if(t.maps){
          zone.material.maps = {...t.maps};
          if(t.tileSizeM!=null) zone.material.tileSizeM = t.tileSizeM;
        }else{
          zone.material.maps = {albedo:url};
        }
        // Palette-level/material-level parameters (from bucket JSON). Used by PBR shader.
        if(t.params) zone.material.params = {...t.params};
        else zone.material.params = null;
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
    try{ if(prevBitmap && prevBitmap.close) prevBitmap.close(); }catch(_){ }

    state.zones.forEach(z=>{
      z.contour=[];z.closed=false;z.cutouts=[];
      // Patch D: new photo -> reset Ultra manual-tune flags so auto-calibration can help by default.
      if(z && z.material){
        if(z.material._ultraTuned){
          z.material._ultraTuned.horizon = false;
          z.material._ultraTuned.perspective = false;
        }else{
          z.material._ultraTuned = { horizon:false, perspective:false };
        }
      }
    });
    state.ui.activeCutoutId=null;

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
    // Defaults tuned for visibility; users can lower opacity or switch to Multiply.
    el("opacityRange").value=z.material.params.opacity??1.0;
    const oc=el("opaqueFillChk"); if(oc) oc.checked=!!(z.material.params.opaqueFill);
    const bs=el("blendSelect"); if(bs && oc){ bs.disabled=oc.checked; if(oc.checked) bs.value="source-over"; }
    const bs2=el("blendSelect"); if(bs2){ bs2.value = (oc && oc.checked) ? "source-over" : (z.material.params.blendMode??"source-over"); }
    el("perspectiveRange").value=z.material.params.perspective??0.75;
    // Show UI value (shifted/bias-mapped) while keeping internal value stored in material params.
    el("horizonRange").value = horizonToUi(z.material.params.horizon??H_NEUTRAL);
  }

  function syncCloseButtonUI(){
    const btn=el("closePolyBtn");
    if(!btn) return;
    if(state.ui.mode==="cutout") btn.textContent="Замкнуть вырез";
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
        c3.warn = null;
      }else{
        c3.result = prevOk || {ok:false, reason:(res && res.reason) ? String(res.reason) : "calibration_weak", fallback:true};
        c3.status = "ready";
        c3.error = null;
        c3.warn = (res && res.reason) ? String(res.reason) : "calibration_weak";
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
    window.addEventListener("ai:status", renderAiStatus);
    window.addEventListener("ai:ready", renderAiStatus);
    window.addEventListener("ai:error", renderAiStatus);
    window.addEventListener("ai:depthReady", renderAiStatus);
    window.addEventListener("ai:occlusionReady", renderAiStatus);
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
    el("modeView").addEventListener("click",()=>{setActiveStep("export");ED.setMode("view");syncCloseButtonUI();});

    el("undoBtn").addEventListener("click",()=>{if(undo()){normalizeAllZones();ED.render();renderZonesUI();renderShapesUI();renderTexturesUI();syncSettingsUI();}});
    el("redoBtn").addEventListener("click",()=>{if(redo()){normalizeAllZones();ED.render();renderZonesUI();renderShapesUI();renderTexturesUI();syncSettingsUI();}});
    window.addEventListener("keydown",(e)=>{
      if(e.ctrlKey&&e.key.toLowerCase()==="z"){if(undo()){normalizeAllZones();ED.render();renderZonesUI();renderShapesUI();renderTexturesUI();syncSettingsUI();}e.preventDefault();}
      if(e.ctrlKey&&(e.key.toLowerCase()==="y"||(e.shiftKey&&e.key.toLowerCase()==="z"))){if(redo()){normalizeAllZones();ED.render();renderZonesUI();renderShapesUI();renderTexturesUI();syncSettingsUI();}e.preventDefault();}
    });

    const btnResetPlane=el("resetPlaneBtn");
    el("resetZoneBtn").addEventListener("click",()=>{const z=S.getActiveZone();if(!z)return;pushHistory();z.contour=[];z.closed=false;z.cutouts=[];state.ui.activeCutoutId=null;renderZonesUI();ED.render();});

    const closeBtn=el("closePolyBtn");
    if(closeBtn){
      closeBtn.addEventListener("click",()=>{
        const z=S.getActiveZone();
        if(!z) return;
        // Explicit close helps on mobile, where tapping the first point may be finicky.
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

    el("addZoneBtn").addEventListener("click",()=>{pushHistory();const z=makeZone();state.zones.push(z);state.ui.activeZoneId=z.id;state.ui.activeCutoutId=null;renderZonesUI();setActiveStep("zones");ED.setMode("contour");syncCloseButtonUI();});
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
		z.material.params.scale = v;
		ED.render();
	});
    el("rotRange").addEventListener("input",()=>{const z=S.getActiveZone();if(!z)return;z.material.params.rotation=parseFloat(el("rotRange").value);ED.render();});
    el("opacityRange").addEventListener("input",()=>{const z=S.getActiveZone();if(!z)return;z.material.params.opacity=parseFloat(el("opacityRange").value);ED.render();});
    const oc=el("opaqueFillChk");
    if(oc){
      oc.addEventListener("change",()=>{
        const z=S.getActiveZone(); if(!z) return;
        z.material.params.opaqueFill=!!oc.checked;
        const bs=el("blendSelect");
        if(bs){
          bs.disabled=oc.checked;
          if(oc.checked){
            bs.value="source-over";
            z.material.params.blendMode="source-over";
          }
        }
        ED.render();
      });
    }
el("blendSelect").addEventListener("change",()=>{const z=S.getActiveZone();if(!z)return;z.material.params.blendMode=el("blendSelect").value;ED.render();});

    
    el("perspectiveRange").addEventListener("input",()=>{
      const z=S.getActiveZone();if(!z)return;
      z.material.params.perspective=parseFloat(el("perspectiveRange").value);
      // Patch D: user manual tune in Ultra disables auto-calibration overlay for that parameter.
      if(state.ai && state.ai.enabled!==false && z.material && z.material._ultraTuned){
        z.material._ultraTuned.perspective = true;
      }
      ED.render();
    });
    el("horizonRange").addEventListener("input",()=>{
      const z=S.getActiveZone();if(!z)return;
      const uiVal = parseFloat(el("horizonRange").value);
      z.material.params.horizon = uiToHorizon(uiVal);
      // Patch D: user manual tune in Ultra disables auto-calibration overlay for that parameter.
      if(state.ai && state.ai.enabled!==false && z.material && z.material._ultraTuned){
        z.material._ultraTuned.horizon = true;
      }
      ED.render();
    });
el("exportPngBtn").addEventListener("click",()=>ED.exportPNG());
    el("copySummaryBtn").addEventListener("click",async ()=>{const t=makeSummaryText();await navigator.clipboard.writeText(t).catch(()=>{});API.setStatus("Описание скопировано");});
    el("waBtn").addEventListener("click",()=>openMessenger("wa"));
    el("tgBtn").addEventListener("click",()=>openMessenger("tg"));
    el("shareBtn").addEventListener("click",()=>share());
  }

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
      syncSettingsUI();
      await ED.render();
      API.setStatus("Готово");
    }catch(e){
      console.error(e);
      API.setStatus("Ошибка инициализации API (см. консоль)");
      renderZonesUI();
      await ED.render();
    }
  }

  bootstrap();
})();
