
window.PhotoPaveAPI=(function(){
  const {state}=window.PhotoPaveState;
  const setStatus=(t)=>{const el=document.getElementById("statusText");if(el)el.textContent=t||"";};
  async function fetchJson(url,opts={}){
    // opts may include headers, method, body

    const res=await fetch(url,{...opts,headers:{...(opts.headers||{}),"Accept":"application/json"}});
    if(!res.ok){const txt=await res.text().catch(()=> "");throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} :: ${txt.slice(0,120)}`);}
    return await res.json();
  }

function isAuthMissing(err){
  const msg=String(err&&err.message||"");
  return msg.includes("HTTP 401") || msg.includes("missing_token") || msg.includes("Unauthorized");
}
async function tryJsonCandidates(urls){
  let lastErr=null;
  for(const u of urls){
    try{ return await fetchJson(u); }catch(e){ lastErr=e; }
  }
  throw lastErr||new Error("All candidates failed");
}
function absFromStorageMaybe(p){
  if(!p) return null;
  if(typeof p!=="string") return null;
  if(/^https?:\/\//i.test(p)) return p;
  // common cases: "surfaces/..." or "/surfaces/..."
  const key=p.replace(/^\//,"");
  return state.api.storageBase.replace(/\/$/,"")+"/"+key;
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
  // In this photo-editor we treat shapes as PUBLIC static content.
  // Many deployments protect /api/shapes with JWT, so we do NOT rely on it.
  const baseHref=window.location.href;
  const candidates=[
    // current folder
    new URL("shapes.json", baseHref).toString(),
    // common subfolders
    new URL("data/shapes.json", baseHref).toString(),
    new URL("frontend_github_pages/shapes.json", baseHref).toString(),
    // explicit project pages (robust for iframe)
    "https://miropolcevpro.github.io/Test3dplitka/shapes.json",
    // legacy
    "https://miropolcevpro.github.io/test3d/shapes.json"
  ];

  try{
    const shapes=await tryJsonCandidates(candidates);
    state.catalog.shapes=Array.isArray(shapes)?shapes:(shapes.shapes||[]);
    return;
  }catch(eStatic){
    console.warn("Shapes load failed (static). Ensure shapes.json is deployed next to the editor.", eStatic);
    state.catalog.shapes=[];
    return;
  }
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
  const apiUrl=state.api.apiBase+"/api/palettes/"+encodeURIComponent(shapeId);
  let pal=null;
  try{
    pal=await fetchJson(apiUrl);
  }catch(e){
    // Fallback to public Object Storage palettes if API requires token
    const s3Url=state.api.storageBase.replace(/\/$/,"")+"/palettes/"+encodeURIComponent(shapeId)+".json";
    try{ pal=await fetchJson(s3Url); }
    catch(e2){ console.warn("Palette load failed", e, e2); pal=null; }
  }
  if(!pal){ state.catalog.palettesByShape[shapeId]=null; state.catalog.texturesByShape[shapeId]=[]; setStatus("Палитра не найдена"); return {palette:null,textures:[]}; }

  state.catalog.palettesByShape[shapeId]=pal;
  const tex=normalizePaletteTextures(pal).map(t=>({
    ...t,
    previewUrl: absFromStorageMaybe(t.previewUrl),
    albedoUrl: absFromStorageMaybe(t.albedoUrl),
  }));
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
