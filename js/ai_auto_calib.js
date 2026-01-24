/*
  Patch D: Auto-calibration (vanishing point + horizon + plane direction)

  PURPOSE
  - Make Ultra defaults (horizon/perspective) look natural with minimal user tuning.
  - Keep current product stable: calibration is an overlay, never a hard dependency.

  GUARANTEE
  - If OpenCV.js cannot be loaded or inference fails, we fall back to safe heuristics.
  - No changes to contour editing logic; runs only on photo load.

  OUTPUT (stored in state.ai.calib)
  - vanish: {x,y} normalized 0..1
  - horizonY: 0..1
  - planeDir: {x,y} normalized in image space (x right, y down). "Far" should be towards negative y.
  - confidence: 0..1
  - autoHorizon: -1..1
  - autoPerspective: 0..1
*/
(function(){
  const S = window.PhotoPaveState;
  if(!S || !S.state){
    console.warn("[AI] AutoCalib: PhotoPaveState not ready");
    return;
  }

  const state = S.state;

  function _now(){ return (typeof performance!=="undefined" && performance.now) ? performance.now() : Date.now(); }
  function _clamp(v,a,b){ v=+v; return v<a?a:(v>b?b:v); }
  function _hypot(x,y){ return Math.hypot(x,y); }
  function _norm2(v){ const m=_hypot(v.x||0,v.y||0); return (m>1e-6&&isFinite(m)) ? {x:(v.x||0)/m,y:(v.y||0)/m} : {x:0,y:-1}; }

  // Optional OpenCV.js loader. If it fails, we continue with fallback.
  // OpenCV loader candidates.
  // Priority is LOCAL (GitHub Pages repo) for maximum stability in Tilda iframe.
  // Recommended: ship a single-file build (WASM embedded) at:
  //   assets/vendor/opencv/opencv.js
  const OPENCV_CANDIDATES = [
    // Local (preferred)
    "assets/vendor/opencv/opencv.js",
    // OpenCV official docs host (often available)
    "https://docs.opencv.org/4.x/opencv.js",
    // CDN fallback (may work depending on availability)
    "https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js"
  ];

  let _cvReady = null;
  function _loadScript(url){
    return new Promise((resolve,reject)=>{
      const s=document.createElement('script');
      s.async=true;
      s.src=url;
      s.onload=()=>resolve(true);
      s.onerror=()=>reject(new Error("Failed to load: "+url));
      document.head.appendChild(s);
    });
  }

  // --- OpenCV in Worker (to avoid blocking UI) ---
let _cvWorker = null;
let _cvWorkerReady = null;
let _cvWorkerReqId = 1;
const _cvWorkerPending = new Map();

function _absUrl(rel){
  try{ return new URL(rel, document.baseURI).toString(); }catch(_){ return rel; }
}

function _getOpenCVCandidatesAbs(){
  // Only use a bundled, same-origin OpenCV build.
  // Remote OpenCV builds frequently depend on extra WASM assets and/or violate
  // iframe/CORS constraints, which can surface as noisy worker console errors.
  return [ _absUrl("assets/vendor/opencv/opencv.js") ];
}

async function _localOpenCvExists(){
  // Avoid starting the worker at all if OpenCV is not bundled with the app.
  // This prevents noisy, non-actionable console errors in production.
  const url = _absUrl("assets/vendor/opencv/opencv.js");
  try{
    let res = await fetch(url, { method: "HEAD", cache: "no-store" });
    if(res && res.ok) return true;
    // Some hosts (or local proxies) may not support HEAD; try GET as a fallback.
    res = await fetch(url, { method: "GET", cache: "no-store" });
    return !!(res && res.ok);
  }catch(_){
    return false;
  }
}

function ensureOpenCV(){
  // Backwards-compatible name: now ensures worker is ready.
  if(_cvWorkerReady) return _cvWorkerReady;

  _cvWorkerReady = (async ()=>{
    // If OpenCV is not bundled locally, don't attempt remote sources.
    // We will fall back to a safe heuristic without producing console noise.
    const okLocal = await _localOpenCvExists();
    if(!okLocal){
      throw new Error("OpenCV is not bundled");
    }
    if(typeof Worker === "undefined"){
      throw new Error("Worker not supported");
    }

    const workerUrl = _absUrl("js/ai_auto_calib_worker.js");
    _cvWorker = new Worker(workerUrl);

    _cvWorker.onmessage = (ev)=>{
      const msg = ev.data || {};
      if(msg.type === "ready"){
        // no-op; resolve happens in init promise below
        return;
      }
      if(msg.type === "result" || msg.type === "error"){
        const p = _cvWorkerPending.get(msg.id);
        if(p){
          _cvWorkerPending.delete(msg.id);
          (msg.type === "result" ? p.resolve : p.reject)(msg.payload);
        }
        return;
      }
    };

    _cvWorker.onerror = (e)=>{
      // Reject all pending
      for(const [id,p] of _cvWorkerPending.entries()){
        _cvWorkerPending.delete(id);
        p.reject(new Error("Worker error: " + (e?.message || "unknown")));
      }
    };

    // Init worker with candidate URLs (absolute)
    const candidates = _getOpenCVCandidatesAbs();
    const initId = _cvWorkerReqId++;
    const initP = new Promise((resolve,reject)=>{
      _cvWorkerPending.set(initId, {resolve, reject});
      const t = setTimeout(()=>{
        _cvWorkerPending.delete(initId);
        reject(new Error("OpenCV worker init timeout"));
      }, 12000);
      _cvWorkerPending.get(initId).resolve = (payload)=>{ clearTimeout(t); resolve(payload); };
      _cvWorkerPending.get(initId).reject  = (payload)=>{ clearTimeout(t); reject(payload instanceof Error ? payload : new Error(String(payload))); };
    });

    _cvWorker.postMessage({ type:"init", id:initId, candidates });

    await initP;
    return true;
  })();

  return _cvWorkerReady;
}


  function _downscaleToCanvas(bitmap, longSide){
    const bw = bitmap?.width || 1;
    const bh = bitmap?.height || 1;
    let w=bw,h=bh;
    const ls=Math.max(bw,bh);
    if(ls>longSide){
      const sc=longSide/ls;
      w=Math.max(1,Math.round(bw*sc));
      h=Math.max(1,Math.round(bh*sc));
    }
    const c=document.createElement('canvas');
    c.width=w; c.height=h;
    const ctx=c.getContext('2d', {willReadFrequently:true});
    ctx.drawImage(bitmap,0,0,w,h);
    return {canvas:c,ctx,w,h};
  }

  function _pickLongestLines(lines, maxN){
    // lines: array of {x1,y1,x2,y2,len}
    lines.sort((a,b)=>b.len-a.len);
    return lines.slice(0, Math.max(1,maxN|0));
  }

  function _intersect(l1,l2){
    // Infinite-line intersection.
    const x1=l1.x1,y1=l1.y1,x2=l1.x2,y2=l1.y2;
    const x3=l2.x1,y3=l2.y1,x4=l2.x2,y4=l2.y2;
    const den = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4);
    if(Math.abs(den) < 1e-6) return null;
    const px = ((x1*y2-y1*x2)*(x3-x4) - (x1-x2)*(x3*y4-y3*x4)) / den;
    const py = ((x1*y2-y1*x2)*(y3-y4) - (y1-y2)*(x3*y4-y3*x4)) / den;
    if(!isFinite(px) || !isFinite(py)) return null;
    return {x:px,y:py};
  }

  function _histogramPick(points, w, h){
    if(!points.length) return null;
    // Allow vanishing outside image bounds (common). Use extended box.
    const xmin = -0.5*w, xmax = 1.5*w;
    const ymin = -0.5*h, ymax = 1.5*h;
    const gx=24, gy=24;
    const bins = new Array(gx*gy).fill(0);
    const sums = new Array(gx*gy).fill(0).map(()=>({x:0,y:0,n:0}));

    for(const p of points){
      if(p.x<xmin||p.x>xmax||p.y<ymin||p.y>ymax) continue;
      const ix = Math.max(0, Math.min(gx-1, Math.floor(((p.x-xmin)/(xmax-xmin))*gx)));
      const iy = Math.max(0, Math.min(gy-1, Math.floor(((p.y-ymin)/(ymax-ymin))*gy)));
      const idx = iy*gx + ix;
      bins[idx]++;
      sums[idx].x += p.x;
      sums[idx].y += p.y;
      sums[idx].n += 1;
    }

    let best=-1, bestCount=0;
    for(let i=0;i<bins.length;i++){
      if(bins[i] > bestCount){ bestCount=bins[i]; best=i; }
    }
    if(best<0 || bestCount<6) return null;
    const s=sums[best];
    if(!s || !s.n) return null;
    return { x: s.x/s.n, y: s.y/s.n, count: bestCount };
  }

  function _softClamp01(v){
    // Prevent extreme values when the vanishing point is outside the frame.
    // We keep it responsive, but avoid snapping to 0/1 which causes unstable defaults.
    const x = +v;
    if(!isFinite(x)) return 0.5;
    // Allow some out-of-range influence, but cap it smoothly.
    const delta = _clamp(x - 0.5, -0.35, 0.35); // => [0.15 .. 0.85]
    return 0.5 + delta;
  }

  function _deriveControlsFromVanish(vanishNorm){
    // Heuristic mapping into existing UI ranges.
    // vanish.y < 0.5 (higher horizon) => more negative horizon shift and stronger perspective.
    const vy = _softClamp01(vanishNorm?.y);
    const autoH = _clamp((vy - 0.5) * 1.8, -1, 1);
    const autoP = _clamp(0.78 + (0.5 - vy) * 0.55, 0.45, 1.0);
    return { autoHorizon:autoH, autoPerspective:autoP, vy };
  }

  async function runOpenCV(bitmap){
  // Run heavy CV in a Worker to avoid blocking contour editing on the main thread.
  await ensureOpenCV();

  if(!_cvWorker){
    throw new Error("OpenCV worker missing");
  }

  const id = _cvWorkerReqId++;
  const p = new Promise((resolve,reject)=>{
    _cvWorkerPending.set(id, {resolve, reject});
    const t = setTimeout(()=>{
      _cvWorkerPending.delete(id);
      reject(new Error("OpenCV worker run timeout"));
    }, 6000);
    _cvWorkerPending.get(id).resolve = (payload)=>{ clearTimeout(t); resolve(payload); };
    _cvWorkerPending.get(id).reject  = (payload)=>{ clearTimeout(t); reject(payload instanceof Error ? payload : new Error(String(payload))); };
  });

  // Transfer bitmap to worker (zero-copy); it will be released after postMessage.
  try{
    _cvWorker.postMessage({ type:"run", id, longSide: 640, bitmap }, [bitmap]);
  }catch(e){
    // If transfer fails, fall back to a safe heuristic (do not attempt main-thread OpenCV).
    _cvWorkerPending.delete(id);
    throw new Error("OpenCV worker postMessage failed: " + (e?.message || e));
  }

  const payload = await p;
if(!payload || payload.ok !== true){
  throw new Error(payload && payload.reason ? payload.reason : "OpenCV worker returned no result");
}

// Map worker payload to the legacy result shape expected by the main pipeline.
const vanishRaw = payload.vanishRaw || {x:0.5, y:0.35};
const vanish = {
  x: _clamp(vanishRaw.x, 0, 1),
  y: _clamp(vanishRaw.y, 0, 1)
};

const horizonY = (typeof payload.horizonY === "number") ? payload.horizonY : _clamp(vanishRaw.y, 0.15, 0.85);

// Auto perspective: conservative curve based on horizon and confidence.
const conf = _clamp(typeof payload.confidence === "number" ? payload.confidence : 0, 0, 1);
const autoP = _clamp(0.35 + 0.55*(1 - horizonY) * (0.35 + 0.65*conf), 0.15, 0.95);

let dir = payload.planeDir || null;
if(dir && typeof dir.x === "number" && typeof dir.y === "number"){
  dir = _norm2(dir);
  if(dir.y > -0.05) dir = {x:-dir.x, y:-dir.y};
}else{
  dir = null;
}

return {
  source: "opencv_worker",
  vanish,
  horizonY,
  planeDir: dir,
  confidence: conf,
  autoHorizon: horizonY,
  autoPerspective: autoP,
  debug: payload.meta || null
};
}



  function runFallback(bitmap){
    const w = bitmap?.width || 1;
    const h = bitmap?.height || 1;

    // If depth already inferred planeDir, we will use it in compositor. Here we only set safe defaults.
    // Fallback assumes horizon slightly above mid and decent perspective.
    const vanish = { x: 0.5, y: 0.38 };
    const horizonY = 0.38;
    const planeDir = _norm2({ x: 0, y: -1 });
    const { autoHorizon, autoPerspective } = _deriveControlsFromVanish(vanish);
    return {
      source: "fallback",
      vanish,
      horizonY,
      planeDir,
      confidence: 0.18,
      autoHorizon,
      autoPerspective,
      debug: { w, h }
    };
  }

  async function run(info){
    const ai = (state.ai = state.ai || {});
    const calib = (ai.calib = ai.calib || {});
    if(calib.enabled === false) return null;

    const bitmap = info?.bitmap || state.assets?.photoBitmap;
    if(!bitmap) return null;

    const photoHash = info?.photoHash || ai.photoHash || null;

    // Cache by photoHash
    if(photoHash && calib.photoHash === photoHash && calib.status === "ready"){
      return calib;
    }

    const t0 = _now();
    calib.status = "running";
    calib.source = null;
    calib.photoHash = photoHash;
    calib.confidence = 0;
    try{ window.dispatchEvent(new Event("ai:calibStarted")); }catch(_){ }

    let res = null;
    try{
      res = await runOpenCV(bitmap);
    }catch(e){
      // OpenCV missing or failed -> fallback
      res = runFallback(bitmap);
    }

    calib.status = "ready";
    calib.source = res.source;
    calib.vanish = res.vanish;
    calib.horizonY = res.horizonY;
    calib.planeDir = res.planeDir;
    calib.confidence = res.confidence;
    calib.autoHorizon = res.autoHorizon;
    calib.autoPerspective = res.autoPerspective;
    calib.debug = res.debug;
    calib.ms = Math.round(_now() - t0);

    // Mirror a couple of fields for convenience (kept for future pipeline stages)
    ai.vanish = ai.vanish || calib.vanish;
    ai.horizonY = ai.horizonY || calib.horizonY;

    try{ window.dispatchEvent(new Event("ai:calibReady")); }catch(_){ }
    return calib;
  }

  window.AIAutoCalib = { ensureOpenCV, run };
})();
