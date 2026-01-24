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

  async function ensureOpenCV(){
    // Already loaded
    if(window.cv && window.cv.Mat) return window.cv;
    if(_cvReady) return _cvReady;

    _cvReady = (async()=>{
      let lastErr=null;
      for(const url of OPENCV_CANDIDATES){
        try{
          await _loadScript(url);
          // Wait for runtime init (OpenCV sets cv.onRuntimeInitialized)
          const cv = window.cv;
          if(!cv) throw new Error("cv global missing after load: "+url);
          // Some builds may initialize very quickly. Give it a microtask turn.
          await new Promise(r=>setTimeout(r,0));
          if(cv.Mat) return cv;
          await new Promise((resolve,reject)=>{
            let done=false;
            const t=setTimeout(()=>{ if(done) return; done=true; reject(new Error("OpenCV init timeout")); }, 8000);
            // Preserve any existing hook.
            const prev = cv.onRuntimeInitialized;
            cv.onRuntimeInitialized = ()=>{
              if(done) return;
              try{ if(typeof prev === 'function') prev(); }catch(_){/*noop*/}
              done=true;
              clearTimeout(t);
              resolve(true);
            };
          });
          if(window.cv && window.cv.Mat) return window.cv;
          throw new Error("OpenCV loaded but not initialized: "+url);
        }catch(e){
          lastErr=e;
        }
      }
      throw lastErr || new Error("OpenCV load failed");
    })();

    return _cvReady;
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
    const cv = await ensureOpenCV();
    const {canvas,w,h} = _downscaleToCanvas(bitmap, 640);

    // cv.imread can accept canvas element
    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    const blur = new cv.Mat();
    const edges = new cv.Mat();
    const lines = new cv.Mat();

    try{
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5,5), 0, 0, cv.BORDER_DEFAULT);
      cv.Canny(blur, edges, 50, 140);

      // HoughLinesP
      cv.HoughLinesP(edges, lines, 1, Math.PI/180, 60, 30, 10);

      const out=[];
      const arr = lines.data32S; // [x1,y1,x2,y2,...]
      for(let i=0;i<arr.length;i+=4){
        const x1=arr[i], y1=arr[i+1], x2=arr[i+2], y2=arr[i+3];
        const dx=x2-x1, dy=y2-y1;
        const len=_hypot(dx,dy);
        if(!isFinite(len) || len < 26) continue;
        // Filter out near-horizontal lines (too noisy for vanishing)
        const ang = Math.abs(Math.atan2(dy,dx));
        const sin = Math.abs(Math.sin(ang));
        if(sin < 0.25) continue;
        out.push({x1,y1,x2,y2,len});
      }

      const picked = _pickLongestLines(out, 70);
      const inter=[];
      for(let i=0;i<picked.length;i++){
        for(let j=i+1;j<picked.length;j++){
          const p = _intersect(picked[i], picked[j]);
          if(p) inter.push(p);
        }
      }

      const v = _histogramPick(inter, w, h);
      if(!v) throw new Error("No stable vanishing point");

      // Keep RAW normalized vanish (may be outside 0..1 for real scenes).
      // We store a clamped copy for UI/debug, but derive defaults from a soft-clamped value.
      const vanishRaw = { x: (v.x / w), y: (v.y / h) };
      const vanish = { x: _clamp(vanishRaw.x, 0, 1), y: _clamp(vanishRaw.y, 0, 1) };
      const horizonY = _softClamp01(vanishRaw.y);

      // planeDir from bottom-center to vanish (in image space).
      // FAR should point upward (negative y). If the estimate points downward (towards the camera)
      // or becomes near-horizontal, flip to stabilize and prevent premium inversion.
      let dir = _norm2({ x: (v.x - 0.5*w), y: (v.y - 0.98*h) });
      if(!isFinite(dir.x) || !isFinite(dir.y)) dir = {x:0,y:-1};
      if(dir.y > -0.05){
        dir = { x: -dir.x, y: -dir.y };
      }

      // Confidence: density of the best bin vs total intersections
      const conf = _clamp((v.count || 0) / Math.max(1, inter.length), 0, 1);
      const controls = _deriveControlsFromVanish(vanishRaw);

      return {
        source: "opencv",
        vanish,
        horizonY,
        planeDir: dir,
        confidence: conf,
        autoHorizon: controls.autoHorizon,
        autoPerspective: controls.autoPerspective,
        debug: { w, h, lines: picked.length, intersections: inter.length, binCount: v.count, vanishRaw }
      };

    }finally{
      // Cleanup Mats
      try{ src.delete(); }catch(_){ }
      try{ gray.delete(); }catch(_){ }
      try{ blur.delete(); }catch(_){ }
      try{ edges.delete(); }catch(_){ }
      try{ lines.delete(); }catch(_){ }
    }
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
