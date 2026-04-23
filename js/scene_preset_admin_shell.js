window.PhotoPaveScenePresetAdminShell=(function(){
  const S=window.PhotoPaveState||null;
  const RELEASE=window.PhotoPaveReleaseConfig||null;
  const SCENES=window.PhotoPaveScenePresets||null;
  const ADMIN=window.PhotoPaveScenePresetAdmin||null;
  const state=S && S.state ? S.state : null;

  const DEFAULTS={
    stage:"foundation",
    enabled:false,
    autoInit:true,
    showOnAdminOnly:true,
    defaultSource:"resolved",
    allowPublishedOpen:true,
    allowDraftOpen:true,
    emptyStateText:"Сцены ещё не опубликованы или не подготовлены в storage."
  };

  function deepClone(v){ return JSON.parse(JSON.stringify(v)); }
  function safeGet(obj, path, fallback){
    try{
      let cur=obj;
      for(let i=0;i<path.length;i++){
        if(!cur || typeof cur !== "object") return fallback;
        cur=cur[path[i]];
      }
      return typeof cur === "undefined" ? fallback : cur;
    }catch(_){ return fallback; }
  }
  function isNotFound(err){
    const msg=String(err && err.message || err || "").toLowerCase();
    return msg.includes("404") || msg.includes("not found");
  }
  function formatTime(iso){
    if(!iso) return "—";
    try{ return new Date(iso).toLocaleString("ru-RU"); }
    catch(_){ return String(iso); }
  }
  function escapeHtml(s){ return String(s||"").replace(/[&<>'"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

  function getBootstrapConfig(){
    const raw=window.PhotoPaveAdminBootstrap || window.__PHOTO_PAVE_ADMIN__ || null;
    if(!raw || typeof raw !== "object") return null;
    if(raw.scenePresetsAdmin && typeof raw.scenePresetsAdmin === "object"){
      const adminCfg=raw.scenePresetsAdmin;
      if(adminCfg.adminShell && typeof adminCfg.adminShell === "object") return Object.assign({}, adminCfg.adminShell);
    }
    if(raw.adminShell && typeof raw.adminShell === "object") return Object.assign({}, raw.adminShell);
    return null;
  }

  function getConfig(options){
    const merged=Object.assign({}, DEFAULTS, safeGet(RELEASE, ["scenePresets", "adminShell"], {}) || {});
    const boot=getBootstrapConfig();
    if(boot) Object.assign(merged, boot);
    if(options && options.config && typeof options.config === "object") Object.assign(merged, options.config);
    merged.stage=String(merged.stage || DEFAULTS.stage);
    merged.enabled=merged.enabled !== false;
    merged.autoInit=merged.autoInit !== false;
    merged.showOnAdminOnly=merged.showOnAdminOnly !== false;
    merged.defaultSource=String(merged.defaultSource || DEFAULTS.defaultSource);
    merged.allowPublishedOpen=merged.allowPublishedOpen !== false;
    merged.allowDraftOpen=merged.allowDraftOpen !== false;
    merged.emptyStateText=String(merged.emptyStateText || DEFAULTS.emptyStateText);
    return merged;
  }

  function makeRuntime(){
    return {
      stage:"foundation",
      enabled:false,
      ready:false,
      visible:false,
      collapsed:false,
      bound:false,
      selectedSceneId:null,
      selectedSource:"resolved",
      lastError:null,
      lastLoadedAt:null,
      manifestStatus:{ draft:"idle", published:"idle" },
      manifests:{ draft:null, published:null },
      scenes:[],
      sceneMap:{},
      config:getConfig(null)
    };
  }

  function ensureRuntime(targetState){
    if(!targetState || typeof targetState !== "object") return makeRuntime();
    targetState.scenePresets = targetState.scenePresets || {};
    if(!targetState.scenePresets.adminShell || typeof targetState.scenePresets.adminShell !== "object"){
      targetState.scenePresets.adminShell = makeRuntime();
    }
    const runtime=targetState.scenePresets.adminShell;
    if(!runtime.manifestStatus || typeof runtime.manifestStatus !== "object") runtime.manifestStatus={ draft:"idle", published:"idle" };
    if(!runtime.manifests || typeof runtime.manifests !== "object") runtime.manifests={ draft:null, published:null };
    if(!Array.isArray(runtime.scenes)) runtime.scenes=[];
    if(!runtime.sceneMap || typeof runtime.sceneMap !== "object") runtime.sceneMap={};
    if(!runtime.config || typeof runtime.config !== "object") runtime.config=getConfig(null);
    return runtime;
  }

  let refs=null;
  function getRefs(){
    if(refs) return refs;
    refs={
      root:document.getElementById("scenePresetAdminShell"),
      modeBadge:document.getElementById("scenePresetAdminShellModeBadge"),
      tokenBadge:document.getElementById("scenePresetAdminShellTokenBadge"),
      status:document.getElementById("scenePresetAdminShellStatus"),
      substatus:document.getElementById("scenePresetAdminShellSubstatus"),
      refreshBtn:document.getElementById("scenePresetAdminShellRefreshBtn"),
      openResolvedBtn:document.getElementById("scenePresetAdminShellOpenResolvedBtn"),
      openDraftBtn:document.getElementById("scenePresetAdminShellOpenDraftBtn"),
      openPublishedBtn:document.getElementById("scenePresetAdminShellOpenPublishedBtn"),
      collapseBtn:document.getElementById("scenePresetAdminShellCollapseBtn"),
      sceneList:document.getElementById("scenePresetAdminShellSceneList"),
      sceneMeta:document.getElementById("scenePresetAdminShellSceneMeta"),
      sourceMeta:document.getElementById("scenePresetAdminShellSourceMeta"),
      authoringMeta:document.getElementById("scenePresetAdminShellAuthoringMeta")
    };
    return refs;
  }

  function getAdminRuntime(){
    try{ return ADMIN && typeof ADMIN.getRuntime === "function" ? ADMIN.getRuntime() : null; }
    catch(_){ return null; }
  }

  function computeVisible(runtime){
    const adminRt=getAdminRuntime();
    const isAdmin=!!(adminRt && adminRt.mode === "admin" && adminRt.enabled);
    if(runtime.config.showOnAdminOnly) return isAdmin;
    return runtime.config.enabled;
  }

  function syncShellFrame(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    const adminRt=getAdminRuntime();
    runtime.enabled = !!runtime.config.enabled;
    runtime.visible = computeVisible(runtime);
    if(r.root) r.root.hidden = !runtime.visible;
    try{ document.body.classList.toggle("ppAdminShellMode", !!runtime.visible); }catch(_){ }
    try{ document.body.classList.toggle("ppAdminShellCollapsed", !!runtime.collapsed); }catch(_){ }
    if(r.modeBadge){
      const mode=adminRt && adminRt.mode ? adminRt.mode : "public";
      r.modeBadge.textContent = mode === "admin" ? "Admin" : "Public";
    }
    if(r.tokenBadge){
      if(adminRt && adminRt.tokenPresent) r.tokenBadge.textContent = "Токен: " + String(adminRt.tokenMask || "есть");
      else r.tokenBadge.textContent = "Токен не задан";
    }
    return runtime;
  }

  function setStatus(msg, sub){
    const r=getRefs();
    if(r.status) r.status.textContent = String(msg || "");
    if(r.substatus) r.substatus.textContent = String(sub || "");
  }

  async function safeLoadManifest(source){
    const runtime=ensureRuntime(state||{});
    runtime.manifestStatus[source] = "loading";
    try{
      const manifest=await SCENES.loadManifest({ source, context:"admin" });
      runtime.manifestStatus[source] = "ready";
      runtime.manifests[source] = manifest;
      return manifest;
    }catch(err){
      runtime.manifestStatus[source] = isNotFound(err) ? "missing" : "error";
      if(isNotFound(err)){
        runtime.manifests[source] = null;
        try{
          if(state && state.scenePresets){ state.scenePresets.status = "ready"; state.scenePresets.lastError = null; }
        }catch(_){ }
        return null;
      }
      throw err;
    }
  }

  function buildMergedScenes(runtime){
    const draft=safeGet(runtime, ["manifests", "draft", "scenes"], []) || [];
    const published=safeGet(runtime, ["manifests", "published", "scenes"], []) || [];
    const map=new Map();
    function upsert(entry, source){
      if(!entry || !entry.id) return;
      if(!map.has(entry.id)){
        map.set(entry.id, {
          id:entry.id,
          title:entry.title || entry.id,
          order:Number(entry.order) || 0,
          thumbUrl:entry.thumbUrl || null,
          coverUrl:entry.coverUrl || null,
          photoUrl:entry.photoUrl || null,
          draftExists:false,
          publishedExists:false,
          draftEntry:null,
          publishedEntry:null,
          preferredSource:source
        });
      }
      const cur=map.get(entry.id);
      cur.title = (source === "draft" ? (entry.title || cur.title) : cur.title) || entry.title || cur.title || entry.id;
      cur.order = Number(entry.order) || cur.order || 0;
      if(source === "draft"){
        cur.draftExists = true;
        cur.draftEntry = deepClone(entry);
        cur.preferredSource = "draft";
        cur.thumbUrl = entry.thumbUrl || cur.thumbUrl;
        cur.coverUrl = entry.coverUrl || cur.coverUrl;
        cur.photoUrl = entry.photoUrl || cur.photoUrl;
      }else{
        cur.publishedExists = true;
        cur.publishedEntry = deepClone(entry);
        cur.thumbUrl = cur.thumbUrl || entry.thumbUrl || null;
        cur.coverUrl = cur.coverUrl || entry.coverUrl || null;
        cur.photoUrl = cur.photoUrl || entry.photoUrl || null;
      }
    }
    draft.forEach((entry)=>upsert(entry, "draft"));
    published.forEach((entry)=>upsert(entry, "published"));
    const scenes=Array.from(map.values()).sort((a,b)=>{
      if(a.order !== b.order) return a.order - b.order;
      return String(a.title||"").localeCompare(String(b.title||""), "ru");
    });
    runtime.scenes = scenes;
    runtime.sceneMap = {};
    scenes.forEach((scene)=>{ runtime.sceneMap[scene.id] = scene; });
    if(!runtime.selectedSceneId && scenes[0]) runtime.selectedSceneId = scenes[0].id;
    if(runtime.selectedSceneId && !runtime.sceneMap[runtime.selectedSceneId] && scenes[0]) runtime.selectedSceneId = scenes[0].id;
    return scenes;
  }

  function renderSceneList(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    if(!r.sceneList) return;
    const scenes=runtime.scenes || [];
    if(!scenes.length){
      r.sceneList.innerHTML = '<div class="scenePresetAdminShell__empty">' + escapeHtml(runtime.config.emptyStateText) + '</div>';
      return;
    }
    r.sceneList.innerHTML = scenes.map((scene)=>{
      const active=scene.id === runtime.selectedSceneId;
      const chips=[];
      if(scene.draftExists) chips.push('<span class="scenePresetAdminShell__chip scenePresetAdminShell__chip--draft">draft</span>');
      if(scene.publishedExists) chips.push('<span class="scenePresetAdminShell__chip scenePresetAdminShell__chip--published">published</span>');
      if(active) chips.push('<span class="scenePresetAdminShell__chip scenePresetAdminShell__chip--active">selected</span>');
      const sub=[scene.id];
      if(scene.preferredSource) sub.push('pref: ' + scene.preferredSource);
      return '<button class="scenePresetAdminShell__sceneItem' + (active ? ' isActive' : '') + '" data-scene-id="' + escapeHtml(scene.id) + '" type="button">'
        + '<span class="scenePresetAdminShell__sceneText">'
        +   '<span class="scenePresetAdminShell__sceneTitle">' + escapeHtml(scene.title || scene.id) + '</span>'
        +   '<span class="scenePresetAdminShell__sceneSub">' + escapeHtml(sub.join(' · ')) + '</span>'
        + '</span>'
        + '<span class="scenePresetAdminShell__chips">' + chips.join('') + '</span>'
        + '</button>';
    }).join('');
  }

  function renderMeta(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    const selected=runtime.selectedSceneId ? runtime.sceneMap[runtime.selectedSceneId] : null;
    const adminRt=getAdminRuntime();
    const activeSceneId=safeGet(state, ["scenePresets", "activeSceneId"], null);
    const lastResolved=safeGet(state, ["scenePresets", "lastResolved"], null);
    if(r.sceneMeta){
      if(!selected){
        r.sceneMeta.innerHTML = '<div class="scenePresetAdminShell__empty">Выберите сцену, чтобы увидеть статусы draft/published и открыть её в authoring runtime.</div>';
      }else{
        r.sceneMeta.innerHTML = [
          '<div class="scenePresetAdminShell__metaCard">',
          '<div class="scenePresetAdminShell__metaTitle">Выбранная сцена</div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Название</span><span>' + escapeHtml(selected.title || selected.id) + '</span></div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Scene ID</span><span>' + escapeHtml(selected.id) + '</span></div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Предпочтительный source</span><span>' + escapeHtml(selected.preferredSource || 'resolved') + '</span></div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Активна в runtime</span><span>' + escapeHtml(activeSceneId || '—') + '</span></div>',
          '</div>'
        ].join('');
      }
    }
    if(r.sourceMeta){
      const draftState=runtime.manifestStatus.draft || 'idle';
      const pubState=runtime.manifestStatus.published || 'idle';
      r.sourceMeta.innerHTML = [
        '<div class="scenePresetAdminShell__metaCard">',
        '<div class="scenePresetAdminShell__metaTitle">Источники и контур чтения</div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Draft manifest</span><span>' + escapeHtml(draftState) + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Published manifest</span><span>' + escapeHtml(pubState) + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Admin mode</span><span>' + escapeHtml(adminRt && adminRt.mode || 'public') + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Read order</span><span>' + escapeHtml((SCENES && SCENES.getSourceOrder ? SCENES.getSourceOrder({ context:"admin" }).join(' → ') : 'draft → published')) + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Последнее обновление</span><span>' + escapeHtml(formatTime(runtime.lastLoadedAt)) + '</span></div>',
        '</div>'
      ].join('');
    }
    if(r.authoringMeta){
      const resolvedText=lastResolved ? [lastResolved.kind || 'record', lastResolved.status || 'idle', lastResolved.resolvedSource || '—'].join(' · ') : '—';
      const selectedScene=selected || {};
      r.authoringMeta.innerHTML = [
        '<div class="scenePresetAdminShell__metaCard">',
        '<div class="scenePresetAdminShell__metaTitle">Authoring runtime</div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Открытие сцен</span><span>через app bridge</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Draft доступен</span><span>' + escapeHtml(selectedScene.draftExists ? 'да' : 'нет') + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Published доступен</span><span>' + escapeHtml(selectedScene.publishedExists ? 'да' : 'нет') + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Последний resolve</span><span>' + escapeHtml(resolvedText) + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Следующий шаг</span><span>scene create/edit UI</span></div>',
        '</div>'
      ].join('');
    }
    if(r.openDraftBtn) r.openDraftBtn.disabled = !(selected && selected.draftExists && runtime.config.allowDraftOpen);
    if(r.openPublishedBtn) r.openPublishedBtn.disabled = !(selected && selected.publishedExists && runtime.config.allowPublishedOpen);
    if(r.openResolvedBtn) r.openResolvedBtn.disabled = !selected;
  }

  function selectScene(sceneId){
    const runtime=ensureRuntime(state||{});
    runtime.selectedSceneId = String(sceneId || "").trim() || null;
    renderSceneList();
    renderMeta();
  }

  async function refreshCatalog(options){
    const runtime=ensureRuntime(state||{});
    syncShellFrame();
    if(!runtime.visible) return runtime;
    setStatus("Загружаю список сцен…", "Проверяю draft и published manifests.");
    runtime.lastError = null;
    try{
      const results=await Promise.all([safeLoadManifest("draft"), safeLoadManifest("published")]);
      buildMergedScenes(runtime);
      runtime.lastLoadedAt = new Date().toISOString();
      renderSceneList();
      renderMeta();
      const count=(runtime.scenes || []).length;
      setStatus(count ? ("Список сцен готов: " + count) : "Сцены не найдены", count ? "Можно открыть сцену в resolved / draft / published режиме." : runtime.config.emptyStateText);
      return runtime;
    }catch(err){
      runtime.lastError = String(err && err.message || err);
      renderSceneList();
      renderMeta();
      setStatus("Ошибка загрузки сцен", runtime.lastError);
      throw err;
    }
  }

  async function openScene(mode){
    const runtime=ensureRuntime(state||{});
    const selected=runtime.selectedSceneId ? runtime.sceneMap[runtime.selectedSceneId] : null;
    if(!selected) throw new Error("Scene is not selected");
    const bridge=window.PhotoPaveAppBridge || null;
    if(!bridge || typeof bridge.openScenePresetRecord !== "function") throw new Error("PhotoPaveAppBridge is unavailable");
    const label = mode === "resolved" ? "resolved" : mode;
    setStatus("Открываю сцену…", (selected.title || selected.id) + " · mode: " + label);
    let sceneRecord=null;
    if(mode === "resolved") sceneRecord = await SCENES.loadSceneResolved(selected.id, { context:"admin" });
    else sceneRecord = await SCENES.loadScene(selected.id, { source:mode, context:"admin" });
    if(SCENES && typeof SCENES.attachSceneToState === "function"){
      try{ SCENES.attachSceneToState(sceneRecord); }catch(_){ }
    }
    await bridge.openScenePresetRecord(sceneRecord, { context:"admin", source:mode });
    renderMeta();
    setStatus("Сцена открыта", (sceneRecord.title || sceneRecord.id) + " · source: " + String(sceneRecord.source || label));
    return sceneRecord;
  }

  function bind(){
    const runtime=ensureRuntime(state||{});
    if(runtime.bound) return;
    const r=getRefs();
    if(!r.root) return;
    if(r.refreshBtn) r.refreshBtn.addEventListener("click", ()=>{ refreshCatalog().catch(()=>{}); });
    if(r.openResolvedBtn) r.openResolvedBtn.addEventListener("click", ()=>{ openScene("resolved").catch((err)=>setStatus("Не удалось открыть сцену", String(err && err.message || err))); });
    if(r.openDraftBtn) r.openDraftBtn.addEventListener("click", ()=>{ openScene("draft").catch((err)=>setStatus("Не удалось открыть draft", String(err && err.message || err))); });
    if(r.openPublishedBtn) r.openPublishedBtn.addEventListener("click", ()=>{ openScene("published").catch((err)=>setStatus("Не удалось открыть published", String(err && err.message || err))); });
    if(r.collapseBtn) r.collapseBtn.addEventListener("click", ()=>{
      runtime.collapsed = !runtime.collapsed;
      if(r.collapseBtn) r.collapseBtn.textContent = runtime.collapsed ? "Развернуть" : "Свернуть";
      syncShellFrame();
    });
    if(r.sceneList) r.sceneList.addEventListener("click", (ev)=>{
      const btn=ev.target && ev.target.closest ? ev.target.closest("[data-scene-id]") : null;
      if(!btn) return;
      const sceneId=btn.getAttribute("data-scene-id");
      if(sceneId) selectScene(sceneId);
    });
    runtime.bound = true;
  }

  function init(options){
    const runtime=ensureRuntime(state||{});
    runtime.config = getConfig(options);
    runtime.stage = runtime.config.stage;
    bind();
    syncShellFrame();
    if(!runtime.visible){
      runtime.ready = false;
      return runtime;
    }
    runtime.ready = true;
    refreshCatalog().catch(()=>{});
    return runtime;
  }

  const API={ init, refreshCatalog, selectScene, openScene, getRuntime:()=>ensureRuntime(state||{}) };

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", ()=>{ try{ if(getConfig(null).autoInit) init(); }catch(_){ } }, { once:true });
  }else{
    try{ if(getConfig(null).autoInit) init(); }catch(_){ }
  }

  return API;
})();
