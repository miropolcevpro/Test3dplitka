window.PhotoPaveState=(function(){
  const DEFAULT_GATEWAY="https://d5d1712p9mu7k3aurh9s.laqt4bj7.apigw.yandexcloud.net";

  const state={
    // IMPORTANT: version string is displayed in the footer and helps bust caches in iframe setups.
    build: { version: "mvp-iter2.2.46-ultra-autocalib",ts:new Date().toISOString()},
    api:{gatewayBase:DEFAULT_GATEWAY,apiBase:DEFAULT_GATEWAY,storageBase:"https://storage.yandexcloud.net/webar3dtexture",allowApiPalette:false,config:null},

    ui:{
      showContour:true,
      activeStep:"photo",
      mode:"photo",
      activeZoneId:null,
      activeCutoutId:null,
      draggingPoint:null,
      selectedPoint:null,
      isPointerDown:false
    },

    catalog:{shapes:[],palettesByShape:{},texturesByShape:{},activeShapeId:null},
    assets:{photoBitmap:null,photoW:0,photoH:0,textureCache:new Map()},

    // Ultra AI state (Patch 1/2)
    ai:{
      enabled:true,
      quality:"basic",
      status:"idle",
      device:{webgpu:false,tier:"low",mem:null,probeMs:0,error:null},
      photoHash:null,

      // Patch D (Auto-calibration): vanishing-point + horizon guidance (CV) layered on top of depth.
      // Goal: stable, natural default perspective in Ultra so users rarely touch sliders.
      calib:{
        enabled:true,
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
      },
      models:{
        // Depth ONNX model URL (Depth Anything V2 ViT-B outdoor dynamic).
        // Stored in Yandex Object Storage (public read + CORS required).
        depthUrl:"https://storage.yandexcloud.net/webar3dtexture/ai/models/depth_anything_v2_vitb_outdoor_dynamic.onnx"
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
      occlusionEnabled:true,
      _occPickMode:false,
      floorHintMask:null,
      depthMap:null,
      depthReady:false,
      // Debug
      timings:{},
      errors:[]
    },

    floorPlane:{points:[],closed:false},
    zones:[]
  };

  const uid=(p="id")=>p+"_"+Math.random().toString(16).slice(2)+"_"+Date.now().toString(16);
  const getActiveZone=()=>state.zones.find(z=>z.id===state.ui.activeZoneId)||null;
  const getActiveCutout=(z)=>z? (z.cutouts||[]).find(c=>c.id===state.ui.activeCutoutId)||null : null;

  const _clone=(o)=>JSON.parse(JSON.stringify(o));

  const makeZone=()=>{
    const base={scale:1.0,rotation:0,opacity:1.0,blendMode:"source-over",opaqueFill:true,perspective:0.75,horizon:0.0};
    const ultra=_clone(base);
    const active=(state.ai && state.ai.enabled!==false) ? ultra : base;
    return ({
    id:uid("zone"),
    name:"Зона "+(state.zones.length+1),
    enabled:true,
    closed:false,
    contour:[],
    cutouts:[],
    material:{
      shapeId:state.catalog.activeShapeId||null,
      textureId:null,
      textureUrl:null,
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
    ui:{activeStep:state.ui.activeStep,mode:state.ui.mode,activeZoneId:state.ui.activeZoneId,activeCutoutId:state.ui.activeCutoutId},
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
    state.floorPlane=s.floorPlane;
    state.zones=s.zones;
    state.catalog.activeShapeId=s.catalog.activeShapeId;
  };

  const pushHistory=()=>{history.push(snapshot());if(history.length>HISTORY_LIMIT)history.shift();future.length=0;};
  const undo=()=>{if(history.length<2)return false;const cur=history.pop();future.push(cur);restore(history[history.length-1]);return true;};
  const redo=()=>{if(!future.length)return false;const next=future.pop();history.push(next);restore(next);return true;};

  return {state,uid,makeZone,makeCutout,getActiveZone,getActiveCutout,pushHistory,undo,redo};
})();
