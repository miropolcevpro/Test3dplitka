window.PhotoPaveAnalytics=(function(){
  const S = window.PhotoPaveState || null;
  const RELEASE = window.PhotoPaveReleaseConfig || null;
  const DIAG = window.PhotoPaveDiagnostics || null;
  const state = S && S.state ? S.state : null;
  const CFG = (RELEASE && RELEASE.analytics) ? RELEASE.analytics : {};
  const MAX_RECENT = Number(CFG.maxRecent || 80);
  const MAX_QUEUE = Number(CFG.maxQueue || 200);
  const STORAGE_KEY = String(CFG.storageKey || "pp_analytics_queue_v1");
  const EVENT_VERSION = 1;
  const DEDUPE_MS = 1200;

  function nowIso(){ return new Date().toISOString(); }
  function uid(){ return "an_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16); }
  function safeJsonClone(obj){
    try{ return JSON.parse(JSON.stringify(obj)); }
    catch(_){ return null; }
  }
  function trimText(v, max){
    const s = (v == null) ? "" : String(v);
    return s.length > max ? s.slice(0, max) : s;
  }
  function ensureState(){
    if(!state) return null;
    if(!state.analytics || typeof state.analytics !== "object"){
      state.analytics = {
        sessionId: uid(),
        sessionStartedAt: nowIso(),
        events: [],
        queue: [],
        counters: {},
        transport: { mode: String(CFG.transportMode || "local_queue"), endpoint: CFG.endpoint || null, enabled: !!CFG.endpoint, lastFlushAt: null, lastFlushError: null },
        _loaded: false,
        _restoredFromStorage: false,
        _lastKey: null,
        _lastAt: 0
      };
    }
    return state.analytics;
  }
  function persistQueue(){
    const an = ensureState();
    if(!an) return;
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify((an.queue || []).slice(-MAX_QUEUE))); }catch(_){ }
  }
  function loadQueue(){
    const an = ensureState();
    if(!an || an._loaded) return an;
    an._loaded = true;
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if(Array.isArray(arr) && arr.length){
        an.queue = arr.slice(-MAX_QUEUE);
        an._restoredFromStorage = true;
        try{ DIAG && DIAG.note && DIAG.note("analytics_queue_restored", { queueSize: an.queue.length }); }catch(_){ }
      }
    }catch(e){
      an.transport.lastFlushError = e && e.message ? e.message : String(e);
    }
    return an;
  }
  function getContext(){
    const st = state || {};
    const ui = st.ui || {};
    const assets = st.assets || {};
    const catalog = st.catalog || {};
    const ai = st.ai || {};
    const zone = (S && typeof S.getActiveZone === "function") ? S.getActiveZone() : null;
    const mat = zone && zone.material ? zone.material : {};
    return {
      version: EVENT_VERSION,
      buildVersion: st.build && st.build.version ? st.build.version : null,
      preset: st.release && st.release.preset ? st.release.preset : null,
      patch: st.release && st.release.patch ? st.release.patch : null,
      uiMode: ui.mode || null,
      activeStep: ui.activeStep || null,
      singleZoneMode: !!ui.singleZoneMode,
      zonesCount: Array.isArray(st.zones) ? st.zones.length : 0,
      photoLoaded: !!assets.photoBitmap,
      photoW: assets.photoW || 0,
      photoH: assets.photoH || 0,
      activeShapeId: catalog.activeShapeId || mat.shapeId || null,
      activeTextureId: mat.textureId || null,
      capabilityTier: ai.capability && ai.capability.label ? ai.capability.label : (ai.capability && ai.capability.tier ? ai.capability.tier : null),
      aiStatus: ai.status || null
    };
  }
  function pushEvent(entry, opts){
    const an = loadQueue();
    if(!an) return null;
    const key = entry.name + "|" + JSON.stringify(entry.props || {});
    const now = Date.now();
    if(!(opts && opts.allowDuplicate)){
      if(an._lastKey === key && (now - (an._lastAt || 0)) < DEDUPE_MS) return null;
    }
    an._lastKey = key;
    an._lastAt = now;
    an.events.push(entry);
    if(an.events.length > MAX_RECENT) an.events.splice(0, an.events.length - MAX_RECENT);
    an.queue.push(entry);
    if(an.queue.length > MAX_QUEUE) an.queue.splice(0, an.queue.length - MAX_QUEUE);
    an.counters[entry.name] = (an.counters[entry.name] || 0) + 1;
    persistQueue();
    return entry;
  }
  function track(name, props, options){
    const an = loadQueue();
    if(!an || !name) return null;
    const entry = Object.assign({
      id: uid(),
      name: String(name),
      at: nowIso(),
      sessionId: an.sessionId,
      sessionStartedAt: an.sessionStartedAt
    }, getContext());
    entry.props = safeJsonClone(props || {}) || {};
    const pushed = pushEvent(entry, options || null);
    if(!pushed) return null;
    try{ window.dispatchEvent(new CustomEvent("pp:analytics", { detail: { entry: pushed, snapshot: getSnapshot() } })); }catch(_){ }
    return pushed;
  }
  function getSnapshot(){
    const an = loadQueue();
    if(!an) return null;
    return {
      sessionId: an.sessionId,
      sessionStartedAt: an.sessionStartedAt,
      restoredFromStorage: !!an._restoredFromStorage,
      counters: safeJsonClone(an.counters || {}),
      queueSize: Array.isArray(an.queue) ? an.queue.length : 0,
      recentEvents: safeJsonClone((an.events || []).slice(-12)),
      pendingQueue: safeJsonClone((an.queue || []).slice(-20)),
      transport: safeJsonClone(an.transport || null)
    };
  }
  function bindDiagnostics(){
    if(window.__ppAnalyticsDiagBound) return;
    window.__ppAnalyticsDiagBound = true;
    window.addEventListener("pp:diagnostics", function(ev){
      const entry = ev && ev.detail ? ev.detail.entry : null;
      if(!entry || !entry.kind) return;
      const extra = entry.extra || {};
      if(entry.kind === "render_error"){
        track("render_error", { stage: extra.stage || null, severity: entry.severity || null, message: trimText(entry.error && entry.error.message, 180) }, { allowDuplicate:false });
      }else if(entry.kind === "export_error"){
        track("export_error", { stage: extra.stage || null, message: trimText(entry.error && entry.error.message, 180) }, { allowDuplicate:false });
      }else if(entry.kind === "init_error"){
        track("init_error", { stage: extra.stage || null, message: trimText(entry.error && entry.error.message, 180) }, { allowDuplicate:false });
      }else if(entry.kind === "ai_error"){
        track("ai_error", { stage: extra.stage || null, status: extra.status || null, message: trimText(entry.error && entry.error.message, 180) }, { allowDuplicate:false });
      }
    });
  }
  function init(){
    loadQueue();
    bindDiagnostics();
    return getSnapshot();
  }
  return { init, track, getSnapshot };
})();
