
window.PhotoPaveAPI=(function(){
  const {state}=window.PhotoPaveState;
  const setStatus=(t)=>{const el=document.getElementById("statusText");if(el)el.textContent=t||"";};
  async function _headExists(url){
    try{ const r=await fetch(url,{method:"HEAD",cache:"no-store"}); return !!r.ok; }catch(_){ return false; }
  }

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



  function resolveAssetUrl(u, shapeId, textureId){
    if(!u || typeof u !== "string") return null;
    const s = u.trim();
    const storageBase = state.api.storageBase.replace(/\/$/,"");
    // Relative paths -> Object Storage
    if(!/^https?:\/\//i.test(s)){
      const rel = s.replace(/^\//,"");
      if(rel.startsWith("surfaces/") || rel.startsWith("palettes/")){
        return storageBase + "/" + rel;
      }
      // sometimes palette stores just filename or subpath; try to map to surfaces
      if(shapeId && textureId && rel){
        // If looks like an albedo file name, attach to standard surfaces path
        if(/\.(png|jpe?g|webp)$/i.test(rel) && !rel.includes("/")){
          return storageBase + "/surfaces/" + encodeURIComponent(shapeId) + "/" + encodeURIComponent(textureId) + "/1k/" + rel;
        }
      }
      return new URL(rel, window.location.href).toString();
    }
    // Absolute URLs
    if(s.includes(".apigw.yandexcloud.net")){
      // Common proxy patterns: .../webar3dtexture/<path> or .../surfaces/<path> or .../palettes/<path>
      const m = s.match(/\/webar3dtexture\/(.+)$/);
      if(m) return storageBase + "/" + m[1];
      const m2 = s.match(/\/(surfaces\/.+)$/);
      if(m2) return storageBase + "/" + m2[1];
      const m3 = s.match(/\/(palettes\/.+)$/);
      if(m3) return storageBase + "/" + m3[1];
      // If still gateway, drop it (will likely 401) and try storage-based guess
      if(shapeId && textureId){
        return storageBase + "/surfaces/" + encodeURIComponent(shapeId) + "/" + encodeURIComponent(textureId) + "/1k/" + encodeURIComponent(textureId) + "_albedo.webp";
      }
    }
    return s;
  }

  function normalizePaletteTextures(pal, shapeId){
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
      const pUrl = resolveAssetUrl(previewUrl, shapeId, textureId);
      const aUrl = resolveAssetUrl(albedoUrl, shapeId, textureId) || resolveAssetUrl(previewUrl, shapeId, textureId);
      out.push({textureId,title,previewUrl:pUrl,albedoUrl:aUrl,raw:it});
    }
    return out;
  }
  async function loadPalette(shapeId){
  setStatus("Загрузка палитры…");
  state.catalog.paletteMissing = state.catalog.paletteMissing || {};
  if(state.catalog.paletteMissing[shapeId]){
    setStatus("Палитра недоступна");
    return {palette:null,textures:[]};
  }
  // Many deployments protect /api/palettes with JWT (401 missing_token).
  // For this public website widget we prefer reading palettes directly from Object Storage.
  const s3Url=state.api.storageBase.replace(/\/$/,"")+"/palettes/"+encodeURIComponent(shapeId)+".json";
  const apiUrl=state.api.apiBase+"/api/palettes/"+encodeURIComponent(shapeId);
  let pal=null;
  try{
    // Avoid console noise on missing palette keys: HEAD-check first.
    const has = await _headExists(s3Url);
    if(!has) throw new Error("palette_missing");
    pal=await fetchJson(s3Url);
  }catch(eS3){
    // Optional gateway fallback (often returns 401 missing_token). Disabled by default.
    if(state.api && state.api.allowApiPalette){
      try{ pal=await fetchJson(apiUrl); }
      catch(_eApi){ pal=null; }
    }else{
      pal=null;
    }
  }
  if(!pal){ state.catalog.paletteMissing[shapeId]=true; state.catalog.palettesByShape[shapeId]=null; state.catalog.texturesByShape[shapeId]=[]; setStatus("Текстуры для этой формы временно недоступны"); return {palette:null,textures:[]}; }

  state.catalog.palettesByShape[shapeId]=pal;
  const tex=normalizePaletteTextures(pal, shapeId).map(t=>({
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
    // Cache key should be the final URL actually used.
    if(cache.has(url)) return cache.get(url).img;

    // Two-pass strategy:
    // 1) Try CORS-safe load (crossOrigin="anonymous") so canvas export works.
    // 2) If it fails (likely missing CORS on bucket for this domain), retry WITHOUT CORS so rendering works,
    //    but warn that export may be blocked ("tainted canvas") until CORS is fixed.
    async function tryLoad(u, useCORS){
      return await new Promise((resolve,reject)=>{
        const img=new Image();
        if(useCORS) img.crossOrigin="anonymous";
        img.onload=()=>resolve(img);
        img.onerror=()=>reject(new Error("Image load failed: "+u+(useCORS?" (CORS)":" (no-CORS)")));
        img.src=u;
      });
    }

    let finalUrl=url;
    let img=null;

    try{
      img=await tryLoad(finalUrl, true);
    }catch(e1){
      // Retry once by rewriting gateway/proxy URLs to Object Storage
      const alt = (typeof resolveAssetUrl==="function") ? resolveAssetUrl(finalUrl, null, null) : null;
      if(alt && alt!==finalUrl){
        try{
          img=await tryLoad(alt, true);
          finalUrl=alt;
        }catch(e2){
          // Fall back to no-CORS load (rendering will work; exporting may not)
          console.warn("[assets] CORS-safe image load failed, falling back to no-CORS. Export may be blocked until CORS is configured.", e2);
          img=await tryLoad(alt, false);
          finalUrl=alt;
        }
      }else{
        // Fall back to no-CORS load
        console.warn("[assets] CORS-safe image load failed, falling back to no-CORS. Export may be blocked until CORS is configured.", e1);
        img=await tryLoad(finalUrl, false);
      }
    }

    const entry={img,ts:Date.now()};
    cache.set(finalUrl, entry);
    if(url!==finalUrl) cache.set(url, entry);
    if(cache.size>14){
      const entries=[...cache.entries()].sort((a,b)=>a[1].ts-b[1].ts);
      for(let i=0;i<Math.max(1,cache.size-14);i++) cache.delete(entries[i][0]);
    }
    return img;
  }
  return {setStatus,loadConfig,loadShapes,loadPalette,loadImage};
})();
