
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
  const DEFAULT_MAT_PARAMS={scale:1.0,rotation:0,opacity:1.0,blendMode:"source-over",opaqueFill:true,perspective:0.75,horizon:0.0};
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
        if(zone){zone.material.shapeId=shapeId;zone.material.textureId=null;
    // AUTO_HIDE_CONTOUR_ON_TEXTURE
    try{
      const z = (typeof getActiveZone==="function") ? getActiveZone() : null;
      if(z && z.closed){
        state.ui = state.ui || {};
        state.ui.showContour = false;
        if(typeof updateContourBtn==="function") updateContourBtn();
      }
    }catch(e){}
zone.material.textureUrl=null;}
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
      card.innerHTML=`<div class="thumb">${thumb?`<img src="${thumb}" alt="">`:""}</div><div class="card__label"><span>${escapeHtml(t.title||t.textureId||"")}</span><span class="badge">${escapeHtml(t.textureId||"")}</span></div>`;
      card.addEventListener("click",()=>{
        if(!zone) return;
        pushHistory();
        zone.material.shapeId=shapeId;
        zone.material.textureId=t.textureId;
        zone.material.textureUrl=url;
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
    const bmp=await createImageBitmap(file);
    let w=bmp.width,h=bmp.height;
    let sc=1,longSide=Math.max(w,h);
    if(longSide>maxSide) sc=maxSide/longSide;
    const nw=Math.round(w*sc),nh=Math.round(h*sc);
    const off=document.createElement("canvas");off.width=nw;off.height=nh;
    off.getContext("2d").drawImage(bmp,0,0,nw,nh);
    const resized=await createImageBitmap(off);

    pushHistory();
    state.assets.photoBitmap=resized;state.assets.photoW=nw;state.assets.photoH=nh;
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
    el("scaleRange").value=z.material.params.scale??1.0;
    el("rotRange").value=z.material.params.rotation??0;
    // Defaults tuned for visibility; users can lower opacity or switch to Multiply.
    el("opacityRange").value=z.material.params.opacity??1.0;
    const oc=el("opaqueFillChk"); if(oc) oc.checked=!!(z.material.params.opaqueFill);
    const bs=el("blendSelect"); if(bs && oc){ bs.disabled=oc.checked; if(oc.checked) bs.value="source-over"; }
    const bs2=el("blendSelect"); if(bs2){ bs2.value = (oc && oc.checked) ? "source-over" : (z.material.params.blendMode??"source-over"); }
    el("perspectiveRange").value=z.material.params.perspective??0.75;
    el("horizonRange").value=z.material.params.horizon??0.0;
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
    const isContourShown = () => !(state.ui && state.ui.showContour === false);
    function updateContourBtn(){
      if(!toggleContourBtn) return;
      toggleContourBtn.textContent = isContourShown() ? "Скрыть контур" : "Показать контур";
    }
    if(toggleContourBtn){
      toggleContourBtn.addEventListener("click", () => {
        state.ui = state.ui || {};
        state.ui.showContour = !isContourShown();
        updateContourBtn();
        ED.render();
      });
      updateContourBtn();
    }


    // Ultra AI toggle (skeleton)
    const aiChk = document.getElementById("aiUltraChk");
    const aiStatusEl = document.getElementById("aiStatusText");

    // Premium occlusion controls (Patch 4)
    const aiOccChk = document.getElementById("aiOccChk");
    const aiOccPickBtn = document.getElementById("aiOccPickBtn");
    const aiOccClearBtn = document.getElementById("aiOccClearBtn");
    const aiOccHint = document.getElementById("aiOccHint");
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

    // URL flag
    try{
      const qs = new URLSearchParams(location.search);
      if(qs.get("aidebug")==="1"){ setAiDebugOverlayEnabled(true); }
    }catch(_){}

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

    el("scaleRange").addEventListener("input",()=>{const z=S.getActiveZone();if(!z)return;z.material.params.scale=parseFloat(el("scaleRange").value);ED.render();});
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
      z.material.params.horizon=parseFloat(el("horizonRange").value);
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
