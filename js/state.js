window.PhotoPaveState=(function(){
  const DEFAULT_GATEWAY="https://d5d1712p9mu7k3aurh9s.laqt4bj7.apigw.yandexcloud.net";
  const DEFAULT_DEPTH_MODEL_URL="https://storage.yandexcloud.net/webar3dtexture/ai/models/depth_anything_v2_vitb_outdoor_dynamic.onnx";
  const RELEASE=window.PhotoPaveReleaseConfig||null;
  const relEnabled=(name,fallback)=>{
    try{
      return RELEASE && typeof RELEASE.isEnabled==="function" ? RELEASE.isEnabled(name, fallback) : !!fallback;
    }catch(_){ return !!fallback; }
  };
  const _clone=(o)=>JSON.parse(JSON.stringify(o));
  const uid=(p="id")=>p+"_"+Math.random().toString(16).slice(2)+"_"+Date.now().toString(16);

  const DEFAULT_MAT_PARAMS={
    scale:12.0,
    rotation:0,
    offsetU:0.0,
    offsetV:0.0,
    opacity:1.0,
    blendMode:"source-over",
    opaqueFill:true,
    perspective:0.75,
    horizon:0.18
  };

  function makeDefaultUiState(){
    return {
      showContour:true,
      activeStep:"photo",
      mode:"photo",
      // Z-C: editing scope for tiling/material controls
      // "active" = only active zone; "all" = all zones
      editScope:"active",
      masterZoneId:null,
      activeZoneId:null,
      activeCutoutId:null,
      draggingPoint:null,
      selectedPoint:null,
      isPointerDown:false,
      pointerCaptureId:null,
      splitDraft:null,
      _prevMode:null,
      shellMode:((RELEASE && RELEASE.simpleMode && RELEASE.simpleMode.defaultShellMode) || "simple"),
      secondaryToolsOpen:!!(RELEASE && RELEASE.simpleMode && RELEASE.simpleMode.defaultSecondaryToolsOpen),
      singleZoneMode:!relEnabled("multiZone", false)
    };
  }

  function makeDefaultAiCalibState(){
    return {
      enabled:true,
      // When false, calibration is computed for diagnostics/UI but is NOT injected into quad geometry.
      // This keeps premium perspective/horizon behavior identical to the stable base mode.
      applyToQuad:false,
      status:"idle",          // idle|running|ready|error
      source:null,             // "opencv"|"fallback"
      photoHash:null,
      // Results (normalized)
      vanish:null,             // {x:0..1,y:0..1}
      horizonY:null,           // 0..1
      planeDir:null,           // {x,y} in image space, normalized
      confidence:0,
      // Recommended user-controls for quad inference (same ranges as sliders)
      autoHorizon:0.0,         // -1..1
      autoPerspective:0.85     // 0..1
    };
  }

  function makeDefaultAiCalib3dState(){
    return {
      enabled:false,
      // When true and calibration is ready, use the 3D camera ray-plane renderer in WebGL (Variant B).
      use3DRenderer:true,
      // Strict product rule: paving always goes bottom->up; disallow depth inversion.
      forceBottomUp:true,
      // Variant B rule: contour is the single source of paving axis (bottom→up) and quad geometry.
      // Calibration lines affect only camera intrinsics (and later extrinsics), never the texture direction.
      contourDefinesAxis:true,
      // In Variant B, ignore AI-guided quad inference (keeps the new mode deterministic).
      disableAiQuad:true,
      // Allow 3D renderer to run without finished lines (uses robust fallback intrinsics).
      allowFallbackK:true,
      // When true, computed calibration can be mapped into the legacy horizon/perspective sliders.
      // For Variant B rollout we keep it OFF by default to avoid surprising jumps in the new mode.
      applyToActiveZone:false,
      // Active line key: "A1"|"A2"|"B1"|"B2"|null
      active:null,
      // Lines stored in image pixel coordinates: {p1:{x,y}, p2:{x,y}}
      lines:{ A1:null, A2:null, B1:null, B2:null },
      // Computed result (see js/camera_calib.js)
      result:null,
      lastGoodResult:null,
      status:"idle", // idle|editing|ready|error
      error:null,
      warn:null,
      showLines:false
    };
  }

  function makeDefaultAnalyticsState(){
    return {
      sessionId: uid("analytics"),
      sessionStartedAt: new Date().toISOString(),
      events:[],
      queue:[],
      counters:{},
      transport:{ mode:(RELEASE && RELEASE.analytics && RELEASE.analytics.transportMode) || "local_queue", endpoint:(RELEASE && RELEASE.analytics && RELEASE.analytics.endpoint) || null, enabled:!!(RELEASE && RELEASE.analytics && RELEASE.analytics.endpoint), lastFlushAt:null, lastFlushError:null },
      _loaded:false,
      _restoredFromStorage:false,
      _lastKey:null,
      _lastAt:0
    };
  }

  function makeDefaultDiagnosticsState(){
    return {
      sessionId: uid("diag"),
      sessionStartedAt: new Date().toISOString(),
      events:[],
      counters:{},
      lastCritical:null,
      _lastKey:null,
      _lastAt:0
    };
  }

  function makeDefaultAiState(){
    return {
      enabled:relEnabled("ultra", true),
      // GEOMETRY LOCK (Premium stability)
      // When true, premium mode uses the same deterministic bottom->top quad inference as the base mode.
      // This prevents rare near/far swaps, 180° inversions, and horizon-induced "fold" artifacts
      // caused by ambiguous AI direction estimates on weak-structure photos.
      // Product rule: paving always starts from the bottom of the photo and goes toward the top.
      geomLockBottomUp:true,
      quality:"basic",
      status:"idle",
      userToggled:false,
      device:{webgpu:false,webgl2:true,tier:"low",mem:null,cores:null,probeMs:0,error:null},
      capability:{tier:"reduced",label:"Reduced",reason:"Ожидание проверки устройства",ultraVisible:true,ultraAllowed:true,ultraDefault:false,runDepth:true,quality:"balanced",preferProvider:"auto",maxInputLongSide:224,exportScale:0.92,photoMp:0,mem:null,cores:null,webgl2:true,webgpu:false},
      photoHash:null,
      // Patch D (Auto-calibration): vanishing-point + horizon guidance (CV) layered on top of depth.
      // Goal: stable, natural default perspective in Ultra so users rarely touch sliders.
      calib:makeDefaultAiCalibState(),
      // Premium (3D Variant B - MVP): Manual camera calibration by user-defined perspective lines.
      calib3d:makeDefaultAiCalib3dState(),
      models:{
        // Depth ONNX model URL (Depth Anything V2 ViT-B outdoor dynamic).
        // Stored in Yandex Object Storage (public read + CORS required).
        depthUrl:DEFAULT_DEPTH_MODEL_URL
      },
      // Geometry (future patches)
      horizonY:null,
      vanish:null,
      planeDir:null,
      plane:null,
      confidence:0,
      // Masks
      // Interactive occlusion mask (premium). If present, compositor will clip tiles under objects.
      // Shape: {canvas:HTMLCanvasElement,width:number,height:number,photoHash:string,updatedAt:number}
      occlusionMask:null,
      // Feature toggles (UI)
      occlusionEnabled:relEnabled("occlusion", false),
      _occPickMode:false,
      floorHintMask:null,
      depthMap:null,
      depthReady:false,
      debugOverlay:false,
      // Debug
      timings:{},
      errors:[]
    };
  }

  function clearObject(target){
    if(!target || typeof target !== "object") return target;
    Object.keys(target).forEach((k)=>{ delete target[k]; });
    return target;
  }

  function resetUiState(target, overrides){
    const next=Object.assign(makeDefaultUiState(), overrides||{});
    const out=target && typeof target==="object" ? target : {};
    clearObject(out);
    Object.assign(out, next);
    return out;
  }

  function resetAiState(target, options){
    const prev=(target && typeof target==="object") ? target : {};
    const opts=options||{};
    const next=makeDefaultAiState();

    if(opts.preserveUserToggles !== false){
      if(typeof prev.enabled === "boolean") next.enabled = prev.enabled;
      if(typeof prev.userToggled === "boolean") next.userToggled = prev.userToggled;
      if(typeof prev.occlusionEnabled === "boolean") next.occlusionEnabled = prev.occlusionEnabled;
      if(prev.calib && typeof prev.calib.enabled === "boolean") next.calib.enabled = prev.calib.enabled;
      if(prev.calib3d && typeof prev.calib3d.enabled === "boolean") next.calib3d.enabled = prev.calib3d.enabled;
      if(prev.calib3d && typeof prev.calib3d.applyToActiveZone === "boolean") next.calib3d.applyToActiveZone = prev.calib3d.applyToActiveZone;
    }
    if(opts.preserveDevice !== false && prev.device && typeof prev.device === "object"){
      next.device = Object.assign(next.device, _clone(prev.device));
    }
    if(prev.capability && typeof prev.capability === "object"){
      next.capability = Object.assign({}, next.capability, _clone(prev.capability));
    }
    if(prev.models && typeof prev.models === "object"){
      next.models = Object.assign({}, next.models, _clone(prev.models));
    }
    if(typeof prev.debugOverlay === "boolean") next.debugOverlay = prev.debugOverlay;

    const out=target && typeof target==="object" ? target : {};
    clearObject(out);
    Object.assign(out, next);
    return out;
  }

  function resetProjectState(targetState, options){
    const st=targetState || state;
    const opts=options||{};
    st.ui = resetUiState(st.ui || {}, opts.uiOverrides || null);
    st.ai = resetAiState(st.ai || {}, { preserveUserToggles:true, preserveDevice:true });
    st.floorPlane = { points:[], closed:false };
    st.zones = [];

    st.assets = st.assets || {};
    st.assets.photoBitmap = null;
    st.assets.photoW = 0;
    st.assets.photoH = 0;
    if(!(st.assets.textureCache instanceof Map)) st.assets.textureCache = new Map();
    delete st.assets.photoAvgLum;
    delete st.assets.photoExposure;
    delete st.assets.photoLight;
    st.assets.lastLoadError = null;
    st.assets.exportSafe = true;
    st.assets.exportBlockedReason = null;
    st.assets.textureLoadInfo = {};
    st.assets.lastTextureLoad = null;
    return st;
  }

  const state={
    // IMPORTANT: version string is displayed in the footer and helps bust caches in iframe setups.
    build: { version: "mvp-iter2.2.182-autocontour-ui-restore",ts:new Date().toISOString(),preset:(RELEASE&&RELEASE.preset)||"legacy"},
    api:{gatewayBase:DEFAULT_GATEWAY,apiBase:DEFAULT_GATEWAY,storageBase:"https://storage.yandexcloud.net/webar3dtexture",allowApiPalette:!!(RELEASE&&RELEASE.assetDelivery&&RELEASE.assetDelivery.allowApiPaletteFallback),assetPolicy:(RELEASE&&RELEASE.assetDelivery)||null,config:null},
    ui:makeDefaultUiState(),
    catalog:{shapes:[],palettesByShape:{},texturesByShape:{},activeShapeId:null},
    assets:{photoBitmap:null,photoW:0,photoH:0,textureCache:new Map(),lastLoadError:null,exportSafe:true,exportBlockedReason:null,textureLoadInfo:{},lastTextureLoad:null},
    // UX premium helpers
    ux:{autoScaleEnabled:true,autoScaleK:3.6},
    // Ultra AI state (Patch 1/2)
    ai:makeDefaultAiState(),
    diagnostics:makeDefaultDiagnosticsState(),
    analytics:makeDefaultAnalyticsState(),
    release:{preset:(RELEASE&&RELEASE.preset)||"legacy",patch:(RELEASE&&RELEASE.patch)||null,inventory:(RELEASE&&RELEASE.inventory)||null,assetDelivery:(RELEASE&&RELEASE.assetDelivery)||null,capabilityMatrix:(RELEASE&&RELEASE.capabilityMatrix)||null,analytics:(RELEASE&&RELEASE.analytics)||null,simpleMode:(RELEASE&&RELEASE.simpleMode)||null},
    floorPlane:{points:[],closed:false},
    zones:[]
  };

  const getActiveZone=()=>state.zones.find(z=>z.id===state.ui.activeZoneId)||null;
  const getActiveCutout=(z)=>z? (z.cutouts||[]).find(c=>c.id===state.ui.activeCutoutId)||null : null;

  const makeZone=()=>{
    const base=_clone(DEFAULT_MAT_PARAMS);
    const ultra=_clone(DEFAULT_MAT_PARAMS);
    const active=(state.ai && state.ai.enabled!==false) ? ultra : base;
    return ({
      id:uid("zone"),
      name:"Зона "+(state.zones.length+1),
      enabled:true,
      closed:false,
      contour:[],
      cutouts:[],
      meta:{userTouchedScale:false},
      // Z-D: per-zone linking to master tiling/params
      linked:!!relEnabled("multiZone", false),
      baseParams:null,
      overrides:{
        // multiplicative/offset deltas relative to master when linked
        scaleMult:1,
        rotOffset:0,
        opacityMult:1,
        perspectiveOffset:0,
        horizonOffset:0,
        blendModeOverride:null,
        opaqueFillOverride:null,
        materialOverride:null,
        shapeOverride:null
      },
      material:{
        shapeId:state.catalog.activeShapeId||null,
        textureId:null,
        textureUrl:null,
        maps:null,
        mapsMeta:null,
        mapSet:null,
        // Parameters are split between base and ultra modes to avoid cross-mode pollution.
        // material.params always points to the active set depending on state.ai.enabled.
        params_base:base,
        params_ultra:ultra,
        params:active
      }
    });
  };

  const makeCutout=(n)=>({id:uid("cut"),name:n?("Вырез "+n):"Вырез",closed:false,polygon:[]});

  const history=[],future=[],HISTORY_LIMIT=60;
  const snapshot=()=>JSON.stringify({
    ui:{
      activeStep:state.ui.activeStep,
      mode:state.ui.mode,
      activeZoneId:state.ui.activeZoneId,
      activeCutoutId:state.ui.activeCutoutId,
      editScope:state.ui.editScope,
      masterZoneId:state.ui.masterZoneId,
      // Z-S: split draft is part of user workflow; keep it undoable.
      splitDraft:state.ui.splitDraft || null,
      shellMode:state.ui.shellMode || "simple",
      secondaryToolsOpen:!!state.ui.secondaryToolsOpen
    },
    floorPlane:state.floorPlane,
    zones:state.zones,
    catalog:{activeShapeId:state.catalog.activeShapeId}
  });

  const restore=(json)=>{
    const s=JSON.parse(json);
    state.ui.activeStep=s.ui.activeStep;
    state.ui.mode=s.ui.mode;
    state.ui.activeZoneId=s.ui.activeZoneId;
    state.ui.activeCutoutId=s.ui.activeCutoutId;
    state.ui.editScope=s.ui.editScope;
    state.ui.masterZoneId=s.ui.masterZoneId;
    state.ui.splitDraft=s.ui.splitDraft||null;
    state.ui.shellMode=s.ui.shellMode||"simple";
    state.ui.secondaryToolsOpen=!!s.ui.secondaryToolsOpen;
    state.floorPlane=s.floorPlane;
    state.zones=s.zones;
    state.catalog.activeShapeId=s.catalog.activeShapeId;
  };

  const pushHistory=()=>{history.push(snapshot());if(history.length>HISTORY_LIMIT)history.shift();future.length=0;};
  const undo=()=>{if(history.length<2)return false;const cur=history.pop();future.push(cur);restore(history[history.length-1]);return true;};
  const redo=()=>{if(!future.length)return false;const next=future.pop();history.push(next);restore(next);return true;};

  return {
    state,
    uid,
    makeZone,
    makeCutout,
    getActiveZone,
    getActiveCutout,
    pushHistory,
    undo,
    redo,
    clone:_clone,
    defaults:{ materialParams:_clone(DEFAULT_MAT_PARAMS) },
    makeDefaultUiState,
    makeDefaultAiCalib3dState,
    makeDefaultAiState,
    makeDefaultDiagnosticsState,
    makeDefaultAnalyticsState,
    resetUiState,
    resetAiState,
    resetProjectState
  };
})();
