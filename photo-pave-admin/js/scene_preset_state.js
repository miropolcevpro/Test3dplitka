window.PhotoPaveScenePresetState=(function(){
  const StateNS=window.PhotoPaveState||null;
  const PresetsNS=window.PhotoPaveScenePresets||null;
  const state=StateNS && StateNS.state ? StateNS.state : null;

  const SCHEMA_VERSION=1;
  const SCENE_KIND="scene-base";
  const VARIANT_KIND="scene-variant-snapshot";

  function deepClone(v){ return JSON.parse(JSON.stringify(v)); }
  function asObj(v){ return v && typeof v==="object" ? v : {}; }
  function asArr(v){ return Array.isArray(v) ? v : []; }
  function asBool(v, fallback){ return typeof v === "boolean" ? v : !!fallback; }
  function asNum(v, fallback){ const n=Number(v); return Number.isFinite(n) ? n : (fallback==null ? null : Number(fallback)); }
  function asStr(v, fallback){ return v==null || v==="" ? (fallback==null ? null : String(fallback)) : String(v); }

  function sanitizePoint(p){
    const src=asObj(p);
    const x=asNum(src.x, null);
    const y=asNum(src.y, null);
    if(x==null || y==null) return null;
    return { x, y };
  }

  function sanitizePolygon(points){
    return asArr(points).map(sanitizePoint).filter(Boolean);
  }

  function sanitizeCutout(cut){
    const src=asObj(cut);
    return {
      id: asStr(src.id, null),
      name: asStr(src.name, "Вырез"),
      closed: asBool(src.closed, false),
      polygon: sanitizePolygon(src.polygon)
    };
  }

  function sanitizeFloorPlane(fp){
    const src=asObj(fp);
    return {
      points: sanitizePolygon(src.points),
      closed: asBool(src.closed, false)
    };
  }

  function sanitizeMaterialParams(params){
    const src=asObj(params);
    const out={};
    ["scale","rotation","offsetU","offsetV","opacity","perspective","horizon"].forEach((k)=>{
      const v=asNum(src[k], null);
      if(v!=null) out[k]=v;
    });
    if(src.blendMode!=null) out.blendMode=String(src.blendMode);
    if(typeof src.opaqueFill === "boolean") out.opaqueFill=!!src.opaqueFill;
    return out;
  }

  function sanitizeMaterialSelection(material, fallbackShapeId){
    const src=asObj(material);
    return {
      shapeId: asStr(src.shapeId, fallbackShapeId || null),
      textureId: asStr(src.textureId, null),
      textureUrl: asStr(src.textureUrl, null),
      tileSizeM: asNum(src.tileSizeM, null),
      maps: src.maps && typeof src.maps === "object" ? deepClone(src.maps) : null,
      mapsMeta: src.mapsMeta && typeof src.mapsMeta === "object" ? deepClone(src.mapsMeta) : null,
      mapSet: src.mapSet && typeof src.mapSet === "object" ? deepClone(src.mapSet) : null,
      pbrParams: src.pbrParams && typeof src.pbrParams === "object" ? deepClone(src.pbrParams) : null,
      params_base: sanitizeMaterialParams(src.params_base || src.params || null),
      params_ultra: sanitizeMaterialParams(src.params_ultra || src.params || null),
      ultraTuned: src._ultraTuned && typeof src._ultraTuned === "object" ? deepClone(src._ultraTuned) : null
    };
  }

  function sanitizeZoneGeometry(zone){
    const src=asObj(zone);
    return {
      id: asStr(src.id, null),
      name: asStr(src.name, "Зона"),
      enabled: src.enabled == null ? true : !!src.enabled,
      closed: asBool(src.closed, false),
      contour: sanitizePolygon(src.contour),
      cutouts: asArr(src.cutouts).map(sanitizeCutout),
      linked: src.linked == null ? false : !!src.linked
    };
  }

  function sanitizeZoneVariant(zone, fallbackShapeId){
    const src=asObj(zone);
    return {
      id: asStr(src.id, null),
      name: asStr(src.name, "Зона"),
      enabled: src.enabled == null ? true : !!src.enabled,
      linked: src.linked == null ? false : !!src.linked,
      baseParams: src.baseParams && typeof src.baseParams === "object" ? deepClone(src.baseParams) : null,
      overrides: src.overrides && typeof src.overrides === "object" ? deepClone(src.overrides) : null,
      material: sanitizeMaterialSelection(src.material, fallbackShapeId)
    };
  }

  function sanitizeUiForScene(ui){
    const src=asObj(ui);
    return {
      activeStep: asStr(src.activeStep, "photo"),
      mode: asStr(src.mode, "photo"),
      editScope: asStr(src.editScope, "active"),
      shellMode: asStr(src.shellMode, "simple"),
      secondaryToolsOpen: !!src.secondaryToolsOpen,
      singleZoneMode: src.singleZoneMode == null ? true : !!src.singleZoneMode,
      masterZoneId: asStr(src.masterZoneId, null),
      activeZoneId: asStr(src.activeZoneId, null),
      activeCutoutId: asStr(src.activeCutoutId, null)
    };
  }

  function sanitizeUiForVariant(ui){
    const src=sanitizeUiForScene(ui);
    return {
      editScope: src.editScope,
      shellMode: src.shellMode,
      secondaryToolsOpen: src.secondaryToolsOpen,
      masterZoneId: src.masterZoneId,
      activeZoneId: src.activeZoneId,
      activeCutoutId: src.activeCutoutId
    };
  }

  function sanitizeAiCalib(calib){
    const src=asObj(calib);
    return {
      enabled: src.enabled == null ? true : !!src.enabled,
      applyToQuad: !!src.applyToQuad,
      status: asStr(src.status, "idle"),
      source: asStr(src.source, null),
      photoHash: asStr(src.photoHash, null),
      vanish: sanitizePoint(src.vanish),
      horizonY: asNum(src.horizonY, null),
      planeDir: src.planeDir && typeof src.planeDir === "object" ? { x: asNum(src.planeDir.x, 0), y: asNum(src.planeDir.y, 0) } : null,
      confidence: asNum(src.confidence, 0),
      autoHorizon: asNum(src.autoHorizon, 0),
      autoPerspective: asNum(src.autoPerspective, 0.85)
    };
  }

  function sanitizeAiCalib3d(calib3d){
    const src=asObj(calib3d);
    const lines=asObj(src.lines);
    function linePair(v){
      const line=asObj(v);
      const p1=sanitizePoint(line.p1);
      const p2=sanitizePoint(line.p2);
      return (p1 && p2) ? { p1, p2 } : null;
    }
    return {
      enabled: !!src.enabled,
      use3DRenderer: src.use3DRenderer == null ? true : !!src.use3DRenderer,
      forceBottomUp: src.forceBottomUp == null ? true : !!src.forceBottomUp,
      contourDefinesAxis: src.contourDefinesAxis == null ? true : !!src.contourDefinesAxis,
      disableAiQuad: src.disableAiQuad == null ? true : !!src.disableAiQuad,
      allowFallbackK: src.allowFallbackK == null ? true : !!src.allowFallbackK,
      applyToActiveZone: !!src.applyToActiveZone,
      active: asStr(src.active, null),
      lines:{ A1:linePair(lines.A1), A2:linePair(lines.A2), B1:linePair(lines.B1), B2:linePair(lines.B2) },
      result: src.result && typeof src.result === "object" ? deepClone(src.result) : null,
      lastGoodResult: src.lastGoodResult && typeof src.lastGoodResult === "object" ? deepClone(src.lastGoodResult) : null,
      status: asStr(src.status, "idle"),
      error: asStr(src.error, null),
      warn: asStr(src.warn, null),
      showLines: !!src.showLines
    };
  }

  function sanitizeAiForVariant(ai){
    const src=asObj(ai);
    return {
      enabled: src.enabled == null ? true : !!src.enabled,
      quality: asStr(src.quality, "basic"),
      userToggled: !!src.userToggled,
      occlusionEnabled: !!src.occlusionEnabled,
      calib: sanitizeAiCalib(src.calib),
      calib3d: sanitizeAiCalib3d(src.calib3d)
    };
  }

  function scenePhotoInfo(options, srcState){
    const opts=asObj(options);
    const assets=srcState && srcState.assets ? srcState.assets : {};
    const photo=asObj(opts.photo);
    return {
      sourceUrl: asStr(photo.sourceUrl || opts.photoUrl, null),
      storageUrl: asStr(photo.storageUrl, null),
      thumbUrl: asStr(photo.thumbUrl, null),
      width: asNum(photo.width, assets.photoW || null),
      height: asNum(photo.height, assets.photoH || null),
      fileName: asStr(photo.fileName, null),
      mime: asStr(photo.mime, null)
    };
  }

  function findZoneById(zones, id){
    const wanted=asStr(id, null);
    if(!wanted) return null;
    return asArr(zones).find((z)=>z && z.id===wanted) || null;
  }

  function serializeSceneBase(options){
    const opts=asObj(options);
    const srcState=opts.state || state;
    if(!srcState) throw new Error("PhotoPave state is unavailable");
    const sceneId = PresetsNS && typeof PresetsNS.makeSceneId === "function"
      ? PresetsNS.makeSceneId(opts.sceneId || opts.id || (srcState.scenePresets && srcState.scenePresets.activeSceneId) || opts.title || "scene", "scene")
      : asStr(opts.sceneId || opts.id, "scene");
    const activeShapeId = asStr((srcState.catalog && srcState.catalog.activeShapeId) || opts.shapeId, null);
    const zones=asArr(srcState.zones).map(sanitizeZoneGeometry);
    return {
      schemaVersion:SCHEMA_VERSION,
      kind:SCENE_KIND,
      id:sceneId,
      sceneId,
      title:asStr(opts.title, sceneId),
      updatedAt:new Date().toISOString(),
      sourceBuild:srcState.build && srcState.build.version ? String(srcState.build.version) : null,
      photo:scenePhotoInfo(opts, srcState),
      ui:sanitizeUiForScene(srcState.ui),
      catalog:{ activeShapeId },
      floorPlane:sanitizeFloorPlane(srcState.floorPlane),
      zones,
      meta:opts.meta && typeof opts.meta === "object" ? deepClone(opts.meta) : {},
      baseSnapshot:{
        ui:sanitizeUiForScene(srcState.ui),
        catalog:{ activeShapeId },
        floorPlane:sanitizeFloorPlane(srcState.floorPlane),
        zones
      }
    };
  }

  function serializeVariantSnapshot(options){
    const opts=asObj(options);
    const srcState=opts.state || state;
    if(!srcState) throw new Error("PhotoPave state is unavailable");
    const zones=asArr(srcState.zones);
    const activeZone=findZoneById(zones, srcState.ui && srcState.ui.activeZoneId) || zones[0] || null;
    const activeShapeId = asStr(opts.shapeId || (activeZone && activeZone.material && activeZone.material.shapeId) || (srcState.catalog && srcState.catalog.activeShapeId), null);
    const activeTextureId = asStr(opts.textureId || (activeZone && activeZone.material && activeZone.material.textureId), null);
    if(!activeShapeId) throw new Error("Cannot serialize variant snapshot without shapeId");
    if(!activeTextureId) throw new Error("Cannot serialize variant snapshot without textureId");
    const sceneId = PresetsNS && typeof PresetsNS.makeSceneId === "function"
      ? PresetsNS.makeSceneId(opts.sceneId || opts.id || (srcState.scenePresets && srcState.scenePresets.activeSceneId) || "scene", "scene")
      : asStr(opts.sceneId || opts.id, "scene");
    const key = PresetsNS && typeof PresetsNS.buildVariantKey === "function"
      ? PresetsNS.buildVariantKey(sceneId, activeShapeId, activeTextureId)
      : [sceneId, activeShapeId, activeTextureId].join("__");
    return {
      schemaVersion:SCHEMA_VERSION,
      kind:VARIANT_KIND,
      id:key,
      key,
      sceneId,
      shapeId:activeShapeId,
      textureId:activeTextureId,
      title:asStr(opts.title, key),
      status:asStr(opts.status, "draft"),
      updatedAt:new Date().toISOString(),
      sourceBuild:srcState.build && srcState.build.version ? String(srcState.build.version) : null,
      meta:opts.meta && typeof opts.meta === "object" ? deepClone(opts.meta) : {},
      stateSnapshot:{
        ui:sanitizeUiForVariant(srcState.ui),
        catalog:{ activeShapeId },
        ai:sanitizeAiForVariant(srcState.ai),
        zones:zones.map((z)=>sanitizeZoneVariant(z, activeShapeId))
      }
    };
  }

  function deserializeSceneBase(payload){
    const src=asObj(payload);
    const sceneId = PresetsNS && typeof PresetsNS.makeSceneId === "function"
      ? PresetsNS.makeSceneId(src.sceneId || src.id || src.title, "scene")
      : asStr(src.sceneId || src.id, "scene");
    const snapshot=asObj(src.baseSnapshot);
    const ui = sanitizeUiForScene(snapshot.ui || src.ui || null);
    const catalog = asObj(snapshot.catalog || src.catalog);
    const floorPlane = sanitizeFloorPlane(snapshot.floorPlane || src.floorPlane || null);
    const zones = asArr(snapshot.zones || src.zones).map(sanitizeZoneGeometry);
    return {
      schemaVersion:Number(src.schemaVersion) > 0 ? Number(src.schemaVersion) : SCHEMA_VERSION,
      kind:SCENE_KIND,
      id:sceneId,
      sceneId,
      title:asStr(src.title, sceneId),
      updatedAt:asStr(src.updatedAt, null),
      sourceBuild:asStr(src.sourceBuild, null),
      photo:scenePhotoInfo(src.photo || {}, { assets:{} }),
      ui,
      catalog:{ activeShapeId: asStr(catalog.activeShapeId, null) },
      floorPlane,
      zones,
      meta:src.meta && typeof src.meta === "object" ? deepClone(src.meta) : {},
      baseSnapshot:{ ui, catalog:{ activeShapeId: asStr(catalog.activeShapeId, null) }, floorPlane, zones }
    };
  }

  function deserializeVariantSnapshot(payload){
    const src=asObj(payload);
    const sceneId = PresetsNS && typeof PresetsNS.makeSceneId === "function"
      ? PresetsNS.makeSceneId(src.sceneId || src.id, "scene")
      : asStr(src.sceneId, "scene");
    const shapeId=asStr(src.shapeId, null);
    const textureId=asStr(src.textureId, null);
    const key = PresetsNS && typeof PresetsNS.buildVariantKey === "function"
      ? PresetsNS.buildVariantKey(sceneId || "scene", shapeId || "shape", textureId || "texture")
      : asStr(src.key || src.id, null);
    const snap=asObj(src.stateSnapshot);
    return {
      schemaVersion:Number(src.schemaVersion) > 0 ? Number(src.schemaVersion) : SCHEMA_VERSION,
      kind:VARIANT_KIND,
      id:key,
      key,
      sceneId,
      shapeId,
      textureId,
      title:asStr(src.title, key),
      status:asStr(src.status, "draft"),
      updatedAt:asStr(src.updatedAt, null),
      sourceBuild:asStr(src.sourceBuild, null),
      meta:src.meta && typeof src.meta === "object" ? deepClone(src.meta) : {},
      stateSnapshot:{
        ui:sanitizeUiForVariant(snap.ui),
        catalog:{ activeShapeId: asStr(snap.catalog && snap.catalog.activeShapeId, shapeId) },
        ai:sanitizeAiForVariant(snap.ai),
        zones:asArr(snap.zones).map((z)=>sanitizeZoneVariant(z, shapeId))
      }
    };
  }

  function applySceneBase(payload, options){
    const opts=asObj(options);
    const dst=opts.state || state;
    if(!dst) throw new Error("PhotoPave state is unavailable");
    const scene=deserializeSceneBase(payload);
    const defaultParams = StateNS && StateNS.defaults && StateNS.defaults.materialParams ? deepClone(StateNS.defaults.materialParams) : { scale:12, rotation:0, offsetU:0, offsetV:0, opacity:1, blendMode:"source-over", opaqueFill:true, perspective:0.75, horizon:0.18 };
    dst.floorPlane = scene.floorPlane;
    dst.zones = deepClone(scene.zones).map((z)=>{
      const params_base=deepClone(defaultParams);
      const params_ultra=deepClone(defaultParams);
      return Object.assign({ material:{ shapeId:scene.catalog.activeShapeId || null, textureId:null, textureUrl:null, maps:null, mapsMeta:null, mapSet:null, pbrParams:null, params_base:params_base, params_ultra:params_ultra, params:(dst.ai && dst.ai.enabled ? params_ultra : params_base), _ultraTuned:null }, baseParams:null, overrides:null, meta:{ userTouchedScale:false } }, z);
    });
    dst.catalog = dst.catalog || {};
    if(scene.catalog.activeShapeId) dst.catalog.activeShapeId = scene.catalog.activeShapeId;
    dst.ui = dst.ui || {};
    if(scene.ui.masterZoneId != null) dst.ui.masterZoneId = scene.ui.masterZoneId;
    if(scene.ui.activeZoneId != null) dst.ui.activeZoneId = scene.ui.activeZoneId || (dst.zones[0] && dst.zones[0].id) || null;
    if(scene.ui.activeCutoutId != null) dst.ui.activeCutoutId = scene.ui.activeCutoutId;
    if(scene.ui.editScope) dst.ui.editScope = scene.ui.editScope;
    if(scene.ui.shellMode) dst.ui.shellMode = scene.ui.shellMode;
    dst.ui.secondaryToolsOpen = !!scene.ui.secondaryToolsOpen;
    if(scene.ui.singleZoneMode != null) dst.ui.singleZoneMode = !!scene.ui.singleZoneMode;
    if(!dst.ui.activeZoneId && dst.zones[0] && dst.zones[0].id) dst.ui.activeZoneId = dst.zones[0].id;
    dst.scenePresets = dst.scenePresets || {};
    dst.scenePresets.activeSceneId = scene.sceneId;
    dst.scenePresets.loadedAt = new Date().toISOString();
    dst.scenePresets.lastSceneBase = deepClone(scene);
    return scene;
  }

  function applyVariantSnapshot(payload, options){
    const opts=asObj(options);
    const dst=opts.state || state;
    if(!dst) throw new Error("PhotoPave state is unavailable");
    const variant=deserializeVariantSnapshot(payload);
    dst.catalog = dst.catalog || {};
    dst.ui = dst.ui || {};
    dst.ai = dst.ai || {};
    if(variant.stateSnapshot.catalog.activeShapeId) dst.catalog.activeShapeId = variant.stateSnapshot.catalog.activeShapeId;
    const ui=variant.stateSnapshot.ui;
    if(ui.masterZoneId != null) dst.ui.masterZoneId = ui.masterZoneId;
    if(ui.activeZoneId != null) dst.ui.activeZoneId = ui.activeZoneId;
    if(ui.activeCutoutId != null) dst.ui.activeCutoutId = ui.activeCutoutId;
    if(ui.editScope) dst.ui.editScope = ui.editScope;
    if(ui.shellMode) dst.ui.shellMode = ui.shellMode;
    dst.ui.secondaryToolsOpen = !!ui.secondaryToolsOpen;

    const ai=variant.stateSnapshot.ai;
    dst.ai.enabled = ai.enabled;
    dst.ai.quality = ai.quality;
    dst.ai.userToggled = ai.userToggled;
    dst.ai.occlusionEnabled = ai.occlusionEnabled;
    dst.ai.calib = deepClone(ai.calib);
    dst.ai.calib3d = deepClone(ai.calib3d);

    const byId=new Map(asArr(dst.zones).map((z, index)=>[z && z.id ? z.id : "#"+index, z]));
    asArr(variant.stateSnapshot.zones).forEach((snap, index)=>{
      const target = (snap.id && byId.get(snap.id)) || asArr(dst.zones)[index] || null;
      if(!target) return;
      target.name = snap.name;
      target.enabled = snap.enabled;
      target.linked = snap.linked;
      target.baseParams = snap.baseParams ? deepClone(snap.baseParams) : null;
      target.overrides = snap.overrides ? deepClone(snap.overrides) : null;
      target.material = target.material || {};
      const sm=snap.material || {};
      target.material.shapeId = sm.shapeId;
      target.material.textureId = sm.textureId;
      target.material.textureUrl = sm.textureUrl;
      target.material.tileSizeM = sm.tileSizeM;
      target.material.maps = sm.maps ? deepClone(sm.maps) : null;
      target.material.mapsMeta = sm.mapsMeta ? deepClone(sm.mapsMeta) : null;
      target.material.mapSet = sm.mapSet ? deepClone(sm.mapSet) : null;
      target.material.pbrParams = sm.pbrParams ? deepClone(sm.pbrParams) : null;
      target.material.params_base = sm.params_base ? deepClone(sm.params_base) : null;
      target.material.params_ultra = sm.params_ultra ? deepClone(sm.params_ultra) : null;
      target.material._ultraTuned = sm.ultraTuned ? deepClone(sm.ultraTuned) : null;
      target.material.params = dst.ai.enabled ? target.material.params_ultra : target.material.params_base;
    });
    dst.scenePresets = dst.scenePresets || {};
    dst.scenePresets.activeSceneId = variant.sceneId;
    dst.scenePresets.activeVariantKey = variant.key;
    dst.scenePresets.loadedAt = new Date().toISOString();
    dst.scenePresets.lastVariantSnapshot = deepClone(variant);
    return variant;
  }

  function captureAuthoringBundle(options){
    const opts=asObj(options);
    return {
      schemaVersion:SCHEMA_VERSION,
      kind:"scene-authoring-bundle",
      updatedAt:new Date().toISOString(),
      scene:serializeSceneBase(opts.scene || opts),
      variant:serializeVariantSnapshot(opts.variant || opts)
    };
  }

  const API={
    schemaVersion:SCHEMA_VERSION,
    kinds:{ scene:SCENE_KIND, variant:VARIANT_KIND },
    serializeSceneBase,
    serializeVariantSnapshot,
    deserializeSceneBase,
    deserializeVariantSnapshot,
    applySceneBase,
    applyVariantSnapshot,
    captureAuthoringBundle
  };

  if(window.PhotoPaveScenePresets && typeof window.PhotoPaveScenePresets === "object"){
    window.PhotoPaveScenePresets.State = API;
  }

  return API;
})();
