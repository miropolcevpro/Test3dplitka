window.PhotoPaveScenePresetAdmin=(function(){
  const S=window.PhotoPaveState||null;
  const RELEASE=window.PhotoPaveReleaseConfig||null;
  const state=S && S.state ? S.state : null;

  const DEFAULTS={
    schemaVersion:1,
    stage:"foundation",
    enabled:false,
    contextMode:"bootstrap_only",
    contextQueryParam:"ppAdmin",
    contextQueryValue:"1",
    storageKey:"pp_scene_presets_admin_token",
    sessionStorageKey:"pp_scene_presets_admin_token",
    allowTokenFromStorage:true,
    allowTokenFromQuery:false,
    allowTokenPersistence:false,
    authHeader:"Authorization",
    authScheme:"Bearer",
    authTokenHeader:"X-PhotoPave-Admin-Token",
    requireAuth:true,
    timeoutMs:25000,
    endpoints:{
      saveSceneDraft:"scene-presets/admin/draft/scene",
      saveVariantDraft:"scene-presets/admin/draft/variant",
      publishScene:"scene-presets/admin/publish/scene",
      publishVariant:"scene-presets/admin/publish/variant",
      uploadAsset:"scene-presets/admin/upload"
    },
    methods:{
      saveSceneDraft:"POST",
      saveVariantDraft:"POST",
      publishScene:"POST",
      publishVariant:"POST",
      uploadAsset:"POST"
    }
  };

  function deepClone(v){
    return JSON.parse(JSON.stringify(v));
  }

  function safeGet(obj, path, fallback){
    try{
      let cur=obj;
      for(let i=0;i<path.length;i++){
        if(!cur || typeof cur !== "object") return fallback;
        cur=cur[path[i]];
      }
      return typeof cur === "undefined" ? fallback : cur;
    }catch(_){
      return fallback;
    }
  }

  function isAbsUrl(v){
    return typeof v === "string" && /^https?:\/\//i.test(v.trim());
  }

  function absUrl(v, baseUrl){
    try{ return new URL(v, baseUrl || window.location.href).toString(); }
    catch(_){ return String(v||""); }
  }

  function joinPath(base, rel){
    const head=String(base||"").replace(/\/+$/g,"");
    const tail=String(rel||"").replace(/^\/+/,"");
    if(!head) return tail;
    if(!tail) return head;
    return head + "/" + tail;
  }

  function safeStorageGet(storage, key){
    try{ return storage && key ? storage.getItem(key) : null; }
    catch(_){ return null; }
  }

  function safeStorageSet(storage, key, value){
    try{
      if(storage && key) storage.setItem(key, value);
      return true;
    }catch(_){
      return false;
    }
  }

  function safeStorageRemove(storage, key){
    try{
      if(storage && key) storage.removeItem(key);
      return true;
    }catch(_){
      return false;
    }
  }

  function readQueryParam(name){
    try{
      const params=new URLSearchParams(window.location.search || "");
      const v=params.get(String(name||""));
      return typeof v === "string" ? v : null;
    }catch(_){
      return null;
    }
  }

  function maskToken(token){
    const raw=String(token||"").trim();
    if(!raw) return null;
    if(raw.length <= 8) return raw.charAt(0) + "***" + raw.charAt(raw.length-1);
    return raw.slice(0, 4) + "…" + raw.slice(-4);
  }

  function stripSecrets(input){
    const src=input && typeof input === "object" ? deepClone(input) : {};
    delete src.authToken;
    delete src.token;
    return src;
  }

  function getReleaseConfig(){
    return safeGet(RELEASE, ["scenePresets", "adminApi"], null);
  }

  function getApiRuntimeConfig(){
    return safeGet(state, ["api", "scenePresets", "adminApi"], null);
  }

  function getBootstrapRaw(){
    const raw=window.PhotoPaveAdminBootstrap || window.__PHOTO_PAVE_ADMIN__ || null;
    if(!raw || typeof raw !== "object") return null;
    if(raw.scenePresetsAdmin && typeof raw.scenePresetsAdmin === "object"){
      const merged=Object.assign({}, raw.scenePresetsAdmin);
      if(typeof merged.enabled === "undefined" && typeof raw.enabled === "boolean") merged.enabled = raw.enabled;
      if(!merged.authToken && raw.authToken) merged.authToken = raw.authToken;
      if(!merged.apiBase && raw.apiBase) merged.apiBase = raw.apiBase;
      if(!merged.gatewayBase && raw.gatewayBase) merged.gatewayBase = raw.gatewayBase;
      return merged;
    }
    return Object.assign({}, raw);
  }

  function normalizeConfig(src){
    const input=src && typeof src === "object" ? src : {};
    const cfg=Object.assign({}, DEFAULTS, stripSecrets(input));
    cfg.schemaVersion = Number(cfg.schemaVersion) > 0 ? Number(cfg.schemaVersion) : DEFAULTS.schemaVersion;
    cfg.stage = String(cfg.stage || DEFAULTS.stage);
    cfg.enabled = !!cfg.enabled;
    cfg.contextMode = String(cfg.contextMode || DEFAULTS.contextMode);
    cfg.contextQueryParam = String(cfg.contextQueryParam || DEFAULTS.contextQueryParam);
    cfg.contextQueryValue = String(cfg.contextQueryValue || DEFAULTS.contextQueryValue);
    cfg.storageKey = String(cfg.storageKey || DEFAULTS.storageKey);
    cfg.sessionStorageKey = String(cfg.sessionStorageKey || DEFAULTS.sessionStorageKey);
    cfg.allowTokenFromStorage = cfg.allowTokenFromStorage !== false;
    cfg.allowTokenFromQuery = !!cfg.allowTokenFromQuery;
    cfg.allowTokenPersistence = !!cfg.allowTokenPersistence;
    cfg.authHeader = String(cfg.authHeader || DEFAULTS.authHeader);
    cfg.authScheme = String(cfg.authScheme || DEFAULTS.authScheme);
    cfg.authTokenHeader = String(cfg.authTokenHeader || DEFAULTS.authTokenHeader);
    cfg.requireAuth = cfg.requireAuth !== false;
    cfg.timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : DEFAULTS.timeoutMs;
    cfg.apiBase = cfg.apiBase ? String(cfg.apiBase) : null;
    cfg.gatewayBase = cfg.gatewayBase ? String(cfg.gatewayBase) : null;
    cfg.endpoints = Object.assign({}, DEFAULTS.endpoints, input.endpoints || {});
    cfg.methods = Object.assign({}, DEFAULTS.methods, input.methods || {});
    Object.keys(cfg.endpoints).forEach((k)=>{ cfg.endpoints[k] = cfg.endpoints[k] ? String(cfg.endpoints[k]) : null; });
    Object.keys(cfg.methods).forEach((k)=>{ cfg.methods[k] = String(cfg.methods[k] || DEFAULTS.methods[k] || "POST").toUpperCase(); });
    return cfg;
  }

  function makeDefaultRuntime(){
    return {
      stage:"foundation",
      mode:"public",
      enabled:false,
      ready:false,
      lastError:null,
      tokenPresent:false,
      tokenSource:null,
      tokenMask:null,
      bootstrap:{ enabled:false, tokenPresent:false, hasApiBase:false, hasGatewayBase:false },
      config:normalizeConfig(null),
      lastAction:null,
      lastRequest:null,
      lastResponse:null
    };
  }

  function ensureRuntime(targetState){
    if(!targetState || typeof targetState !== "object") return null;
    targetState.scenePresets = targetState.scenePresets || {};
    if(!targetState.scenePresets.admin || typeof targetState.scenePresets.admin !== "object"){
      targetState.scenePresets.admin = makeDefaultRuntime();
    }
    const runtime=targetState.scenePresets.admin;
    if(!runtime.bootstrap || typeof runtime.bootstrap !== "object") runtime.bootstrap = { enabled:false, tokenPresent:false, hasApiBase:false, hasGatewayBase:false };
    if(!runtime.config || typeof runtime.config !== "object") runtime.config = normalizeConfig(null);
    if(!Object.prototype.hasOwnProperty.call(runtime, "lastRequest")) runtime.lastRequest = null;
    if(!Object.prototype.hasOwnProperty.call(runtime, "lastResponse")) runtime.lastResponse = null;
    if(!Object.prototype.hasOwnProperty.call(runtime, "lastAction")) runtime.lastAction = null;
    return runtime;
  }

  function getConfig(options){
    const merged=Object.assign({}, getReleaseConfig() || {}, getApiRuntimeConfig() || {});
    const bootstrap=getBootstrapRaw();
    if(bootstrap && typeof bootstrap === "object"){
      if(typeof bootstrap.enabled === "boolean") merged.enabled = bootstrap.enabled;
      if(bootstrap.apiBase) merged.apiBase = bootstrap.apiBase;
      if(bootstrap.gatewayBase) merged.gatewayBase = bootstrap.gatewayBase;
      if(bootstrap.endpoints && typeof bootstrap.endpoints === "object") merged.endpoints = Object.assign({}, merged.endpoints || {}, bootstrap.endpoints);
      if(bootstrap.methods && typeof bootstrap.methods === "object") merged.methods = Object.assign({}, merged.methods || {}, bootstrap.methods);
      ["contextMode","contextQueryParam","contextQueryValue","allowTokenFromQuery","allowTokenFromStorage","allowTokenPersistence","requireAuth","timeoutMs"].forEach((k)=>{
        if(typeof bootstrap[k] !== "undefined") merged[k] = bootstrap[k];
      });
    }
    if(options && options.config && typeof options.config === "object"){
      const clean=stripSecrets(options.config);
      if(clean.endpoints && typeof clean.endpoints === "object") clean.endpoints = Object.assign({}, merged.endpoints || {}, clean.endpoints);
      if(clean.methods && typeof clean.methods === "object") clean.methods = Object.assign({}, merged.methods || {}, clean.methods);
      Object.assign(merged, clean);
    }
    return normalizeConfig(merged);
  }

  function getMode(config, options){
    if(options && (options.forceAdmin === true || options.context === "admin")) return "admin";
    if(options && (options.forceAdmin === false || options.context === "public")) return "public";
    const bootstrap=getBootstrapRaw();
    if(bootstrap && bootstrap.enabled === true) return "admin";
    const bodyFlag=safeGet(document, ["body", "dataset", "photoPaveAdmin"], null) || safeGet(document, ["body", "dataset", "admin"], null);
    if(config.contextMode !== "bootstrap_only"){
      const qp=readQueryParam(config.contextQueryParam);
      if(qp && (!config.contextQueryValue || qp === config.contextQueryValue)) return "admin";
      if(String(bodyFlag||"") === "1") return "admin";
    }
    return "public";
  }

  function resolveTokenInfo(config, options){
    const explicit=(options && (options.authToken || options.token)) ? String(options.authToken || options.token).trim() : "";
    if(explicit) return { token:explicit, source:"explicit", mask:maskToken(explicit) };

    const bootstrap=getBootstrapRaw();
    const bootstrapToken=bootstrap && (bootstrap.authToken || bootstrap.token) ? String(bootstrap.authToken || bootstrap.token).trim() : "";
    if(bootstrapToken) return { token:bootstrapToken, source:"bootstrap", mask:maskToken(bootstrapToken) };

    if(config.allowTokenFromStorage){
      const sessionToken=safeStorageGet(window.sessionStorage, config.sessionStorageKey);
      if(sessionToken) return { token:String(sessionToken).trim(), source:"sessionStorage", mask:maskToken(sessionToken) };
      const localToken=safeStorageGet(window.localStorage, config.storageKey);
      if(localToken) return { token:String(localToken).trim(), source:"localStorage", mask:maskToken(localToken) };
    }

    if(config.allowTokenFromQuery){
      const qp=readQueryParam(config.tokenQueryParam || "ppAdminToken");
      if(qp) return { token:String(qp).trim(), source:"query", mask:maskToken(qp) };
    }

    return { token:"", source:null, mask:null };
  }

  function rememberAuthToken(token, options){
    const config=getConfig(options);
    const raw=String(token||"").trim();
    if(!raw || !config.allowTokenPersistence) return false;
    const useSession = options && options.persistTo === "session";
    if(useSession) return safeStorageSet(window.sessionStorage, config.sessionStorageKey, raw);
    return safeStorageSet(window.localStorage, config.storageKey, raw);
  }

  function clearRememberedAuthToken(options){
    const config=getConfig(options);
    safeStorageRemove(window.sessionStorage, config.sessionStorageKey);
    safeStorageRemove(window.localStorage, config.storageKey);
    const runtime=ensureRuntime(state || {});
    if(runtime){
      runtime.tokenPresent=false;
      runtime.tokenSource=null;
      runtime.tokenMask=null;
    }
    return true;
  }

  function syncRuntime(options){
    const runtime=ensureRuntime(state || {});
    const config=getConfig(options);
    const mode=getMode(config, options);
    const bootstrap=getBootstrapRaw();
    const tokenInfo=resolveTokenInfo(config, options);
    runtime.stage = config.stage || "foundation";
    runtime.mode = mode;
    runtime.enabled = !!config.enabled && mode === "admin";
    runtime.ready = !!config.enabled && (!config.requireAuth || !!tokenInfo.token);
    runtime.config = deepClone(config);
    runtime.bootstrap = {
      enabled: !!(bootstrap && bootstrap.enabled === true),
      tokenPresent: !!(bootstrap && (bootstrap.authToken || bootstrap.token)),
      hasApiBase: !!(bootstrap && bootstrap.apiBase),
      hasGatewayBase: !!(bootstrap && bootstrap.gatewayBase)
    };
    runtime.tokenPresent = !!tokenInfo.token;
    runtime.tokenSource = tokenInfo.source || null;
    runtime.tokenMask = tokenInfo.mask || null;
    return { runtime, config, tokenInfo };
  }

  function getApiBase(config, options){
    const explicit = options && options.apiBase ? String(options.apiBase) : "";
    if(explicit) return explicit.replace(/\/+$/g,"");
    if(config.apiBase) return String(config.apiBase).replace(/\/+$/g,"");
    if(state && state.api && state.api.apiBase) return String(state.api.apiBase).replace(/\/+$/g,"");
    if(config.gatewayBase) return String(config.gatewayBase).replace(/\/+$/g,"");
    if(state && state.api && state.api.gatewayBase) return String(state.api.gatewayBase).replace(/\/+$/g,"");
    return String(window.location.origin || "").replace(/\/+$/g,"");
  }

  function buildEndpointUrl(action, options){
    const config=getConfig(options);
    const endpoint=(options && options.url) ? String(options.url) : String(config.endpoints[action] || "");
    if(!endpoint) return null;
    if(isAbsUrl(endpoint)) return endpoint;
    return absUrl(joinPath(getApiBase(config, options), endpoint));
  }

  function buildAuthHeaders(config, tokenInfo){
    const headers={};
    if(config.requireAuth){
      if(!tokenInfo || !tokenInfo.token) throw new Error("scene preset admin auth token is missing");
      const scheme=config.authScheme ? String(config.authScheme).trim() + " " : "";
      headers[config.authHeader] = scheme + tokenInfo.token;
      if(config.authTokenHeader) headers[config.authTokenHeader] = tokenInfo.token;
    }
    return headers;
  }

  function summarizePayload(payload){
    const src=payload && typeof payload === "object" ? payload : {};
    return {
      keys:Object.keys(src).slice(0, 24),
      sceneId:src.sceneId || null,
      shapeId:src.shapeId || null,
      textureId:src.textureId || null,
      key:src.key || null,
      hasScene:!!src.scene,
      hasVariant:!!src.variant,
      hasSnapshot:!!(src.stateSnapshot || src.snapshot),
      hasFile:!!src.file,
      sizeHint: src.snapshot ? JSON.stringify(src.snapshot).length : (src.stateSnapshot ? JSON.stringify(src.stateSnapshot).length : 0)
    };
  }

  function summarizeResponse(data){
    if(data && typeof data === "object"){
      return {
        keys:Object.keys(data).slice(0, 24),
        ok:typeof data.ok === "boolean" ? data.ok : null,
        sceneId:data.sceneId || null,
        key:data.key || null,
        status:data.status || null,
        uploaded:data.uploaded || null
      };
    }
    return { type:typeof data, preview:String(data||"").slice(0, 120) };
  }

  function describeAdminApiContract(options){
    const sync=syncRuntime(options);
    const cfg=sync.config;
    return {
      stage:cfg.stage,
      mode:sync.runtime.mode,
      enabled:sync.runtime.enabled,
      requireAuth:cfg.requireAuth,
      apiBase:getApiBase(cfg, options),
      endpoints:{
        saveSceneDraft:buildEndpointUrl("saveSceneDraft", options),
        saveVariantDraft:buildEndpointUrl("saveVariantDraft", options),
        publishScene:buildEndpointUrl("publishScene", options),
        publishVariant:buildEndpointUrl("publishVariant", options),
        uploadAsset:buildEndpointUrl("uploadAsset", options)
      },
      tokenPresent:sync.runtime.tokenPresent,
      tokenSource:sync.runtime.tokenSource,
      tokenMask:sync.runtime.tokenMask
    };
  }

  function ensureAdminWriteAccess(action, options){
    const sync=syncRuntime(options);
    const runtime=sync.runtime;
    const config=sync.config;
    const endpoint=buildEndpointUrl(action, options);
    runtime.lastError = null;
    if(runtime.mode !== "admin" || !config.enabled){
      runtime.lastError = "scene preset admin mode is disabled";
      throw new Error(runtime.lastError);
    }
    if(!endpoint){
      runtime.lastError = "scene preset admin endpoint is not configured for action: " + action;
      throw new Error(runtime.lastError);
    }
    const authHeaders=buildAuthHeaders(config, sync.tokenInfo);
    return { runtime, config, endpoint, authHeaders, tokenInfo:sync.tokenInfo };
  }

  async function parseResponse(res, url){
    const text=await res.text().catch(()=>"");
    const ct=(res.headers && typeof res.headers.get === "function") ? String(res.headers.get("content-type") || "") : "";
    let data=text;
    if(ct.includes("application/json") || (text && /^[\[{]/.test(text.trim()))){
      try{ data=text ? JSON.parse(text) : null; }
      catch(_){ data=text; }
    }
    if(!res.ok){
      const preview = typeof data === "string" ? data : JSON.stringify(data||{});
      throw new Error("HTTP " + res.status + " " + res.statusText + " for " + url + " :: " + String(preview||"").slice(0, 180));
    }
    return data;
  }

  async function requestJson(action, payload, options){
    const ctx=ensureAdminWriteAccess(action, options);
    const method=String((options && options.method) || ctx.config.methods[action] || "POST").toUpperCase();
    const headers=Object.assign({ "Accept":"application/json", "Content-Type":"application/json" }, ctx.authHeaders, (options && options.headers) || {});
    const runtime=ctx.runtime;
    runtime.lastAction = action;
    runtime.lastRequest = {
      action,
      method,
      url:ctx.endpoint,
      at:new Date().toISOString(),
      payloadSummary:summarizePayload(payload)
    };
    let controller=null;
    let timeoutId=null;
    try{
      if(typeof AbortController !== "undefined"){
        controller=new AbortController();
        timeoutId=window.setTimeout(()=>{ try{ controller.abort(); }catch(_){ } }, ctx.config.timeoutMs);
      }
      const res=await fetch(ctx.endpoint, {
        method,
        headers,
        body: JSON.stringify(payload || {}),
        signal: controller ? controller.signal : void 0
      });
      const data=await parseResponse(res, ctx.endpoint);
      runtime.lastResponse = {
        action,
        ok:true,
        status:res.status,
        at:new Date().toISOString(),
        summary:summarizeResponse(data)
      };
      runtime.lastError = null;
      return { ok:true, action, status:res.status, url:ctx.endpoint, data };
    }catch(err){
      runtime.lastResponse = {
        action,
        ok:false,
        status:0,
        at:new Date().toISOString(),
        summary:{ error:String(err && err.message || err) }
      };
      runtime.lastError = String(err && err.message || err);
      throw err;
    }finally{
      if(timeoutId){ try{ window.clearTimeout(timeoutId); }catch(_){ } }
    }
  }

  async function requestUpload(action, params, options){
    const ctx=ensureAdminWriteAccess(action, options);
    const runtime=ctx.runtime;
    const form=new FormData();
    const src=params && typeof params === "object" ? params : {};
    if(src.file) form.append("file", src.file, src.fileName || src.file.name || "scene-asset");
    if(src.blob) form.append("file", src.blob, src.fileName || "scene-asset");
    if(src.sceneId) form.append("sceneId", String(src.sceneId));
    if(src.shapeId) form.append("shapeId", String(src.shapeId));
    if(src.textureId) form.append("textureId", String(src.textureId));
    if(src.kind) form.append("kind", String(src.kind));
    if(src.meta && typeof src.meta === "object") form.append("meta", JSON.stringify(src.meta));
    runtime.lastAction = action;
    runtime.lastRequest = {
      action,
      method:String((options && options.method) || ctx.config.methods[action] || "POST").toUpperCase(),
      url:ctx.endpoint,
      at:new Date().toISOString(),
      payloadSummary:summarizePayload(src)
    };
    const headers=Object.assign({ "Accept":"application/json" }, ctx.authHeaders, (options && options.headers) || {});
    const res=await fetch(ctx.endpoint, { method:runtime.lastRequest.method, headers, body:form });
    const data=await parseResponse(res, ctx.endpoint);
    runtime.lastResponse = {
      action,
      ok:true,
      status:res.status,
      at:new Date().toISOString(),
      summary:summarizeResponse(data)
    };
    runtime.lastError = null;
    return { ok:true, action, status:res.status, url:ctx.endpoint, data };
  }

  function buildSceneDraftPayload(scene, options){
    const src=scene && typeof scene === "object" ? scene : {};
    return {
      sceneId: src.sceneId || src.id || (options && options.sceneId) || null,
      title: src.title || null,
      scene: src,
      contractVersion: safeGet(state, ["scenePresets", "config", "contractVersion"], 1)
    };
  }

  function buildVariantDraftPayload(variant, options){
    const src=variant && typeof variant === "object" ? variant : {};
    return {
      sceneId: src.sceneId || (options && options.sceneId) || null,
      shapeId: src.shapeId || (options && options.shapeId) || null,
      textureId: src.textureId || (options && options.textureId) || null,
      key: src.key || src.id || null,
      variant: src,
      contractVersion: safeGet(state, ["scenePresets", "config", "contractVersion"], 1)
    };
  }

  function writeSceneDraft(scene, options){
    return requestJson("saveSceneDraft", buildSceneDraftPayload(scene, options), options);
  }

  function writeVariantDraft(variant, options){
    return requestJson("saveVariantDraft", buildVariantDraftPayload(variant, options), options);
  }

  function publishScene(payload, options){
    return requestJson("publishScene", payload || {}, options);
  }

  function publishVariant(payload, options){
    return requestJson("publishVariant", payload || {}, options);
  }

  function uploadSceneAsset(params, options){
    return requestUpload("uploadAsset", params, options);
  }

  const ns={
    DEFAULTS:deepClone(DEFAULTS),
    normalizeConfig,
    getConfig,
    getMode,
    getApiBase,
    buildEndpointUrl,
    describeAdminApiContract,
    ensureAdminWriteAccess,
    rememberAuthToken,
    clearRememberedAuthToken,
    syncRuntime,
    getRuntime:()=>{ const rt=ensureRuntime(state || {}); syncRuntime(); return rt; },
    writeSceneDraft,
    writeVariantDraft,
    publishScene,
    publishVariant,
    uploadSceneAsset
  };

  if(window.PhotoPaveScenePresets && typeof window.PhotoPaveScenePresets === "object"){
    window.PhotoPaveScenePresets.Admin = ns;
  }

  try{ syncRuntime(); }catch(_){ }

  return ns;
})();
