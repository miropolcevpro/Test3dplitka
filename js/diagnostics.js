window.PhotoPaveDiagnostics=(function(){
  const S = window.PhotoPaveState || null;
  const RELEASE = window.PhotoPaveReleaseConfig || null;
  const state = S && S.state ? S.state : null;
  const MAX_EVENTS = 40;
  const DEDUPE_MS = 1800;
  const apiSetStatus = function(msg){
    try{
      if(window.PhotoPaveAPI && typeof window.PhotoPaveAPI.setStatus === "function"){
        window.PhotoPaveAPI.setStatus(msg);
        return;
      }
    }catch(_){ }
    try{
      const el = document.getElementById("statusText");
      if(el) el.textContent = msg || "";
    }catch(_){ }
  };

  function nowIso(){ return new Date().toISOString(); }
  function uid(){ return "diag_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16); }
  function asStr(v){ return (v == null) ? "" : String(v); }
  function trimStack(stack){
    const s = asStr(stack).trim();
    if(!s) return null;
    return s.split("\n").slice(0,6).join("\n");
  }
  function safeJsonClone(obj){
    try{ return JSON.parse(JSON.stringify(obj)); }
    catch(_){ return null; }
  }
  function detectBrowser(){
    const ua = navigator.userAgent || "";
    const out = { ua: ua, platform: navigator.platform || "", language: navigator.language || "" };
    if(/YaBrowser\//i.test(ua)) out.name = "Yandex Browser";
    else if(/Edg\//i.test(ua)) out.name = "Edge";
    else if(/Chrome\//i.test(ua)) out.name = "Chrome";
    else if(/Firefox\//i.test(ua)) out.name = "Firefox";
    else if(/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) out.name = "Safari";
    else out.name = "Unknown";
    return out;
  }
  function getFeatureSnapshot(){
    const src = RELEASE && RELEASE.features ? RELEASE.features : null;
    const out = {};
    if(!src) return out;
    Object.keys(src).forEach(function(key){
      const f = src[key] || {};
      out[key] = {
        enabled: !!f.enabled,
        visible: !!f.visible,
        stage: f.stage || null
      };
    });
    return out;
  }
  function getLoadedAssetIds(){
    const st = state || {};
    const zones = Array.isArray(st.zones) ? st.zones : [];
    const out = [];
    zones.forEach(function(z){
      const mat = z && z.material ? z.material : {};
      out.push({
        zoneId: z && z.id ? z.id : null,
        zoneName: z && z.name ? z.name : null,
        shapeId: mat.shapeId || null,
        textureId: mat.textureId || null,
        textureUrl: mat.textureUrl || null,
        mapsSummary: mat.mapSet ? safeJsonClone(mat.mapSet) : null,
        mapResolutionHints: mat.mapsMeta ? safeJsonClone(mat.mapsMeta) : null,
        closed: !!(z && z.closed),
        cutouts: Array.isArray(z && z.cutouts) ? z.cutouts.length : 0
      });
    });
    return out;
  }
  function getBuildInfo(){
    const st = state || {};
    const build = st.build || {};
    const release = st.release || {};
    return {
      version: build.version || null,
      buildTs: build.ts || null,
      preset: release.preset || build.preset || null,
      patch: release.patch || null,
      sessionId: st.diagnostics && st.diagnostics.sessionId ? st.diagnostics.sessionId : null,
      sessionStartedAt: st.diagnostics && st.diagnostics.sessionStartedAt ? st.diagnostics.sessionStartedAt : null
    };
  }
  function getUiInfo(){
    const st = state || {};
    const ui = st.ui || {};
    return {
      mode: ui.mode || null,
      editScope: ui.editScope || null,
      singleZoneMode: !!ui.singleZoneMode,
      activeZoneId: ui.activeZoneId || null,
      activeCutoutId: ui.activeCutoutId || null,
      zonesCount: Array.isArray(st.zones) ? st.zones.length : 0,
      photoLoaded: !!(st.assets && st.assets.photoBitmap),
      photoSize: {
        width: st.assets && st.assets.photoW ? st.assets.photoW : 0,
        height: st.assets && st.assets.photoH ? st.assets.photoH : 0
      }
    };
  }
  function getAiInfo(){
    const st = state || {};
    const ai = st.ai || {};
    return {
      enabled: ai.enabled !== false,
      status: ai.status || null,
      quality: ai.quality || null,
      capability: safeJsonClone(ai.capability || null),
      device: safeJsonClone(ai.device || null),
      depthReady: !!ai.depthReady,
      errors: Array.isArray(ai.errors) ? ai.errors.slice(-5) : []
    };
  }
  function getAssetsInfo(){
    const st = state || {};
    const assets = st.assets || {};
    const catalog = st.catalog || {};
    return {
      exportSafe: assets.exportSafe !== false,
      exportBlockedReason: assets.exportBlockedReason || null,
      lastLoadError: assets.lastLoadError || null,
      activeShapeId: catalog.activeShapeId || null,
      textureCacheSize: assets.textureCache && typeof assets.textureCache.size === "number" ? assets.textureCache.size : 0,
      lastTextureLoad: safeJsonClone(assets.lastTextureLoad || null),
      textureLoadInfo: safeJsonClone(assets.textureLoadInfo || null),
      lastContourValidation: safeJsonClone(assets.lastContourValidation || null),
      loadedAssetIds: getLoadedAssetIds()
    };
  }
  function getViewportInfo(){
    return {
      width: window.innerWidth || 0,
      height: window.innerHeight || 0,
      dpr: window.devicePixelRatio || 1,
      reducedMotion: !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches),
      colorScheme: (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light"
    };
  }
  function getSnapshot(extra){
    const st = state || {};
    return {
      capturedAt: nowIso(),
      build: getBuildInfo(),
      browser: detectBrowser(),
      viewport: getViewportInfo(),
      release: {
        inventory: safeJsonClone(st.release && st.release.inventory ? st.release.inventory : null),
        features: getFeatureSnapshot()
      },
      ui: getUiInfo(),
      ai: getAiInfo(),
      assets: getAssetsInfo(),
      diagnostics: {
        lastCritical: safeJsonClone(st.diagnostics && st.diagnostics.lastCritical ? st.diagnostics.lastCritical : null),
        recentEvents: safeJsonClone(st.diagnostics && st.diagnostics.events ? st.diagnostics.events.slice(-8) : []),
        counters: safeJsonClone(st.diagnostics && st.diagnostics.counters ? st.diagnostics.counters : {})
      },
      analytics: (window.PhotoPaveAnalytics && typeof window.PhotoPaveAnalytics.getSnapshot === "function") ? safeJsonClone(window.PhotoPaveAnalytics.getSnapshot()) : safeJsonClone(st.analytics || null),
      extra: safeJsonClone(extra || null)
    };
  }
  function ensureState(){
    if(!state) return null;
    if(!state.diagnostics || typeof state.diagnostics !== "object"){
      state.diagnostics = {
        sessionId: uid(),
        sessionStartedAt: nowIso(),
        events: [],
        counters: {},
        lastCritical: null,
        _lastKey: null,
        _lastAt: 0
      };
    }
    return state.diagnostics;
  }
  function sanitizeError(err){
    if(!err) return { name: "Error", message: "Unknown error", stack: null };
    if(typeof err === "string") return { name: "Error", message: err, stack: null };
    const name = err.name || "Error";
    const message = err.message || String(err);
    const stack = trimStack(err.stack || "");
    return { name: name, message: message, stack: stack };
  }
  function pushEvent(entry){
    const diag = ensureState();
    if(!diag) return entry;
    const key = entry.kind + "|" + (entry.error && entry.error.message ? entry.error.message : "");
    const now = Date.now();
    if(diag._lastKey === key && (now - (diag._lastAt || 0)) < DEDUPE_MS) return null;
    diag._lastKey = key;
    diag._lastAt = now;
    diag.events.push(entry);
    if(diag.events.length > MAX_EVENTS) diag.events.splice(0, diag.events.length - MAX_EVENTS);
    diag.counters[entry.kind] = (diag.counters[entry.kind] || 0) + 1;
    if(entry.severity === "error") diag.lastCritical = safeJsonClone(entry);
    return entry;
  }
  function report(kind, err, extra, severity){
    const diag = ensureState();
    const entry = {
      id: uid(),
      at: nowIso(),
      kind: kind || "error",
      severity: severity || "error",
      error: sanitizeError(err),
      extra: safeJsonClone(extra || null)
    };
    const pushed = pushEvent(entry);
    if(!pushed) return null;
    try{ window.dispatchEvent(new CustomEvent("pp:diagnostics", { detail: { entry: pushed, snapshot: getSnapshot(extra) } })); }catch(_){ }
    return pushed;
  }
  function note(kind, extra){
    return report(kind || "note", null, extra, "info");
  }
  async function copySnapshot(extra){
    const snap = getSnapshot(extra || null);
    const txt = JSON.stringify(snap, null, 2);
    if(navigator.clipboard && typeof navigator.clipboard.writeText === "function"){
      await navigator.clipboard.writeText(txt);
      return txt;
    }
    const ta = document.createElement("textarea");
    ta.value = txt;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand("copy"); }finally{ document.body.removeChild(ta); }
    return txt;
  }
  function bindUi(){
    const btn = document.getElementById("copyDiagBtn");
    if(btn && !btn.__ppBound){
      btn.__ppBound = true;
      btn.addEventListener("click", async function(){
        try{
          await copySnapshot({ source: "copyDiagBtn" });
          apiSetStatus("Диагностика скопирована в буфер обмена");
          note("diagnostics_copied", { source: "footer_button" });
        }catch(e){
          report("diagnostics_copy_error", e, { source: "footer_button" });
          apiSetStatus("Не удалось скопировать диагностику");
        }
      });
    }
  }
  function registerGlobalHandlers(){
    if(window.__ppDiagGlobalHandlers) return;
    window.__ppDiagGlobalHandlers = true;
    window.addEventListener("error", function(ev){
      const err = ev && ev.error ? ev.error : new Error((ev && ev.message) || "window error");
      report("window_error", err, {
        filename: ev && ev.filename ? ev.filename : null,
        lineno: ev && typeof ev.lineno === "number" ? ev.lineno : null,
        colno: ev && typeof ev.colno === "number" ? ev.colno : null
      });
    });
    window.addEventListener("unhandledrejection", function(ev){
      const reason = ev ? ev.reason : null;
      report("unhandled_rejection", reason instanceof Error ? reason : new Error(asStr(reason || "Unhandled rejection")), null);
    });
  }
  function init(){
    ensureState();
    bindUi();
    registerGlobalHandlers();
    note("diagnostics_ready", { build: getBuildInfo() });
    return true;
  }

  return {
    init: init,
    note: note,
    report: report,
    getSnapshot: getSnapshot,
    copySnapshot: copySnapshot
  };
})();

try{ if(window.PhotoPaveDiagnostics && typeof window.PhotoPaveDiagnostics.init === "function") window.PhotoPaveDiagnostics.init(); }catch(_){ }
