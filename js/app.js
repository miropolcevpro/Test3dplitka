
(function(){
  const S=window.PhotoPaveState,API=window.PhotoPaveAPI,ED=window.PhotoPaveEditor;
  const {state,makeZone,makeCutout,pushHistory,undo,redo}=S;
  const el=(id)=>document.getElementById(id);
  const escapeHtml=(s)=>String(s||"").replace(/[&<>'"]/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;" }[c]));
  const ESC_ATTR_MAP={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};
  const escapeAttr=(s)=>String(s||"").replace(/[&<>"']/g,(c)=>ESC_ATTR_MAP[c]);

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
    if(!(zone.cutouts||[]).length) wrap.innerHTML=`<div class="note">Нет вырезов. Нажмите “Добавить вырез”.</div>`;
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
      card.addEventListener("click",async ()=>{
        pushHistory();
        state.catalog.activeShapeId=shapeId;
        const zone=S.getActiveZone();
        if(zone){zone.material.shapeId=shapeId;zone.material.textureId=null;zone.material.textureUrl=null;}
        renderShapesUI();
        await loadTexturesForActiveShape();
        renderZonesUI();
        ED.render();
      });
      wrap.appendChild(card);
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
    state.floorPlane.points=[];state.floorPlane.closed=false;
    state.zones.forEach(z=>{z.contour=[];z.closed=false;z.cutouts=[];});
    state.ui.activeCutoutId=null;

    API.setStatus(`Фото загружено (${nw}×${nh})`);
    setActiveStep("zones");
    ED.setMode("contour");
    ED.render();
  }

  function syncSettingsUI(){
    const z=S.getActiveZone(); if(!z) return;
    el("scaleRange").value=z.material.params.scale??1.0;
    el("rotRange").value=z.material.params.rotation??0;
    el("opacityRange").value=z.material.params.opacity??0.85;
    el("blendSelect").value=z.material.params.blendMode??"multiply";
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
    el("modePhoto").addEventListener("click",()=>{setActiveStep("photo");ED.setMode("photo");});
    el("modePlane").addEventListener("click",()=>{setActiveStep("plane");ED.setMode("plane");});
    el("modeContour").addEventListener("click",()=>{setActiveStep("zones");ED.setMode("contour");});
    el("modeCutout").addEventListener("click",()=>{setActiveStep("cutouts");ED.setMode("cutout");});
    el("modeView").addEventListener("click",()=>{setActiveStep("export");ED.setMode("view");});

    el("undoBtn").addEventListener("click",()=>{if(undo()){ED.render();renderZonesUI();renderShapesUI();renderTexturesUI();syncSettingsUI();}});
    el("redoBtn").addEventListener("click",()=>{if(redo()){ED.render();renderZonesUI();renderShapesUI();renderTexturesUI();syncSettingsUI();}});
    window.addEventListener("keydown",(e)=>{
      if(e.ctrlKey&&e.key.toLowerCase()==="z"){if(undo()){ED.render();renderZonesUI();renderShapesUI();renderTexturesUI();syncSettingsUI();}e.preventDefault();}
      if(e.ctrlKey&&(e.key.toLowerCase()==="y"||(e.shiftKey&&e.key.toLowerCase()==="z"))){if(redo()){ED.render();renderZonesUI();renderShapesUI();renderTexturesUI();syncSettingsUI();}e.preventDefault();}
    });

    el("resetPlaneBtn").addEventListener("click",()=>{pushHistory();state.floorPlane.points=[];state.floorPlane.closed=false;ED.render();});
    el("resetZoneBtn").addEventListener("click",()=>{const z=S.getActiveZone();if(!z)return;pushHistory();z.contour=[];z.closed=false;z.cutouts=[];state.ui.activeCutoutId=null;renderZonesUI();ED.render();});

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
      state.floorPlane.points=[];state.floorPlane.closed=false;state.zones=[];state.ui.activeZoneId=null;state.ui.activeCutoutId=null;
      ensureActiveZone();renderZonesUI();ED.render();
    });

    el("addZoneBtn").addEventListener("click",()=>{pushHistory();const z=makeZone();state.zones.push(z);state.ui.activeZoneId=z.id;state.ui.activeCutoutId=null;renderZonesUI();setActiveStep("zones");ED.setMode("contour");});
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
    });
    el("delCutoutBtn").addEventListener("click",()=>{
      const z=S.getActiveZone();if(!z)return;const cid=state.ui.activeCutoutId;if(!cid)return;pushHistory();
      z.cutouts=z.cutouts.filter(c=>c.id!==cid);state.ui.activeCutoutId=z.cutouts[0]?.id||null;
      renderZonesUI();ED.render();
    });

    el("scaleRange").addEventListener("input",()=>{const z=S.getActiveZone();if(!z)return;z.material.params.scale=parseFloat(el("scaleRange").value);ED.render();});
    el("rotRange").addEventListener("input",()=>{const z=S.getActiveZone();if(!z)return;z.material.params.rotation=parseFloat(el("rotRange").value);ED.render();});
    el("opacityRange").addEventListener("input",()=>{const z=S.getActiveZone();if(!z)return;z.material.params.opacity=parseFloat(el("opacityRange").value);ED.render();});
    el("blendSelect").addEventListener("change",()=>{const z=S.getActiveZone();if(!z)return;z.material.params.blendMode=el("blendSelect").value;ED.render();});

    el("exportPngBtn").addEventListener("click",()=>ED.exportPNG());
    el("copySummaryBtn").addEventListener("click",async ()=>{const t=makeSummaryText();await navigator.clipboard.writeText(t).catch(()=>{});API.setStatus("Описание скопировано");});
    el("waBtn").addEventListener("click",()=>openMessenger("wa"));
    el("tgBtn").addEventListener("click",()=>openMessenger("tg"));
    el("shareBtn").addEventListener("click",()=>share());
  }

  async function bootstrap(){
    setBuildInfo();
    ensureActiveZone();

    ED.init(el("editorCanvas"));
    ED.bindInput();
    bindUI();
    pushHistory();

    try{
      await API.loadConfig();
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