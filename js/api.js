
window.PhotoPaveAPI=(function(){
  const {state}=window.PhotoPaveState;
  const RELEASE=window.PhotoPaveReleaseConfig||null;
  const DIAG=window.PhotoPaveDiagnostics||null;
  const assetPolicy=(state.api && state.api.assetPolicy) || (RELEASE && RELEASE.assetDelivery) || {};
  const setStatus=(t)=>{const el=document.getElementById("statusText");if(el)el.textContent=t||"";};

  function _absUrl(url){
    try{ return new URL(url, window.location.href).toString(); }
    catch(_){ return String(url||""); }
  }
  function _assetAllowed(url, kind, fallback){
    try{
      if(RELEASE && typeof RELEASE.isAssetAllowed === "function") return RELEASE.isAssetAllowed(url, kind);
    }catch(_){ }
    return !!fallback;
  }
  function _ensureAllowed(url, kind, label){
    const abs = _absUrl(url);
    if(!_assetAllowed(abs, kind, true)) throw new Error((label||kind||"asset") + " blocked by release asset policy: " + abs);
    return abs;
  }
  function _setAssetError(message, withStatus, extra){
    state.assets = state.assets || {};
    const prev = state.assets.lastLoadError || null;
    state.assets.lastLoadError = message || null;
    if(message && withStatus !== false) setStatus(message);
    if(message && message !== prev){
      try{
        DIAG && DIAG.report && DIAG.report("asset_error", new Error(message), Object.assign({ withStatus: withStatus !== false }, extra||{}));
      }catch(_){ }
    }
    return message;
  }
  function _clearAssetError(){
    state.assets = state.assets || {};
    state.assets.lastLoadError = null;
    return null;
  }
  async function _headExists(url){
    try{ const r=await fetch(url,{method:"HEAD",cache:"no-store"}); return (r && typeof r.ok==="boolean") ? !!r.ok : false; }
    catch(_){ return null; }
  }

  function _texturePolicy(){
    const fallback = { preferredResolution:"2k", fallbackResolution:"1k", strategy:"2k_first_fallback_1k", applyTo:["albedo","normal","roughness","ao","height"] };
    const src = assetPolicy && assetPolicy.textureResolutionPolicy ? assetPolicy.textureResolutionPolicy : null;
    return Object.assign({}, fallback, src||{});
  }
  function _mapKindSuffix(kind){
    const k = String(kind||"albedo").toLowerCase();
    if(k === "basecolor") return "albedo";
    return ({ albedo:"albedo", normal:"normal", roughness:"roughness", ao:"ao", height:"height", preview:"preview" })[k] || k;
  }
  function _detectTextureResolution(url){
    const s = String(url||"");
    const m = s.match(/\/(1k|2k)\//i);
    return m ? String(m[1]).toLowerCase() : null;
  }
  function _replaceSurfaceResolution(url, resolution){
    const abs = _absUrl(url);
    return abs.replace(/\/(1k|2k)\//i, "/" + String(resolution||"2k") + "/");
  }
  function _basename(pathLike){
    const clean = String(pathLike||"").split("?")[0].split("#")[0];
    const parts = clean.split("/").filter(Boolean);
    return parts.length ? parts[parts.length-1] : "";
  }
  function _ensureSurfaceFilename(textureId, kind, candidate){
    const base = _basename(candidate||"");
    if(base && /\.(png|jpe?g|webp)$/i.test(base)) return base;
    const suffix = _mapKindSuffix(kind);
    return encodeURIComponent(textureId) + "_" + suffix + ".webp";
  }
  function _buildStorageSurfaceUrl(shapeId, textureId, resolution, fileName){
    if(!shapeId || !textureId || !fileName) return null;
    const storageBase = state.api.storageBase.replace(/\/$/,"");
    return storageBase + "/surfaces/" + encodeURIComponent(shapeId) + "/" + encodeURIComponent(textureId) + "/" + encodeURIComponent(String(resolution||"2k")) + "/" + fileName;
  }
  function _candidateFromRelativeAsset(rel, shapeId, textureId, kind, resolution){
    const trimmed = String(rel||"").replace(/^\//,"");
    if(!trimmed) return null;
    const storageBase = state.api.storageBase.replace(/\/$/,"");
    if(trimmed.startsWith("surfaces/") || trimmed.startsWith("palettes/")){
      const abs = storageBase + "/" + trimmed;
      if(trimmed.startsWith("surfaces/")) return _replaceSurfaceResolution(abs, resolution);
      return abs;
    }
    if(shapeId && textureId && /\.(png|jpe?g|webp)$/i.test(trimmed)){
      return _buildStorageSurfaceUrl(shapeId, textureId, resolution, _ensureSurfaceFilename(textureId, kind, trimmed));
    }
    return new URL(trimmed, window.location.href).toString();
  }
  function _candidateFromAbsoluteAsset(absUrl, shapeId, textureId, kind, resolution){
    const s = String(absUrl||"").trim();
    if(!s) return null;
    const storageBase = state.api.storageBase.replace(/\/$/,"");
    if(s.includes(".apigw.yandexcloud.net")){
      const m = s.match(/\/webar3dtexture\/(.+)$/);
      if(m) return _candidateFromRelativeAsset(m[1], shapeId, textureId, kind, resolution);
      const m2 = s.match(/\/(surfaces\/.+)$/);
      if(m2) return _candidateFromRelativeAsset(m2[1], shapeId, textureId, kind, resolution);
      const m3 = s.match(/\/(palettes\/.+)$/);
      if(m3) return storageBase + "/" + m3[1];
      if(shapeId && textureId){
        return _buildStorageSurfaceUrl(shapeId, textureId, resolution, _ensureSurfaceFilename(textureId, kind, null));
      }
    }
    if(/\/surfaces\//i.test(s)) return _replaceSurfaceResolution(s, resolution);
    return s;
  }
  function resolveTextureMapUrls(u, shapeId, textureId, kind){
    const policy = _texturePolicy();
    const preferredResolution = policy.preferredResolution || "2k";
    const fallbackResolution = policy.fallbackResolution || "1k";
    const normalizedKind = _mapKindSuffix(kind);
    const raw = (typeof u === "string") ? u.trim() : "";
    const declared = !!raw || normalizedKind === "albedo";
    let preferredUrl = null;
    if(raw){
      preferredUrl = /^https?:\/\//i.test(raw)
        ? _candidateFromAbsoluteAsset(raw, shapeId, textureId, normalizedKind, preferredResolution)
        : _candidateFromRelativeAsset(raw, shapeId, textureId, normalizedKind, preferredResolution);
    }else if(shapeId && textureId && normalizedKind === "albedo"){
      preferredUrl = _buildStorageSurfaceUrl(shapeId, textureId, preferredResolution, _ensureSurfaceFilename(textureId, normalizedKind, null));
    }
    const fallbackUrl = preferredUrl ? _replaceSurfaceResolution(preferredUrl, fallbackResolution) : null;
    return {
      preferredUrl,
      fallbackUrl,
      declared,
      kind: normalizedKind,
      preferredResolution,
      fallbackResolution,
      strategy: policy.strategy || "2k_first_fallback_1k"
    };
  }
  function resolveTextureFallbackUrl(url){
    const abs = _absUrl(url);
    const current = _detectTextureResolution(abs);
    if(current === "2k") return _replaceSurfaceResolution(abs, "1k");
    return null;
  }
  function _recordTextureLoad(requestedUrl, loadedUrl){
    state.assets = state.assets || {};
    state.assets.textureLoadInfo = state.assets.textureLoadInfo || {};
    const requested = _absUrl(requestedUrl||loadedUrl||"");
    const resolved = _absUrl(loadedUrl||requestedUrl||"");
    const entry = {
      requestedUrl: requested,
      loadedUrl: resolved,
      resolution: _detectTextureResolution(resolved),
      fallbackUsed: requested !== resolved,
      at: new Date().toISOString()
    };
    state.assets.textureLoadInfo[requested] = entry;
    state.assets.lastTextureLoad = entry;
    return entry;
  }

  async function fetchJson(url,opts={}){
    const abs=_ensureAllowed(url,"json","JSON asset");
    const res=await fetch(abs,{...opts,headers:{...(opts.headers||{}),"Accept":"application/json"}});
    if(!res.ok){const txt=await res.text().catch(()=> "");throw new Error(`HTTP ${res.status} ${res.statusText} for ${abs} :: ${txt.slice(0,120)}`);}
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
  const abs = /^https?:\/\//i.test(p)
    ? p
    : (state.api.storageBase.replace(/\/$/,"") + "/" + p.replace(/^\//,""));
  return _assetAllowed(abs, "image", true) ? abs : null;
}
  async function loadConfig(){
    setStatus("Загрузка config…");
    const base=state.api.gatewayBase;
    let cfg=null;
    try{cfg=await fetchJson(base+"/config");}catch(e1){try{cfg=await fetchJson(base+"/api/config");}catch(e2){cfg=null;}}
    state.api.config=cfg;
    const cand=cfg&&(cfg.apiBase||cfg.apiBaseUrl||cfg.baseUrl||cfg.gatewayBaseUrl||cfg.url);
    if(typeof cand==="string" && cand.startsWith("http") && _assetAllowed(cand, "json", true)){
      state.api.apiBase=cand.replace(/\/$/,"");
    }else{
      state.api.apiBase=base;
    }
    setStatus("API: "+state.api.apiBase);
    return state.api.apiBase;
  }
  async function loadShapes(){
  setStatus("Загрузка форм…");
  const relCandidates=(assetPolicy && Array.isArray(assetPolicy.shapesCandidates) && assetPolicy.shapesCandidates.length)
    ? assetPolicy.shapesCandidates
    : ["shapes.json","data/shapes.json","frontend_github_pages/shapes.json"];
  const candidates=[...new Set(relCandidates.map((rel)=>_absUrl(rel)).filter((url)=>_assetAllowed(url,"json",true)))];

  try{
    const shapes=await tryJsonCandidates(candidates);
    state.catalog.shapes=Array.isArray(shapes)?shapes:(shapes.shapes||[]);
    const ids=(state.catalog.shapes||[]).map((sh)=>sh && (sh.id||sh.shapeId||sh.slug)).filter(Boolean);
    if(ids.length && (!state.catalog.activeShapeId || ids.indexOf(state.catalog.activeShapeId)===-1)){
      state.catalog.activeShapeId=ids[0];
    }
    _clearAssetError();
    return;
  }catch(eStatic){
    console.warn("Shapes load failed (static). Ensure shapes.json is deployed next to the editor.", eStatic);
    state.catalog.shapes=[];
    _setAssetError("Формы не загружены: проверьте локальный shapes.json рядом с редактором.", true, { kind:"shapes", candidates:candidates });
    return;
  }
}



  function resolveAssetUrl(u, shapeId, textureId){
    if(!u || typeof u !== "string") return null;
    const s = u.trim();
    if(!/^https?:\/\//i.test(s)) return _candidateFromRelativeAsset(s, shapeId, textureId, "preview", "1k");
    return _candidateFromAbsoluteAsset(s, shapeId, textureId, "preview", "1k");
  }

  
  function _clamp(v, a, b){ return Math.min(b, Math.max(a, v)); }

  // Palette/material params (from bucket JSON). Supports Russian key "параметры" and English "params".
  // Contract (current bucket):
  //   normalScale, bumpScale, exposureMult, specStrength, roughnessMult,
  //   lightAzimuth, lightElevation, lightStrength, ambientStrength
  // We normalize to:
  //   normalScale, bumpScale, exposureMult, specStrength, roughnessMult (same keys, sanitized)
  function sanitizePaletteParams(p){
    if(!p || typeof p !== "object") return null;
    const out = {};
    const ns = Number(p.normalScale);
    const bs = Number(p.bumpScale);
    const em = Number(p.exposureMult);
    const ss = Number(p.specStrength);
    const rm = Number(p.roughnessMult);

    const la = Number(p.lightAzimuth);
    const le = Number(p.lightElevation);
    const ls = Number(p.lightStrength);
    const am = Number(p.ambientStrength);

    out.normalScale   = isFinite(ns) ? _clamp(ns, 0.0, 2.5) : 1.0;
    // bumpScale is reserved for height/parallax: keep conservative
    out.bumpScale     = isFinite(bs) ? _clamp(bs, 0.0, 0.12) : 0.0;
    out.exposureMult  = isFinite(em) ? _clamp(em, 0.5, 1.8) : 1.0;
    out.specStrength  = isFinite(ss) ? _clamp(ss, 0.0, 2.0) : 1.0;
    out.roughnessMult = isFinite(rm) ? _clamp(rm, 0.25, 2.5) : 1.0;

    // Lighting controls (degrees + strengths). Used by the PBR shader (Ultra only).
    out.lightAzimuth   = isFinite(la) ? (((la % 360) + 360) % 360) : null; // 0..360
    out.lightElevation = isFinite(le) ? _clamp(le, 0.0, 89.0) : null;      // degrees above horizon
    out.lightStrength  = isFinite(ls) ? _clamp(ls, 0.0, 2.5) : null;
    out.ambientStrength= isFinite(am) ? _clamp(am, 0.0, 1.2) : null;
    return out;
  }

  function mergePaletteParams(pal, it){
    const pPal = sanitizePaletteParams(pal?.params || pal?.["параметры"]);
    const pIt  = sanitizePaletteParams(it?.params  || it?.["параметры"]);
    if(!pPal && !pIt) return null;
    return {...(pPal||{}), ...(pIt||{})};
  }

function normalizePaletteTextures(pal, shapeId){
    const out=[];
    const arr=pal?.textures||pal?.items||pal||[];
    if(!Array.isArray(arr)) return out;

    for(const it of arr){
      const textureId=it.textureId||it.id||it.slug||it.key||null;
      const title=it.title||it.name||textureId||"Текстура";
      const previewUrl=it.preview||it.previewUrl||it.thumb||it.thumbnail||it.image||null;

      // Legacy + modern: albedo may live in it.albedo / it.baseColor / it.maps.albedo
      let albedoUrl=null;
      if(typeof it.albedo==="string") albedoUrl=it.albedo;
      else if(typeof it.albedoUrl==="string") albedoUrl=it.albedoUrl;
      else if(it.maps && typeof it.maps.albedo==="string") albedoUrl=it.maps.albedo;
      else if(it.maps && typeof it.maps.baseColor==="string") albedoUrl=it.maps.baseColor;
      else if(typeof it.baseColor==="string") albedoUrl=it.baseColor;

      const pUrl = resolveAssetUrl(previewUrl, shapeId, textureId);
      const aRes = resolveTextureMapUrls(albedoUrl, shapeId, textureId, "albedo");
      const nRes = resolveTextureMapUrls(it.maps?.normal, shapeId, textureId, "normal");
      const rRes = resolveTextureMapUrls(it.maps?.roughness, shapeId, textureId, "roughness");
      const aoRes = resolveTextureMapUrls(it.maps?.ao, shapeId, textureId, "ao");
      const hRes = resolveTextureMapUrls(it.maps?.height, shapeId, textureId, "height");
      const aUrl = aRes.preferredUrl || pUrl;

      // PBR maps: 2k-first with safe 1k fallback.
      const nUrl = nRes.preferredUrl;
      const rUrl = rRes.preferredUrl;
      const aoUrl = aoRes.preferredUrl;
      const hUrl = hRes.preferredUrl;

      const tileSizeM = (typeof it.tileSizeM==="number") ? it.tileSizeM :
                        (typeof it.tileSize==="number") ? it.tileSize : null;

      const params = mergePaletteParams(pal, it);


      out.push({
        textureId,
        title,
        previewUrl: pUrl,
        albedoUrl: aUrl,
        maps: { albedo: aUrl, normal: nUrl, roughness: rUrl, ao: aoUrl, height: hUrl },
        mapsMeta: {
          albedo: aRes,
          normal: nRes,
          roughness: rRes,
          ao: aoRes,
          height: hRes
        },
        mapSet: {
          strategy: aRes.strategy,
          declared: {
            albedo: !!aRes.preferredUrl,
            normal: !!nRes.preferredUrl,
            roughness: !!rRes.preferredUrl,
            ao: !!aoRes.preferredUrl,
            height: !!hRes.preferredUrl
          },
          fullPbrDeclared: !!(aRes.preferredUrl && nRes.preferredUrl && rRes.preferredUrl && aoRes.preferredUrl && hRes.preferredUrl),
          pbrGateNormalPresent: !!nRes.preferredUrl
        },
        tileSizeM,
        params,
        pbrComplete: !!(aUrl && nUrl && rUrl && aoUrl),
        raw: it
      });
    }
    return out;
  }
  async function loadPalette(shapeId){
  setStatus("Загрузка палитры…");
  state.catalog.paletteMissing = state.catalog.paletteMissing || {};
  // paletteMissing is a soft hint (e.g., confirmed 404). We keep a short TTL to avoid "missing forever".
  const miss = state.catalog.paletteMissing[shapeId];
  if(miss){
    const ts = (typeof miss === "number") ? miss : (miss.ts || 0);
    if(ts && (Date.now() - ts) < 60000){
      setStatus("Палитра недоступна");
      return {palette:null,textures:[]};
    }
    // TTL passed -> retry
    try{ delete state.catalog.paletteMissing[shapeId]; }catch(_){ }
  }
  // Many deployments protect /api/palettes with JWT (401 missing_token).
  // For this public website widget we prefer reading palettes directly from Object Storage.
  const s3Url=state.api.storageBase.replace(/\/$/,"")+"/palettes/"+encodeURIComponent(shapeId)+".json";
  const apiUrl=state.api.apiBase+"/api/palettes/"+encodeURIComponent(shapeId);
  let pal=null;
  let eS3=null;
  try{
    // Avoid console noise on missing palette keys: HEAD-check first.
    // NOTE: some proxies/buckets may block HEAD via CORS while allowing GET.
    // _headExists returns: true/false/null (null = inconclusive, do NOT treat as missing).
    const has = await _headExists(s3Url);
    if(has === false) throw new Error("palette_missing");
    pal = await fetchJson(s3Url);
  }catch(e){
    eS3=e;
    // Optional gateway fallback (often returns 401 missing_token). Disabled by default.
    if(state.api && state.api.allowApiPalette){
      try{ pal=await fetchJson(apiUrl); }
      catch(_eApi){ pal=null; }
    }else{
      pal=null;
    }
  }
  if(!pal){
    // Mark as missing ONLY for confirmed 404 responses (network/CORS should not poison the cache).
    const msg = String((eS3 && eS3.message) || "");
    if(msg.includes("HTTP 404") || msg.includes(" 404 " ) || msg.includes("palette_missing")){
      state.catalog.paletteMissing[shapeId] = Date.now();
    }
    state.catalog.palettesByShape[shapeId]=null;
    state.catalog.texturesByShape[shapeId]=[];
    _setAssetError("Текстуры для этой формы временно недоступны", true, { kind:"palette", shapeId:shapeId, url:s3Url });
    return {palette:null,textures:[]};
  }

  state.catalog.palettesByShape[shapeId]=pal;
  const tex=[];
  let blockedCount=0;
  for(const t of normalizePaletteTextures(pal, shapeId)){
    const previewUrl=absFromStorageMaybe(t.previewUrl);
    const albedoUrl=absFromStorageMaybe(t.albedoUrl);
    const maps=t.maps ? {
      albedo: absFromStorageMaybe(t.maps.albedo),
      normal: absFromStorageMaybe(t.maps.normal),
      roughness: absFromStorageMaybe(t.maps.roughness),
      ao: absFromStorageMaybe(t.maps.ao),
      height: absFromStorageMaybe(t.maps.height),
    } : null;
    const mapsMeta=t.mapsMeta ? {
      albedo: t.mapsMeta.albedo ? Object.assign({}, t.mapsMeta.albedo, { preferredUrl: absFromStorageMaybe(t.mapsMeta.albedo.preferredUrl), fallbackUrl: absFromStorageMaybe(t.mapsMeta.albedo.fallbackUrl) }) : null,
      normal: t.mapsMeta.normal ? Object.assign({}, t.mapsMeta.normal, { preferredUrl: absFromStorageMaybe(t.mapsMeta.normal.preferredUrl), fallbackUrl: absFromStorageMaybe(t.mapsMeta.normal.fallbackUrl) }) : null,
      roughness: t.mapsMeta.roughness ? Object.assign({}, t.mapsMeta.roughness, { preferredUrl: absFromStorageMaybe(t.mapsMeta.roughness.preferredUrl), fallbackUrl: absFromStorageMaybe(t.mapsMeta.roughness.fallbackUrl) }) : null,
      ao: t.mapsMeta.ao ? Object.assign({}, t.mapsMeta.ao, { preferredUrl: absFromStorageMaybe(t.mapsMeta.ao.preferredUrl), fallbackUrl: absFromStorageMaybe(t.mapsMeta.ao.fallbackUrl) }) : null,
      height: t.mapsMeta.height ? Object.assign({}, t.mapsMeta.height, { preferredUrl: absFromStorageMaybe(t.mapsMeta.height.preferredUrl), fallbackUrl: absFromStorageMaybe(t.mapsMeta.height.fallbackUrl) }) : null,
    } : null;
    if(!albedoUrl){ blockedCount++; continue; }
    tex.push({
      ...t,
      previewUrl,
      albedoUrl,
      maps,
      mapsMeta
    });
  }
  state.catalog.texturesByShape[shapeId]=tex;
  _clearAssetError();
  setStatus(blockedCount ? ("Текстур: "+tex.length+" · "+blockedCount+" скрыто политикой поставки") : ("Текстур: "+tex.length));
  return {palette:pal,textures:tex};
}

  // Strict CORS-only image loader (no no-CORS fallback).
  // Use this for WebGL texture uploads of data maps (normal/roughness/ao/height) to avoid taint/security errors.
  async function loadImageStrict(url){
    async function tryLoad(u){
      const abs = _ensureAllowed(u, "image", "Image asset");
      return await new Promise((resolve,reject)=>{
        const img=new Image();
        img.crossOrigin="anonymous";
        img.onload=()=>resolve(img);
        img.onerror=()=>reject(new Error("Image load failed: "+abs+" (CORS-only)"));
        img.src=abs;
      });
    }
    let finalUrl=_absUrl(url);
    try{
      const img = await tryLoad(finalUrl);
      _recordTextureLoad(finalUrl, finalUrl);
      state.assets.exportSafe = true;
      state.assets.exportBlockedReason = null;
      _clearAssetError();
      return img;
    }catch(e1){
      const alt = resolveTextureFallbackUrl(finalUrl);
      if(alt && alt!==finalUrl){
        const img = await tryLoad(alt);
        _recordTextureLoad(finalUrl, alt);
        state.assets.exportSafe = true;
        state.assets.exportBlockedReason = null;
        _clearAssetError();
        return img;
      }
      const msg = "Текстура недоступна для безопасной загрузки по CORS: " + String(finalUrl||"");
      state.assets.exportSafe = false;
      state.assets.exportBlockedReason = msg;
      _setAssetError(msg, true, { kind:"image", url: String(finalUrl||"") });
      throw e1;
    }
  }

  async function loadImage(url){
    const cache=state.assets.textureCache;
    if(cache.has(url)) return cache.get(url).img;

    async function tryLoad(u, useCORS){
      const abs = _ensureAllowed(u, "image", "Image asset");
      return await new Promise((resolve,reject)=>{
        const img=new Image();
        if(useCORS) img.crossOrigin="anonymous";
        img.onload=()=>resolve({img, finalUrl:abs});
        img.onerror=()=>reject(new Error("Image load failed: "+abs+(useCORS?" (CORS)":" (no-CORS)")));
        img.src=abs;
      });
    }

    let finalUrl=_absUrl(url);
    let img=null;

    try{
      const loaded=await tryLoad(finalUrl, true);
      img=loaded.img;
      finalUrl=loaded.finalUrl;
      _recordTextureLoad(url, finalUrl);
      state.assets.exportSafe = true;
      state.assets.exportBlockedReason = null;
      _clearAssetError();
    }catch(e1){
      const alt = resolveTextureFallbackUrl(finalUrl);
      if(alt && alt!==finalUrl){
        try{
          const loaded=await tryLoad(alt, true);
          img=loaded.img;
          finalUrl=loaded.finalUrl;
          _recordTextureLoad(url, finalUrl);
          state.assets.exportSafe = true;
          state.assets.exportBlockedReason = null;
          _clearAssetError();
        }catch(e2){
          if(assetPolicy && assetPolicy.allowNoCorsImageFallback){
            console.warn("[assets] CORS-safe image load failed, falling back to no-CORS. Export may be blocked until CORS is configured.", e2);
            const loaded=await tryLoad(alt, false);
            img=loaded.img;
            finalUrl=loaded.finalUrl;
            _recordTextureLoad(url, finalUrl);
            state.assets.exportSafe = false;
            state.assets.exportBlockedReason = "Texture loaded without CORS; PNG export may be blocked.";
            _setAssetError(state.assets.exportBlockedReason, true, { kind:"image", url: String(alt||finalUrl||"") });
          }else{
            const msg = "Текстура заблокирована: нужен CORS и разрешённый production-origin. URL: " + String(alt||finalUrl||"");
            state.assets.exportSafe = false;
            state.assets.exportBlockedReason = msg;
            _setAssetError(msg, true, { kind:"image", url: String(finalUrl||"") });
            throw new Error(msg);
          }
        }
      }else if(assetPolicy && assetPolicy.allowNoCorsImageFallback){
        console.warn("[assets] CORS-safe image load failed, falling back to no-CORS. Export may be blocked until CORS is configured.", e1);
        const loaded=await tryLoad(finalUrl, false);
        img=loaded.img;
        finalUrl=loaded.finalUrl;
        _recordTextureLoad(url, finalUrl);
        state.assets.exportSafe = false;
        state.assets.exportBlockedReason = "Texture loaded without CORS; PNG export may be blocked.";
        _setAssetError(state.assets.exportBlockedReason, true, { kind:"image", url: String(finalUrl||"") });
      }else{
        const msg = "Текстура заблокирована: нужен CORS и разрешённый production-origin. URL: " + String(finalUrl||"");
        state.assets.exportSafe = false;
        state.assets.exportBlockedReason = msg;
        _setAssetError(msg, true, { kind:"image", url: String(alt||finalUrl||"") });
        throw new Error(msg);
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
  return {setStatus,loadConfig,loadShapes,loadPalette,loadImage,loadImageStrict,resolveTextureFallbackUrl,detectTextureResolution:_detectTextureResolution};
})();
