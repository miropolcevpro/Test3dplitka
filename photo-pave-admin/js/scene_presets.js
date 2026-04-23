window.PhotoPaveScenePresets=(function(){
  const S=window.PhotoPaveState||null;
  const API=window.PhotoPaveAPI||null;
  const RELEASE=window.PhotoPaveReleaseConfig||null;
  const state=S && S.state ? S.state : null;

  const DEFAULTS={
    schemaVersion:1,
    contractVersion:1,
    manifestFile:"manifest.json",
    sceneFile:"scene.json",
    variantsIndexFile:"variants.json",
    variantsDir:"variants",
    publishedRoot:"preset-scenes/published",
    draftRoot:"preset-scenes/draft",
    publicReadMode:"published_only",
    adminReadMode:"draft_then_published",
    enabled:false
  };

  function deepClone(v){
    return JSON.parse(JSON.stringify(v));
  }

  function isAbsUrl(v){
    return typeof v === "string" && /^https?:\/\//i.test(v.trim());
  }

  function absUrl(v){
    try{ return new URL(v, window.location.href).toString(); }
    catch(_){ return String(v||""); }
  }

  function dirnameUrl(v){
    const abs=absUrl(v);
    const idx=abs.lastIndexOf("/");
    return idx >= 0 ? abs.slice(0, idx + 1) : abs;
  }

  function resolveUrl(v, baseUrl){
    const raw=String(v||"").trim();
    if(!raw) return null;
    if(isAbsUrl(raw)) return raw;
    try{ return new URL(raw, baseUrl || window.location.href).toString(); }
    catch(_){ return absUrl(raw); }
  }

  function joinPath(){
    const out=[];
    for(let i=0;i<arguments.length;i++){
      const part=String(arguments[i]||"").trim();
      if(!part) continue;
      if(i===0 && isAbsUrl(part)){
        out.push(part.replace(/\/+$/,""));
        continue;
      }
      out.push(part.replace(/^\/+|\/+$/g,""));
    }
    if(!out.length) return "";
    const head=out[0];
    if(isAbsUrl(head)) return head + (out.length>1 ? "/" + out.slice(1).join("/") : "");
    return out.join("/");
  }

  function slugify(v, fallback){
    let s=String(v||"").toLowerCase().trim();
    s=s
      .replace(/[аàáâãäå]/g,"a")
      .replace(/[б]/g,"b")
      .replace(/[в]/g,"v")
      .replace(/[г]/g,"g")
      .replace(/[д]/g,"d")
      .replace(/[еёèéêë]/g,"e")
      .replace(/[ж]/g,"zh")
      .replace(/[з]/g,"z")
      .replace(/[иìíîï]/g,"i")
      .replace(/[й]/g,"j")
      .replace(/[к]/g,"k")
      .replace(/[л]/g,"l")
      .replace(/[м]/g,"m")
      .replace(/[н]/g,"n")
      .replace(/[оòóôõö]/g,"o")
      .replace(/[п]/g,"p")
      .replace(/[р]/g,"r")
      .replace(/[с]/g,"s")
      .replace(/[т]/g,"t")
      .replace(/[уùúûü]/g,"u")
      .replace(/[ф]/g,"f")
      .replace(/[х]/g,"h")
      .replace(/[ц]/g,"c")
      .replace(/[ч]/g,"ch")
      .replace(/[ш]/g,"sh")
      .replace(/[щ]/g,"sch")
      .replace(/[ъь]/g,"")
      .replace(/[ы]/g,"y")
      .replace(/[э]/g,"e")
      .replace(/[ю]/g,"yu")
      .replace(/[я]/g,"ya")
      .replace(/[^a-z0-9]+/g,"-")
      .replace(/^-+|-+$/g,"");
    return s || String(fallback||"scene");
  }

  function makeSceneId(input, fallback){
    return slugify(input, fallback || "scene");
  }

  function buildVariantKey(sceneId, shapeId, textureId){
    const s=makeSceneId(sceneId, "scene");
    const sh=slugify(shapeId, "shape");
    const tx=slugify(textureId, "texture");
    return [s, sh, tx].join("__");
  }

  function buildSceneSourceKey(sceneId, source){
    return [makeSceneId(sceneId, "scene"), String(source||"published")].join("@");
  }

  function buildVariantSourceKey(sceneId, shapeId, textureId, source){
    return [buildVariantKey(sceneId, shapeId, textureId), String(source||"published")].join("@");
  }

  function parseVariantKey(key){
    const raw=String(key||"");
    const parts=raw.split("__");
    return {
      raw,
      sceneId:parts[0]||null,
      shapeId:parts[1]||null,
      textureId:parts[2]||null,
      isComplete:parts.length >= 3 && !!parts[0] && !!parts[1] && !!parts[2]
    };
  }

  function normalizeConfig(src){
    const cfg=Object.assign({}, DEFAULTS, src||{});
    cfg.schemaVersion = Number(cfg.schemaVersion) > 0 ? Number(cfg.schemaVersion) : DEFAULTS.schemaVersion;
    cfg.contractVersion = Number(cfg.contractVersion) > 0 ? Number(cfg.contractVersion) : DEFAULTS.contractVersion;
    cfg.enabled = !!cfg.enabled;
    cfg.manifestFile = String(cfg.manifestFile || DEFAULTS.manifestFile);
    cfg.sceneFile = String(cfg.sceneFile || DEFAULTS.sceneFile);
    cfg.variantsIndexFile = String(cfg.variantsIndexFile || DEFAULTS.variantsIndexFile);
    cfg.variantsDir = String(cfg.variantsDir || DEFAULTS.variantsDir).replace(/^\/+|\/+$/g,"") || DEFAULTS.variantsDir;
    cfg.publishedRoot = String(cfg.publishedRoot || DEFAULTS.publishedRoot).replace(/\/+$/g,"");
    cfg.draftRoot = String(cfg.draftRoot || DEFAULTS.draftRoot).replace(/\/+$/g,"");
    cfg.publicReadMode = String(cfg.publicReadMode || DEFAULTS.publicReadMode);
    cfg.adminReadMode = String(cfg.adminReadMode || DEFAULTS.adminReadMode);
    return cfg;
  }

  function createRuntimeState(){
    return {
      schemaVersion:DEFAULTS.schemaVersion,
      enabled:false,
      status:"idle",
      source:"published",
      lastError:null,
      config:normalizeConfig(null),
      manifest:null,
      activeSceneId:null,
      activeVariantKey:null,
      loadedAt:null,
      scenesById:{},
      scenesBySourceId:{},
      variantsByKey:{},
      variantsBySourceKey:{},
      manifestsBySource:{},
      variantIndicesBySceneSource:{},
      lastResolved:null,
      requests:{ manifestUrl:null, sceneUrl:null, variantsIndexUrl:null, variantUrl:null, resolution:null },
      contract:null
    };
  }

  function ensureState(targetState){
    if(!targetState || typeof targetState !== "object") return null;
    if(!targetState.scenePresets || typeof targetState.scenePresets !== "object"){
      targetState.scenePresets = createRuntimeState();
    }
    if(!targetState.api || typeof targetState.api !== "object") targetState.api = {};
    const releaseCfg = RELEASE && RELEASE.scenePresets ? RELEASE.scenePresets : null;
    targetState.api.scenePresets = normalizeConfig(targetState.api.scenePresets || releaseCfg || null);
    const runtime = targetState.scenePresets;
    runtime.schemaVersion = targetState.api.scenePresets.schemaVersion;
    runtime.enabled = !!targetState.api.scenePresets.enabled;
    runtime.config = deepClone(targetState.api.scenePresets);
    if(!runtime.scenesById || typeof runtime.scenesById !== "object") runtime.scenesById = {};
    if(!runtime.scenesBySourceId || typeof runtime.scenesBySourceId !== "object") runtime.scenesBySourceId = {};
    if(!runtime.variantsByKey || typeof runtime.variantsByKey !== "object") runtime.variantsByKey = {};
    if(!runtime.variantsBySourceKey || typeof runtime.variantsBySourceKey !== "object") runtime.variantsBySourceKey = {};
    if(!runtime.manifestsBySource || typeof runtime.manifestsBySource !== "object") runtime.manifestsBySource = {};
    if(!runtime.variantIndicesBySceneSource || typeof runtime.variantIndicesBySceneSource !== "object") runtime.variantIndicesBySceneSource = {};
    if(!runtime.requests || typeof runtime.requests !== "object") runtime.requests = { manifestUrl:null, sceneUrl:null, variantsIndexUrl:null, variantUrl:null, resolution:null };
    if(!Object.prototype.hasOwnProperty.call(runtime.requests, "variantsIndexUrl")) runtime.requests.variantsIndexUrl = null;
    if(!Object.prototype.hasOwnProperty.call(runtime.requests, "resolution")) runtime.requests.resolution = null;
    if(!Object.prototype.hasOwnProperty.call(runtime, "lastResolved")) runtime.lastResolved = null;
    if(!Object.prototype.hasOwnProperty.call(runtime, "contract")) runtime.contract = null;
    return runtime;
  }

  function getStorageBase(){
    const base = state && state.api && state.api.storageBase ? state.api.storageBase : "";
    return String(base||"").replace(/\/+$/g,"");
  }

  function getRootUrl(source){
    const runtime=ensureState(state);
    const cfg=(runtime && runtime.config) ? runtime.config : normalizeConfig(null);
    const rel = source === "draft" ? cfg.draftRoot : cfg.publishedRoot;
    if(isAbsUrl(rel)) return rel.replace(/\/+$/g,"");
    const storageBase=getStorageBase();
    if(storageBase) return joinPath(storageBase, rel);
    return absUrl(rel);
  }

  function buildManifestUrl(source){
    const runtime=ensureState(state);
    const cfg=(runtime && runtime.config) ? runtime.config : normalizeConfig(null);
    return joinPath(getRootUrl(source), cfg.manifestFile);
  }

  function buildSceneUrl(sceneId, source){
    const runtime=ensureState(state);
    const cfg=(runtime && runtime.config) ? runtime.config : normalizeConfig(null);
    return joinPath(getRootUrl(source), makeSceneId(sceneId, "scene"), cfg.sceneFile);
  }

  function buildSceneAssetUrl(sceneId, source, fileName){
    return joinPath(getRootUrl(source), makeSceneId(sceneId, "scene"), fileName);
  }

  function buildVariantsIndexUrl(sceneId, source){
    const runtime=ensureState(state);
    const cfg=(runtime && runtime.config) ? runtime.config : normalizeConfig(null);
    return joinPath(getRootUrl(source), makeSceneId(sceneId, "scene"), cfg.variantsIndexFile);
  }

  function buildVariantUrl(sceneId, shapeId, textureId, source){
    const runtime=ensureState(state);
    const cfg=(runtime && runtime.config) ? runtime.config : normalizeConfig(null);
    return joinPath(getRootUrl(source), makeSceneId(sceneId, "scene"), cfg.variantsDir, slugify(shapeId, "shape") + "__" + slugify(textureId, "texture") + ".json");
  }

  function makeHttpErrorStatus(err){
    const raw=String(err && (err.message || err) || "");
    const match=raw.match(/HTTP\s+(\d{3})\b/i);
    return match ? Number(match[1]) : 0;
  }

  function isNotFoundError(err){
    const status=makeHttpErrorStatus(err);
    return status === 404;
  }

  function getReadMode(options){
    const runtime=ensureState(state);
    const cfg=(runtime && runtime.config) ? runtime.config : normalizeConfig(null);
    const explicit = options && options.readMode ? String(options.readMode) : "";
    if(explicit) return explicit;
    const context = options && options.context ? String(options.context) : "public";
    return context === "admin" ? cfg.adminReadMode : cfg.publicReadMode;
  }

  function normalizeSourceList(sources){
    const arr = Array.isArray(sources) ? sources : [sources];
    const out=[];
    arr.forEach((entry)=>{
      const value=String(entry||"").trim();
      if(!value) return;
      if(value !== "draft" && value !== "published") return;
      if(out.indexOf(value) === -1) out.push(value);
    });
    return out;
  }

  function getSourceOrder(options){
    const explicit = normalizeSourceList(options && options.sources);
    if(explicit.length) return explicit;
    const mode = getReadMode(options);
    if(mode === "draft_only") return ["draft"];
    if(mode === "draft_then_published") return ["draft","published"];
    if(mode === "published_then_draft") return ["published","draft"];
    return ["published"];
  }

  function makeResolutionMeta(kind, targetKey, options){
    const sources=getSourceOrder(options);
    return {
      kind:String(kind||"variant"),
      targetKey:String(targetKey||""),
      readMode:getReadMode(options),
      context:(options && options.context) ? String(options.context) : "public",
      requestedSources:sources.slice(),
      attempts:[],
      resolvedSource:null,
      resolvedUrl:null,
      cacheHit:false,
      status:"idle",
      at:new Date().toISOString()
    };
  }

  function storeResolutionMeta(meta){
    const runtime=ensureState(state);
    runtime.lastResolved = deepClone(meta || null);
    runtime.requests.resolution = meta && meta.resolvedUrl ? meta.resolvedUrl : null;
    return runtime.lastResolved;
  }

  function getCachedScene(sceneId, source){
    const runtime=ensureState(state);
    const sourceKey=buildSceneSourceKey(sceneId, source || "published");
    return runtime.scenesBySourceId[sourceKey] || null;
  }

  function getCachedVariant(sceneId, shapeId, textureId, source){
    const runtime=ensureState(state);
    const sourceKey=buildVariantSourceKey(sceneId, shapeId, textureId, source || "published");
    return runtime.variantsBySourceKey[sourceKey] || null;
  }

  async function fetchJson(url){
    if(API && typeof API.fetchJson === "function") return await API.fetchJson(url, { cache:"no-store" });
    const res=await fetch(absUrl(url), { cache:"no-store", headers:{ "Accept":"application/json" } });
    if(!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText + " for " + absUrl(url));
    return await res.json();
  }

  function normalizeContract(input, source){
    const runtime=ensureState(state);
    const cfg=(runtime && runtime.config) ? runtime.config : normalizeConfig(null);
    const src=input && typeof input === "object" ? input : {};
    return {
      version:Number(src.version || src.contractVersion || cfg.contractVersion || DEFAULTS.contractVersion) || DEFAULTS.contractVersion,
      source:String(source || src.source || "published"),
      rootUrl:src.rootUrl ? absUrl(src.rootUrl) : getRootUrl(source),
      manifestFile:String(src.manifestFile || cfg.manifestFile || DEFAULTS.manifestFile),
      sceneFile:String(src.sceneFile || cfg.sceneFile || DEFAULTS.sceneFile),
      variantsIndexFile:String(src.variantsIndexFile || cfg.variantsIndexFile || DEFAULTS.variantsIndexFile),
      variantsDir:String(src.variantsDir || cfg.variantsDir || DEFAULTS.variantsDir).replace(/^\/+|\/+$/g,"") || DEFAULTS.variantsDir
    };
  }

  function sceneSourceCacheKey(sceneId, source){
    return buildSceneSourceKey(sceneId, source);
  }

  function getSceneBaseUrl(sceneId, source){
    return dirnameUrl(buildSceneUrl(sceneId, source));
  }

  function normalizeSceneEntry(entry, source, ctx){
    const baseUrl = ctx && ctx.baseUrl ? ctx.baseUrl : getRootUrl(source);
    const contract = normalizeContract(ctx && ctx.contract, source);
    const src=entry && typeof entry === "object" ? entry : {};
    const sceneId=makeSceneId(src.id || src.sceneId || src.slug || src.title, "scene");
    const sceneDirUrl = src.sceneDirUrl ? resolveUrl(src.sceneDirUrl, baseUrl) : dirnameUrl(buildSceneUrl(sceneId, source));
    const sceneUrl = src.sceneUrl ? resolveUrl(src.sceneUrl, baseUrl) : resolveUrl(src.scenePath || contract.sceneFile, sceneDirUrl);
    const variantsIndexUrl = src.variantsUrl
      ? resolveUrl(src.variantsUrl, baseUrl)
      : resolveUrl(src.variantsIndexPath || contract.variantsIndexFile, sceneDirUrl);
    const thumbUrl = src.thumbUrl || src.thumbnailUrl ? resolveUrl(src.thumbUrl || src.thumbnailUrl, sceneDirUrl) : null;
    const coverUrl = src.coverUrl ? resolveUrl(src.coverUrl, sceneDirUrl) : thumbUrl;
    const photoUrl = src.photoUrl || (src.photo && (src.photo.url || src.photo.sourceUrl || src.photo.storageUrl))
      ? resolveUrl(src.photoUrl || src.photo.url || src.photo.sourceUrl || src.photo.storageUrl, sceneDirUrl)
      : null;
    return {
      id:sceneId,
      title:String((src.title || src.name || sceneId) || sceneId),
      enabled:typeof src.enabled === "boolean" ? !!src.enabled : true,
      order:Number(src.order) || 0,
      thumbUrl,
      coverUrl,
      photoUrl,
      sceneDirUrl,
      sceneUrl,
      variantsIndexUrl,
      source:source || "published"
    };
  }

  function normalizeManifest(input, opts){
    const src=input && typeof input === "object" ? input : {};
    const source=(opts && opts.source) || "published";
    const contract = normalizeContract(Object.assign({}, src.contract||{}, opts && opts.contract ? opts.contract : {}), source);
    const manifestUrl=(opts && opts.url) ? absUrl(opts.url) : buildManifestUrl(source);
    const baseUrl=dirnameUrl(manifestUrl);
    const sceneEntries = Array.isArray(src.scenes) ? src.scenes : (Array.isArray(src.items) ? src.items : []);
    const scenes = sceneEntries.map((entry)=>normalizeSceneEntry(entry, source, { baseUrl, contract })).sort((a,b)=>{
      if(a.order !== b.order) return a.order - b.order;
      return String(a.title||"").localeCompare(String(b.title||""), "ru");
    });
    return {
      schemaVersion:Number(src.schemaVersion || src.version) || DEFAULTS.schemaVersion,
      contract,
      source,
      defaultSceneId:src.defaultSceneId ? makeSceneId(src.defaultSceneId, scenes[0] && scenes[0].id) : (scenes[0] ? scenes[0].id : null),
      scenes,
      loadedFrom:manifestUrl,
      loadedAt:new Date().toISOString()
    };
  }

  function normalizeScene(input, opts){
    const src=input && typeof input === "object" ? input : {};
    const source=(opts && opts.source) || "published";
    const contract = normalizeContract(Object.assign({}, src.contract||{}, opts && opts.contract ? opts.contract : {}), source);
    const sceneUrl=(opts && opts.sceneUrl) ? absUrl(opts.sceneUrl) : buildSceneUrl(src.id || src.sceneId || (opts && opts.sceneId), source);
    const sceneDirUrl=dirnameUrl(sceneUrl);
    const inferredId=makeSceneId(src.id || src.sceneId || (opts && opts.sceneId) || src.title, "scene");
    const defaults = src.defaults && typeof src.defaults === "object" ? deepClone(src.defaults) : {};
    const scene = {
      id:inferredId,
      title:String(src.title || src.name || inferredId),
      enabled:src && typeof src.enabled === "boolean" ? !!src.enabled : true,
      order:Number(src.order) || 0,
      source,
      contract,
      urls:{
        sceneUrl:sceneUrl,
        sceneDirUrl:sceneDirUrl,
        photoUrl:src.photoUrl ? resolveUrl(src.photoUrl, sceneDirUrl) : (src.photo && (src.photo.url || src.photo.sourceUrl || src.photo.storageUrl) ? resolveUrl(src.photo.url || src.photo.sourceUrl || src.photo.storageUrl, sceneDirUrl) : null),
        thumbUrl:src.thumbUrl ? resolveUrl(src.thumbUrl, sceneDirUrl) : (src.thumbnailUrl ? resolveUrl(src.thumbnailUrl, sceneDirUrl) : null),
        coverUrl:src.coverUrl ? resolveUrl(src.coverUrl, sceneDirUrl) : null,
        variantsIndexUrl:src.variantsUrl ? resolveUrl(src.variantsUrl, sceneDirUrl) : resolveUrl(src.variantsIndexPath || contract.variantsIndexFile, sceneDirUrl)
      },
      geometry:{
        contour:Array.isArray(src.contour) ? deepClone(src.contour) : [],
        cutouts:Array.isArray(src.cutouts) ? deepClone(src.cutouts) : [],
        floorPlane:(src.floorPlane && typeof src.floorPlane === "object") ? deepClone(src.floorPlane) : null
      },
      baseSnapshot:(src.baseSnapshot && typeof src.baseSnapshot === "object") ? deepClone(src.baseSnapshot) : (src.sceneBaseSnapshot && typeof src.sceneBaseSnapshot === "object" ? deepClone(src.sceneBaseSnapshot) : null),
      defaults:{
        shapeId:defaults.shapeId || src.defaultShapeId || null,
        textureId:defaults.textureId || src.defaultTextureId || null,
        variantKey:defaults.variantKey || null
      },
      meta:src.meta && typeof src.meta === "object" ? deepClone(src.meta) : {},
      variantKeys:Array.isArray(src.variantKeys) ? src.variantKeys.map((v)=>String(v||"")).filter(Boolean) : [],
      variantIndex:src.variantIndex && typeof src.variantIndex === "object" ? deepClone(src.variantIndex) : {}
    };
    if(!scene.urls.coverUrl) scene.urls.coverUrl = scene.urls.thumbUrl || scene.urls.photoUrl || null;
    return scene;
  }

  function normalizeVariant(input, opts){
    const src=input && typeof input === "object" ? input : {};
    const source=(opts && opts.source) || "published";
    const sceneId=makeSceneId(src.sceneId || (opts && opts.sceneId), "scene");
    const shapeId=slugify(src.shapeId || src.formId || (opts && opts.shapeId), "shape");
    const textureId=slugify(src.textureId || src.materialId || (opts && opts.textureId), "texture");
    const key=String(src.key || src.id || buildVariantKey(sceneId, shapeId, textureId));
    const url=(opts && opts.url) ? absUrl(opts.url) : buildVariantUrl(sceneId, shapeId, textureId, source);
    const variantDirUrl=dirnameUrl(url);
    return {
      id:key,
      key,
      sceneId,
      shapeId,
      textureId,
      title:String(src.title || key),
      status:String(src.status || "draft"),
      source,
      updatedAt:src.updatedAt || null,
      createdAt:src.createdAt || null,
      sceneVersion:src.sceneVersion || null,
      snapshot:src.stateSnapshot && typeof src.stateSnapshot === "object" ? deepClone(src.stateSnapshot) : {},
      meta:src.meta && typeof src.meta === "object" ? deepClone(src.meta) : {},
      previewUrl:src.previewUrl ? resolveUrl(src.previewUrl, variantDirUrl) : null,
      url:url
    };
  }

  function normalizeVariantIndex(input, opts){
    const src=input && typeof input === "object" ? input : {};
    const source=(opts && opts.source) || "published";
    const sceneId=makeSceneId(src.sceneId || (opts && opts.sceneId), "scene");
    const url=(opts && opts.url) ? absUrl(opts.url) : buildVariantsIndexUrl(sceneId, source);
    const baseUrl=dirnameUrl(url);
    const items=Array.isArray(src.variants) ? src.variants : (Array.isArray(src.items) ? src.items : []);
    const byKey={};
    items.forEach((item)=>{
      const entry=item && typeof item === "object" ? item : {};
      const shapeId=slugify(entry.shapeId || entry.formId || entry.shape || entry.form, "shape");
      const textureId=slugify(entry.textureId || entry.materialId || entry.texture || entry.material, "texture");
      const key=buildVariantKey(sceneId, shapeId, textureId);
      byKey[key]={
        key,
        sceneId,
        shapeId,
        textureId,
        status:String(entry.status || "published"),
        title:String(entry.title || key),
        url: entry.url ? resolveUrl(entry.url, baseUrl) : buildVariantUrl(sceneId, shapeId, textureId, source),
        previewUrl: entry.previewUrl ? resolveUrl(entry.previewUrl, baseUrl) : null,
        updatedAt: entry.updatedAt || null,
        source
      };
    });
    return {
      schemaVersion:Number(src.schemaVersion || src.version) || DEFAULTS.schemaVersion,
      source,
      sceneId,
      loadedFrom:url,
      loadedAt:new Date().toISOString(),
      items:items.map((item)=>deepClone(item)),
      byKey
    };
  }

  function getSceneEntry(sceneId, manifest){
    const m=manifest || (state && state.scenePresets ? state.scenePresets.manifest : null);
    if(!m || !Array.isArray(m.scenes)) return null;
    const wanted=makeSceneId(sceneId, sceneId);
    return m.scenes.find((entry)=>entry.id === wanted) || null;
  }

  async function loadManifest(options){
    const runtime=ensureState(state);
    const source=(options && options.source) || runtime.source || "published";
    const url=(options && options.url) ? options.url : buildManifestUrl(source);
    runtime.status="loading_manifest";
    runtime.lastError=null;
    runtime.requests.manifestUrl=absUrl(url);
    try{
      const data=await fetchJson(url);
      const manifest=normalizeManifest(data, { source, url });
      runtime.manifest=manifest;
      runtime.manifestsBySource[source] = deepClone(manifest);
      runtime.contract=deepClone(manifest.contract || normalizeContract(null, source));
      runtime.source=source;
      runtime.loadedAt=new Date().toISOString();
      runtime.status="ready";
      runtime.activeSceneId = manifest.defaultSceneId || null;
      manifest.scenes.forEach((entry)=>{ runtime.scenesById[entry.id] = runtime.scenesById[entry.id] || { id:entry.id, entry:deepClone(entry) }; runtime.scenesById[entry.id].entry = deepClone(entry); });
      return manifest;
    }catch(err){
      runtime.status="error";
      runtime.lastError=String(err && err.message || err);
      throw err;
    }
  }

  async function loadScene(sceneRef, options){
    const runtime=ensureState(state);
    const source=(options && options.source) || runtime.source || "published";
    const entry = typeof sceneRef === "string" ? getSceneEntry(sceneRef, runtime.manifest) : sceneRef;
    const sceneId = makeSceneId(entry && entry.id ? entry.id : sceneRef, "scene");
    const url=(options && options.url) || (entry && entry.sceneUrl) || buildSceneUrl(sceneId, source);
    runtime.status="loading_scene";
    runtime.lastError=null;
    runtime.requests.sceneUrl=absUrl(url);
    try{
      const data=await fetchJson(url);
      const scene=normalizeScene(data, { source, sceneUrl:url, sceneId, contract: runtime.contract || null });
      const prev = runtime.scenesById[scene.id] || {};
      const mergedScene = Object.assign({}, prev, scene, { entry: entry ? deepClone(entry) : (prev.entry || null) });
      runtime.scenesById[scene.id] = mergedScene;
      runtime.scenesBySourceId[buildSceneSourceKey(scene.id, source)] = deepClone(mergedScene);
      runtime.activeSceneId = scene.id;
      runtime.status="ready";
      runtime.loadedAt=new Date().toISOString();
      return runtime.scenesById[scene.id];
    }catch(err){
      runtime.status="error";
      runtime.lastError=String(err && err.message || err);
      throw err;
    }
  }

  async function loadVariantsIndex(sceneRef, options){
    const runtime=ensureState(state);
    const source=(options && options.source) || runtime.source || "published";
    const sceneRecord = typeof sceneRef === "string" ? resolveSceneRecord(sceneRef, source, { sources:[source] }) : sceneRef;
    const sceneId = makeSceneId(sceneRecord && sceneRecord.id ? sceneRecord.id : sceneRef, "scene");
    const sceneUrl = sceneRecord && sceneRecord.urls && sceneRecord.urls.sceneUrl ? sceneRecord.urls.sceneUrl : buildSceneUrl(sceneId, source);
    const sceneDirUrl = dirnameUrl(sceneUrl);
    const url=(options && options.url) || (sceneRecord && sceneRecord.urls && sceneRecord.urls.variantsIndexUrl) || resolveUrl((sceneRecord && sceneRecord.contract && sceneRecord.contract.variantsIndexFile) || null, sceneDirUrl) || buildVariantsIndexUrl(sceneId, source);
    runtime.status="loading_variant_index";
    runtime.lastError=null;
    runtime.requests.variantsIndexUrl=absUrl(url);
    try{
      const data=await fetchJson(url);
      const index=normalizeVariantIndex(data, { source, url, sceneId });
      runtime.variantIndicesBySceneSource[sceneSourceCacheKey(sceneId, source)] = deepClone(index);
      runtime.status="ready";
      runtime.loadedAt=new Date().toISOString();
      return index;
    }catch(err){
      runtime.status="error";
      runtime.lastError=String(err && err.message || err);
      throw err;
    }
  }

  function getCachedVariantIndex(sceneId, source){
    const runtime=ensureState(state);
    return runtime.variantIndicesBySceneSource[sceneSourceCacheKey(sceneId, source || "published")] || null;
  }

  function resolveVariantIndexRecord(sceneId, shapeId, textureId, preferredSource, options){
    const order = preferredSource ? normalizeSourceList([preferredSource]) : getSourceOrder(options);
    const wantedKey=buildVariantKey(sceneId, shapeId, textureId);
    for(let i=0;i<order.length;i++){
      const idx=getCachedVariantIndex(sceneId, order[i]);
      if(idx && idx.byKey && idx.byKey[wantedKey]) return deepClone(idx.byKey[wantedKey]);
    }
    return null;
  }

  async function loadVariant(ref, options){
    const runtime=ensureState(state);
    const source=(options && options.source) || runtime.source || "published";
    const parsed = typeof ref === "string" ? parseVariantKey(ref) : { sceneId:ref && ref.sceneId, shapeId:ref && ref.shapeId, textureId:ref && ref.textureId };
    const sceneId=makeSceneId(parsed.sceneId || (options && options.sceneId), "scene");
    const shapeId=slugify(parsed.shapeId || (options && options.shapeId), "shape");
    const textureId=slugify(parsed.textureId || (options && options.textureId), "texture");
    const key=buildVariantKey(sceneId, shapeId, textureId);
    const url=(options && options.url) || buildVariantUrl(sceneId, shapeId, textureId, source);
    runtime.status="loading_variant";
    runtime.lastError=null;
    runtime.requests.variantUrl=absUrl(url);
    try{
      const data=await fetchJson(url);
      const variant=normalizeVariant(data, { source, url, sceneId, shapeId, textureId });
      runtime.variantsByKey[variant.key] = variant;
      runtime.variantsBySourceKey[buildVariantSourceKey(sceneId, shapeId, textureId, source)] = deepClone(variant);
      runtime.activeVariantKey = variant.key;
      runtime.status="ready";
      runtime.loadedAt=new Date().toISOString();
      return variant;
    }catch(err){
      runtime.status="error";
      runtime.lastError=String(err && err.message || err);
      throw err;
    }
  }

  function resolveSceneRecord(sceneId, preferredSource, options){
    const runtime=ensureState(state);
    const order = preferredSource ? normalizeSourceList([preferredSource]) : getSourceOrder(options);
    for(let i=0;i<order.length;i++){
      const record=getCachedScene(sceneId, order[i]);
      if(record) return deepClone(record);
    }
    const fallback=runtime.scenesById[makeSceneId(sceneId, "scene")] || null;
    return fallback ? deepClone(fallback) : null;
  }

  function resolveVariantRecord(sceneId, shapeId, textureId, preferredSource, options){
    const runtime=ensureState(state);
    const order = preferredSource ? normalizeSourceList([preferredSource]) : getSourceOrder(options);
    for(let i=0;i<order.length;i++){
      const record=getCachedVariant(sceneId, shapeId, textureId, order[i]);
      if(record) return deepClone(record);
    }
    const key=buildVariantKey(sceneId, shapeId, textureId);
    const fallback=runtime.variantsByKey[key] || null;
    return fallback ? deepClone(fallback) : null;
  }

  async function loadSceneResolved(sceneRef, options){
    const runtime=ensureState(state);
    const sceneId = makeSceneId(typeof sceneRef === "string" ? sceneRef : (sceneRef && sceneRef.id), "scene");
    const resolution=makeResolutionMeta("scene", sceneId, options);
    runtime.status="resolving_scene";
    runtime.lastError=null;
    const cached=resolveSceneRecord(sceneId, null, options);
    if(cached){
      resolution.cacheHit=true;
      resolution.status="resolved";
      resolution.resolvedSource=String(cached.source || "");
      resolution.resolvedUrl=cached.urls && cached.urls.sceneUrl ? cached.urls.sceneUrl : null;
      storeResolutionMeta(resolution);
      runtime.activeSceneId = cached.id;
      runtime.status="ready";
      return cached;
    }
    const order=getSourceOrder(options);
    for(let i=0;i<order.length;i++){
      const source=order[i];
      const url=(options && options.url && i===0) ? options.url : buildSceneUrl(sceneId, source);
      resolution.attempts.push({ source, url:absUrl(url), status:"loading" });
      try{
        const scene=await loadScene(sceneId, Object.assign({}, options||{}, { source, url }));
        resolution.attempts[resolution.attempts.length-1].status="resolved";
        resolution.resolvedSource=source;
        resolution.resolvedUrl=scene && scene.urls ? scene.urls.sceneUrl : absUrl(url);
        resolution.status="resolved";
        storeResolutionMeta(resolution);
        return scene;
      }catch(err){
        resolution.attempts[resolution.attempts.length-1].status=isNotFoundError(err) ? "not_found" : "error";
        resolution.attempts[resolution.attempts.length-1].error=String(err && err.message || err);
        if(!isNotFoundError(err)){
          resolution.status="error";
          storeResolutionMeta(resolution);
          throw err;
        }
      }
    }
    const notFound=new Error("Scene not found for " + sceneId + " via " + order.join(", "));
    runtime.status="error";
    runtime.lastError=String(notFound.message || notFound);
    resolution.status="not_found";
    storeResolutionMeta(resolution);
    throw notFound;
  }

  async function loadVariantResolved(ref, options){
    const runtime=ensureState(state);
    const parsed = typeof ref === "string" ? parseVariantKey(ref) : { sceneId:ref && ref.sceneId, shapeId:ref && ref.shapeId, textureId:ref && ref.textureId };
    const sceneId=makeSceneId(parsed.sceneId || (options && options.sceneId), "scene");
    const shapeId=slugify(parsed.shapeId || (options && options.shapeId), "shape");
    const textureId=slugify(parsed.textureId || (options && options.textureId), "texture");
    const key=buildVariantKey(sceneId, shapeId, textureId);
    const resolution=makeResolutionMeta("variant", key, options);
    runtime.status="resolving_variant";
    runtime.lastError=null;
    const cached=resolveVariantRecord(sceneId, shapeId, textureId, null, options);
    if(cached){
      resolution.cacheHit=true;
      resolution.status="resolved";
      resolution.resolvedSource=String(cached.source || "");
      resolution.resolvedUrl=cached.url || null;
      storeResolutionMeta(resolution);
      runtime.activeVariantKey = cached.key;
      runtime.status="ready";
      return cached;
    }
    const order=getSourceOrder(options);
    for(let i=0;i<order.length;i++){
      const source=order[i];
      let indexRecord=resolveVariantIndexRecord(sceneId, shapeId, textureId, source, { sources:[source] });
      if(!indexRecord && options && options.tryVariantIndex !== false){
        try{
          await loadVariantsIndex(sceneId, { source });
          indexRecord=resolveVariantIndexRecord(sceneId, shapeId, textureId, source, { sources:[source] });
        }catch(idxErr){
          if(!isNotFoundError(idxErr)){
            resolution.attempts.push({ source, url:null, status:"index_error", error:String(idxErr && idxErr.message || idxErr) });
          }
        }
      }
      const url=(options && options.url && i===0) ? options.url : ((indexRecord && indexRecord.url) || buildVariantUrl(sceneId, shapeId, textureId, source));
      resolution.attempts.push({ source, url:absUrl(url), status:"loading" });
      try{
        const variant=await loadVariant(key, Object.assign({}, options||{}, { source, url, sceneId, shapeId, textureId }));
        resolution.attempts[resolution.attempts.length-1].status="resolved";
        resolution.resolvedSource=source;
        resolution.resolvedUrl=variant && variant.url ? variant.url : absUrl(url);
        resolution.status="resolved";
        storeResolutionMeta(resolution);
        return variant;
      }catch(err){
        resolution.attempts[resolution.attempts.length-1].status=isNotFoundError(err) ? "not_found" : "error";
        resolution.attempts[resolution.attempts.length-1].error=String(err && err.message || err);
        if(!isNotFoundError(err)){
          resolution.status="error";
          storeResolutionMeta(resolution);
          throw err;
        }
      }
    }
    const notFound=new Error("Variant not found for " + key + " via " + order.join(", "));
    runtime.status="error";
    runtime.lastError=String(notFound.message || notFound);
    resolution.status="not_found";
    storeResolutionMeta(resolution);
    throw notFound;
  }

  function attachSceneToState(scene){
    const runtime=ensureState(state);
    if(!scene || !scene.id) return null;
    const clone=deepClone(scene);
    runtime.scenesById[scene.id] = clone;
    runtime.scenesBySourceId[buildSceneSourceKey(scene.id, clone.source || "published")] = deepClone(clone);
    runtime.activeSceneId = scene.id;
    runtime.loadedAt = new Date().toISOString();
    return runtime.scenesById[scene.id];
  }

  function attachVariantToState(variant){
    const runtime=ensureState(state);
    if(!variant || !variant.key) return null;
    const clone=deepClone(variant);
    runtime.variantsByKey[variant.key] = clone;
    runtime.variantsBySourceKey[buildVariantSourceKey(clone.sceneId, clone.shapeId, clone.textureId, clone.source || "published")] = deepClone(clone);
    runtime.activeVariantKey = variant.key;
    runtime.loadedAt = new Date().toISOString();
    return runtime.variantsByKey[variant.key];
  }

  function describeStorageContract(source){
    const runtime=ensureState(state);
    const cfg=(runtime && runtime.config) ? runtime.config : normalizeConfig(null);
    const src=String(source || runtime.source || "published");
    return {
      source:src,
      rootUrl:getRootUrl(src),
      manifestUrl:buildManifestUrl(src),
      sceneTemplate:joinPath(getRootUrl(src), "{sceneId}", cfg.sceneFile),
      variantsIndexTemplate:joinPath(getRootUrl(src), "{sceneId}", cfg.variantsIndexFile),
      variantTemplate:joinPath(getRootUrl(src), "{sceneId}", cfg.variantsDir, "{shapeId}__{textureId}.json"),
      config:deepClone(cfg)
    };
  }

  ensureState(state);

  return {
    defaults:deepClone(DEFAULTS),
    ensureState,
    createRuntimeState,
    normalizeConfig,
    makeSceneId,
    buildVariantKey,
    buildSceneSourceKey,
    buildVariantSourceKey,
    parseVariantKey,
    normalizeManifest,
    normalizeScene,
    normalizeVariant,
    getRootUrl,
    buildManifestUrl,
    buildSceneUrl,
    buildSceneAssetUrl,
    buildVariantsIndexUrl,
    buildVariantUrl,
    getSceneEntry,
    getReadMode,
    getSourceOrder,
    getCachedScene,
    getCachedVariant,
    getCachedVariantIndex,
    loadManifest,
    loadScene,
    loadSceneResolved,
    loadVariantsIndex,
    loadVariant,
    loadVariantResolved,
    resolveSceneRecord,
    resolveVariantRecord,
    resolveVariantIndexRecord,
    describeStorageContract,
    attachSceneToState,
    attachVariantToState
  };
})();
