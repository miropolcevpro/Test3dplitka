
window.PhotoPaveState=(function(){
  const DEFAULT_GATEWAY="https://d5d1712p9mu7k3aurh9s.laqt4bj7.apigw.yandexcloud.net";
  const state={
    build:{version:"mvp-iter1.12-unified-contour-texturefix",ts:new Date().toISOString()},
    api:{gatewayBase:DEFAULT_GATEWAY,apiBase:DEFAULT_GATEWAY,storageBase:"https://storage.yandexcloud.net/webar3dtexture",config:null},
    ui:{activeStep:"photo",mode:"photo",activeZoneId:null,activeCutoutId:null,draggingPoint:null,selectedPoint:null,isPointerDown:false},
    catalog:{shapes:[],palettesByShape:{},texturesByShape:{},activeShapeId:null},
    assets:{photoBitmap:null,photoW:0,photoH:0,textureCache:new Map()},
    floorPlane:{points:[],closed:false},
    zones:[]
  };
  const uid=(p="id")=>p+"_"+Math.random().toString(16).slice(2)+"_"+Date.now().toString(16);
  const getActiveZone=()=>state.zones.find(z=>z.id===state.ui.activeZoneId)||null;
  const getActiveCutout=(z)=>z? (z.cutouts||[]).find(c=>c.id===state.ui.activeCutoutId)||null : null;
  const makeZone=()=>({id:uid("zone"),name:"Зона "+(state.zones.length+1),enabled:true,closed:false,contour:[],cutouts:[],material:{shapeId:state.catalog.activeShapeId||null,textureId:null,textureUrl:null,params:{scale:1.0,rotation:0,opacity:0.85,blendMode:"multiply"}}});
  const makeCutout=(n)=>({id:uid("cut"),name:n?("Вырез "+n):"Вырез",closed:false,polygon:[]});

  const history=[],future=[],HISTORY_LIMIT=60;
  const snapshot=()=>JSON.stringify({ui:{activeStep:state.ui.activeStep,mode:state.ui.mode,activeZoneId:state.ui.activeZoneId,activeCutoutId:state.ui.activeCutoutId},floorPlane:state.floorPlane,zones:state.zones,catalog:{activeShapeId:state.catalog.activeShapeId}});
  const restore=(json)=>{const s=JSON.parse(json);state.ui.activeStep=s.ui.activeStep;state.ui.mode=s.ui.mode;state.ui.activeZoneId=s.ui.activeZoneId;state.ui.activeCutoutId=s.ui.activeCutoutId;state.floorPlane=s.floorPlane;state.zones=s.zones;state.catalog.activeShapeId=s.catalog.activeShapeId;};
  const pushHistory=()=>{history.push(snapshot());if(history.length>HISTORY_LIMIT)history.shift();future.length=0;};
  const undo=()=>{if(history.length<2)return false;const cur=history.pop();future.push(cur);restore(history[history.length-1]);return true;};
  const redo=()=>{if(!future.length)return false;const next=future.pop();history.push(next);restore(next);return true;};

  return {state,uid,makeZone,makeCutout,getActiveZone,getActiveCutout,pushHistory,undo,redo};
})();
