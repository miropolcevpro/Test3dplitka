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
  const ORT_SCRIPT_CANDIDATES = [
    // local (recommended: keep ORT JS + WASM from the same version)
    { url: "assets/ai/ort/ort.all.min.js", wasmBase: "assets/ai/ort/" },

    // CDN fallbacks (pinned; MUST match wasmBase version)
    { url: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/ort.all.min.js",
      wasmBase: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/" },

    { url: "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.23.0/ort.all.min.js",
      wasmBase: "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.23.0/" }
  ];

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
    // Avoid console 404 noise for missing local assets: check existence before injecting <script>.
    if(_isRelativeUrl(url)){
      const ok = await _headExists(url);
      if(!ok) return false;
    }
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

      // Store a canvas-based depth map for safe WebGL texture upload.
      ai.depthMap = {
        canvas: norm.canvas,
        width: ow,
        height: oh,
        min: norm.min,
        max: norm.max,
        provider,
        modelUrl: sessionInfo.modelUrl,
        photoHash: ai.photoHash || null
      };

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
    _ensureOrtLoaded: ensureOrtLoaded
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
