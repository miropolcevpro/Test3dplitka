/*
  Ultra AI Pipeline
  Patch 2: Depth inference (ONNX Runtime Web + WebGPU EP) + safe delivery to compositor.

  Constraints:
  - On-device only (no server inference)
  - Runs ONLY after photo load/replace, never during contour drag
  - Must never break the main app: errors are contained and fall back to current render

  This patch wires depth computation and delivery, but does NOT change the visual output yet.
*/
(function(){
  const S = window.PhotoPaveState;
  if(!S || !S.state){
    console.warn("[AI] PhotoPaveState not ready");
    return;
  }

  const state = S.state;

  // -------- Utilities
  function nowMs(){ return (typeof performance!=="undefined" && performance.now) ? performance.now() : Date.now(); }

  async function sha1HexFromString(str){
    try{
      if(window.crypto && crypto.subtle){
        const enc = new TextEncoder();
        const buf = await crypto.subtle.digest("SHA-1", enc.encode(str));
        const arr = Array.from(new Uint8Array(buf));
        return arr.map(b=>b.toString(16).padStart(2,"0")).join("");
      }
    }catch(e){}
    // Fallback (non-cryptographic but stable-ish)
    let h=0; for(let i=0;i<str.length;i++){ h=((h<<5)-h)+str.charCodeAt(i); h|=0; }
    return "h"+(h>>>0).toString(16);
  }

  async function computePhotoHash(info){
    const file = info?.file;
    const bmp = info?.bitmap;
    const parts = [
      file?.name||"",
      file?.type||"",
      file?.size||0,
      file?.lastModified||0,
      bmp?.width||info?.width||0,
      bmp?.height||info?.height||0
    ];
    return sha1HexFromString(parts.join("|"));
  }

  async function probeWebGPU(){
    const res = { webgpu:false, ms:0, error:null };
    try{
      if(!navigator.gpu) return res;
      const t0=nowMs();
      const adapter = await navigator.gpu.requestAdapter();
      if(!adapter) return res;
      const device = await adapter.requestDevice();
      res.webgpu = !!device;
      res.ms = Math.round(nowMs()-t0);
      return res;
    }catch(e){
      res.error = String(e && (e.message||e) || e);
      return res;
    }
  }

  function chooseTierAndQuality(deviceInfo){
    // Conservative: WebGPU => ultra, else basic.
    if(deviceInfo?.webgpu) return { tier:"high", quality:"ultra" };
    return { tier:"low", quality:"basic" };
  }

  function setStatus(nextStatus){
    state.ai = state.ai || {};
    state.ai.status = nextStatus;
    window.dispatchEvent(new CustomEvent("ai:status", { detail: { status: nextStatus, quality: state.ai.quality, tier: state.ai.device?.tier } }));
  }

  // -------- ORT loader (local-first, CDN fallback)
  const USE_LOCAL_ORT = !!(S && S.state && S.state.ai && S.state.ai.models && S.state.ai.models.useLocalOrt);
  const ORT_SCRIPT_CANDIDATES = [
    // CDN (default). Pinned versions; wasmBase MUST match JS bundle version.
    { url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/ort.all.min.js",
      wasmBase: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/" },

    { url: "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.23.0/ort.all.min.js",
      wasmBase: "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.23.0/" }
  ];

  if(USE_LOCAL_ORT){
    // Optional local override (kept off by default to avoid 404 noise in production).
    ORT_SCRIPT_CANDIDATES.unshift({ url: "assets/ai/ort/ort.all.min.js", wasmBase: "assets/ai/ort/" });
  }

  // Default depth model URL. Can be overridden via state.ai.models.depthUrl.
  // Team-provided model in Yandex Object Storage (Depth Anything V2 ViT-B outdoor dynamic).
  const DEFAULT_DEPTH_MODEL_URL = "https://storage.yandexcloud.net/webar3dtexture/ai/models/depth_anything_v2_vitb_outdoor_dynamic.onnx";

  function _isRelativeUrl(url){
    return !/^https?:\/\//i.test(url);
  }

  async function _headExists(url){
    try{
      const res = await fetch(url, { method: "HEAD", cache: "no-store" });
      return !!res.ok;
    }catch(_){
      return false;
    }
  }

  async function _loadScriptOnce(url){
    // Load script once; no preflight HEAD to avoid noisy 404 logs on GitHub Pages.
    return new Promise((resolve,reject)=>{
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.onload = ()=>resolve(true);
      s.onerror = ()=>reject(new Error("Failed to load script: "+url));
      document.head.appendChild(s);
    });
  }

  let _ortReadyPromise = null;
  async function ensureOrtLoaded(){
    if(window.ort && window.ort.InferenceSession) return window.ort;
    if(_ortReadyPromise) return _ortReadyPromise;

    _ortReadyPromise = (async ()=>{
      let lastErr = null;
      for(const cand of ORT_SCRIPT_CANDIDATES){
        const url = cand.url;
        try{
          const loaded = await _loadScriptOnce(url);
          if(!loaded) continue;
          if(window.ort && window.ort.InferenceSession){
          try{
            // Ensure WASM binaries are loaded from the same build/version as the JS bundle.
            if(window.ort.env && window.ort.env.wasm){
              window.ort.env.wasm.wasmPaths = cand.wasmBase;
              // Avoid threaded WASM on hosts without cross-origin isolation.
              if(typeof self !== "undefined" && !self.crossOriginIsolated){
                window.ort.env.wasm.numThreads = 1;
              }
            }
          }catch(_){/* noop */}
          return window.ort;
        }
          lastErr = new Error("ORT script loaded but window.ort is missing: "+url);
        }catch(e){
          lastErr = e;
        }
      }
      throw lastErr || new Error("Failed to load ONNX Runtime Web");
    })();

    return _ortReadyPromise;
  }

  // -------- Depth stage
  let _depthSession = null;
  let _depthSessionProvider = null;

  function _pickDepthInputLongSide(tier){
    // Depth Anything V2 *dynamic* ONNX models require H and W to be multiples of 14.
    // Pick values that are already multiples of 14 so snapping doesn't upscale.
    // high: 336 (=24*14), mid/low: 280 (=20*14)
    return (tier === "high") ? 336 : 280;
  }

  function _snapToMultiple(v, m){
    v = (v|0);
    if(!m || m<=1) return Math.max(1, v);
    const snapped = Math.floor(v / m) * m;
    return Math.max(m, snapped);
  }

  function _downscaleToCanvas(bitmap, longSide, snapMultiple){
    const bw = bitmap.width || 1;
    const bh = bitmap.height || 1;
    let w = bw;
    let h = bh;
    if(Math.max(bw,bh) > longSide){
      if(bw >= bh){
        w = longSide;
        h = Math.round((bh/bw) * w);
      }else{
        h = longSide;
        w = Math.round((bw/bh) * h);
      }
    }
    w = Math.max(1, w|0);
    h = Math.max(1, h|0);

    // For dynamic depth models: enforce H/W multiples (e.g. 14 for DAv2).
    if(snapMultiple && snapMultiple > 1){
      w = _snapToMultiple(w, snapMultiple);
      h = _snapToMultiple(h, snapMultiple);
    }
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    return { canvas: c, ctx, w, h };
  }

  function _canvasToNCHWTensor(ort, canvas, w, h){
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0,0,w,h);
    const data = img.data;
    // NCHW float32, normalized to 0..1
    const f = new Float32Array(3 * w * h);
    const hw = w*h;
    for(let i=0;i<hw;i++){
      const r = data[i*4+0] / 255;
      const g = data[i*4+1] / 255;
      const b = data[i*4+2] / 255;
      f[i] = r;
      f[i + hw] = g;
      f[i + hw*2] = b;
    }
    return new ort.Tensor("float32", f, [1,3,h,w]);
  }

  function _normalizeDepthToCanvas(depthData, ow, oh){
    // Normalize to 0..255 for visualization/texture upload.
    let mn = Infinity, mx = -Infinity;
    const n = depthData.length;
    for(let i=0;i<n;i++){
      const v = depthData[i];
      if(!Number.isFinite(v)) continue;
      if(v < mn) mn = v;
      if(v > mx) mx = v;
    }
    if(!Number.isFinite(mn) || !Number.isFinite(mx) || mx <= mn){
      mn = 0;
      mx = 1;
    }
    const c = document.createElement("canvas");
    c.width = ow;
    c.height = oh;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const img = ctx.createImageData(ow, oh);
    const out = img.data;
    const denom = (mx - mn) || 1;
    for(let i=0;i<ow*oh;i++){
      const v = depthData[i];
      const t = (v - mn) / denom;
      const g = Math.max(0, Math.min(255, (t*255)|0));
      out[i*4+0] = g;
      out[i*4+1] = g;
      out[i*4+2] = g;
      out[i*4+3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { canvas: c, min: mn, max: mx };
  }

  function _estimateDepthFarHigh(depth01, w, h){
    // Heuristic: in typical outdoor photos, far regions are near the horizon (upper image)
    // and near regions are at the bottom. Compare means.
    try{
      if(!depth01 || w*h !== depth01.length || w < 8 || h < 8) return true;
      const band = Math.max(2, Math.floor(h * 0.18));
      let topSum=0, topCnt=0, botSum=0, botCnt=0;
      for(let y=0;y<band;y++){
        const off = y*w;
        for(let x=0;x<w;x++){
          const v = depth01[off+x];
          if(Number.isFinite(v)){ topSum += v; topCnt++; }
        }
      }
      for(let y=h-band;y<h;y++){
        const off = y*w;
        for(let x=0;x<w;x++){
          const v = depth01[off+x];
          if(Number.isFinite(v)){ botSum += v; botCnt++; }
        }
      }
      if(topCnt < 16 || botCnt < 16) return true;
      const topMean = topSum / topCnt;
      const botMean = botSum / botCnt;
      // If top is larger, normalized values are higher for far (good).
      // Otherwise, treat it as inverted.
      return topMean >= botMean;
    }catch(_){
      return true;
    }
  }

  // Estimate a dominant "far" direction from a relative depth map.
  // Conservative by design: if signal is weak, returns low confidence and will be ignored by the compositor.
  // Output dir is normalized in image space (x right, y down).
  function _estimatePlaneDirFromDepth(depthData, w, h){
    try{
      const n = w*h;
      if(!depthData || n <= 0) return { dir: null, confidence: 0 };

      // Fit a simple plane: d = a*x + b*y + c (least squares on a coarse grid).
      // Use normalized coords centered at 0.
      const step = Math.max(2, Math.floor(Math.min(w, h) / 96)); // ~<=96 samples per axis

      let sumX=0, sumY=0, sumD=0;
      let sumXX=0, sumYY=0, sumXY=0;
      let sumXD=0, sumYD=0;
      let cnt=0;

      for(let y=0; y<h; y+=step){
        const ny = (y/(h-1))*2 - 1;
        const row = y*w;
        for(let x=0; x<w; x+=step){
          const nx = (x/(w-1))*2 - 1;
          const d = depthData[row + x];
          if(!isFinite(d)) continue;
          sumX += nx; sumY += ny; sumD += d;
          sumXX += nx*nx; sumYY += ny*ny; sumXY += nx*ny;
          sumXD += nx*d; sumYD += ny*d;
          cnt++;
        }
      }

      if(cnt < 200) return { dir: null, confidence: 0 };

      // Solve normal equations for a,b (ignore c):
      // [sumXX sumXY] [a] = [sumXD]
      // [sumXY sumYY] [b]   [sumYD]
      const det = sumXX*sumYY - sumXY*sumXY;
      if(!isFinite(det) || Math.abs(det) < 1e-6) return { dir: null, confidence: 0 };

      const invDet = 1/det;
      const a = ( sumYY*sumXD - sumXY*sumYD) * invDet;
      const b = (-sumXY*sumXD + sumXX*sumYD) * invDet;

      // Direction of increasing depth in normalized coords.
      let dx = a;
      let dy = b;
      const mag = Math.hypot(dx, dy);
      if(!isFinite(mag) || mag < 1e-4) return { dir: null, confidence: 0 };
      dx /= mag; dy /= mag;

      // Choose sign so "far" tends to point upward (negative y in image space).
      // If dy is positive (points downward), flip.
      if(dy > 0) { dx = -dx; dy = -dy; }

      // Convert from normalized coord direction to pixel-space direction (account for aspect).
      // In normalized space, x spans 2 over width, y spans 2 over height.
      // Multiply by aspect so that dot products in pixel space remain consistent.
      const px = dx * (w/h);
      const py = dy;
      const pm = Math.hypot(px, py);
      const outDir = pm > 1e-6 ? { x: px/pm, y: py/pm } : { x: dx, y: dy };

      // Confidence: stronger gradient + adequate sample count.
      // Calibrate conservatively.
      const conf = Math.max(0, Math.min(1, (mag*2.5) * Math.min(1, cnt/1200)));
      return { dir: outDir, confidence: conf };
    }catch(_){
      return { dir: null, confidence: 0 };
    }
  }

  function _sampleDepthBilinear(depth, w, h, x, y){
    // depth: Float32Array (0..1), x/y in pixel coords
    if(!depth || w<=1 || h<=1) return NaN;
    const fx = Math.max(0, Math.min(w-1, x));
    const fy = Math.max(0, Math.min(h-1, y));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(w-1, x0+1), y1 = Math.min(h-1, y0+1);
    const tx = fx - x0, ty = fy - y0;
    const i00 = y0*w + x0;
    const i10 = y0*w + x1;
    const i01 = y1*w + x0;
    const i11 = y1*w + x1;
    const d00 = depth[i00], d10 = depth[i10], d01 = depth[i01], d11 = depth[i11];
    if(!isFinite(d00)||!isFinite(d10)||!isFinite(d01)||!isFinite(d11)) return NaN;
    const a = d00*(1-tx) + d10*tx;
    const b = d01*(1-tx) + d11*tx;
    return a*(1-ty) + b*ty;
  }

  function _stabilizePlaneDirSign(depthNorm, w, h, dir, depthFarHigh){
    // Ensure that +dir consistently points towards "far" in terms of depth.
    // Without this, eigen/gradient sign ambiguity can flip between runs, causing texture inversion.
    if(!dir || !isFinite(dir.x) || !isFinite(dir.y)) return dir;
    const dx = dir.x * w;
    const dy = dir.y * h;
    const dm = Math.hypot(dx, dy);
    if(!isFinite(dm) || dm < 1e-6) return dir;
    const ux = dx / dm;
    const uy = dy / dm;

    // Sample around a near-ground anchor (lower-middle of the frame)
    const cx = w * 0.5;
    const cy = h * 0.72;
    const L = Math.max(6, Math.min(w, h) * 0.16);
    const dPlus  = _sampleDepthBilinear(depthNorm, w, h, cx + ux*L, cy + uy*L);
    const dMinus = _sampleDepthBilinear(depthNorm, w, h, cx - ux*L, cy - uy*L);
    if(!isFinite(dPlus) || !isFinite(dMinus)){
      // Fallback: keep a consistent "upward" tendency
      if(dir.y > 0) return { x: -dir.x, y: -dir.y };
      return dir;
    }

    const diff = dPlus - dMinus;
    // If far=high, diff should be positive for correct sign. If far=low, diff should be negative.
    const want = depthFarHigh ? 1 : -1;
    if(Math.abs(diff) > 0.02 && (diff * want) < 0){
      return { x: -dir.x, y: -dir.y };
    }
    // Small/ambiguous gradients: avoid downward flip
    if(dir.y > 0) return { x: -dir.x, y: -dir.y };
    return dir;
  }

  async function _ensureDepthSession(ort, preferProvider){
    const modelUrl = (state.ai && state.ai.models && state.ai.models.depthUrl) ? state.ai.models.depthUrl : DEFAULT_DEPTH_MODEL_URL;

    // If a session exists for this provider, keep it.
    if(_depthSession && _depthSessionProvider === preferProvider) return { session: _depthSession, provider: _depthSessionProvider, modelUrl };

    const opts = {};
    if(preferProvider === "webgpu"){
      opts.executionProviders = ["webgpu"]; // WebGPU EP
    }else{
      // fallback provider
      opts.executionProviders = ["wasm"];
      // best-effort wasm path hint (works only if matching wasm assets are present)
      try{
        if(ort.env && ort.env.wasm){
          ort.env.wasm.wasmPaths = "assets/ai/ort/";
        }
      }catch(_){/*noop*/}
    }

    const session = await ort.InferenceSession.create(modelUrl, opts);
    _depthSession = session;
    _depthSessionProvider = preferProvider;
    return { session, provider: preferProvider, modelUrl };
  }

  async function runDepth(info){
    // Preconditions
    state.ai = state.ai || {};
    const ai = state.ai;
    if(ai.enabled === false) return;
    // Patch 2+: prefer WebGPU when available; otherwise use WASM fallback (slower).
    if(ai.quality !== "ultra") return;

    const bmp = info?.bitmap;
    if(!bmp || !bmp.width || !bmp.height) return;

    const t0 = nowMs();
    ai.timings = ai.timings || {};

    try{
      const depthUrl = (ai.models && ai.models.depthUrl) ? ai.models.depthUrl : DEFAULT_DEPTH_MODEL_URL;
      // If local model file is missing, skip depth stage to avoid console 404 noise.
      if(_isRelativeUrl(depthUrl)){
        const ok = await _headExists(depthUrl);
        if(!ok){
          ai.depthReady = false;
          ai.depthStatus = "missing_model";
          ai.depthMap = null;
          ai.timings.depthMs = nowMs() - t0;
          return;
        }
      }

      const ort = await ensureOrtLoaded();

      // Prefer WebGPU. If it fails at session creation or run, we fallback to wasm (still safe, but can be slower).
      let provider = "webgpu";
      let sessionInfo = null;
      try{
        sessionInfo = await _ensureDepthSession(ort, provider);
      }catch(eWebgpu){
        provider = "wasm";
        sessionInfo = await _ensureDepthSession(ort, provider);
      }

      const session = sessionInfo.session;
      const inName = (session.inputNames && session.inputNames.length) ? session.inputNames[0] : null;
      const outName = (session.outputNames && session.outputNames.length) ? session.outputNames[0] : null;
      if(!inName || !outName) throw new Error("Depth model IO names not found");

      const longSide = _pickDepthInputLongSide(ai.device.tier);
      // Depth Anything V2 dynamic ONNX requires H/W multiples of 14.
      // We detect dynamic models by filename to keep this patch minimal and safe.
      const isDynamic = /_dynamic\.onnx(\?|$)/i.test(depthUrl);
      const ds = _downscaleToCanvas(bmp, longSide, isDynamic ? 14 : 0);
      const inputTensor = _canvasToNCHWTensor(ort, ds.canvas, ds.w, ds.h);

      const feeds = {};
      feeds[inName] = inputTensor;

      const tRun0 = nowMs();
      const outputs = await session.run(feeds);
      ai.timings.depthRunMs = Math.round(nowMs() - tRun0);

      const out = outputs[outName];
      if(!out || !out.data || !out.dims) throw new Error("Depth output tensor missing");

      // Expect output like [1,1,H,W] or [1,H,W] etc.
      let ow = ds.w;
      let oh = ds.h;
      if(out.dims.length === 4){
        // try NCHW
        oh = out.dims[2];
        ow = out.dims[3];
      }else if(out.dims.length === 3){
        oh = out.dims[1];
        ow = out.dims[2];
      }else if(out.dims.length === 2){
        oh = out.dims[0];
        ow = out.dims[1];
      }
      ow = Math.max(1, ow|0);
      oh = Math.max(1, oh|0);

      // If tensor length doesn't match expected, keep safe.
      const expected = ow * oh;
      const depthData = out.data;
      if(depthData.length < expected){
        throw new Error("Depth output size mismatch: got "+depthData.length+", expected "+expected);
      }

      const norm = _normalizeDepthToCanvas(depthData, ow, oh);

      // Build a normalized float depth array (0..1) for lightweight geometry inference (Patch 3+).
      // Keep it small: this runs on the downscaled inference resolution.
      const denom = (norm.max - norm.min) || 1;
      const depthNorm = new Float32Array(expected);
      for(let i=0;i<expected;i++){
        depthNorm[i] = (depthData[i] - norm.min) / denom;
      }

      // Store a canvas-based depth map for safe WebGL texture upload.
      ai.depthMap = {
        canvas: norm.canvas,
        width: ow,
        height: oh,
        min: norm.min,
        max: norm.max,
        data: depthNorm,
        provider,
        modelUrl: sessionInfo.modelUrl,
        photoHash: ai.photoHash || null
      };

      // Determine whether normalized depth values increase with distance (far=high).
      // This allows shaders to apply far effects consistently even if the model output is inverted.
      ai.depthFarHigh = _estimateDepthFarHigh(depthNorm, ow, oh);

      // Patch 3 groundwork: infer a dominant plane direction from depth (conservative confidence).
      // Compositor may use this to orient the perspective along the real scene direction.
      const est = _estimatePlaneDirFromDepth(depthNorm, ow, oh);
      // Stabilize sign: +dir should reliably point towards "far" to avoid random inversion
      // when toggling Ultra / re-running the pipeline.
      ai.planeDir = _stabilizePlaneDirSign(depthNorm, ow, oh, est.dir, ai.depthFarHigh);
      ai.confidence = Math.max(ai.confidence||0, est.confidence||0);

      ai.timings.depthTotalMs = Math.round(nowMs() - t0);
      ai.depthReady = true;
      window.dispatchEvent(new CustomEvent("ai:depthReady", { detail: { w:ow, h:oh, provider } }));

    }catch(e){
      const msg = String(e && (e.message||e) || e);
      ai.errors = ai.errors || [];
      ai.errors.push("depth: "+msg);
      // Depth errors should not stop the pipeline: mark and continue.
      ai.depthReady = false;
      ai.depthMap = null;
      if(ai.debug){ console.warn("[AI] depth error:", msg); }
    }
  }

  // -------- Main pipeline run
  async function run(info){
    state.ai = state.ai || {};
    const ai = state.ai;
    if(ai.enabled === false) return;

    const startedAt = nowMs();
    ai.errors = ai.errors || [];
    ai.timings = ai.timings || {};

    try{
      setStatus("running");
      window.dispatchEvent(new CustomEvent("ai:started", { detail: { when: Date.now() } }));

      // Photo hash
      const tHash0 = nowMs();
      const photoHash = await computePhotoHash(info);
      ai.photoHash = photoHash;
      ai.timings.hashMs = Math.round(nowMs() - tHash0);

      // Patch D (Auto-calibration): start vanishing/horizon calibration asynchronously.
      // This must NEVER block the UI or the depth stage.
      try{
        if(ai.calib && ai.calib.enabled !== false && window.AIAutoCalib && typeof window.AIAutoCalib.run === "function"){
          window.AIAutoCalib.run({ bitmap: info?.bitmap, photoHash }).catch(()=>{});
        }
      }catch(_){/* no-op */}

      // Probe device
      const tProbe0 = nowMs();
      const dev = await probeWebGPU();
      ai.device = ai.device || {};
      ai.device.webgpu = !!dev.webgpu;
      ai.device.probeMs = dev.ms ?? Math.round(nowMs() - tProbe0);
      if(dev.error) ai.device.error = dev.error;

      const tier = chooseTierAndQuality(dev);
      ai.device.tier = tier.tier;
      ai.quality = tier.quality;
      ai.confidence = 0;

      // Depth stage (Patch 2) - safe no-op if unavailable
      await runDepth(info);

      ai.timings.totalMs = Math.round(nowMs() - startedAt);
      setStatus("ready");
      window.dispatchEvent(new CustomEvent("ai:ready", { detail: { quality: ai.quality, tier: ai.device.tier, hash: ai.photoHash, depth: !!ai.depthMap } }));

    }catch(e){
      const msg = String(e && (e.message||e) || e);
      ai.errors.push(msg);
      ai.status = "error";
      window.dispatchEvent(new CustomEvent("ai:error", { detail: { error: msg } }));
      window.dispatchEvent(new CustomEvent("ai:status", { detail: { status:"error" } }));
      console.warn("[AI] pipeline error:", msg);
    }
  }

  // ---------------- Premium occlusion (interactive segmentation)
  // This is intentionally "user-driven" to avoid heavy per-frame ML. User clicks an object once;
  // we cache the occlusion mask by photoHash and deliver it to the WebGL compositor.

  const MP_VERSION = "0.10.15";
  const MP_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
  // Default model shipped by MediaPipe for InteractiveSegmenter (publicly hosted).
  const MP_DEFAULT_MODEL_URL = "https://storage.googleapis.com/mediapipe-tasks/interactive_segmenter/ptm_512_hdt_ptm_woid.tflite";

  let _mpVision = null;
  let _mpSegmenter = null;
  let _occInputCanvas = null;
  let _occCanvas = null;
  let _occHash = null;

  async function ensureInteractiveSegmenter(){
    if(_mpSegmenter) return _mpSegmenter;
    if(!_mpVision){
      // Dynamic import keeps this optional and avoids bundler requirements.
      _mpVision = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`);
    }
    const FilesetResolver = _mpVision.FilesetResolver;
    const InteractiveSegmenter = _mpVision.InteractiveSegmenter;
    const fileset = await FilesetResolver.forVisionTasks(MP_WASM_BASE);
    _mpSegmenter = await InteractiveSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: (state.ai?.models?.interactiveSegUrl || MP_DEFAULT_MODEL_URL) },
      outputCategoryMask: true,
      outputConfidenceMasks: false
    });
    return _mpSegmenter;
  }

  function _ensureOccCanvases(info){
    const photoW = info && info.photoW ? info.photoW : (state.assets && state.assets.photoW) || 0;
    const photoH = info && info.photoH ? info.photoH : (state.assets && state.assets.photoH) || 0;
    const long = Math.max(1, photoW, photoH);
    const longSide = 512;
    const sc = longSide / long;
    const w = Math.max(1, Math.round(photoW * sc));
    const h = Math.max(1, Math.round(photoH * sc));

    if(!_occInputCanvas){ _occInputCanvas = document.createElement("canvas"); }
    if(!_occCanvas){ _occCanvas = document.createElement("canvas"); }

    if(_occInputCanvas.width !== w || _occInputCanvas.height !== h){
      _occInputCanvas.width = w; _occInputCanvas.height = h;
    }
    if(_occCanvas.width !== w || _occCanvas.height !== h){
      _occCanvas.width = w; _occCanvas.height = h;
      // Reset on resize
      const ctx0 = _occCanvas.getContext("2d");
      ctx0.clearRect(0,0,w,h);
    }

    return { w, h };
  }

  function _maskToBinaryU8(maskImageData){
    // Converts mask ImageData into a 0/255 grayscale Uint8ClampedArray.
    const d = maskImageData.data;
    const out = new Uint8ClampedArray(maskImageData.width * maskImageData.height);
    for(let i=0,j=0;i<d.length;i+=4,j++){
      // Category mask: non-zero means selected region.
      const v = d[i];
      out[j] = (v > 0) ? 255 : 0;
    }
    return out;
  }

  function _blendOccMask(mode, binU8, w, h){
    // Union/subtract into persistent occlusion canvas.
    const ctx = _occCanvas.getContext("2d");
    const img = ctx.getImageData(0,0,w,h);
    const d = img.data;
    if(mode === "sub"){
      for(let p=0, i=0;p<binU8.length;p++, i+=4){
        if(binU8[p] > 0){
          d[i] = 0; d[i+1] = 0; d[i+2] = 0; d[i+3] = 0;
        }
      }
    }else{
      for(let p=0, i=0;p<binU8.length;p++, i+=4){
        const v = binU8[p];
        if(v > 0){
          // Store mask in RGB (alpha also filled) for straightforward sampling.
          d[i] = 255; d[i+1] = 255; d[i+2] = 255; d[i+3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);

    // Light feather for nicer edges (cheap): draw blurred copy over itself.
    try{
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.filter = "blur(1.2px)";
      ctx.drawImage(_occCanvas, 0, 0);
      ctx.restore();
    }catch(_){ /* noop */ }
  }

  async function pickOcclusionAt(nx, ny, opts={}){
    // nx,ny are normalized in photo coordinates (0..1).
    const a = state.ai || (state.ai = {});
    if(a.enabled === false) return;
    if(a.occlusionEnabled === false) return;
    if(!(state.assets && state.assets.photoBitmap && state.assets.photoW && state.assets.photoH)) return;

    const seg = await ensureInteractiveSegmenter();
    const info = {
      photoBitmap: state.assets.photoBitmap,
      photoW: state.assets.photoW,
      photoH: state.assets.photoH
    };

    // Ensure hash and canvases
    if(!a.photoHash){
      try{ a.photoHash = await computePhotoHash(info); }catch(_){ a.photoHash = String(Date.now()); }
    }
    const dims = _ensureOccCanvases(info);
    const ctxIn = _occInputCanvas.getContext("2d");
    ctxIn.clearRect(0,0,dims.w,dims.h);
    ctxIn.drawImage(info.photoBitmap, 0, 0, dims.w, dims.h);

    if(_occHash !== a.photoHash){
      _occHash = a.photoHash;
      // Reset per photo
      const ctx0 = _occCanvas.getContext("2d");
      ctx0.clearRect(0,0,dims.w,dims.h);
    }

    const x = Math.max(0, Math.min(1, nx));
    const y = Math.max(0, Math.min(1, ny));
    const mode = (opts && opts.mode === "sub") ? "sub" : "add";

    let res = null;
    // segment() is synchronous in many builds, but handle Promise-based implementations as well.
    res = seg.segment(_occInputCanvas, { keypoint: { x, y } });
    if(res && typeof res.then === "function"){
      res = await res;
    }
    const cm = res && res.categoryMask ? res.categoryMask : null;
    if(!cm) throw new Error("InteractiveSegmenter returned empty categoryMask");

    let maskImageData = null;
    try{
      maskImageData = cm.getAsImageData();
    }catch(_){
      // Fallback: build ImageData from raw data if supported.
      const u8 = cm.getAsUint8Array ? cm.getAsUint8Array() : null;
      const mw = cm.width || dims.w;
      const mh = cm.height || dims.h;
      if(!u8) throw new Error("Cannot read mask data");
      const rgba = new Uint8ClampedArray(mw*mh*4);
      for(let p=0, i=0;p<u8.length;p++, i+=4){
        const v = u8[p];
        rgba[i] = v; rgba[i+1] = v; rgba[i+2] = v; rgba[i+3] = 255;
      }
      maskImageData = new ImageData(rgba, mw, mh);
    }

    const bin = _maskToBinaryU8(maskImageData);
    _blendOccMask(mode, bin, maskImageData.width, maskImageData.height);

    // Publish to state
    a.occlusionMask = { canvas: _occCanvas, width: _occCanvas.width, height: _occCanvas.height, photoHash: a.photoHash, updatedAt: Date.now() };
    return true;
  }

  // -------- Public API
  const API = {
    setEnabled(v){
      state.ai = state.ai || {};
      state.ai.enabled = !!v;
      if(!state.ai.enabled){
        setStatus("idle");
      }
    },
    onPhotoLoaded(info){
      state.ai = state.ai || {};
      if(state.ai.enabled === false) return;
      state.ai.status = "loading";
      window.dispatchEvent(new CustomEvent("ai:status", { detail: { status:"loading" } }));
      setTimeout(()=>run(info), 0);
    },
    // For debugging/manual triggers
    _run: run,
    _ensureOrtLoaded: ensureOrtLoaded,
    pickOcclusionAt
  };

  window.AIUltraPipeline = API;

  // -------- Defaults
  state.ai = state.ai || {
    enabled: true,
    quality: "basic",
    status: "idle",
    device: { webgpu:false, tier:"low" },
    photoHash: null,
    horizonY: null,
    vanish: null,
    planeDir: null,
    plane: null,
    confidence: 0,
    occlusionMask: null,
    depthMap: null,
    depthReady: false,
    floorMask: null,
    models: { depthUrl: DEFAULT_DEPTH_MODEL_URL },
    timings: {},
    errors: []
  };

})();
