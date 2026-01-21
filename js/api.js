
window.PhotoPaveAPI=(function(){
  const {state}=window.PhotoPaveState;
  const setStatus=(t)=>{const el=document.getElementById("statusText");if(el)el.textContent=t||"";};
  async function fetchJson(url,opts={}){
    const res=await fetch(url,{...opts,headers:{...(opts.headers||{}),"Accept":"application/json"}});
    if(!res.ok){const txt=await res.text().catch(()=> "");throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} :: ${txt.slice(0,120)}`);}
    return await res.json();
  }
  async function loadConfig(){
    setStatus("Загрузка config…");
    const base=state.api.gatewayBase;
    let cfg=null;
    try{cfg=await fetchJson(base+"/config");}catch(e1){try{cfg=await fetchJson(base+"/api/config");}catch(e2){cfg=null;}}
    state.api.config=cfg;
    const cand=cfg&&(cfg.apiBase||cfg.apiBaseUrl||cfg.baseUrl||cfg.gatewayBaseUrl||cfg.url);
    state.api.apiBase=(typeof cand==="string"&&cand.startsWith("http"))?cand.replace(/\/$/,""):base;
    setStatus("API: "+state.api.apiBase);
    return state.api.apiBase;
  }
  async function loadShapes(){
    setStatus("Загрузка форм…");
    const shapes=await fetchJson(state.api.apiBase+"/api/shapes");
    state.catalog.shapes=Array.isArray(shapes)?shapes:(shapes.shapes||[]);
    if(!state.catalog.activeShapeId&&state.catalog.shapes.length){
      const s0=state.catalog.shapes[0];
      state.catalog.activeShapeId=s0.id||s0.shapeId||s0.slug;
    }
    setStatus("Формы: "+state.catalog.shapes.length);
    return state.catalog.shapes;
  }
  function normalizePaletteTextures(pal){
    const out=[];const arr=pal?.textures||pal?.items||pal||[];if(!Array.isArray(arr))return out;
    for(const it of arr){
      const textureId=it.textureId||it.id||it.slug||it.key;
      const title=it.title||it.name||textureId||"Текстура";
      const previewUrl=it.preview||it.previewUrl||it.thumb||it.thumbnail||it.image||null;
      let albedoUrl=null;
      if(typeof it.albedo==="string")albedoUrl=it.albedo;
      else if(typeof it.albedoUrl==="string")albedoUrl=it.albedoUrl;
      else if(it.maps&&typeof it.maps.albedo==="string")albedoUrl=it.maps.albedo;
      else if(it.maps&&typeof it.maps.baseColor==="string")albedoUrl=it.maps.baseColor;
      else if(typeof it.baseColor==="string")albedoUrl=it.baseColor;
      out.push({textureId,title,previewUrl,albedoUrl,raw:it});
    }
    return out;
  }
  async function loadPalette(shapeId){
    setStatus("Загрузка палитры…");
    const pal=await fetchJson(state.api.apiBase+"/api/palettes/"+encodeURIComponent(shapeId));
    state.catalog.palettesByShape[shapeId]=pal;
    const tex=normalizePaletteTextures(pal);
    state.catalog.texturesByShape[shapeId]=tex;
    setStatus("Текстур: "+tex.length);
    return {palette:pal,textures:tex};
  }
  async function loadImage(url){
    const cache=state.assets.textureCache;
    if(cache.has(url))return cache.get(url).img;
    const img=new Image();img.crossOrigin="anonymous";
    await new Promise((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error("Image load failed: "+url));img.src=url;});
    cache.set(url,{img,ts:Date.now()});
    if(cache.size>14){
      const entries=[...cache.entries()].sort((a,b)=>a[1].ts-b[1].ts);
      for(let i=0;i<cache.size-12;i++)cache.delete(entries[i][0]);
    }
    return img;
  }
  return {setStatus,loadConfig,loadShapes,loadPalette,loadImage};
})();
