window.PhotoPaveScenePresetAdminShell=(function(){
  const S=window.PhotoPaveState||null;
  const RELEASE=window.PhotoPaveReleaseConfig||null;
  const SCENES=window.PhotoPaveScenePresets||null;
  const ADMIN=window.PhotoPaveScenePresetAdmin||null;
  const PST=window.PhotoPaveScenePresetState||null;
  const state=S && S.state ? S.state : null;

  const DEFAULTS={
    stage:"scene-authoring",
    enabled:false,
    autoInit:true,
    showOnAdminOnly:true,
    defaultSource:"resolved",
    allowPublishedOpen:true,
    allowDraftOpen:true,
    emptyStateText:"Сцены ещё не опубликованы или не подготовлены в storage.",
    localDraftStorageKey:"pp_scene_preset_local_drafts_v1",
    bulkAssetImportStorageKey:"pp_scene_preset_bulk_asset_import_v1"
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
  function safeSetText(node, text){ if(node) node.textContent=String(text || ""); }
  function setIfDiff(node, value){
    if(!node) return;
    const next=value == null ? "" : String(value);
    if(node.value !== next) node.value = next;
  }
  function safeStorageGet(key, fallback){
    try{
      const raw=window.localStorage.getItem(String(key||""));
      if(!raw) return fallback;
      return JSON.parse(raw);
    }catch(_){ return fallback; }
  }
  function safeStorageSet(key, value){
    try{ window.localStorage.setItem(String(key||""), JSON.stringify(value)); return true; }
    catch(_){ return false; }
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
  function normalizeSceneId(raw, fallback){
    const wanted=String(raw || fallback || "scene").trim() || String(fallback || "scene");
    try{ return SCENES && typeof SCENES.makeSceneId === "function" ? SCENES.makeSceneId(wanted, fallback || "scene") : wanted; }
    catch(_){ return wanted; }
  }

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
    merged.localDraftStorageKey=String(merged.localDraftStorageKey || DEFAULTS.localDraftStorageKey);
    merged.localVariantStorageKey=String(merged.localVariantStorageKey || DEFAULTS.localVariantStorageKey);
    merged.publishAutofillStorageKey=String(merged.publishAutofillStorageKey || DEFAULTS.publishAutofillStorageKey);
    merged.bulkAssetImportStorageKey=String(merged.bulkAssetImportStorageKey || DEFAULTS.bulkAssetImportStorageKey);
    return merged;
  }

  function createEmptyDraft(seed){
    const src=seed && typeof seed === "object" ? seed : {};
    const sceneId=normalizeSceneId(src.sceneId || src.id || src.title || "scene", "scene");
    return {
      schemaVersion:1,
      kind:"scene-base",
      id:sceneId,
      sceneId,
      title:String(src.title || sceneId),
      order:Number(src.order) || 0,
      enabled: src.enabled == null ? true : !!src.enabled,
      updatedAt: src.updatedAt || new Date().toISOString(),
      photo:{
        sourceUrl: src.photo && src.photo.sourceUrl ? String(src.photo.sourceUrl) : (src.photoUrl ? String(src.photoUrl) : null),
        thumbUrl: src.photo && src.photo.thumbUrl ? String(src.photo.thumbUrl) : (src.thumbUrl ? String(src.thumbUrl) : null),
        coverUrl: src.photo && src.photo.coverUrl ? String(src.photo.coverUrl) : (src.coverUrl ? String(src.coverUrl) : null),
        width: src.photo && src.photo.width ? Number(src.photo.width) : null,
        height: src.photo && src.photo.height ? Number(src.photo.height) : null,
        fileName: src.photo && src.photo.fileName ? String(src.photo.fileName) : null,
        mime: src.photo && src.photo.mime ? String(src.photo.mime) : null
      },
      ui: src.ui && typeof src.ui === "object" ? deepClone(src.ui) : null,
      catalog: src.catalog && typeof src.catalog === "object" ? deepClone(src.catalog) : null,
      floorPlane: src.floorPlane && typeof src.floorPlane === "object" ? deepClone(src.floorPlane) : { points:[], closed:false },
      zones: Array.isArray(src.zones) ? deepClone(src.zones) : [],
      meta: src.meta && typeof src.meta === "object" ? deepClone(src.meta) : {},
      baseSnapshot: src.baseSnapshot && typeof src.baseSnapshot === "object" ? deepClone(src.baseSnapshot) : null,
      source: src.source || "local"
    };
  }

  function normalizeLocalDraft(input){
    const src=input && typeof input === "object" ? input : {};
    let scene=null;
    try{ scene = PST && typeof PST.deserializeSceneBase === "function" ? PST.deserializeSceneBase(src) : null; }
    catch(_){ scene = null; }
    if(!scene) scene=createEmptyDraft(src);
    scene.sceneId = normalizeSceneId(scene.sceneId || scene.id || src.sceneId || src.id || src.title || "scene", "scene");
    scene.id = scene.sceneId;
    scene.title = String(scene.title || src.title || scene.sceneId);
    scene.order = Number(src.order != null ? src.order : scene.order) || 0;
    scene.enabled = src.enabled == null ? (scene.enabled == null ? true : !!scene.enabled) : !!src.enabled;
    scene.updatedAt = src.updatedAt || scene.updatedAt || new Date().toISOString();
    scene.photo = scene.photo && typeof scene.photo === "object" ? scene.photo : {};
    if(src.photoUrl && !scene.photo.sourceUrl) scene.photo.sourceUrl = String(src.photoUrl);
    if(src.thumbUrl && !scene.photo.thumbUrl) scene.photo.thumbUrl = String(src.thumbUrl);
    if(src.coverUrl && !scene.photo.coverUrl) scene.photo.coverUrl = String(src.coverUrl);
    scene.meta = scene.meta && typeof scene.meta === "object" ? scene.meta : {};
    scene.source = "local";
    return scene;
  }

  function makeRuntime(){
    return {
      stage:"scene-authoring",
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
      localDrafts:{},
      localVariants:{},
      scenes:[],
      sceneMap:{},
      editor:{ draft:createEmptyDraft(), dirty:false, lastSavedAt:null },
      variantEditor:{ draft:null, dirty:false, lastSavedAt:null },
      publishAutofill:null,
      bulkAssetImport:{ rawText:"", updatedAt:null, analysis:null },
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
    if(!runtime.localDrafts || typeof runtime.localDrafts !== "object") runtime.localDrafts={};
    if(!runtime.localVariants || typeof runtime.localVariants !== "object") runtime.localVariants={};
    if(!Array.isArray(runtime.scenes)) runtime.scenes=[];
    if(!runtime.sceneMap || typeof runtime.sceneMap !== "object") runtime.sceneMap={};
    if(!runtime.config || typeof runtime.config !== "object") runtime.config=getConfig(null);
    if(!runtime.editor || typeof runtime.editor !== "object") runtime.editor={ draft:createEmptyDraft(), dirty:false, lastSavedAt:null };
    if(!runtime.editor.draft || typeof runtime.editor.draft !== "object") runtime.editor.draft=createEmptyDraft();
    if(!runtime.variantEditor || typeof runtime.variantEditor !== "object") runtime.variantEditor={ draft:null, dirty:false, lastSavedAt:null };
    if(!runtime.publishAutofill || typeof runtime.publishAutofill !== "object") runtime.publishAutofill=null;
    if(!runtime.bulkAssetImport || typeof runtime.bulkAssetImport !== "object") runtime.bulkAssetImport={ rawText:"", updatedAt:null, analysis:null };
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
      authoringMeta:document.getElementById("scenePresetAdminShellAuthoringMeta"),
      geometryState:document.getElementById("scenePresetAdminShellGeometryState"),
      geometryChips:document.getElementById("scenePresetAdminShellGeometryChips"),
      geometryMeta:document.getElementById("scenePresetAdminShellGeometryMeta"),
      draftState:document.getElementById("scenePresetAdminShellDraftState"),
      inputSceneId:document.getElementById("scenePresetAdminShellSceneId"),
      inputTitle:document.getElementById("scenePresetAdminShellSceneTitle"),
      inputOrder:document.getElementById("scenePresetAdminShellSceneOrder"),
      inputEnabled:document.getElementById("scenePresetAdminShellSceneEnabled"),
      inputPhotoUrl:document.getElementById("scenePresetAdminShellScenePhotoUrl"),
      inputThumbUrl:document.getElementById("scenePresetAdminShellSceneThumbUrl"),
      inputNote:document.getElementById("scenePresetAdminShellSceneNote"),
      btnNew:document.getElementById("scenePresetAdminShellNewBtn"),
      btnCapture:document.getElementById("scenePresetAdminShellCaptureBtn"),
      btnUploadPhoto:document.getElementById("scenePresetAdminShellUploadPhotoBtn"),
      btnSaveLocal:document.getElementById("scenePresetAdminShellSaveLocalBtn"),
      btnExport:document.getElementById("scenePresetAdminShellExportBtn"),
      btnExportPackage:document.getElementById("scenePresetAdminShellExportPackageBtn"),
      btnImport:document.getElementById("scenePresetAdminShellImportBtn"),
      importInput:document.getElementById("scenePresetAdminShellImportInput"),
      helperStatus:document.getElementById("scenePresetAdminShellPublishHelperStatus"),
      helperPaths:document.getElementById("scenePresetAdminShellPublishHelperPaths"),
      helperManifest:document.getElementById("scenePresetAdminShellPublishHelperManifest"),
      helperDeploy:document.getElementById("scenePresetAdminShellPublishHelperDeploy"),
      helperPackage:document.getElementById("scenePresetAdminShellPublishHelperPackage"),
      helperValidationState:document.getElementById("scenePresetAdminShellPublishValidationState"),
      helperValidationChips:document.getElementById("scenePresetAdminShellPublishValidationChips"),
      helperValidationMeta:document.getElementById("scenePresetAdminShellPublishValidationMeta"),
      btnValidatePublish:document.getElementById("scenePresetAdminShellValidatePublishBtn"),
      btnCopyManifest:document.getElementById("scenePresetAdminShellCopyManifestBtn"),
      btnCopyPaths:document.getElementById("scenePresetAdminShellCopyPathsBtn"),
      btnCopyDeploy:document.getElementById("scenePresetAdminShellCopyDeployBtn"),
      btnCopyPackage:document.getElementById("scenePresetAdminShellCopyPackageBtn"),
      helperAutofillState:document.getElementById("scenePresetAdminShellPublishAutofillState"),
      inputPagesBase:document.getElementById("scenePresetAdminShellPublishPagesBase"),
      inputMediaDir:document.getElementById("scenePresetAdminShellPublishMediaDir"),
      inputPreviewsDir:document.getElementById("scenePresetAdminShellPublishPreviewsDir"),
      inputScenePhotoFile:document.getElementById("scenePresetAdminShellPublishScenePhotoFile"),
      inputSceneThumbFile:document.getElementById("scenePresetAdminShellPublishSceneThumbFile"),
      inputSceneCoverFile:document.getElementById("scenePresetAdminShellPublishSceneCoverFile"),
      inputVariantPreviewExt:document.getElementById("scenePresetAdminShellPublishVariantPreviewExt"),
      btnAutofillSceneUrls:document.getElementById("scenePresetAdminShellAutofillSceneUrlsBtn"),
      btnAutofillVariantPreviews:document.getElementById("scenePresetAdminShellAutofillVariantPreviewsBtn"),
      btnSaveAutofillPreset:document.getElementById("scenePresetAdminShellSaveAutofillPresetBtn"),
      bulkAssetState:document.getElementById("scenePresetAdminShellBulkAssetState"),
      bulkAssetInput:document.getElementById("scenePresetAdminShellBulkAssetInput"),
      bulkAssetMeta:document.getElementById("scenePresetAdminShellBulkAssetMeta"),
      btnAnalyzeBulkAssets:document.getElementById("scenePresetAdminShellAnalyzeBulkAssetsBtn"),
      btnApplyBulkAssets:document.getElementById("scenePresetAdminShellApplyBulkAssetsBtn"),
      btnClearBulkAssets:document.getElementById("scenePresetAdminShellClearBulkAssetsBtn"),
      quickState:document.getElementById("scenePresetAdminShellQuickState"),
      quickChips:document.getElementById("scenePresetAdminShellQuickChips"),
      btnQuickNewScene:document.getElementById("scenePresetAdminShellQuickNewSceneBtn"),
      btnQuickSaveScene:document.getElementById("scenePresetAdminShellQuickSaveSceneBtn"),
      btnQuickSaveVariant:document.getElementById("scenePresetAdminShellQuickSaveVariantBtn"),
      btnQuickFinalizeExport:document.getElementById("scenePresetAdminShellQuickFinalizeExportBtn"),
      btnQuickToggleAdvanced:document.getElementById("scenePresetAdminShellQuickToggleAdvancedBtn"),
      btnModeContour:document.getElementById("scenePresetAdminShellModeContourBtn"),
      btnModeCutout:document.getElementById("scenePresetAdminShellModeCutoutBtn"),
      btnModeView:document.getElementById("scenePresetAdminShellModeViewBtn"),
      btnCloseContour:document.getElementById("scenePresetAdminShellCloseContourBtn"),
      btnResetGeometry:document.getElementById("scenePresetAdminShellResetGeometryBtn"),
      variantState:document.getElementById("scenePresetAdminShellVariantState"),
      variantContext:document.getElementById("scenePresetAdminShellVariantContext"),
      variantList:document.getElementById("scenePresetAdminShellVariantList"),
      inputVariantShapeId:document.getElementById("scenePresetAdminShellVariantShapeId"),
      inputVariantTextureId:document.getElementById("scenePresetAdminShellVariantTextureId"),
      inputVariantTitle:document.getElementById("scenePresetAdminShellVariantTitle"),
      inputVariantPreviewUrl:document.getElementById("scenePresetAdminShellVariantPreviewUrl"),
      inputVariantNote:document.getElementById("scenePresetAdminShellVariantNote"),
      btnCaptureVariant:document.getElementById("scenePresetAdminShellCaptureVariantBtn"),
      btnSaveVariantLocal:document.getElementById("scenePresetAdminShellSaveVariantLocalBtn"),
      btnOpenVariantLocal:document.getElementById("scenePresetAdminShellOpenVariantLocalBtn"),
      btnExportVariant:document.getElementById("scenePresetAdminShellExportVariantBtn"),
      btnImportVariant:document.getElementById("scenePresetAdminShellImportVariantBtn"),
      importVariantInput:document.getElementById("scenePresetAdminShellImportVariantInput")
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

  function loadLocalDrafts(runtime){
    const raw=safeStorageGet(runtime.config.localDraftStorageKey, {});
    const out={};
    Object.keys(raw || {}).forEach((k)=>{
      try{
        const scene=normalizeLocalDraft(raw[k]);
        out[scene.sceneId]=scene;
      }catch(_){ }
    });
    runtime.localDrafts = out;
    return out;
  }

  function persistLocalDrafts(runtime){
    const out={};
    Object.keys(runtime.localDrafts || {}).forEach((k)=>{
      if(runtime.localDrafts[k] && runtime.localDrafts[k].sceneId) out[k]=runtime.localDrafts[k];
    });
    return safeStorageSet(runtime.config.localDraftStorageKey, out);
  }

  function makeVariantKey(sceneId, shapeId, textureId){
    try{ return SCENES && typeof SCENES.buildVariantKey === "function" ? SCENES.buildVariantKey(sceneId, shapeId, textureId) : [normalizeSceneId(sceneId, "scene"), String(shapeId||"shape"), String(textureId||"texture")].join("__"); }
    catch(_){ return [normalizeSceneId(sceneId, "scene"), String(shapeId||"shape"), String(textureId||"texture")].join("__"); }
  }

  function createEmptyVariantDraft(seed){
    const src=seed && typeof seed === "object" ? seed : {};
    const sceneId=normalizeSceneId(src.sceneId || src.id || (state && state.scenePresets && state.scenePresets.activeSceneId) || "scene", "scene");
    const shapeId=String(src.shapeId || safeGet(src,["stateSnapshot","catalog","activeShapeId"],null) || safeGet(state,["catalog","activeShapeId"],"" ) || "").trim() || null;
    let textureId=String(src.textureId || "").trim() || null;
    if(!textureId){
      const zones=Array.isArray(state && state.zones) ? state.zones : [];
      const activeZoneId=safeGet(state,["ui","activeZoneId"],null);
      const zone=zones.find((z)=>z && z.id===activeZoneId) || zones[0] || null;
      textureId = String(zone && zone.material && zone.material.textureId || "").trim() || null;
    }
    const key=src.key || makeVariantKey(sceneId, shapeId || "shape", textureId || "texture");
    return {
      schemaVersion:1,
      kind:"scene-variant-snapshot",
      id:key,
      key,
      sceneId,
      shapeId,
      textureId,
      title:String(src.title || key),
      status:String(src.status || "draft"),
      updatedAt:src.updatedAt || new Date().toISOString(),
      previewUrl:src.previewUrl ? String(src.previewUrl) : null,
      meta:src.meta && typeof src.meta === "object" ? deepClone(src.meta) : {},
      stateSnapshot:src.stateSnapshot && typeof src.stateSnapshot === "object" ? deepClone(src.stateSnapshot) : null,
      source:src.source || "local"
    };
  }

  function normalizeLocalVariant(input){
    const src=input && typeof input === "object" ? input : {};
    let variant=null;
    try{ variant = PST && typeof PST.deserializeVariantSnapshot === "function" ? PST.deserializeVariantSnapshot(src) : null; }
    catch(_){ variant = null; }
    if(!variant) variant=createEmptyVariantDraft(src);
    variant.sceneId = normalizeSceneId(variant.sceneId || src.sceneId || "scene", "scene");
    variant.shapeId = String(variant.shapeId || src.shapeId || "").trim() || null;
    variant.textureId = String(variant.textureId || src.textureId || "").trim() || null;
    variant.key = makeVariantKey(variant.sceneId, variant.shapeId || "shape", variant.textureId || "texture");
    variant.id = variant.key;
    variant.title = String(src.title || variant.title || variant.key);
    variant.updatedAt = src.updatedAt || variant.updatedAt || new Date().toISOString();
    variant.previewUrl = src.previewUrl || variant.previewUrl || null;
    variant.meta = variant.meta && typeof variant.meta === "object" ? variant.meta : {};
    variant.source = "local";
    return variant;
  }

  function loadLocalVariants(runtime){
    const raw=safeStorageGet(runtime.config.localVariantStorageKey, {});
    const out={};
    Object.keys(raw || {}).forEach((k)=>{
      try{
        const variant=normalizeLocalVariant(raw[k]);
        out[variant.key]=variant;
      }catch(_){ }
    });
    runtime.localVariants = out;
    return out;
  }

  function persistLocalVariants(runtime){
    const out={};
    Object.keys(runtime.localVariants || {}).forEach((k)=>{
      if(runtime.localVariants[k] && runtime.localVariants[k].key) out[k]=runtime.localVariants[k];
    });
    return safeStorageSet(runtime.config.localVariantStorageKey, out);
  }

  function createDefaultPublishAutofill(){
    return {
      pagesBase:'https://miropolcevpro.github.io/Test3dplitka/preset-scenes/published',
      mediaDir:'media',
      previewsDir:'previews',
      scenePhotoFile:'scene-photo.jpg',
      sceneThumbFile:'scene-thumb.jpg',
      sceneCoverFile:'scene-cover.jpg',
      variantPreviewExt:'jpg',
      updatedAt:null
    };
  }

  function normalizePublishAutofill(input){
    const src=input && typeof input === 'object' ? input : {};
    const base=createDefaultPublishAutofill();
    const out=Object.assign({}, base, src || {});
    out.pagesBase=String(out.pagesBase || base.pagesBase).trim().replace(/\/+$/,'');
    out.mediaDir=String(out.mediaDir || base.mediaDir).trim().replace(/^\/+|\/+$/g,'') || base.mediaDir;
    out.previewsDir=String(out.previewsDir || base.previewsDir).trim().replace(/^\/+|\/+$/g,'') || base.previewsDir;
    out.scenePhotoFile=String(out.scenePhotoFile || base.scenePhotoFile).trim() || base.scenePhotoFile;
    out.sceneThumbFile=String(out.sceneThumbFile || base.sceneThumbFile).trim() || base.sceneThumbFile;
    out.sceneCoverFile=String(out.sceneCoverFile || base.sceneCoverFile).trim() || base.sceneCoverFile;
    out.variantPreviewExt=String(out.variantPreviewExt || base.variantPreviewExt).trim().replace(/^\./,'') || base.variantPreviewExt;
    out.updatedAt=src.updatedAt || out.updatedAt || null;
    return out;
  }

  function normalizeBulkAssetImport(input){
    const src=input && typeof input === 'object' ? input : {};
    return { rawText:String(src.rawText || ''), updatedAt:src.updatedAt || null, analysis:src.analysis && typeof src.analysis==='object' ? deepClone(src.analysis) : null };
  }

  function loadBulkAssetImport(runtime){
    const raw=safeStorageGet(runtime.config.bulkAssetImportStorageKey, null);
    runtime.bulkAssetImport = normalizeBulkAssetImport(raw);
    return runtime.bulkAssetImport;
  }

  function persistBulkAssetImport(runtime){
    runtime.bulkAssetImport = normalizeBulkAssetImport(runtime.bulkAssetImport);
    runtime.bulkAssetImport.updatedAt = new Date().toISOString();
    return safeStorageSet(runtime.config.bulkAssetImportStorageKey, runtime.bulkAssetImport);
  }

  function readBulkAssetImport(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    runtime.bulkAssetImport = normalizeBulkAssetImport(runtime.bulkAssetImport);
    runtime.bulkAssetImport.rawText = String((r.bulkAssetInput && r.bulkAssetInput.value) || runtime.bulkAssetImport.rawText || '');
    return runtime.bulkAssetImport;
  }

  function cleanBulkAssetLine(line){
    return String(line || '').replace(/^[-*•]+\s*/, '').trim();
  }

  function parseBulkAssetEntries(raw){
    const lines=String(raw || '').split(/\r?\n/).map(cleanBulkAssetLine).filter(Boolean);
    return lines.map((url)=>{
      const clean=String(url || '').trim();
      const noHash=clean.split('#')[0];
      const noQuery=noHash.split('?')[0];
      const baseName=(noQuery.split('/').pop() || '').trim();
      const stem=baseName.replace(/\.[^.]+$/, '');
      return { url:clean, baseName:baseName, stem:stem };
    }).filter((entry)=>entry.baseName);
  }

  function analyzeBulkAssetImport(rawText, scene, variants, cfg){
    const publishCfg=normalizePublishAutofill(cfg || createDefaultPublishAutofill());
    const entries=parseBulkAssetEntries(rawText);
    const byBase={};
    const byStem={};
    entries.forEach((entry)=>{ byBase[entry.baseName]=entry; byStem[entry.stem]=entry; });
    const sceneMatch={
      photo: byBase[publishCfg.scenePhotoFile] ? byBase[publishCfg.scenePhotoFile].url : null,
      thumb: byBase[publishCfg.sceneThumbFile] ? byBase[publishCfg.sceneThumbFile].url : null,
      cover: byBase[publishCfg.sceneCoverFile] ? byBase[publishCfg.sceneCoverFile].url : null
    };
    const variantMatches=[];
    const unmatched=[];
    const consumed=new Set();
    Object.values(sceneMatch).forEach((u)=>{ if(u) consumed.add(u); });
    (variants || []).forEach((variant)=>{
      const stem=buildPublishedVariantStem(variant);
      const hit=byStem[stem] || null;
      variantMatches.push({ key:variant.key, label:formatVariantLabel(variant), stem:stem, url:hit ? hit.url : null });
      if(hit) consumed.add(hit.url);
    });
    entries.forEach((entry)=>{ if(!consumed.has(entry.url)) unmatched.push(entry.url); });
    return {
      totalEntries:entries.length,
      scene:sceneMatch,
      variants:variantMatches,
      matchedVariantCount:variantMatches.filter((v)=>!!v.url).length,
      unmatched:unmatched,
      missingSceneKinds:['photo','thumb','cover'].filter((k)=>!sceneMatch[k]),
      missingVariantCount:variantMatches.filter((v)=>!v.url).length
    };
  }

  function loadPublishAutofill(runtime){
    const raw=safeStorageGet(runtime.config.publishAutofillStorageKey, null);
    runtime.publishAutofill = normalizePublishAutofill(raw);
    return runtime.publishAutofill;
  }

  function persistPublishAutofill(runtime){
    runtime.publishAutofill = normalizePublishAutofill(runtime.publishAutofill);
    runtime.publishAutofill.updatedAt = new Date().toISOString();
    return safeStorageSet(runtime.config.publishAutofillStorageKey, runtime.publishAutofill);
  }

  function readPublishAutofill(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    const cur=normalizePublishAutofill(runtime.publishAutofill || createDefaultPublishAutofill());
    cur.pagesBase=String((r.inputPagesBase && r.inputPagesBase.value) || cur.pagesBase || '').trim().replace(/\/+$/,'');
    cur.mediaDir=String((r.inputMediaDir && r.inputMediaDir.value) || cur.mediaDir || '').trim().replace(/^\/+|\/+$/g,'') || 'media';
    cur.previewsDir=String((r.inputPreviewsDir && r.inputPreviewsDir.value) || cur.previewsDir || '').trim().replace(/^\/+|\/+$/g,'') || 'previews';
    cur.scenePhotoFile=String((r.inputScenePhotoFile && r.inputScenePhotoFile.value) || cur.scenePhotoFile || '').trim() || 'scene-photo.jpg';
    cur.sceneThumbFile=String((r.inputSceneThumbFile && r.inputSceneThumbFile.value) || cur.sceneThumbFile || '').trim() || 'scene-thumb.jpg';
    cur.sceneCoverFile=String((r.inputSceneCoverFile && r.inputSceneCoverFile.value) || cur.sceneCoverFile || '').trim() || 'scene-cover.jpg';
    cur.variantPreviewExt=String((r.inputVariantPreviewExt && r.inputVariantPreviewExt.value) || cur.variantPreviewExt || '').trim().replace(/^\./,'') || 'jpg';
    runtime.publishAutofill = normalizePublishAutofill(cur);
    return runtime.publishAutofill;
  }

  function buildPublishedAssetBase(sceneId, cfg){
    const scene=normalizeSceneId(sceneId || 'scene', 'scene');
    return [String(cfg.pagesBase || '').replace(/\/+$/,''), scene].filter(Boolean).join('/');
  }

  function buildPublishedAssetUrl(sceneId, cfg, kind){
    const base=buildPublishedAssetBase(sceneId, cfg);
    if(!base) return null;
    if(kind === 'photo') return [base, cfg.mediaDir, cfg.scenePhotoFile].join('/');
    if(kind === 'thumb') return [base, cfg.mediaDir, cfg.sceneThumbFile].join('/');
    if(kind === 'cover') return [base, cfg.mediaDir, cfg.sceneCoverFile].join('/');
    return null;
  }

  function buildPublishedVariantStem(variant){
    const shape=String(variant && variant.shapeId || 'shape').trim() || 'shape';
    const texture=String(variant && variant.textureId || 'texture').trim() || 'texture';
    const key=makeVariantKey('scene', shape, texture);
    const parts=String(key || '').split('__');
    return parts.length >= 3 ? parts.slice(1).join('__') : (String(shape) + '__' + String(texture));
  }

  function formatVariantLabel(variant){
    if(!variant) return 'variant';
    const shape=String(variant.shapeId || 'shape');
    const texture=String(variant.textureId || 'texture');
    return shape + ' / ' + texture;
  }

  function collectDuplicatePublishedStems(variants){
    const map={};
    const dupes=[];
    (variants || []).forEach((variant)=>{
      const stem=buildPublishedVariantStem(variant);
      map[stem] = map[stem] || [];
      map[stem].push(variant);
    });
    Object.keys(map).forEach((stem)=>{
      if((map[stem] || []).length > 1){
        dupes.push({ stem:stem, variants:map[stem].map((v)=>formatVariantLabel(v)) });
      }
    });
    return dupes;
  }

  function computePublishReadiness(scene, variants, cfg){
    const errors=[];
    const warnings=[];
    const checks=[];
    const normalizedScene=scene && typeof scene === 'object' ? scene : {};
    const list=Array.isArray(variants) ? variants : [];
    const publishCfg=normalizePublishAutofill(cfg || createDefaultPublishAutofill());
    const sceneId=normalizeSceneId(normalizedScene.sceneId || normalizedScene.id || '', 'scene');
    const hasSceneId=!!String(normalizedScene.sceneId || normalizedScene.id || '').trim();
    const hasBase=!!(normalizedScene.baseSnapshot && typeof normalizedScene.baseSnapshot === 'object');
    const photoUrl=safeGet(normalizedScene,['photo','sourceUrl'],null);
    const thumbUrl=safeGet(normalizedScene,['photo','thumbUrl'],null);
    const coverUrl=safeGet(normalizedScene,['photo','coverUrl'],null);

    checks.push({ key:'sceneId', label:'Scene ID задан', ok:hasSceneId, detail:hasSceneId ? sceneId : 'sceneId пустой' });
    if(!hasSceneId) errors.push('Scene ID не задан');

    checks.push({ key:'base', label:'Base scene захвачена', ok:hasBase, detail:hasBase ? 'baseSnapshot сохранён' : 'baseSnapshot отсутствует' });
    if(!hasBase) errors.push('Base scene ещё не захвачена');

    checks.push({ key:'variants', label:'Есть хотя бы один variant', ok:list.length > 0, detail:'variants: ' + String(list.length) });
    if(!list.length) errors.push('Нет ни одного сохранённого local variant');

    checks.push({ key:'photo', label:'Photo URL задан', ok:!!photoUrl, detail:photoUrl || 'photoUrl пустой' });
    if(!photoUrl) errors.push('Photo URL пустой');

    const duplicates=collectDuplicatePublishedStems(list);
    checks.push({ key:'dupes', label:'Нет конфликтов publish filenames', ok:duplicates.length === 0, detail:duplicates.length ? ('duplicate stems: ' + String(duplicates.length)) : 'конфликтов нет' });
    if(duplicates.length){
      duplicates.forEach((dup)=>errors.push('Конфликт publish filename: ' + dup.stem + ' (' + dup.variants.join(', ') + ')'));
    }

    const missingPreview=list.filter((variant)=>!String(variant && variant.previewUrl || '').trim());
    if(missingPreview.length){
      warnings.push('У ' + String(missingPreview.length) + ' variant(s) не задан preview URL');
    }
    if(!thumbUrl) warnings.push('Thumb URL пустой');
    if(!coverUrl) warnings.push('Cover URL пустой');
    if(!publishCfg.pagesBase) warnings.push('GitHub Pages base URL пустой');

    return {
      sceneId,
      hasSceneId,
      hasBase,
      hasVariants:list.length > 0,
      hasPhotoUrl:!!photoUrl,
      hasThumbUrl:!!thumbUrl,
      hasCoverUrl:!!coverUrl,
      checks,
      errors,
      warnings,
      ok: errors.length === 0,
      variantsCount:list.length,
      missingPreviewCount:missingPreview.length,
      missingPreviewVariants:missingPreview.map((variant)=>({ key:variant.key, label:formatVariantLabel(variant) })),
      duplicateStems:duplicates,
      cfg: publishCfg
    };
  }

  function buildPublishedVariantPreviewUrl(sceneId, variant, cfg){
    if(!variant) return null;
    const base=buildPublishedAssetBase(sceneId, cfg);
    if(!base) return null;
    const stem=buildPublishedVariantStem(variant);
    return [base, cfg.previewsDir, stem + '.' + cfg.variantPreviewExt].join('/');
  }

  function getActiveVariantContext(runtime){
    const zones=Array.isArray(state && state.zones) ? state.zones : [];
    const activeZoneId=safeGet(state,["ui","activeZoneId"],null);
    const zone=zones.find((z)=>z && z.id===activeZoneId) || zones[0] || null;
    const sceneDraft=ensureEditorDraft(runtime);
    const sceneId=normalizeSceneId(sceneDraft.sceneId || sceneDraft.id || safeGet(state,["scenePresets","activeSceneId"],"scene"), "scene");
    const shapeId=String((zone && zone.material && zone.material.shapeId) || safeGet(state,["catalog","activeShapeId"],"" ) || "").trim() || null;
    const textureId=String((zone && zone.material && zone.material.textureId) || "").trim() || null;
    return {
      sceneId,
      shapeId,
      textureId,
      zoneId:zone && zone.id || null,
      sceneReady:!!(sceneDraft && sceneDraft.baseSnapshot && typeof sceneDraft.baseSnapshot === "object"),
      hasShape:!!shapeId,
      hasTexture:!!textureId,
      key:(shapeId && textureId) ? makeVariantKey(sceneId, shapeId, textureId) : null
    };
  }

  function ensureVariantDraft(runtime){
    const ctx=getActiveVariantContext(runtime);
    const current=runtime.variantEditor && runtime.variantEditor.draft && typeof runtime.variantEditor.draft === "object" ? runtime.variantEditor.draft : null;
    if(current && current.sceneId===ctx.sceneId && current.shapeId===ctx.shapeId && current.textureId===ctx.textureId) return current;
    const existing=current && current.key ? normalizeLocalVariant(current) : createEmptyVariantDraft(ctx);
    if(!runtime.variantEditor) runtime.variantEditor={ draft:null, dirty:false, lastSavedAt:null };
    if(!existing.title || existing.title===existing.key) existing.title=[ctx.sceneId, ctx.shapeId || "shape", ctx.textureId || "texture"].join(" · ");
    runtime.variantEditor.draft = existing;
    return runtime.variantEditor.draft;
  }

  function getSceneVariants(runtime, sceneId){
    const wanted=normalizeSceneId(sceneId || getActiveVariantContext(runtime).sceneId, "scene");
    return Object.values(runtime.localVariants || {}).filter((v)=>v && v.sceneId===wanted).sort((a,b)=>{
      const t1=String(a.shapeId||"") + "|" + String(a.textureId||"");
      const t2=String(b.shapeId||"") + "|" + String(b.textureId||"");
      return t1.localeCompare(t2, "ru");
    });
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
      const requireAuth = !!(adminRt && adminRt.config && adminRt.config.requireAuth !== false);
      if(!requireAuth) r.tokenBadge.textContent = "Защищённая страница";
      else if(adminRt && adminRt.tokenPresent) r.tokenBadge.textContent = "Токен: " + String(adminRt.tokenMask || "есть");
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
    const local=Object.values(runtime.localDrafts || {});
    const map=new Map();
    function ensureEntry(id, title, order){
      if(!map.has(id)){
        map.set(id, {
          id,
          title:title || id,
          order:Number(order) || 0,
          thumbUrl:null,
          coverUrl:null,
          photoUrl:null,
          localExists:false,
          draftExists:false,
          publishedExists:false,
          localRecord:null,
          draftEntry:null,
          publishedEntry:null,
          preferredSource:null,
          updatedAt:null
        });
      }
      return map.get(id);
    }
    local.forEach((entry)=>{
      if(!entry || !entry.sceneId) return;
      const cur=ensureEntry(entry.sceneId, entry.title, entry.order);
      cur.title = entry.title || cur.title;
      cur.order = Number(entry.order) || cur.order || 0;
      cur.localExists = true;
      cur.localRecord = deepClone(entry);
      cur.preferredSource = cur.preferredSource || "local";
      cur.thumbUrl = safeGet(entry, ["photo", "thumbUrl"], null) || cur.thumbUrl;
      cur.coverUrl = safeGet(entry, ["photo", "coverUrl"], null) || cur.coverUrl;
      cur.photoUrl = safeGet(entry, ["photo", "sourceUrl"], null) || cur.photoUrl;
      cur.updatedAt = entry.updatedAt || cur.updatedAt;
    });
    function upsert(entry, source){
      if(!entry || !entry.id) return;
      const cur=ensureEntry(entry.id, entry.title, entry.order);
      if(source === "draft"){
        cur.draftExists = true;
        cur.draftEntry = deepClone(entry);
        cur.preferredSource = cur.localExists ? "local" : "draft";
      }else{
        cur.publishedExists = true;
        cur.publishedEntry = deepClone(entry);
        if(!cur.preferredSource) cur.preferredSource = "published";
      }
      cur.title = cur.localExists ? cur.title : ((source === "draft" ? (entry.title || cur.title) : cur.title) || entry.title || cur.id);
      cur.order = cur.localExists ? cur.order : (Number(entry.order) || cur.order || 0);
      cur.thumbUrl = cur.thumbUrl || entry.thumbUrl || null;
      cur.coverUrl = cur.coverUrl || entry.coverUrl || null;
      cur.photoUrl = cur.photoUrl || entry.photoUrl || null;
      cur.updatedAt = cur.updatedAt || entry.updatedAt || null;
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
      if(scene.localExists) chips.push('<span class="scenePresetAdminShell__chip scenePresetAdminShell__chip--local">local</span>');
      if(scene.draftExists) chips.push('<span class="scenePresetAdminShell__chip scenePresetAdminShell__chip--draft">draft</span>');
      if(scene.publishedExists) chips.push('<span class="scenePresetAdminShell__chip scenePresetAdminShell__chip--published">published</span>');
      if(active) chips.push('<span class="scenePresetAdminShell__chip scenePresetAdminShell__chip--active">selected</span>');
      const sub=[scene.id];
      if(scene.preferredSource) sub.push('pref: ' + scene.preferredSource);
      if(scene.updatedAt) sub.push('upd: ' + formatTime(scene.updatedAt));
      return '<button class="scenePresetAdminShell__sceneItem' + (active ? ' isActive' : '') + '" data-scene-id="' + escapeHtml(scene.id) + '" type="button">'
        + '<span class="scenePresetAdminShell__sceneText">'
        +   '<span class="scenePresetAdminShell__sceneTitle">' + escapeHtml(scene.title || scene.id) + '</span>'
        +   '<span class="scenePresetAdminShell__sceneSub">' + escapeHtml(sub.join(' · ')) + '</span>'
        + '</span>'
        + '<span class="scenePresetAdminShell__chips">' + chips.join('') + '</span>'
        + '</button>';
    }).join('');
  }

  function draftFromSelectedScene(runtime){
    const selected=runtime.selectedSceneId ? runtime.sceneMap[runtime.selectedSceneId] : null;
    if(selected && selected.localRecord) return normalizeLocalDraft(selected.localRecord);
    if(selected){
      return createEmptyDraft({
        sceneId:selected.id,
        title:selected.title || selected.id,
        order:selected.order || 0,
        enabled:true,
        photoUrl:selected.photoUrl || null,
        thumbUrl:selected.thumbUrl || null,
        coverUrl:selected.coverUrl || null,
        source:selected.preferredSource || "draft"
      });
    }
    return createEmptyDraft();
  }

  function ensureEditorDraft(runtime){
    if(!runtime.editor.draft || typeof runtime.editor.draft !== "object") runtime.editor.draft = draftFromSelectedScene(runtime);
    if(!runtime.editor.draft.sceneId && runtime.selectedSceneId) runtime.editor.draft.sceneId = runtime.selectedSceneId;
    if(!runtime.editor.draft.id && runtime.editor.draft.sceneId) runtime.editor.draft.id = runtime.editor.draft.sceneId;
    return runtime.editor.draft;
  }

  function renderEditor(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    const draft=ensureEditorDraft(runtime);
    setIfDiff(r.inputSceneId, draft.sceneId || draft.id || "");
    setIfDiff(r.inputTitle, draft.title || "");
    setIfDiff(r.inputOrder, draft.order == null ? 0 : draft.order);
    if(r.inputEnabled) r.inputEnabled.checked = draft.enabled !== false;
    setIfDiff(r.inputPhotoUrl, safeGet(draft, ["photo", "sourceUrl"], ""));
    setIfDiff(r.inputThumbUrl, safeGet(draft, ["photo", "thumbUrl"], ""));
    setIfDiff(r.inputNote, safeGet(draft, ["meta", "adminNote"], ""));
    if(r.draftState){
      const source = draft.source || "local";
      const hasSnapshot = !!(draft.baseSnapshot && typeof draft.baseSnapshot === "object");
      const bits=[draft.sceneId || draft.id || "scene", source, runtime.editor.dirty ? "есть несохранённые изменения" : "чистый draft"];
      if(hasSnapshot) bits.push("base snapshot готов");
      if(runtime.editor.lastSavedAt) bits.push("saved: " + formatTime(runtime.editor.lastSavedAt));
      r.draftState.textContent = bits.join(" · ");
    }
  }

  function getGeometrySummary(){
    const zones=Array.isArray(state && state.zones) ? state.zones : [];
    const activeZoneId=safeGet(state,["ui","activeZoneId"],null);
    const zone=zones.find((z)=>z && z.id===activeZoneId) || zones[0] || null;
    const contour=Array.isArray(zone && zone.contour) ? zone.contour : [];
    const cutouts=Array.isArray(zone && zone.cutouts) ? zone.cutouts : [];
    const floorPoints=Array.isArray(state && state.floorPlane && state.floorPlane.points) ? state.floorPlane.points : [];
    const photoLoaded=!!(state && state.assets && state.assets.photoBitmap && state.assets.photoW && state.assets.photoH);
    const closedCutouts=cutouts.filter((c)=>c && c.closed && Array.isArray(c.points) && c.points.length>=3).length;
    const totalCutoutPoints=cutouts.reduce((sum,c)=>sum + ((c && Array.isArray(c.points)) ? c.points.length : 0), 0);
    const contourClosed=!!(zone && zone.closed);
    let readiness="need_photo";
    let title="Загрузите фото";
    let note="Без фото нельзя подготовить базовую геометрию сцены.";
    if(photoLoaded){
      readiness="need_contour";
      title="Поставьте точки контура";
      note="Нужно минимум 3 точки по основному периметру сцены.";
      if(contour.length>=3){
        readiness=contourClosed ? "ready" : "contour_open";
        title=contourClosed ? "Базовый контур готов" : "Замкните основной контур";
        note=contourClosed
          ? (cutouts.length ? "Можно уточнить вырезы и переходить к просмотру/захвату сцены." : "Можно добавить вырезы или сразу захватить базовую сцену в draft.")
          : "Основной контур ещё открыт. Замкните его перед сохранением сцены.";
      }
    }
    return {
      photoLoaded,
      activeStep:safeGet(state,["ui","activeStep"],"photo"),
      mode:safeGet(state,["ui","mode"],"photo"),
      zoneCount:zones.length,
      activeZoneId:zone && zone.id || null,
      contourPoints:contour.length,
      contourClosed,
      cutoutCount:cutouts.length,
      closedCutouts,
      totalCutoutPoints,
      floorPlanePoints:floorPoints.length,
      floorPlaneClosed:!!(state && state.floorPlane && state.floorPlane.closed),
      readiness,
      title,
      note
    };
  }

  function renderGeometryPanel(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    const g=getGeometrySummary();
    if(r.geometryState) r.geometryState.textContent = [g.title, g.note].join(" · ");
    if(r.geometryChips){
      const chips=[];
      chips.push('<span class="scenePresetAdminShell__chip ' + (g.photoLoaded ? 'scenePresetAdminShell__chip--ok' : 'scenePresetAdminShell__chip--warn') + '">фото ' + (g.photoLoaded ? 'готово' : 'не загружено') + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip ' + (g.contourClosed ? 'scenePresetAdminShell__chip--ok' : 'scenePresetAdminShell__chip--warn') + '">контур: ' + g.contourPoints + (g.contourClosed ? ' · замкнут' : ' · открыт') + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip">вырезы: ' + g.cutoutCount + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip">режим: ' + escapeHtml(g.mode) + '</span>');
      if(g.cutoutCount){ chips.push('<span class="scenePresetAdminShell__chip">замкнуто вырезов: ' + g.closedCutouts + '</span>'); }
      r.geometryChips.innerHTML = chips.join('');
    }
    if(r.geometryMeta){
      r.geometryMeta.innerHTML = [
        '<div class="scenePresetAdminShell__metaCard">',
        '<div class="scenePresetAdminShell__metaTitle">Статус базовой геометрии</div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Активный этап</span><span>' + escapeHtml(g.activeStep) + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Активная зона</span><span>' + escapeHtml(g.activeZoneId || '—') + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Зон в проекте</span><span>' + escapeHtml(String(g.zoneCount)) + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Точек контура</span><span>' + escapeHtml(String(g.contourPoints)) + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Вырезов</span><span>' + escapeHtml(String(g.cutoutCount)) + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Точек во вырезах</span><span>' + escapeHtml(String(g.totalCutoutPoints)) + '</span></div>',
        '<div class="scenePresetAdminShell__metaRow"><span>Floor plane</span><span>' + escapeHtml(String(g.floorPlanePoints)) + (g.floorPlaneClosed ? ' · closed' : '') + '</span></div>',
        '</div>'
      ].join('');
    }
    if(r.btnModeCutout) r.btnModeCutout.disabled = !(g.photoLoaded && g.contourClosed);
    if(r.btnCloseContour) r.btnCloseContour.disabled = !(g.photoLoaded && g.contourPoints >= 3 && !g.contourClosed);
    if(r.btnResetGeometry) r.btnResetGeometry.disabled = !(g.photoLoaded || g.contourPoints || g.cutoutCount);
    if(r.btnCapture) r.btnCapture.disabled = !(g.photoLoaded && g.contourClosed);
    return g;
  }

  function clickById(id){
    try{
      const node=document.getElementById(String(id||''));
      if(node && typeof node.click === 'function'){ node.click(); return true; }
    }catch(_){ }
    return false;
  }

  function runGeometryAction(action){
    const g=getGeometrySummary();
    if(action === 'contour'){
      const ok=clickById('modeContour');
      setStatus(ok ? 'Режим контура активирован' : 'Не удалось включить режим контура', ok ? 'Продолжайте выставлять или корректировать основной периметр сцены.' : 'Кнопка modeContour недоступна в текущем entrypoint.');
      renderGeometryPanel();
      return ok;
    }
    if(action === 'cutout'){
      if(!g.contourClosed){ setStatus('Сначала замкните основной контур', 'Режим выреза доступен только после подготовки базового контура.'); return false; }
      const ok=clickById('modeCutout');
      setStatus(ok ? 'Режим выреза активирован' : 'Не удалось включить режим выреза', ok ? 'Добавьте внутренние вырезы и затем вернитесь в просмотр.' : 'Кнопка modeCutout недоступна в текущем entrypoint.');
      renderGeometryPanel();
      return ok;
    }
    if(action === 'view'){
      const ok=clickById('modeView');
      setStatus(ok ? 'Режим просмотра активирован' : 'Не удалось переключиться в просмотр', ok ? 'Проверьте базовую геометрию и затем захватите сцену в draft.' : 'Кнопка modeView недоступна в текущем entrypoint.');
      renderGeometryPanel();
      return ok;
    }
    if(action === 'closeContour'){
      if(!g.contourPoints || g.contourClosed){ setStatus('Контур уже замкнут или не начат', 'Добавьте минимум 3 точки, если хотите замкнуть новый контур.'); return false; }
      const ok=clickById('closePolyBtn') || clickById('contourAssistCloseBtn');
      setStatus(ok ? 'Контур замыкается' : 'Не удалось замкнуть контур', ok ? 'Проверьте результат и при необходимости добавьте вырезы.' : 'Кнопка замыкания контура недоступна.');
      setTimeout(()=>{ try{ renderGeometryPanel(); }catch(_){ } }, 50);
      return ok;
    }
    if(action === 'reset'){
      const ok=clickById('resetZoneBtn');
      setStatus(ok ? 'Геометрия сцены сброшена' : 'Не удалось сбросить геометрию', ok ? 'Постройте контур сцены заново и снова захватите draft.' : 'Кнопка resetZoneBtn недоступна.');
      setTimeout(()=>{ try{ renderGeometryPanel(); }catch(_){ } }, 50);
      return ok;
    }
    return false;
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
        r.sceneMeta.innerHTML = '<div class="scenePresetAdminShell__empty">Создайте новую сцену или выберите существующую, чтобы редактировать метаданные и захватывать текущую сцену из runtime.</div>';
      }else{
        r.sceneMeta.innerHTML = [
          '<div class="scenePresetAdminShell__metaCard">',
          '<div class="scenePresetAdminShell__metaTitle">Выбранная сцена</div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Название</span><span>' + escapeHtml(selected.title || selected.id) + '</span></div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Scene ID</span><span>' + escapeHtml(selected.id) + '</span></div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Предпочтительный source</span><span>' + escapeHtml(selected.preferredSource || 'resolved') + '</span></div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Активна в runtime</span><span>' + escapeHtml(activeSceneId || '—') + '</span></div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Локальный draft</span><span>' + escapeHtml(selected.localExists ? 'да' : 'нет') + '</span></div>',
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
        '<div class="scenePresetAdminShell__metaRow"><span>Local drafts</span><span>' + escapeHtml(String(Object.keys(runtime.localDrafts || {}).length)) + '</span></div>'
        + '<div class="scenePresetAdminShell__metaRow"><span>Local variants</span><span>' + escapeHtml(String(Object.keys(runtime.localVariants || {}).length)) + '</span></div>',
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
        '<div class="scenePresetAdminShell__metaRow"><span>Текущий этап</span><span>scene + variant authoring</span></div>',
        '</div>'
      ].join('');
    }
    if(r.openDraftBtn) r.openDraftBtn.disabled = !(selected && ((selected.draftExists || selected.localExists) && runtime.config.allowDraftOpen));
    if(r.openPublishedBtn) r.openPublishedBtn.disabled = !(selected && selected.publishedExists && runtime.config.allowPublishedOpen);
    if(r.openResolvedBtn) r.openResolvedBtn.disabled = !selected;
    renderEditor();
    renderGeometryPanel();
    renderVariantPanel();
    renderPublishAutofill();
    renderPublishHelper();
    renderBulkAssetImport();
    renderQuickFlow();
  }

  function renderBulkAssetImport(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    runtime.bulkAssetImport = normalizeBulkAssetImport(runtime.bulkAssetImport);
    if(r.bulkAssetInput) setIfDiff(r.bulkAssetInput, runtime.bulkAssetImport.rawText || '');
    const scene=ensureEditorDraft(runtime);
    const variants=getSceneVariants(runtime, scene.sceneId);
    const cfg=normalizePublishAutofill(runtime.publishAutofill || createDefaultPublishAutofill());
    const analysis=analyzeBulkAssetImport(runtime.bulkAssetImport.rawText, scene, variants, cfg);
    runtime.bulkAssetImport.analysis = analysis;
    if(r.bulkAssetState){
      const bits=['строк: ' + String(analysis.totalEntries || 0), 'scene matches: ' + String(['photo','thumb','cover'].filter((k)=>analysis.scene && analysis.scene[k]).length) + '/3', 'variant matches: ' + String(analysis.matchedVariantCount || 0) + '/' + String((analysis.variants || []).length)];
      if(analysis.unmatched && analysis.unmatched.length) bits.push('неразобрано: ' + String(analysis.unmatched.length));
      r.bulkAssetState.textContent = bits.join(' · ');
    }
    if(r.bulkAssetMeta){
      const rows=[];
      rows.push('<div class="scenePresetAdminShell__metaCard">');
      rows.push('<div class="scenePresetAdminShell__metaTitle">Bulk asset import summary</div>');
      rows.push('<div class="scenePresetAdminShell__metaRow"><span>Scene photo</span><span>' + escapeHtml(analysis.scene && analysis.scene.photo ? analysis.scene.photo : '—') + '</span></div>');
      rows.push('<div class="scenePresetAdminShell__metaRow"><span>Scene thumb</span><span>' + escapeHtml(analysis.scene && analysis.scene.thumb ? analysis.scene.thumb : '—') + '</span></div>');
      rows.push('<div class="scenePresetAdminShell__metaRow"><span>Scene cover</span><span>' + escapeHtml(analysis.scene && analysis.scene.cover ? analysis.scene.cover : '—') + '</span></div>');
      rows.push('<div class="scenePresetAdminShell__metaRow"><span>Matched variants</span><span>' + escapeHtml(String(analysis.matchedVariantCount || 0)) + ' / ' + escapeHtml(String((analysis.variants || []).length)) + '</span></div>');
      rows.push('<div class="scenePresetAdminShell__metaRow"><span>Unmatched URLs</span><span>' + escapeHtml(String((analysis.unmatched || []).length)) + '</span></div>');
      rows.push('</div>');
      if((analysis.variants || []).length){
        rows.push('<div class="scenePresetAdminShell__metaCard">');
        rows.push('<div class="scenePresetAdminShell__metaTitle">Variant matches</div>');
        (analysis.variants || []).slice(0,12).forEach((item)=>{ rows.push('<div class="scenePresetAdminShell__metaRow"><span>' + escapeHtml(item.label) + '</span><span>' + escapeHtml(item.url ? 'matched' : '—') + '</span></div>'); });
        if((analysis.variants || []).length > 12) rows.push('<div class="scenePresetAdminShell__metaRow"><span>И ещё</span><span>' + escapeHtml(String((analysis.variants || []).length - 12)) + '</span></div>');
        rows.push('</div>');
      }
      if((analysis.unmatched || []).length){
        rows.push('<div class="scenePresetAdminShell__metaCard">');
        rows.push('<div class="scenePresetAdminShell__metaTitle">Unmatched URLs</div>');
        (analysis.unmatched || []).slice(0,8).forEach((url)=>{ rows.push('<div class="scenePresetAdminShell__metaRow"><span>asset</span><span>' + escapeHtml(url) + '</span></div>'); });
        if((analysis.unmatched || []).length > 8) rows.push('<div class="scenePresetAdminShell__metaRow"><span>И ещё</span><span>' + escapeHtml(String((analysis.unmatched || []).length - 8)) + '</span></div>');
        rows.push('</div>');
      }
      r.bulkAssetMeta.innerHTML = rows.join('');
    }
    if(r.btnAnalyzeBulkAssets) r.btnAnalyzeBulkAssets.disabled = !(runtime.bulkAssetImport.rawText || '').trim();
    if(r.btnApplyBulkAssets) r.btnApplyBulkAssets.disabled = !(analysis.totalEntries > 0);
    if(r.btnClearBulkAssets) r.btnClearBulkAssets.disabled = !(runtime.bulkAssetImport.rawText || '').trim();
  }

  function analyzeCurrentBulkAssets(){
    const runtime=ensureRuntime(state||{});
    const scene=ensureEditorDraft(runtime);
    const variants=getSceneVariants(runtime, scene.sceneId);
    const cfg=normalizePublishAutofill(runtime.publishAutofill || createDefaultPublishAutofill());
    const raw=(readBulkAssetImport().rawText || '');
    runtime.bulkAssetImport.analysis = analyzeBulkAssetImport(raw, scene, variants, cfg);
    persistBulkAssetImport(runtime);
    renderBulkAssetImport();
    const a=runtime.bulkAssetImport.analysis;
    setStatus('Bulk asset list проанализирован', 'Scene matches: ' + String(['photo','thumb','cover'].filter((k)=>a.scene && a.scene[k]).length) + '/3 · variant matches: ' + String(a.matchedVariantCount || 0) + '/' + String((a.variants || []).length));
    return a;
  }

  function applyBulkAssetImport(){
    const runtime=ensureRuntime(state||{});
    const scene=ensureEditorDraft(runtime);
    const variants=getSceneVariants(runtime, scene.sceneId);
    const cfg=normalizePublishAutofill(runtime.publishAutofill || createDefaultPublishAutofill());
    const data=analyzeBulkAssetImport(readBulkAssetImport().rawText || '', scene, variants, cfg);
    runtime.bulkAssetImport.analysis = data;
    let sceneApplied=0;
    let variantApplied=0;
    const nextScene=deepClone(scene);
    nextScene.photo = nextScene.photo && typeof nextScene.photo==='object' ? nextScene.photo : {};
    if(data.scene.photo){ nextScene.photo.sourceUrl = data.scene.photo; sceneApplied += 1; }
    if(data.scene.thumb){ nextScene.photo.thumbUrl = data.scene.thumb; sceneApplied += 1; }
    if(data.scene.cover){ nextScene.photo.coverUrl = data.scene.cover; sceneApplied += 1; }
    nextScene.updatedAt = new Date().toISOString();
    updateRuntimeLocalSceneIndex(runtime, nextScene);
    persistLocalDrafts(runtime);
    setEditorDraft(nextScene, { dirty:false, lastSavedAt:nextScene.updatedAt });
    const updated={};
    (data.variants || []).forEach((match)=>{
      if(!match.url || !runtime.localVariants[match.key]) return;
      const v=deepClone(runtime.localVariants[match.key]);
      v.previewUrl = match.url;
      v.updatedAt = new Date().toISOString();
      updated[match.key]=v;
      variantApplied += 1;
    });
    Object.keys(updated).forEach((k)=>{ runtime.localVariants[k]=normalizeLocalVariant(updated[k]); });
    if(variantApplied) persistLocalVariants(runtime);
    const current=runtime.variantEditor && runtime.variantEditor.draft && runtime.variantEditor.draft.key ? runtime.localVariants[runtime.variantEditor.draft.key] : null;
    if(current) setVariantDraft(current, { dirty:false, lastSavedAt:current.updatedAt || null });
    persistBulkAssetImport(runtime);
    renderPublishAutofill();
    renderPublishHelper();
    renderBulkAssetImport();
    setStatus('Bulk asset import применён', 'Scene URLs: ' + String(sceneApplied) + ' · variant previews: ' + String(variantApplied) + ' · unmatched: ' + String((data.unmatched || []).length));
    return { sceneApplied, variantApplied, unmatched:(data.unmatched || []).length };
  }

  function clearBulkAssetImport(){
    const runtime=ensureRuntime(state||{});
    runtime.bulkAssetImport = normalizeBulkAssetImport({ rawText:'', analysis:null });
    persistBulkAssetImport(runtime);
    renderBulkAssetImport();
    setStatus('Bulk asset список очищен', 'Можно вставить новый список URL и снова выполнить разбор.');
  }

  function renderQuickFlow(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    const scene=ensureEditorDraft(runtime);
    const variants=getSceneVariants(runtime, scene.sceneId);
    const geom=getGeometrySummary();
    const ctx=getActiveVariantContext(runtime);
    const cfg=normalizePublishAutofill(runtime.publishAutofill || createDefaultPublishAutofill());
    const readiness=computePublishReadiness(scene, variants, cfg);
    if(r.quickState){
      const steps=[];
      steps.push(scene.sceneId ? 'Сцена: ' + scene.sceneId : 'Сначала создайте сцену');
      if(!geom.photoLoaded) steps.push('Загрузите фото');
      else if(!geom.contourClosed) steps.push('Замкните контур');
      else if(!scene.baseSnapshot) steps.push('Сохраните сцену');
      else if(!variants.length) steps.push('Сохраните хотя бы один вариант');
      else if(!readiness.ok) steps.push('Заполните обязательные publish-данные');
      else steps.push('Можно экспортировать готовый архив');
      r.quickState.textContent = steps.join(' · ');
    }
    if(r.quickChips){
      const chips=[];
      chips.push('<span class="scenePresetAdminShell__chip ' + (scene.sceneId ? 'scenePresetAdminShell__chip--ok':'scenePresetAdminShell__chip--warn') + '">sceneId ' + escapeHtml(scene.sceneId || 'не задан') + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip ' + (geom.photoLoaded ? 'scenePresetAdminShell__chip--ok':'scenePresetAdminShell__chip--warn') + '">фото ' + (geom.photoLoaded?'загружено':'не загружено') + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip ' + (geom.contourClosed ? 'scenePresetAdminShell__chip--ok':'scenePresetAdminShell__chip--warn') + '">контур ' + (geom.contourClosed?'готов':'не готов') + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip ' + (scene.baseSnapshot ? 'scenePresetAdminShell__chip--ok':'scenePresetAdminShell__chip--warn') + '">scene draft ' + (scene.baseSnapshot?'готов':'нет') + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip ' + (variants.length ? 'scenePresetAdminShell__chip--ok':'scenePresetAdminShell__chip--warn') + '">variants: ' + String(variants.length) + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip ' + (ctx.hasShape ? 'scenePresetAdminShell__chip--ok':'scenePresetAdminShell__chip--warn') + '">shape: ' + escapeHtml(ctx.shapeId || '—') + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip ' + (ctx.hasTexture ? 'scenePresetAdminShell__chip--ok':'scenePresetAdminShell__chip--warn') + '">texture: ' + escapeHtml(ctx.textureId || '—') + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip ' + (readiness.ok ? 'scenePresetAdminShell__chip--ok':'scenePresetAdminShell__chip--warn') + '">' + (readiness.ok?'export готов':'нужны правки') + '</span>');
      r.quickChips.innerHTML = chips.join('');
    }
    if(r.btnQuickSaveScene) r.btnQuickSaveScene.disabled = !(geom.photoLoaded && geom.contourClosed);
    if(r.btnQuickSaveVariant) r.btnQuickSaveVariant.disabled = !(scene.baseSnapshot && ctx.hasShape && ctx.hasTexture);
    if(r.btnQuickFinalizeExport) r.btnQuickFinalizeExport.disabled = !(scene.sceneId && scene.baseSnapshot && variants.length);
  }

  async function runQuickNewSceneFlow(){
    seedNewScene();
    promptPhotoUpload();
    renderQuickFlow();
  }

  async function runQuickSaveSceneFlow(){
    const scene=await saveLocalDraft();
    renderQuickFlow();
    setStatus('Сцена сохранена', (scene.title || scene.sceneId) + ' · теперь настраивайте первую текстуру и сохраняйте варианты.');
    return scene;
  }

  async function runQuickSaveVariantFlow(){
    const variant=await saveLocalVariant();
    renderQuickFlow();
    setStatus('Вариант сохранён', (variant.shapeId || 'shape') + ' · ' + (variant.textureId || 'texture') + ' · можно переходить к следующей текстуре.');
    return variant;
  }

  async function runQuickFinalizeExportFlow(){
    const runtime=ensureRuntime(state||{});
    const scene=ensureEditorDraft(runtime);
    if(scene.sceneId) applyPublishAutofillToScene();
    const variants=getSceneVariants(runtime, scene.sceneId);
    if(variants.length) applyPublishAutofillToVariants();
    renderPublishHelper();
    renderQuickFlow();
    const cfg=normalizePublishAutofill(runtime.publishAutofill || createDefaultPublishAutofill());
    const readiness=computePublishReadiness(ensureEditorDraft(runtime), getSceneVariants(runtime, ensureEditorDraft(runtime).sceneId), cfg);
    if(!readiness.ok){
      setStatus('Архив пока не готов', readiness.errors.join(' · '));
      throw new Error(readiness.errors.join(' · '));
    }
    return exportScenePackage();
  }

  function toggleAdvancedPublishTools(){
    try{
      const root=document.getElementById('scenePresetAdminShellAdvanced');
      if(!root) return false;
      root.open = !root.open;
      const r=getRefs();
      if(r.btnQuickToggleAdvanced) r.btnQuickToggleAdvanced.textContent = root.open ? 'Скрыть расширенные инструменты' : 'Показать расширенные инструменты';
      return root.open;
    }catch(_){ return false; }
  }

  function renderPublishAutofill(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    const cfg=normalizePublishAutofill(runtime.publishAutofill || createDefaultPublishAutofill());
    runtime.publishAutofill = cfg;
    setIfDiff(r.inputPagesBase, cfg.pagesBase);
    setIfDiff(r.inputMediaDir, cfg.mediaDir);
    setIfDiff(r.inputPreviewsDir, cfg.previewsDir);
    setIfDiff(r.inputScenePhotoFile, cfg.scenePhotoFile);
    setIfDiff(r.inputSceneThumbFile, cfg.sceneThumbFile);
    setIfDiff(r.inputSceneCoverFile, cfg.sceneCoverFile);
    setIfDiff(r.inputVariantPreviewExt, cfg.variantPreviewExt);
    const scene=ensureEditorDraft(runtime);
    const variants=getSceneVariants(runtime, scene.sceneId);
    const photoUrl=buildPublishedAssetUrl(scene.sceneId, cfg, 'photo');
    const thumbUrl=buildPublishedAssetUrl(scene.sceneId, cfg, 'thumb');
    const coverUrl=buildPublishedAssetUrl(scene.sceneId, cfg, 'cover');
    const sampleVariant=variants[0] ? buildPublishedVariantPreviewUrl(scene.sceneId, variants[0], cfg) : null;
    if(r.helperAutofillState){
      const bits=[cfg.pagesBase || 'base не задан'];
      bits.push('scene assets: ' + cfg.mediaDir);
      bits.push('variant previews: ' + cfg.previewsDir);
      if(photoUrl) bits.push('photo → ' + photoUrl);
      if(sampleVariant) bits.push('preview → ' + sampleVariant);
      r.helperAutofillState.textContent = bits.join(' · ');
    }
    if(r.btnAutofillSceneUrls) r.btnAutofillSceneUrls.disabled = !scene.sceneId;
    if(r.btnAutofillVariantPreviews) r.btnAutofillVariantPreviews.disabled = !scene.sceneId || !variants.length;
    if(r.btnSaveAutofillPreset) r.btnSaveAutofillPreset.disabled = !cfg.pagesBase;
  }

  function applyPublishAutofillToScene(){
    const runtime=ensureRuntime(state||{});
    const cfg=readPublishAutofill();
    const scene=readEditorDraft();
    if(!scene.sceneId) throw new Error('Scene ID не задан');
    scene.photo = scene.photo && typeof scene.photo === 'object' ? scene.photo : {};
    scene.photo.sourceUrl = buildPublishedAssetUrl(scene.sceneId, cfg, 'photo');
    scene.photo.thumbUrl = buildPublishedAssetUrl(scene.sceneId, cfg, 'thumb');
    scene.photo.coverUrl = buildPublishedAssetUrl(scene.sceneId, cfg, 'cover');
    scene.updatedAt = new Date().toISOString();
    runtime.editor.draft = normalizeLocalDraft(scene);
    updateRuntimeLocalSceneIndex(runtime, runtime.editor.draft);
    persistLocalDrafts(runtime);
    runtime.editor.dirty = false;
    persistPublishAutofill(runtime);
    renderEditor();
    renderPublishAutofill();
    renderPublishHelper();
    setStatus('URL сцены автозаполнены', 'photo/thumb/cover проставлены по repo-структуре для published сцены.');
    return scene;
  }

  function applyPublishAutofillToVariants(){
    const runtime=ensureRuntime(state||{});
    const cfg=readPublishAutofill();
    const scene=ensureEditorDraft(runtime);
    const variants=getSceneVariants(runtime, scene.sceneId);
    if(!scene.sceneId) throw new Error('Scene ID не задан');
    if(!variants.length) throw new Error('Для сцены пока нет local variants');
    variants.forEach((variant)=>{
      variant.previewUrl = buildPublishedVariantPreviewUrl(scene.sceneId, variant, cfg);
      runtime.localVariants[variant.key] = normalizeLocalVariant(variant);
    });
    const current=runtime.variantEditor && runtime.variantEditor.draft ? normalizeLocalVariant(runtime.variantEditor.draft) : null;
    if(current && current.sceneId===scene.sceneId && current.shapeId && current.textureId){
      current.previewUrl = buildPublishedVariantPreviewUrl(scene.sceneId, current, cfg);
      runtime.variantEditor.draft = current;
    }
    persistLocalVariants(runtime);
    persistPublishAutofill(runtime);
    renderVariantPanel();
    renderPublishAutofill();
    renderPublishHelper();
    setStatus('Preview URL вариантов автозаполнены', 'Проставлены previewUrl для всех local variants выбранной сцены.');
    return variants.length;
  }

  function renderPublishHelper(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    const scene=ensureEditorDraft(runtime);
    const variants=getSceneVariants(runtime, scene.sceneId);
    const manifestEntry=makePublishedManifestEntry(scene, variants.length);
    const cfg=normalizePublishAutofill(runtime.publishAutofill || createDefaultPublishAutofill());
    const readiness=computePublishReadiness(scene, variants, cfg);
    const paths=listPublishedPackagePaths(scene, variants, cfg);
    const packageSummary=makePackageSummary(scene, variants, cfg, readiness);
    const deployLines=[
      '1. Нажмите «Экспорт repo-пакета сцены».',
      '2. Распакуйте zip рядом с репозиторием.',
      '3. Замените или добавьте папку: preset-scenes/published/' + String(scene.sceneId || 'scene') + '/',
      '4. Откройте published manifest.json и добавьте туда manifest entry ниже.',
      '4.1. При необходимости нажмите «Автозаполнить URL сцены» и «Автозаполнить preview URL вариантов» перед экспортом пакета.',
      '5. Сделайте commit / push в GitHub Pages.',
      '6. Проверьте, что scene.json, variants.json и все variant json попали в репозиторий.'
    ];
    if(readiness.warnings.length){
      readiness.warnings.forEach((warn)=>deployLines.push('WARNING: ' + warn));
    }
    if(r.helperStatus){
      const bits=[scene.sceneId || 'scene'];
      bits.push(readiness.hasBase ? 'base scene готова' : 'base scene ещё не захвачена');
      bits.push('variants: ' + String(variants.length));
      bits.push(readiness.hasPhotoUrl ? 'photo URL задан' : 'photo URL пустой');
      if(readiness.ok) bits.push('publish ready');
      else bits.push('publish blocked');
      if(readiness.missingPreviewCount) bits.push('preview warning: ' + String(readiness.missingPreviewCount));
      r.helperStatus.textContent = bits.join(' · ');
    }
    if(r.helperPaths) r.helperPaths.value = paths.join('\n');
    if(r.helperManifest) r.helperManifest.value = JSON.stringify(manifestEntry, null, 2);
    if(r.helperDeploy) r.helperDeploy.value = deployLines.join('\n');
    if(r.helperPackage) r.helperPackage.value = JSON.stringify(packageSummary, null, 2);
    if(r.btnCopyManifest) r.btnCopyManifest.disabled = !scene.sceneId;
    if(r.btnCopyPaths) r.btnCopyPaths.disabled = !scene.sceneId;
    if(r.btnCopyDeploy) r.btnCopyDeploy.disabled = !scene.sceneId;
    if(r.btnCopyPackage) r.btnCopyPackage.disabled = !scene.sceneId;
    if(r.btnExportPackage) r.btnExportPackage.disabled = !readiness.ok;
  }

  function renderPackageImport(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    const last=runtime.packageImport && runtime.packageImport.lastResult ? runtime.packageImport.lastResult : null;
    if(r.importPackageState){
      if(!last) r.importPackageState.textContent = 'Можно импортировать ранее экспортированный published package zip обратно в local authoring state.';
      else r.importPackageState.textContent = 'Импортирован пакет сцены: ' + String(last.sceneId || 'scene') + ' · variants: ' + String(last.variantsCount || 0) + ' · files: ' + String(last.filesCount || 0) + (last.autofillLoaded ? ' · autofill preset восстановлен' : '');
    }
    if(r.importPackageMeta){
      if(!last){
        r.importPackageMeta.innerHTML = '<div class="scenePresetAdminShell__empty">Выберите exported package zip из предыдущего экспорта. Helper восстановит scene draft, local variants и publish autofill preset.</div>';
      }else{
        const warns=Array.isArray(last.warnings) ? last.warnings : [];
        r.importPackageMeta.innerHTML = [
          '<div class="scenePresetAdminShell__metaCard">',
          '<div class="scenePresetAdminShell__metaTitle">Последний импорт package</div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Scene ID</span><span>' + escapeHtml(last.sceneId || '—') + '</span></div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Вариантов восстановлено</span><span>' + escapeHtml(String(last.variantsCount || 0)) + '</span></div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Файлов в zip</span><span>' + escapeHtml(String(last.filesCount || 0)) + '</span></div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Autofill preset</span><span>' + escapeHtml(last.autofillLoaded ? 'восстановлен' : 'не найден') + '</span></div>',
          '<div class="scenePresetAdminShell__metaRow"><span>Импортирован</span><span>' + escapeHtml(formatTime(last.importedAt || null)) + '</span></div>',
          (warns.length ? '<div class="scenePresetAdminShell__metaRow"><span>Warnings</span><span>' + escapeHtml(String(warns.length)) + '</span></div>' : ''),
          '</div>'
        ].join('');
      }
    }
    if(r.btnImportPackage) r.btnImportPackage.disabled = false;
  }

  function renderVariantPanel(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    const ctx=getActiveVariantContext(runtime);
    const draft=ensureVariantDraft(runtime);
    const variants=getSceneVariants(runtime, ctx.sceneId);
    setIfDiff(r.inputVariantShapeId, draft.shapeId || ctx.shapeId || "");
    setIfDiff(r.inputVariantTextureId, draft.textureId || ctx.textureId || "");
    setIfDiff(r.inputVariantTitle, draft.title || "");
    setIfDiff(r.inputVariantPreviewUrl, draft.previewUrl || "");
    setIfDiff(r.inputVariantNote, safeGet(draft,["meta","adminNote"],""));
    if(r.variantState){
      const bits=[ctx.sceneId || "scene"];
      if(ctx.shapeId) bits.push("shape: " + ctx.shapeId); else bits.push("shape не выбран");
      if(ctx.textureId) bits.push("texture: " + ctx.textureId); else bits.push("texture не выбрана");
      bits.push(runtime.variantEditor && runtime.variantEditor.dirty ? "есть несохранённые изменения" : "чистый variant draft");
      if(runtime.variantEditor && runtime.variantEditor.lastSavedAt) bits.push("saved: " + formatTime(runtime.variantEditor.lastSavedAt));
      r.variantState.textContent = bits.join(" · ");
    }
    if(r.variantContext){
      const chips=[];
      chips.push('<span class="scenePresetAdminShell__chip ' + (ctx.sceneReady ? 'scenePresetAdminShell__chip--ok' : 'scenePresetAdminShell__chip--warn') + '">scene base ' + (ctx.sceneReady ? 'готов' : 'не захвачен') + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip ' + (ctx.hasShape ? 'scenePresetAdminShell__chip--ok' : 'scenePresetAdminShell__chip--warn') + '">shape: ' + escapeHtml(ctx.shapeId || '—') + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip ' + (ctx.hasTexture ? 'scenePresetAdminShell__chip--ok' : 'scenePresetAdminShell__chip--warn') + '">texture: ' + escapeHtml(ctx.textureId || '—') + '</span>');
      chips.push('<span class="scenePresetAdminShell__chip">вариантов для сцены: ' + String(variants.length) + '</span>');
      if(ctx.zoneId) chips.push('<span class="scenePresetAdminShell__chip">zone: ' + escapeHtml(ctx.zoneId) + '</span>');
      r.variantContext.innerHTML = chips.join('');
    }
    if(r.variantList){
      if(!variants.length){
        r.variantList.innerHTML = '<div class="scenePresetAdminShell__empty">Для выбранной сцены ещё нет local variant drafts. Выберите форму и текстуру в редакторе, затем нажмите «Захватить текущий вариант».</div>';
      }else{
        r.variantList.innerHTML = variants.map((v)=>{
          const active=draft && draft.key===v.key;
          const sub=[v.shapeId || 'shape', v.textureId || 'texture'];
          if(v.updatedAt) sub.push('upd: ' + formatTime(v.updatedAt));
          return '<button class="scenePresetAdminShell__sceneItem' + (active ? ' isActive' : '') + '" data-variant-key="' + escapeHtml(v.key) + '" type="button">'
            + '<span class="scenePresetAdminShell__sceneText">'
            +   '<span class="scenePresetAdminShell__sceneTitle">' + escapeHtml(v.title || v.key) + '</span>'
            +   '<span class="scenePresetAdminShell__sceneSub">' + escapeHtml(sub.join(' · ')) + '</span>'
            + '</span>'
            + '<span class="scenePresetAdminShell__chips"><span class="scenePresetAdminShell__chip scenePresetAdminShell__chip--local">local</span></span>'
            + '</button>';
        }).join('');
      }
    }
    if(r.btnCaptureVariant) r.btnCaptureVariant.disabled = !(ctx.sceneReady && ctx.hasShape && ctx.hasTexture);
    if(r.btnSaveVariantLocal) r.btnSaveVariantLocal.disabled = !(draft && draft.shapeId && draft.textureId);
    if(r.btnOpenVariantLocal) r.btnOpenVariantLocal.disabled = !(draft && draft.key && runtime.localVariants && runtime.localVariants[draft.key]);
    if(r.btnExportVariant) r.btnExportVariant.disabled = !(ctx.hasShape && ctx.hasTexture);
  }

  function markVariantDirty(flag){
    const runtime=ensureRuntime(state||{});
    runtime.variantEditor = runtime.variantEditor || { draft:null, dirty:false, lastSavedAt:null };
    runtime.variantEditor.dirty = flag !== false;
    renderVariantPanel();
  }

  function readVariantDraft(){
    const runtime=ensureRuntime(state||{});
    const current=ensureVariantDraft(runtime);
    const r=getRefs();
    const ctx=getActiveVariantContext(runtime);
    const shapeId=String((r.inputVariantShapeId && r.inputVariantShapeId.value) || current.shapeId || ctx.shapeId || "").trim() || null;
    const textureId=String((r.inputVariantTextureId && r.inputVariantTextureId.value) || current.textureId || ctx.textureId || "").trim() || null;
    const next=deepClone(current);
    next.sceneId = ctx.sceneId;
    next.shapeId = shapeId;
    next.textureId = textureId;
    next.key = makeVariantKey(next.sceneId, shapeId || "shape", textureId || "texture");
    next.id = next.key;
    next.title = String((r.inputVariantTitle && r.inputVariantTitle.value) || next.title || next.key).trim() || next.key;
    next.previewUrl = String((r.inputVariantPreviewUrl && r.inputVariantPreviewUrl.value) || next.previewUrl || "").trim() || null;
    next.meta = next.meta && typeof next.meta === "object" ? next.meta : {};
    next.meta.adminNote = String((r.inputVariantNote && r.inputVariantNote.value) || next.meta.adminNote || "").trim() || null;
    next.updatedAt = new Date().toISOString();
    runtime.variantEditor.draft = next;
    return next;
  }

  function setVariantDraft(variant, options){
    const runtime=ensureRuntime(state||{});
    runtime.variantEditor = runtime.variantEditor || { draft:null, dirty:false, lastSavedAt:null };
    runtime.variantEditor.draft = normalizeLocalVariant(variant);
    runtime.variantEditor.lastSavedAt = options && options.lastSavedAt ? options.lastSavedAt : runtime.variantEditor.lastSavedAt;
    runtime.variantEditor.dirty = options && typeof options.dirty === "boolean" ? options.dirty : false;
    renderVariantPanel();
  }

  async function captureCurrentVariant(options){
    const runtime=ensureRuntime(state||{});
    const ctx=getActiveVariantContext(runtime);
    const sceneDraft=ensureEditorDraft(runtime);
    const current=readVariantDraft();
    if(!sceneDraft || !sceneDraft.baseSnapshot) throw new Error("Сначала захватите и сохраните базовую сцену (scene draft)");
    if(!ctx.hasShape && !current.shapeId) throw new Error("Shape не выбран: сначала выберите форму");
    if(!ctx.hasTexture && !current.textureId) throw new Error("Texture не выбрана: сначала выберите текстуру");
    if(!PST || typeof PST.serializeVariantSnapshot !== "function") throw new Error("Variant serializer is unavailable");
    const payload=PST.serializeVariantSnapshot({
      state,
      sceneId:sceneDraft.sceneId,
      shapeId:current.shapeId || ctx.shapeId,
      textureId:current.textureId || ctx.textureId,
      title:current.title,
      meta:current.meta || {}
    });
    payload.previewUrl = current.previewUrl || null;
    payload.source = "local";
    runtime.variantEditor.draft = normalizeLocalVariant(payload);
    runtime.variantEditor.dirty = !(options && options.cleanAfterCapture);
    renderVariantPanel();
    setStatus("Вариант захвачен в draft", (payload.shapeId || 'shape') + ' · ' + (payload.textureId || 'texture') + ' · можно сохранить, экспортировать или открыть позже.');
    return runtime.variantEditor.draft;
  }

  function updateRuntimeLocalVariantIndex(runtime, variant){
    const normalized=normalizeLocalVariant(variant);
    runtime.localVariants[normalized.key] = normalized;
    runtime.variantEditor.lastSavedAt = normalized.updatedAt || new Date().toISOString();
    renderVariantPanel();
    return normalized;
  }

  async function saveLocalVariant(){
    const runtime=ensureRuntime(state||{});
    const variant=await captureCurrentVariant({ cleanAfterCapture:true });
    variant.updatedAt = new Date().toISOString();
    updateRuntimeLocalVariantIndex(runtime, variant);
    const ok=persistLocalVariants(runtime);
    runtime.variantEditor.dirty = false;
    renderVariantPanel();
    if(!ok) setStatus("Не удалось сохранить local variant", "Проверьте доступность localStorage. Для backup используйте экспорт variant.json.");
    else setStatus("Local variant сохранён", (variant.shapeId || 'shape') + ' · ' + (variant.textureId || 'texture') + ' · вариант доступен в списке сцены.');
    return variant;
  }

  async function openLocalVariant(variant){
    const runtime=ensureRuntime(state||{});
    const target=variant && typeof variant === "object" ? normalizeLocalVariant(variant) : (runtime.variantEditor && runtime.variantEditor.draft ? normalizeLocalVariant(runtime.variantEditor.draft) : null);
    if(!target) throw new Error("Variant is not selected");
    const bridge=window.PhotoPaveAppBridge || null;
    if(!bridge || typeof bridge.openVariantPresetRecord !== "function") throw new Error("PhotoPaveAppBridge is unavailable");
    await bridge.openVariantPresetRecord(target, { context:"admin", source:"local" });
    setVariantDraft(target, { dirty:false, lastSavedAt:target.updatedAt || null });
    setStatus("Local variant открыт", (target.shapeId || 'shape') + ' · ' + (target.textureId || 'texture') + ' · можно продолжать ручную настройку.');
    return target;
  }

  async function exportCurrentVariant(){
    const variant=await captureCurrentVariant({ cleanAfterCapture:true });
    downloadJson((variant.key || 'variant') + '.json', variant);
    setStatus("Variant JSON выгружен", "Файл можно хранить как backup или импортировать на другом устройстве.");
  }

  async function importVariantFile(file){
    if(!file) return;
    const text=await file.text();
    const parsed=JSON.parse(text);
    const variant=normalizeLocalVariant(parsed);
    const runtime=ensureRuntime(state||{});
    updateRuntimeLocalVariantIndex(runtime, variant);
    persistLocalVariants(runtime);
    setVariantDraft(variant, { dirty:false, lastSavedAt:variant.updatedAt || null });
    setStatus("Variant JSON импортирован", (variant.shapeId || 'shape') + ' · ' + (variant.textureId || 'texture') + ' · local variant готов к открытию.');
  }

  function markEditorDirty(flag){
    const runtime=ensureRuntime(state||{});
    runtime.editor.dirty = flag !== false;
    renderEditor();
  }

  function readEditorDraft(){
    const runtime=ensureRuntime(state||{});
    const r=getRefs();
    const current=ensureEditorDraft(runtime);
    const title=String((r.inputTitle && r.inputTitle.value) || current.title || "scene").trim() || "scene";
    const requestedSceneId=String((r.inputSceneId && r.inputSceneId.value) || current.sceneId || current.id || title).trim() || title;
    const sceneId=normalizeSceneId(requestedSceneId || title, title);
    const next=deepClone(current);
    next.sceneId = sceneId;
    next.id = sceneId;
    next.title = title;
    next.order = Number((r.inputOrder && r.inputOrder.value) || 0) || 0;
    next.enabled = !!(r.inputEnabled && r.inputEnabled.checked);
    next.photo = next.photo && typeof next.photo === "object" ? next.photo : {};
    next.photo.sourceUrl = String((r.inputPhotoUrl && r.inputPhotoUrl.value) || next.photo.sourceUrl || "").trim() || null;
    next.photo.thumbUrl = String((r.inputThumbUrl && r.inputThumbUrl.value) || next.photo.thumbUrl || "").trim() || null;
    next.meta = next.meta && typeof next.meta === "object" ? next.meta : {};
    next.meta.adminNote = String((r.inputNote && r.inputNote.value) || next.meta.adminNote || "").trim() || null;
    next.updatedAt = new Date().toISOString();
    runtime.editor.draft = next;
    if(r.inputSceneId) r.inputSceneId.value = sceneId;
    return next;
  }

  function setEditorDraft(draft, options){
    const runtime=ensureRuntime(state||{});
    runtime.editor.draft = normalizeLocalDraft(draft);
    runtime.editor.lastSavedAt = options && options.lastSavedAt ? options.lastSavedAt : runtime.editor.lastSavedAt;
    runtime.editor.dirty = options && typeof options.dirty === "boolean" ? options.dirty : false;
    if(runtime.editor.draft.sceneId) runtime.selectedSceneId = runtime.editor.draft.sceneId;
    renderSceneList();
    renderMeta();
    renderGeometryPanel();
  }

  async function captureCurrentScene(options){
    const runtime=ensureRuntime(state||{});
    const draft=readEditorDraft();
    const geom=getGeometrySummary();
    if(!geom.photoLoaded) throw new Error("Фото не загружено: сначала загрузите фото сцены");
    if(geom.contourPoints < 3) throw new Error("Контур сцены ещё не подготовлен: нужно минимум 3 точки");
    if(!geom.contourClosed) throw new Error("Контур сцены ещё открыт: замкните его перед захватом base snapshot");
    if(!PST || typeof PST.serializeSceneBase !== "function") throw new Error("Scene serializer is unavailable");
    const payload=PST.serializeSceneBase({
      state,
      sceneId:draft.sceneId,
      title:draft.title,
      photo:{
        sourceUrl: safeGet(draft, ["photo", "sourceUrl"], null),
        thumbUrl: safeGet(draft, ["photo", "thumbUrl"], null),
        coverUrl: safeGet(draft, ["photo", "coverUrl"], null)
      },
      meta:draft.meta || {}
    });
    payload.order = draft.order || 0;
    payload.enabled = draft.enabled !== false;
    payload.updatedAt = new Date().toISOString();
    payload.photo = payload.photo && typeof payload.photo === "object" ? payload.photo : {};
    if(safeGet(draft, ["photo", "sourceUrl"], null)) payload.photo.sourceUrl = draft.photo.sourceUrl;
    if(safeGet(draft, ["photo", "thumbUrl"], null)) payload.photo.thumbUrl = draft.photo.thumbUrl;
    if(safeGet(draft, ["photo", "coverUrl"], null)) payload.photo.coverUrl = draft.photo.coverUrl;
    payload.meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {};
    if(draft.meta && draft.meta.adminNote) payload.meta.adminNote = draft.meta.adminNote;
    payload.source = "local";
    runtime.editor.draft = normalizeLocalDraft(payload);
    runtime.editor.dirty = !(options && options.cleanAfterCapture);
    renderMeta();
    setStatus("Сцена захвачена в draft", "Композиция, базовый контур и " + String(geom.cutoutCount || 0) + " вырез(а/ов) готовы к сохранению или экспорту.");
    return runtime.editor.draft;
  }

  function updateRuntimeLocalSceneIndex(runtime, scene){
    runtime.localDrafts[scene.sceneId] = normalizeLocalDraft(scene);
    runtime.editor.lastSavedAt = runtime.localDrafts[scene.sceneId].updatedAt || new Date().toISOString();
    buildMergedScenes(runtime);
    renderSceneList();
    renderMeta();
  }

  async function saveLocalDraft(){
    const runtime=ensureRuntime(state||{});
    const scene=await captureCurrentScene({ cleanAfterCapture:true });
    scene.updatedAt = new Date().toISOString();
    updateRuntimeLocalSceneIndex(runtime, scene);
    const ok=persistLocalDrafts(runtime);
    runtime.editor.dirty = false;
    renderEditor();
    if(!ok) setStatus("Не удалось сохранить local draft", "Проверьте, доступен ли localStorage в текущем iframe/браузере. Для страховки используйте экспорт JSON.");
    else setStatus("Local draft сохранён", (scene.title || scene.sceneId) + " · можно открыть, экспортировать или продолжить настройку.");
    return scene;
  }

  function makeSceneRecordFromLocal(scene){
    const normalized=normalizeLocalDraft(scene);
    return {
      id:normalized.sceneId,
      sceneId:normalized.sceneId,
      title:normalized.title || normalized.sceneId,
      source:"local",
      status:"draft-local",
      updatedAt:normalized.updatedAt || null,
      urls:{
        sceneUrl:null,
        sceneDirUrl:null,
        photoUrl:safeGet(normalized,["photo","sourceUrl"],null),
        thumbUrl:safeGet(normalized,["photo","thumbUrl"],null),
        coverUrl:safeGet(normalized,["photo","coverUrl"],null),
        variantsIndexUrl:null
      },
      photo:normalized.photo || {},
      floorPlane:normalized.floorPlane || { points:[], closed:false },
      baseSnapshot:normalized.baseSnapshot || {
        ui:normalized.ui || null,
        catalog:normalized.catalog || null,
        floorPlane:normalized.floorPlane || { points:[], closed:false },
        zones:Array.isArray(normalized.zones) ? deepClone(normalized.zones) : []
      },
      defaults:{ shapeId:safeGet(normalized,["catalog","activeShapeId"],null), textureId:null, variantKey:null },
      meta:normalized.meta || {},
      variantKeys:[],
      variantIndex:{},
      order:normalized.order || 0,
      enabled:normalized.enabled !== false
    };
  }

  async function openLocalDraft(scene){
    const runtime=ensureRuntime(state||{});
    const target=scene ? normalizeLocalDraft(scene) : readEditorDraft();
    const bridge=window.PhotoPaveAppBridge || null;
    if(!bridge || typeof bridge.openScenePresetRecord !== "function") throw new Error("PhotoPaveAppBridge is unavailable");
    const record=makeSceneRecordFromLocal(target);
    if(SCENES && typeof SCENES.attachSceneToState === "function"){
      try{ SCENES.attachSceneToState(record); }catch(_){ }
    }
    await bridge.openScenePresetRecord(record, { context:"admin", source:"local" });
    runtime.selectedSceneId = target.sceneId;
    renderSceneList();
    renderMeta();
    setStatus("Local draft открыт", (target.title || target.sceneId) + " · можно продолжать настройку сцены.");
    return record;
  }

  function downloadJson(filename, data){
    const blob=new Blob([JSON.stringify(data, null, 2)], { type:"application/json;charset=utf-8" });
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download=filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ try{ document.body.removeChild(a); }catch(_){ } try{ URL.revokeObjectURL(url); }catch(_){ } }, 0);
  }

  function downloadBlob(filename, blob){
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download=filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ try{ document.body.removeChild(a); }catch(_){ } try{ URL.revokeObjectURL(url); }catch(_){ } }, 0);
  }

  const CRC32_TABLE=(function(){
    const table=new Uint32Array(256);
    for(let n=0;n<256;n++){
      let c=n;
      for(let k=0;k<8;k++) c=(c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n]=c >>> 0;
    }
    return table;
  })();

  function crc32(bytes){
    let c=0xFFFFFFFF;
    for(let i=0;i<bytes.length;i++) c=CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function toDosDateTime(dateLike){
    const d=dateLike ? new Date(dateLike) : new Date();
    const year=Math.max(1980, d.getFullYear());
    const dosTime=((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds()/2)) & 31);
    const dosDate=(((year-1980) & 127) << 9) | (((d.getMonth()+1) & 15) << 5) | (d.getDate() & 31);
    return { dosDate, dosTime };
  }

  function bytesFrom(value){
    if(value instanceof Uint8Array) return value;
    if(value instanceof ArrayBuffer) return new Uint8Array(value);
    return new TextEncoder().encode(String(value == null ? '' : value));
  }

  function textFromBytes(bytes){
    try{ return new TextDecoder('utf-8').decode(bytes || new Uint8Array(0)); }catch(_){ return ''; }
  }

  function readStoreZipEntries(arrayBuffer){
    const bytes=arrayBuffer instanceof Uint8Array ? bytesFrom(arrayBuffer) : new Uint8Array(arrayBuffer);
    const view=new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries=[];
    let offset=0;
    while(offset + 30 <= bytes.length){
      const sig=view.getUint32(offset, true);
      if(sig !== 0x04034b50) break;
      const compression=view.getUint16(offset + 8, true);
      if(compression !== 0) throw new Error('ZIP uses unsupported compression method: ' + String(compression));
      const compressedSize=view.getUint32(offset + 18, true);
      const uncompressedSize=view.getUint32(offset + 22, true);
      const nameLen=view.getUint16(offset + 26, true);
      const extraLen=view.getUint16(offset + 28, true);
      const nameStart=offset + 30;
      const dataStart=nameStart + nameLen + extraLen;
      const dataEnd=dataStart + compressedSize;
      if(dataEnd > bytes.length) throw new Error('ZIP entry exceeds archive size');
      const name=textFromBytes(bytes.slice(nameStart, nameStart + nameLen));
      entries.push({ name:name, data:bytes.slice(dataStart, dataEnd), size:uncompressedSize });
      offset=dataEnd;
    }
    if(!entries.length) throw new Error('ZIP package is empty or unsupported');
    return entries;
  }

  function makeZipBlob(files){
    const localParts=[];
    const centralParts=[];
    let offset=0;
    files.forEach((file)=>{
      const nameBytes=bytesFrom(file.name);
      const dataBytes=bytesFrom(file.data);
      const crc=crc32(dataBytes);
      const {dosDate,dosTime}=toDosDateTime(file.updatedAt);
      const local=new Uint8Array(30 + nameBytes.length + dataBytes.length);
      const lv=new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, dataBytes.length, true);
      lv.setUint32(22, dataBytes.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      local.set(dataBytes, 30 + nameBytes.length);
      localParts.push(local);

      const central=new Uint8Array(46 + nameBytes.length);
      const cv=new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, dataBytes.length, true);
      cv.setUint32(24, dataBytes.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);
      offset += local.length;
    });
    const centralSize=centralParts.reduce((s,p)=>s+p.length,0);
    const end=new Uint8Array(22);
    const ev=new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);
    return new Blob([...localParts, ...centralParts, end], { type:'application/zip' });
  }

  function makePublishedManifestEntry(scene, variantsCount){
    return {
      id: scene.sceneId,
      title: scene.title || scene.sceneId,
      enabled: scene.enabled !== false,
      order: Number(scene.order) || 0,
      thumbUrl: safeGet(scene,["photo","thumbUrl"],null),
      coverUrl: safeGet(scene,["photo","coverUrl"],null),
      photoUrl: safeGet(scene,["photo","sourceUrl"],null),
      sceneDirUrl: scene.sceneId + '/',
      sceneUrl: scene.sceneId + '/scene.json',
      variantsUrl: scene.sceneId + '/variants.json',
      meta: Object.assign({}, scene.meta || {}, { exportedVariantsCount: variantsCount })
    };
  }

  function makePublishedVariantsIndex(scene, variants){
    return {
      schemaVersion:1,
      sceneId:scene.sceneId,
      variants: variants.map((v)=>({
        shapeId:v.shapeId,
        textureId:v.textureId,
        title:v.title || v.key,
        status:'published',
        url:'variants/' + buildPublishedVariantStem(v) + '.json',
        previewUrl:v.previewUrl || null,
        updatedAt:v.updatedAt || null
      }))
    };
  }

  function makePublishedSceneJson(scene, variants){
    const out=deepClone(scene);
    out.id = scene.sceneId;
    out.sceneId = scene.sceneId;
    out.title = scene.title || scene.sceneId;
    out.variantsIndexPath = 'variants.json';
    out.variantKeys = variants.map((v)=>v.key);
    out.enabled = scene.enabled !== false;
    out.order = Number(scene.order) || 0;
    out.source = 'published';
    out.updatedAt = scene.updatedAt || new Date().toISOString();
    out.defaults = out.defaults && typeof out.defaults === 'object' ? out.defaults : {};
    if(!out.defaults.shapeId) out.defaults.shapeId = variants[0] && variants[0].shapeId || safeGet(scene,['catalog','activeShapeId'],null) || null;
    if(!out.defaults.textureId) out.defaults.textureId = variants[0] && variants[0].textureId || null;
    return out;
  }

  function makeRepoPackageReadme(scene, variants, cfg, readiness){
    const lines=[];
    lines.push('Photo Pave scene package');
    lines.push('');
    lines.push('Scene ID: ' + String(scene.sceneId || 'scene'));
    lines.push('Title: ' + String(scene.title || scene.sceneId || 'scene'));
    lines.push('Variants exported: ' + String(variants.length));
    lines.push('');
    lines.push('Package contents are repo-ready for GitHub Pages static publishing.');
    lines.push('Copy or replace the following folder in your repo:');
    lines.push('preset-scenes/published/' + String(scene.sceneId || 'scene') + '/');
    lines.push('');
    lines.push('Then merge the manifest entry from:');
    lines.push('preset-scenes/published/__manifest_entry__' + String(scene.sceneId || 'scene') + '.json');
    lines.push('into your published manifest.json scenes array.');
    lines.push('');
    const photoUrl=safeGet(scene,['photo','sourceUrl'],null);
    if(!photoUrl){
      lines.push('WARNING: scene photo URL is empty. Publish a real photo asset and update scene.json/photoUrl before enabling this scenario on the public frontend.');
      lines.push('');
    }
    lines.push('Exported variant files preserve per-texture settings captured in admin local drafts.');
    lines.push('');
    lines.push('Package summary and validation files are included in this export for easier repo publication.');
    if(readiness && readiness.warnings && readiness.warnings.length){
      lines.push('');
      lines.push('Warnings at export time:');
      readiness.warnings.forEach((warn)=>lines.push('- ' + warn));
    }
    return lines.join('\n');
  }

  function makePackageTreeLines(scene, variants, cfg){
    const sceneId=normalizeSceneId(scene.sceneId || scene.id || 'scene', 'scene');
    const publishCfg=normalizePublishAutofill(cfg || createDefaultPublishAutofill());
    const lines=[];
    lines.push('preset-scenes/');
    lines.push('  published/');
    lines.push('    ' + sceneId + '/');
    lines.push('      scene.json');
    lines.push('      variants.json');
    lines.push('      variants/');
    (variants||[]).forEach((variant)=>{ lines.push('        ' + buildPublishedVariantStem(variant) + '.json'); });
    lines.push('      ' + publishCfg.mediaDir + '/');
    lines.push('        ' + publishCfg.scenePhotoFile);
    lines.push('        ' + publishCfg.sceneThumbFile);
    lines.push('        ' + publishCfg.sceneCoverFile);
    lines.push('      ' + publishCfg.previewsDir + '/');
    (variants||[]).forEach((variant)=>{ lines.push('        ' + buildPublishedVariantStem(variant) + '.' + publishCfg.variantPreviewExt); });
    lines.push('    __manifest_entry__' + sceneId + '.json');
    lines.push('    __manifest_single_scene_example__' + sceneId + '.json');
    lines.push('    __MANIFEST_MERGE_PATCH__' + sceneId + '.json');
    lines.push('    __PACKAGE_SUMMARY__' + sceneId + '.json');
    lines.push('    __VALIDATION_REPORT__' + sceneId + '.json');
    lines.push('    __ASSET_URLS__' + sceneId + '.json');
    lines.push('    __PACKAGE_TREE__' + sceneId + '.txt');
    lines.push('    __README_DEPLOY__' + sceneId + '.txt');
    lines.push('    __AUTOFILL_PRESET__' + sceneId + '.json');
    return lines;
  }

  function makePackageSummary(scene, variants, cfg, readiness){
    const sceneId=normalizeSceneId(scene.sceneId || scene.id || 'scene', 'scene');
    const publishCfg=normalizePublishAutofill(cfg || createDefaultPublishAutofill());
    return {
      schemaVersion:1,
      kind:'published-scene-package-summary',
      generatedAt:new Date().toISOString(),
      sceneId:sceneId,
      title:String(scene.title || sceneId),
      variantsCount:(variants||[]).length,
      ready:!!(readiness && readiness.ok),
      errors:readiness && Array.isArray(readiness.errors) ? readiness.errors.slice() : [],
      warnings:readiness && Array.isArray(readiness.warnings) ? readiness.warnings.slice() : [],
      pagesBase:publishCfg.pagesBase || null,
      mediaDir:publishCfg.mediaDir,
      previewsDir:publishCfg.previewsDir,
      sceneAssets:{
        photoFile:publishCfg.scenePhotoFile,
        thumbFile:publishCfg.sceneThumbFile,
        coverFile:publishCfg.sceneCoverFile
      },
      previewExt:publishCfg.variantPreviewExt,
      manifestEntry:makePublishedManifestEntry(scene, (variants||[]).length),
      packagePaths:listPublishedPackagePaths(scene, variants, publishCfg),
      packageTree:makePackageTreeLines(scene, variants, publishCfg),
      variants:(variants||[]).map((v)=>({ key:v.key, shapeId:v.shapeId||null, textureId:v.textureId||null, previewUrl:v.previewUrl||null }))
    };
  }

  function makeAssetUrlMap(scene, variants, cfg){
    const sceneId=normalizeSceneId(scene.sceneId || scene.id || 'scene', 'scene');
    const publishCfg=normalizePublishAutofill(cfg || createDefaultPublishAutofill());
    const root='preset-scenes/published/' + sceneId + '/';
    return {
      schemaVersion:1,
      kind:'published-scene-asset-map',
      generatedAt:new Date().toISOString(),
      sceneId:sceneId,
      scene:{
        photo:{ repoPath:root + publishCfg.mediaDir + '/' + publishCfg.scenePhotoFile, sourceUrl:safeGet(scene,['photo','sourceUrl'],null) },
        thumb:{ repoPath:root + publishCfg.mediaDir + '/' + publishCfg.sceneThumbFile, sourceUrl:safeGet(scene,['photo','thumbUrl'],null) },
        cover:{ repoPath:root + publishCfg.mediaDir + '/' + publishCfg.sceneCoverFile, sourceUrl:safeGet(scene,['photo','coverUrl'],null) }
      },
      variants:(variants||[]).map((v)=>({
        key:v.key,
        shapeId:v.shapeId||null,
        textureId:v.textureId||null,
        repoPreviewPath:root + publishCfg.previewsDir + '/' + buildPublishedVariantStem(v) + '.' + publishCfg.variantPreviewExt,
        previewUrl:v.previewUrl || null
      }))
    };
  }

  function makeManifestMergePatch(scene, variants){
    return {
      schemaVersion:1,
      kind:'published-manifest-merge-patch',
      op:'append_scene_entry',
      generatedAt:new Date().toISOString(),
      sceneId:normalizeSceneId(scene.sceneId || scene.id || 'scene', 'scene'),
      targetFile:'preset-scenes/published/manifest.json',
      entry:makePublishedManifestEntry(scene, (variants||[]).length)
    };
  }

  function listPublishedPackagePaths(scene, variants, cfg){
    const sceneId=normalizeSceneId(scene.sceneId || scene.id || 'scene', 'scene');
    const root='preset-scenes/published/' + sceneId + '/';
    const lines=[
      root + 'scene.json',
      root + 'variants.json'
    ];
    const publishCfg=normalizePublishAutofill(cfg || createDefaultPublishAutofill());
    lines.push(root + publishCfg.mediaDir + '/' + publishCfg.scenePhotoFile);
    lines.push(root + publishCfg.mediaDir + '/' + publishCfg.sceneThumbFile);
    lines.push(root + publishCfg.mediaDir + '/' + publishCfg.sceneCoverFile);
    (variants || []).forEach((variant)=>{
      const stem=buildPublishedVariantStem(variant);
      lines.push(root + 'variants/' + stem + '.json');
      lines.push(root + publishCfg.previewsDir + '/' + stem + '.' + publishCfg.variantPreviewExt);
    });
    lines.push('preset-scenes/published/__manifest_entry__' + sceneId + '.json');
    lines.push('preset-scenes/published/__manifest_single_scene_example__' + sceneId + '.json');
    lines.push('preset-scenes/published/__README_DEPLOY__' + sceneId + '.txt');
    return lines;
  }

  function copyText(text, okMessage){
    const value=String(text || '');
    if(!value) throw new Error('Нет данных для копирования');
    if(navigator.clipboard && navigator.clipboard.writeText){
      return navigator.clipboard.writeText(value).then(()=>{ setStatus(okMessage || 'Скопировано', 'Данные помещены в буфер обмена.'); return true; });
    }
    const ta=document.createElement('textarea');
    ta.value=value;
    ta.setAttribute('readonly','readonly');
    ta.style.position='fixed';
    ta.style.top='-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok=document.execCommand('copy');
    try{ document.body.removeChild(ta); }catch(_){ }
    if(!ok) throw new Error('Не удалось скопировать в буфер');
    setStatus(okMessage || 'Скопировано', 'Данные помещены в буфер обмена.');
    return Promise.resolve(true);
  }

  function buildScenePackageFiles(scene, variants, cfg){
    const sceneId=normalizeSceneId(scene.sceneId || scene.id || 'scene', 'scene');
    const root='preset-scenes/published/' + sceneId + '/';
    const manifestEntry=makePublishedManifestEntry(scene, variants.length);
    const manifestSingle={ schemaVersion:1, defaultSceneId:sceneId, scenes:[manifestEntry] };
    const sceneJson=makePublishedSceneJson(scene, variants);
    const variantsIndex=makePublishedVariantsIndex(scene, variants);
    const publishCfg=normalizePublishAutofill(cfg || createDefaultPublishAutofill());
    const readiness=computePublishReadiness(scene, variants, publishCfg);
    const packageSummary=makePackageSummary(scene, variants, publishCfg, readiness);
    const assetMap=makeAssetUrlMap(scene, variants, publishCfg);
    const manifestPatch=makeManifestMergePatch(scene, variants);
    const packageTree=makePackageTreeLines(scene, variants, publishCfg).join('\n') + '\n';
    const files=[
      { name: root + 'scene.json', data: JSON.stringify(sceneJson, null, 2) + '\n', updatedAt: scene.updatedAt },
      { name: root + 'variants.json', data: JSON.stringify(variantsIndex, null, 2) + '\n', updatedAt: new Date().toISOString() },
      { name: 'preset-scenes/published/__manifest_entry__' + sceneId + '.json', data: JSON.stringify(manifestEntry, null, 2) + '\n', updatedAt: new Date().toISOString() },
      { name: 'preset-scenes/published/__manifest_single_scene_example__' + sceneId + '.json', data: JSON.stringify(manifestSingle, null, 2) + '\n', updatedAt: new Date().toISOString() },
      { name: 'preset-scenes/published/__README_DEPLOY__' + sceneId + '.txt', data: makeRepoPackageReadme(scene, variants, publishCfg, readiness) + '\n', updatedAt: new Date().toISOString() },
      { name: 'preset-scenes/published/__AUTOFILL_PRESET__' + sceneId + '.json', data: JSON.stringify(publishCfg, null, 2) + '\n', updatedAt: new Date().toISOString() },
      { name: 'preset-scenes/published/__PACKAGE_SUMMARY__' + sceneId + '.json', data: JSON.stringify(packageSummary, null, 2) + '\n', updatedAt: new Date().toISOString() },
      { name: 'preset-scenes/published/__VALIDATION_REPORT__' + sceneId + '.json', data: JSON.stringify(readiness, null, 2) + '\n', updatedAt: new Date().toISOString() },
      { name: 'preset-scenes/published/__ASSET_URLS__' + sceneId + '.json', data: JSON.stringify(assetMap, null, 2) + '\n', updatedAt: new Date().toISOString() },
      { name: 'preset-scenes/published/__PACKAGE_TREE__' + sceneId + '.txt', data: packageTree, updatedAt: new Date().toISOString() },
      { name: 'preset-scenes/published/__MANIFEST_MERGE_PATCH__' + sceneId + '.json', data: JSON.stringify(manifestPatch, null, 2) + '\n', updatedAt: new Date().toISOString() },
      { name: root + publishCfg.mediaDir + '/__README_ASSETS__.txt', data: 'Place published scene assets here: ' + publishCfg.scenePhotoFile + ', ' + publishCfg.sceneThumbFile + ', ' + publishCfg.sceneCoverFile + '.\n', updatedAt: new Date().toISOString() },
      { name: root + publishCfg.previewsDir + '/__README_PREVIEWS__.txt', data: 'Place published variant previews here. Expected extension: .' + publishCfg.variantPreviewExt + '.\n', updatedAt: new Date().toISOString() }
    ];
    variants.forEach((variant)=>{
      const stem=buildPublishedVariantStem(variant);
      files.push({ name: root + 'variants/' + stem + '.json', data: JSON.stringify(variant, null, 2) + '\n', updatedAt: variant.updatedAt || new Date().toISOString() });
    });
    return files;
  }


  async function exportCurrentDraft(){
    const scene=await captureCurrentScene({ cleanAfterCapture:true });
    runtimeSafeLocalHint();
    downloadJson((scene.sceneId || "scene") + "_draft.json", scene);
    setStatus("Scene JSON выгружен", "Файл можно хранить как backup или импортировать на другом устройстве.");
  }

  function runtimeSafeLocalHint(){
    const runtime=ensureRuntime(state||{});
    if(runtime.editor && runtime.editor.dirty){ runtime.editor.dirty = false; renderEditor(); }
  }

  async function importSceneFile(file){
    if(!file) return;
    const text=await file.text();
    const parsed=JSON.parse(text);
    const scene=normalizeLocalDraft(parsed);
    const runtime=ensureRuntime(state||{});
    updateRuntimeLocalSceneIndex(runtime, scene);
    persistLocalDrafts(runtime);
    setEditorDraft(scene, { dirty:false, lastSavedAt:scene.updatedAt });
    setStatus("Scene JSON импортирован", (scene.title || scene.sceneId) + " · local draft готов к открытию и редактированию.");
  }

  async function exportScenePackage(){
    const runtime=ensureRuntime(state||{});
    const sceneDraft=ensureEditorDraft(runtime);
    let scene=sceneDraft && sceneDraft.baseSnapshot ? normalizeLocalDraft(sceneDraft) : null;
    if((!scene || !scene.baseSnapshot) && sceneDraft && sceneDraft.sceneId && runtime.localDrafts[sceneDraft.sceneId]) scene=normalizeLocalDraft(runtime.localDrafts[sceneDraft.sceneId]);
    if(!scene || !scene.baseSnapshot) throw new Error("Сначала захватите и сохраните базовую сцену (local draft)");
    const variants=getSceneVariants(runtime, scene.sceneId);
    if(!variants.length) throw new Error("Для сцены ещё нет сохранённых local variants. Сначала сохраните хотя бы один вариант текстуры.");
    const cfg=normalizePublishAutofill(runtime.publishAutofill || createDefaultPublishAutofill());
    const readiness=computePublishReadiness(scene, variants, cfg);
    if(!readiness.ok) throw new Error(readiness.errors.join(' · '));
    const files=buildScenePackageFiles(scene, variants, cfg).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''), 'en'));
    const blob=makeZipBlob(files);
    const filename=(scene.sceneId || 'scene') + '_published_package.zip';
    downloadBlob(filename, blob);
    if(readiness.warnings.length) setStatus("Repo-ready пакет экспортирован", (scene.title || scene.sceneId) + ' · файлов: ' + String(files.length) + ' · вариантов: ' + String(variants.length) + ' · warnings: ' + readiness.warnings.join('; '));
    else setStatus("Repo-ready пакет экспортирован", (scene.title || scene.sceneId) + ' · файлов: ' + String(files.length) + ' · вариантов: ' + String(variants.length));
    return { scene, variants, files:files.map((f)=>f.name) };
  }

  function escapeRegExp(str){
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async function importScenePackageFile(file){
    if(!file) return;
    const runtime=ensureRuntime(state||{});
    const buf=await file.arrayBuffer();
    const entries=readStoreZipEntries(buf);
    const sceneEntry=entries.find((e)=>/preset-scenes\/published\/[^/]+\/scene\.json$/i.test(e.name));
    if(!sceneEntry) throw new Error('В zip не найден scene.json');
    const sceneJson=JSON.parse(textFromBytes(sceneEntry.data));
    const scene=normalizeLocalDraft(sceneJson);
    if(!scene.sceneId) throw new Error('Импортированный scene.json не содержит sceneId');
    const sceneIdRe=escapeRegExp(scene.sceneId);
    const variantEntries=entries.filter((e)=>new RegExp('^preset-scenes/published/' + sceneIdRe + '/variants/[^/]+\.json$','i').test(e.name));
    const variants=[];
    const warnings=[];
    variantEntries.forEach((entry)=>{
      try{ variants.push(normalizeLocalVariant(JSON.parse(textFromBytes(entry.data)))); }
      catch(_){ warnings.push('Не удалось импортировать variant: ' + entry.name); }
    });
    const autofillEntry=entries.find((e)=>new RegExp('__AUTOFILL_PRESET__' + sceneIdRe + '\.json$','i').test(e.name));
    updateRuntimeLocalSceneIndex(runtime, scene);
    runtime.localDrafts[scene.sceneId]=scene;
    variants.forEach((v)=>{ runtime.localVariants[v.key]=v; });
    persistLocalDrafts(runtime);
    persistLocalVariants(runtime);
    let autofillLoaded=false;
    if(autofillEntry){
      try{
        const cfg=normalizePublishAutofill(JSON.parse(textFromBytes(autofillEntry.data)));
        runtime.publishAutofill=cfg;
        persistPublishAutofill(runtime);
        autofillLoaded=true;
      }catch(_){ warnings.push('Autofill preset найден, но не прочитан'); }
    }
    runtime.packageImport.lastResult={ sceneId:scene.sceneId, variantsCount:variants.length, filesCount:entries.length, autofillLoaded:autofillLoaded, importedAt:new Date().toISOString(), warnings:warnings.slice() };
    buildMergedScenes(runtime);
    setEditorDraft(scene, { dirty:false, lastSavedAt:scene.updatedAt || null });
    if(variants[0]) setVariantDraft(variants[0], { dirty:false, lastSavedAt:variants[0].updatedAt || null });
    try{ await openLocalDraft(scene); }catch(_){ }
    renderPublishAutofill();
    renderBulkAssetImport();
    renderPublishHelper();
    renderPackageImport();
    renderVariantPanel();
    const msg='Сцена ' + String(scene.title || scene.sceneId) + ' импортирована обратно в admin';
    const sub='Variants: ' + String(variants.length) + ' · files: ' + String(entries.length) + (autofillLoaded ? ' · autofill preset восстановлен' : '') + (warnings.length ? ' · warnings: ' + warnings.join('; ') : '');
    setStatus(msg, sub);
    return { scene:scene, variants:variants, files:entries.map((e)=>e.name), warnings:warnings };
  }

  function seedNewScene(){
    const runtime=ensureRuntime(state||{});
    const fresh=createEmptyDraft({ sceneId:"scene", title:"Новая сцена", order:(runtime.scenes || []).length * 10 });
    setEditorDraft(fresh, { dirty:true, lastSavedAt:null });
    setStatus("Новая сцена подготовлена", "Загрузите фото, выставьте контур и нажмите «Захватить текущую сцену».");
  }

  function promptPhotoUpload(){
    const input=document.getElementById("photoInput");
    if(input && typeof input.click === "function"){
      input.click();
      setStatus("Ожидаю загрузку фото", "После загрузки фото выставьте контур и захватите сцену в local draft.");
      return true;
    }
    setStatus("Не удалось открыть выбор фото", "Элемент photoInput недоступен в текущем entrypoint.");
    return false;
  }

  function selectScene(sceneId){
    const runtime=ensureRuntime(state||{});
    runtime.selectedSceneId = String(sceneId || "").trim() || null;
    const selected=runtime.selectedSceneId ? runtime.sceneMap[runtime.selectedSceneId] : null;
    if(selected){
      const draft = selected.localRecord ? normalizeLocalDraft(selected.localRecord) : draftFromSelectedScene(runtime);
      runtime.editor.draft = draft;
      runtime.editor.dirty = false;
      runtime.variantEditor = runtime.variantEditor || { draft:null, dirty:false, lastSavedAt:null };
      runtime.variantEditor.draft = null;
      runtime.variantEditor.dirty = false;
    }
    renderSceneList();
    renderMeta();
  }

  async function refreshCatalog(){
    const runtime=ensureRuntime(state||{});
    syncShellFrame();
    loadLocalDrafts(runtime);
    loadLocalVariants(runtime);
    loadPublishAutofill(runtime);
    loadBulkAssetImport(runtime);
    if(!runtime.visible) return runtime;
    setStatus("Загружаю список сцен…", "Проверяю local drafts, draft и published manifests.");
    runtime.lastError = null;
    try{
      await Promise.all([safeLoadManifest("draft"), safeLoadManifest("published")]);
      buildMergedScenes(runtime);
      runtime.lastLoadedAt = new Date().toISOString();
      if(!runtime.editor || !runtime.editor.draft || !runtime.editor.draft.sceneId){
        runtime.editor.draft = draftFromSelectedScene(runtime);
      }
      renderSceneList();
      renderMeta();
      const count=(runtime.scenes || []).length;
      if(count){
        setStatus("Список сцен готов: " + count, "Можно открыть сцену, создать local draft или импортировать scene.json.");
      }else{
        setStatus("Сцены не найдены", runtime.config.emptyStateText + " Можно создать новую сцену локально и начать authoring без backend.");
      }
      if(!count && getAdminRuntime() && getAdminRuntime().config && getAdminRuntime().config.requireAuth === false){
        setStatus("Admin shell активен", "No-token режим. Создайте локальную сцену, загрузите фото и захватите base snapshot.");
      }
      return runtime;
    }catch(err){
      runtime.lastError = String(err && err.message || err);
      buildMergedScenes(runtime);
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
    if((mode === "draft" && selected.localExists && !selected.draftExists) || mode === "local"){
      return openLocalDraft(selected.localRecord || runtime.editor.draft);
    }
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
    if(r.variantList) r.variantList.addEventListener("click", (ev)=>{
      const btn=ev.target && ev.target.closest ? ev.target.closest("[data-variant-key]") : null;
      if(!btn) return;
      const key=btn.getAttribute("data-variant-key");
      const variant=key ? ensureRuntime(state||{}).localVariants[key] : null;
      if(variant) setVariantDraft(variant, { dirty:false, lastSavedAt:variant.updatedAt || null });
    });

    [r.inputSceneId, r.inputTitle, r.inputOrder, r.inputPhotoUrl, r.inputThumbUrl, r.inputNote].forEach((node)=>{
      if(node) node.addEventListener("input", ()=>{ readEditorDraft(); markEditorDirty(true); });
    });
    [r.inputVariantShapeId, r.inputVariantTextureId, r.inputVariantTitle, r.inputVariantPreviewUrl, r.inputVariantNote].forEach((node)=>{
      if(node) node.addEventListener("input", ()=>{ readVariantDraft(); markVariantDirty(true); });
    });
    [r.inputPagesBase, r.inputMediaDir, r.inputPreviewsDir, r.inputScenePhotoFile, r.inputSceneThumbFile, r.inputSceneCoverFile, r.inputVariantPreviewExt].forEach((node)=>{
      if(node) node.addEventListener("input", ()=>{ readPublishAutofill(); renderPublishAutofill(); renderPublishHelper(); renderBulkAssetImport(); });
    });
    if(r.bulkAssetInput) r.bulkAssetInput.addEventListener("input", ()=>{ readBulkAssetImport(); renderBulkAssetImport(); });
    if(r.inputEnabled) r.inputEnabled.addEventListener("change", ()=>{ readEditorDraft(); markEditorDirty(true); });
    if(r.btnNew) r.btnNew.addEventListener("click", ()=>{ seedNewScene(); });
    if(r.btnQuickNewScene) r.btnQuickNewScene.addEventListener("click", ()=>{ runQuickNewSceneFlow().catch((err)=>setStatus("Не удалось начать новую сцену", String(err && err.message || err))); });
    if(r.btnCapture) r.btnCapture.addEventListener("click", ()=>{ captureCurrentScene().catch((err)=>setStatus("Не удалось захватить сцену", String(err && err.message || err))); });
    if(r.btnUploadPhoto) r.btnUploadPhoto.addEventListener("click", ()=>{ promptPhotoUpload(); });
    if(r.btnSaveLocal) r.btnSaveLocal.addEventListener("click", ()=>{ saveLocalDraft().catch((err)=>setStatus("Не удалось сохранить local draft", String(err && err.message || err))); });
    if(r.btnQuickSaveScene) r.btnQuickSaveScene.addEventListener("click", ()=>{ runQuickSaveSceneFlow().catch((err)=>setStatus("Не удалось сохранить сцену", String(err && err.message || err))); });
    if(r.btnExport) r.btnExport.addEventListener("click", ()=>{ exportCurrentDraft().catch((err)=>setStatus("Не удалось выгрузить scene.json", String(err && err.message || err))); });
    if(r.btnExportPackage) r.btnExportPackage.addEventListener("click", ()=>{ exportScenePackage().catch((err)=>setStatus("Не удалось выгрузить пакет сцены", String(err && err.message || err))); });
    if(r.btnCopyManifest) r.btnCopyManifest.addEventListener("click", ()=>{ const rt=ensureRuntime(state||{}); const scene=ensureEditorDraft(rt); const variants=getSceneVariants(rt, scene.sceneId); copyText(JSON.stringify(makePublishedManifestEntry(scene, variants.length), null, 2), "Manifest entry скопирован").catch((err)=>setStatus("Не удалось скопировать manifest entry", String(err && err.message || err))); });
    if(r.btnCopyPaths) r.btnCopyPaths.addEventListener("click", ()=>{ const rt=ensureRuntime(state||{}); const scene=ensureEditorDraft(rt); const variants=getSceneVariants(rt, scene.sceneId); const cfg=normalizePublishAutofill(rt.publishAutofill || createDefaultPublishAutofill()); copyText(listPublishedPackagePaths(scene, variants, cfg).join("\n"), "Список путей скопирован").catch((err)=>setStatus("Не удалось скопировать список путей", String(err && err.message || err))); });
    if(r.btnCopyDeploy) r.btnCopyDeploy.addEventListener("click", ()=>{ const val=(getRefs().helperDeploy && getRefs().helperDeploy.value) || ""; copyText(val, "Deploy инструкция скопирована").catch((err)=>setStatus("Не удалось скопировать deploy инструкцию", String(err && err.message || err))); });
    if(r.btnValidatePublish) r.btnValidatePublish.addEventListener("click", ()=>{ renderPublishHelper(); const rt=ensureRuntime(state||{}); const scene=ensureEditorDraft(rt); const variants=getSceneVariants(rt, scene.sceneId); const cfg=normalizePublishAutofill(rt.publishAutofill || createDefaultPublishAutofill()); const readiness=computePublishReadiness(scene, variants, cfg); setStatus(readiness.ok ? "Пакет готов к публикации" : "Пакет требует исправлений", readiness.ok ? "Можно экспортировать repo-пакет сцены." : readiness.errors.join(' · ')); });
    if(r.btnImportPackage) r.btnImportPackage.addEventListener("click", ()=>{ if(r.importPackageInput) r.importPackageInput.click(); });
    if(r.btnQuickFinalizeExport) r.btnQuickFinalizeExport.addEventListener("click", ()=>{ runQuickFinalizeExportFlow().catch((err)=>setStatus("Не удалось подготовить и выгрузить архив", String(err && err.message || err))); });
    if(r.btnQuickToggleAdvanced) r.btnQuickToggleAdvanced.addEventListener("click", ()=>{ toggleAdvancedPublishTools(); });
    if(r.btnImport) r.btnImport.addEventListener("click", ()=>{ if(r.importInput) r.importInput.click(); });
    if(r.btnModeContour) r.btnModeContour.addEventListener("click", ()=>{ runGeometryAction("contour"); });
    if(r.btnModeCutout) r.btnModeCutout.addEventListener("click", ()=>{ runGeometryAction("cutout"); });
    if(r.btnModeView) r.btnModeView.addEventListener("click", ()=>{ runGeometryAction("view"); });
    if(r.btnCloseContour) r.btnCloseContour.addEventListener("click", ()=>{ runGeometryAction("closeContour"); });
    if(r.btnResetGeometry) r.btnResetGeometry.addEventListener("click", ()=>{ runGeometryAction("reset"); });
    if(r.importInput) r.importInput.addEventListener("change", (ev)=>{
      const file=ev && ev.target && ev.target.files ? ev.target.files[0] : null;
      importSceneFile(file).catch((err)=>setStatus("Не удалось импортировать scene.json", String(err && err.message || err))).finally(()=>{ try{ ev.target.value=""; }catch(_){ } });
    });
    if(r.btnCaptureVariant) r.btnCaptureVariant.addEventListener("click", ()=>{ captureCurrentVariant().catch((err)=>setStatus("Не удалось захватить вариант", String(err && err.message || err))); });
    if(r.btnSaveVariantLocal) r.btnSaveVariantLocal.addEventListener("click", ()=>{ saveLocalVariant().catch((err)=>setStatus("Не удалось сохранить local variant", String(err && err.message || err))); });
    if(r.btnQuickSaveVariant) r.btnQuickSaveVariant.addEventListener("click", ()=>{ runQuickSaveVariantFlow().catch((err)=>setStatus("Не удалось сохранить текущую текстуру", String(err && err.message || err))); });
    if(r.btnOpenVariantLocal) r.btnOpenVariantLocal.addEventListener("click", ()=>{ openLocalVariant().catch((err)=>setStatus("Не удалось открыть local variant", String(err && err.message || err))); });
    if(r.btnExportVariant) r.btnExportVariant.addEventListener("click", ()=>{ exportCurrentVariant().catch((err)=>setStatus("Не удалось выгрузить variant.json", String(err && err.message || err))); });
    if(r.btnImportVariant) r.btnImportVariant.addEventListener("click", ()=>{ if(r.importVariantInput) r.importVariantInput.click(); });
    if(r.importVariantInput) r.importVariantInput.addEventListener("change", (ev)=>{
      const file=ev && ev.target && ev.target.files ? ev.target.files[0] : null;
      importVariantFile(file).catch((err)=>setStatus("Не удалось импортировать variant.json", String(err && err.message || err))).finally(()=>{ try{ ev.target.value=""; }catch(_){ } });
    });
    if(r.importPackageInput) r.importPackageInput.addEventListener("change", (ev)=>{
      const file=ev && ev.target && ev.target.files ? ev.target.files[0] : null;
      importScenePackageFile(file).catch((err)=>setStatus("Не удалось импортировать package zip", String(err && err.message || err))).finally(()=>{ try{ ev.target.value=""; }catch(_){ } });
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

  const API={ init, refreshCatalog, selectScene, openScene, saveLocalDraft, captureCurrentScene, importSceneFile, importScenePackageFile, runGeometryAction, getGeometrySummary, captureCurrentVariant, saveLocalVariant, openLocalVariant, importVariantFile, exportScenePackage, runQuickNewSceneFlow, runQuickSaveSceneFlow, runQuickSaveVariantFlow, runQuickFinalizeExportFlow, getRuntime:()=>ensureRuntime(state||{}) };

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", ()=>{ try{ if(getConfig(null).autoInit) init(); }catch(_){ } }, { once:true });
  }else{
    try{ if(getConfig(null).autoInit) init(); }catch(_){ }
  }

  return API;
})();
