/*
  PhotoPave WebGL Compositor (Full Pipeline)
  - Renders background photo + multiple zones with projective tiled textures
  - Uses per-zone mask (with holes) generated on CPU (2D canvas) and sampled in GPU
  - No Canvas2D fill fallback: the visual output is always produced by WebGL

  Public API:
    PhotoPaveCompositor.init(glCanvas)
    PhotoPaveCompositor.setPhoto(imageBitmap, photoW, photoH)
    PhotoPaveCompositor.resize(renderW, renderH)
    PhotoPaveCompositor.render(state) // async
    PhotoPaveCompositor.exportPNG(state, {maxLongSide}) // async -> dataURL
*/

window.PhotoPaveCompositor = (function(){
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const lerp = (a,b,t)=>a + (b-a)*t;
  const smoothstep = (e0,e1,x)=>{
    const t = clamp((x - e0) / ((e1 - e0) || 1e-6), 0, 1);
    return t*t*(3 - 2*t);
  };
  const EPS = 1e-9;

  let canvas = null;
  let gl = null;
  let extAniso = null;
  let maxTexSize = 2048;
  let maxRbSize = 2048;

  // GL resources
  let quadVao = null;
  let progCopy = null;
  let progZone = null;

  let photoTex = null;
  let photoW = 0, photoH = 0;

  let ping = null;
  let pong = null;

  const tileCache = new Map(); // url -> {tex,w,h,ts}
  const maskCache = new Map(); // key -> {maskTex, blurTex, w,h, ts}
  const lastGoodInvH = new Map(); // zoneId -> invH row-major array9
  // Drag-stabilization: while the user drags contour points, keep the inferred "near/far" scanlines
  // anchored to the pre-drag extrema to avoid sudden quad jumps when a different point becomes yMin/yMax.
  // This removes visible "teleport" artifacts without freezing the contour itself.
  const dragLockExtrema = new Map(); // zoneId -> {yMin:number,yMax:number}
  let _lastDragZoneId = null;

  // Track AI mode signature to avoid reusing a homography computed under a different
  // Ultra configuration (can manifest as a sudden vertical inversion when toggling).
  let _lastAIModeKey = null;

  // Ultra AI resources (Patch 2)
  let aiDepthTex = null;
  let aiDepthKey = null;
  let aiDepthW = 0, aiDepthH = 0;

  // Ultra AI resources (Patch 4) - occlusion mask (tile under objects)
  let aiOccTex = null;
  let aiOccKey = null;
  let aiOccW = 0, aiOccH = 0;

  function _destroyTex(t){
    try{ if(t) gl.deleteTexture(t); }catch(_){/*noop*/}
  }

  function _ensureAIDepthTexture(ai){
    // We only "deliver" depth map to GL here (upload as texture) without using it in shaders yet.
    const dm = ai && ai.depthMap ? ai.depthMap : null;
    const key = dm && (dm.photoHash || (ai && ai.photoHash) || '');
    if(!dm || !dm.canvas){
      if(aiDepthTex){ _destroyTex(aiDepthTex); aiDepthTex=null; aiDepthKey=null; }
      return;
    }
    if(aiDepthTex && aiDepthKey === key && aiDepthW === dm.width && aiDepthH === dm.height) return;

    // Recreate texture if changed
    if(aiDepthTex){ _destroyTex(aiDepthTex); aiDepthTex=null; }
    aiDepthKey = key;
    aiDepthW = dm.width|0;
    aiDepthH = dm.height|0;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Upload RGBA canvas (depth packed as grayscale RGBA)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, dm.canvas);

    gl.bindTexture(gl.TEXTURE_2D, null);
    aiDepthTex = tex;
  }

  function _ensureAIOcclusionTexture(ai){
    const om = ai && ai.occlusionMask ? ai.occlusionMask : null;
    const enabled = !(ai && ai.occlusionEnabled === false);
    const key = (om && (om.photoHash || (ai && ai.photoHash) || "")) + "|" + (om && om.updatedAt ? om.updatedAt : 0);
    if(!enabled || !om || !om.canvas){
      if(aiOccTex){ _destroyTex(aiOccTex); aiOccTex=null; aiOccKey=null; }
      return;
    }
    if(aiOccTex && aiOccKey === key && aiOccW === (om.width|0) && aiOccH === (om.height|0)) return;
    if(aiOccTex){ _destroyTex(aiOccTex); aiOccTex=null; }
    aiOccKey = key;
    aiOccW = om.width|0;
    aiOccH = om.height|0;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Upload RGBA canvas (mask stored in RGB/alpha)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, om.canvas);
    gl.bindTexture(gl.TEXTURE_2D, null);
    aiOccTex = tex;
  }



  // Small reusable 2D canvases for mask raster
  const _maskCanvas = document.createElement('canvas');
  const _maskCtx = _maskCanvas.getContext('2d');
  const _blurCanvas = document.createElement('canvas');
  const _blurCtx = _blurCanvas.getContext('2d');

  function _isWebGL2Supported(){
    try{ return !!document.createElement('canvas').getContext('webgl2'); }catch(_){ return false; }
  }

  function _createShader(type, src){
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
      const log = gl.getShaderInfoLog(sh) || 'shader compile failed';
      gl.deleteShader(sh);
      throw new Error(log);
    }
    return sh;
  }

  function _createProgram(vsSrc, fsSrc){
    const vs = _createShader(gl.VERTEX_SHADER, vsSrc);
    const fs = _createShader(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if(!gl.getProgramParameter(p, gl.LINK_STATUS)){
      const log = gl.getProgramInfoLog(p) || 'program link failed';
      gl.deleteProgram(p);
      throw new Error(log);
    }
    return p;
  }

  function _createEmptyTexture(w,h, opts={}){
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const ifmt = opts.internalFormat || gl.RGBA8;
    const fmt = opts.format || gl.RGBA;
    const type = opts.type || gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.minFilter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, opts.magFilter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.wrapS || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, opts.wrapT || gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  function _createFBO(w,h){
    const tex = _createEmptyTexture(w,h,{minFilter:gl.LINEAR,magFilter:gl.LINEAR,wrapS:gl.CLAMP_TO_EDGE,wrapT:gl.CLAMP_TO_EDGE});
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if(st !== gl.FRAMEBUFFER_COMPLETE){
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      throw new Error('Framebuffer incomplete: 0x' + st.toString(16));
    }
    return {tex,fbo,w,h};
  }

  function _destroyFBO(rt){
    if(!rt) return;
    try{ if(rt.fbo) gl.deleteFramebuffer(rt.fbo); }catch(_){ }
    try{ if(rt.tex) gl.deleteTexture(rt.tex); }catch(_){ }
  }

  function _ensureTargets(w,h){
    if(ping && ping.w===w && ping.h===h && pong && pong.w===w && pong.h===h) return;
    _destroyFBO(ping);
    _destroyFBO(pong);
    ping = _createFBO(w,h);
    pong = _createFBO(w,h);
  }

  function _setupQuad(){
    // Fullscreen triangle strip
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const data = new Float32Array([
      -1,-1,
      1,-1,
      -1,1,
      1,1
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = 0;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return {vao,vbo};
  }

  const VS = `#version 300 es
  layout(location=0) in vec2 aPos;
  out vec2 vUv;
  void main(){
    vUv = aPos*0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }`;

  // Copy shader.
  // IMPORTANT: the compositor uses this both for DOM-backed textures (photo, masks)
  // and for FBO-backed textures (previous composite passes). These two sources have
  // different Y origins in practice.
  //
  // To avoid the "photo upside-down" bug, we do NOT hardcode a flip here.
  // Instead we pass uFlipY at draw time:
  //  - uFlipY = 1 when copying from DOM-backed textures (photo/mask/tile)
  //  - uFlipY = 0 when copying from FBO textures (ping/pong)
  const FS_COPY = `#version 300 es
  precision highp float;
  in vec2 vUv;
  uniform sampler2D uTex;
  uniform int uFlipY;
  out vec4 outColor;
  void main(){
    vec2 uv = vUv;
    if(uFlipY==1){ uv.y = 1.0 - uv.y; }
    outColor = texture(uTex, uv);
  }`;

  const FS_ZONE = `#version 300 es
  precision highp float;
  in vec2 vUv;

  uniform sampler2D uPrev;
  uniform sampler2D uPhoto;
  uniform sampler2D uTile;
  uniform sampler2D uMask;
  uniform sampler2D uMaskBlur;
  uniform sampler2D uDepth;
  uniform int uHasDepth;
  uniform int uDepthFarHigh;
  uniform sampler2D uOcc;
  uniform int uHasOcc;

  uniform vec2 uResolution; // render target size in pixels
  uniform mat3 uInvH;       // image(px)->plane(uv)
  // Variant B (3D camera): ray-plane intersection renderer (uses manual calibration lines).
  uniform int uUseCam3D;    // 0/1
  uniform mat3 uKinv;       // pixel -> camera ray (y-down)
  uniform mat3 uRwc;        // world->camera rotation
  uniform vec3 uTwc;        // world->camera translation
  uniform float uScale;     // tile scale
  uniform vec2  uPhase;     // texture phase lock (0..1)
  uniform float uRotation;  // degrees
  uniform float uOpacity;   // 0..1
  uniform int uBlendMode;   // 0=normal, 1=multiply
  uniform float uFeather;   // 0..1
  uniform float uAO;        // 0..1
  uniform float uPhotoFit;  // 0..1
  uniform float uFarFade;   // 0..1
  uniform int uVFlip;       // 0/1: flip plane V (depth)
  uniform int uOpaqueFill; // 0/1: force dense fill (reduce "transparency")
  uniform float uPlaneD;   // plane depth in UV units (for normalization)

  out vec4 outColor;

  vec3 toLinear(vec3 c){ return pow(max(c, vec3(0.0)), vec3(2.2)); }
  vec3 toSRGB(vec3 c){ return pow(max(c, vec3(0.0)), vec3(1.0/2.2)); }

  void main(){
    // Coordinate conventions:
    // - vUv: bottom-left origin (standard fullscreen quad)
    // - uploaded HTML images/canvases: top-left origin
    // - render targets (FBO textures): bottom-left origin
    vec2 uvSrc = vec2(vUv.x, 1.0 - vUv.y);
    vec2 fragPx = uvSrc * uResolution;

    vec4 prev = texture(uPrev, vUv);
    vec3 prevLin = toLinear(prev.rgb);

    vec3 photo = texture(uPhoto, uvSrc).rgb;
    vec3 photoLin = toLinear(photo);
    float lum = dot(photoLin, vec3(0.2126, 0.7152, 0.0722));

    float m = texture(uMask, uvSrc).r;
    float mb = texture(uMaskBlur, uvSrc).r;

    // Feathered alpha from blurred mask (edge softness)
    float alphaEdge = clamp(mb, 0.0, 1.0);
    // Slightly tighten edge to avoid bleeding
    alphaEdge = smoothstep(0.18, 0.82, alphaEdge);
    alphaEdge = mix(m, alphaEdge, clamp(uFeather, 0.0, 1.0));

    float op = clamp(uOpacity, 0.0, 1.0);
    float alpha = alphaEdge * op;

    // Optional "dense fill" mode: make the interior visually solid at high opacity
    // while keeping the feathered edge.
    if(uOpaqueFill == 1){
      // interiorMask ~= 0 on edge, ~= 1 inside
      float interiorMask = smoothstep(0.90, 0.995, mb);
      float targetAlpha = mix(alphaEdge, 1.0, interiorMask);
      alpha = targetAlpha * op;
    }

    // Premium occlusion: if a mask exists, clip the tile under selected objects.
    // The mask is in photo space, so we sample with uvSrc.
    if(uHasOcc == 1){
      float occ = texture(uOcc, uvSrc).r; // 0..1
      float o = smoothstep(0.15, 0.60, occ);
      alpha *= (1.0 - o);
    }

    if(alpha <= 0.0005){
      outColor = vec4(toSRGB(prevLin), 1.0);
      return;
    }

    // Mapping from screen pixel to plane coordinates:
    // - Default: inverse homography (fast)
    // - 3D camera (Variant B): cast a ray through the pixel and intersect with the plane z=0
    vec2 uv;
    if(uUseCam3D == 1){
      // Camera ray in camera coordinates (y-down convention)
      vec3 rayCam = uKinv * vec3(fragPx, 1.0);
      rayCam = normalize(rayCam);

      // Transform ray + camera center to world. Rwc maps world->camera, so Rcw = transpose(Rwc).
      mat3 Rcw = transpose(uRwc);
      vec3 camPosW = -(Rcw * uTwc);
      vec3 rayW = normalize(Rcw * rayCam);

      // Intersect with plane z=0 in world space
      float denom = rayW.z;
      if(abs(denom) < 1e-6){
        outColor = prev;
        return;
      }
      float s = -camPosW.z / denom;
      if(s <= 0.0){
        outColor = prev;
        return;
      }
      vec3 Pw = camPosW + rayW * s;
      uv = Pw.xy;
    }else{
      // Projective mapping: image(px) -> plane(uv)
      vec3 q = uInvH * vec3(fragPx, 1.0);
      float z = q.z;
      if(z <= 1e-5){
        outColor = prev;
        return;
      }
      float zFade = smoothstep(0.0008, 0.006, z);
      alpha *= zFade;
      if(alpha <= 0.0005){ outColor = prev; return; }
      uv = q.xy / z;
    }

    // Optional plane depth inversion (user control via negative perspective slider).
    if(uVFlip == 1){
      uv.y = uPlaneD - uv.y;
    }

    // Tile transform
    float rot = radians(uRotation);
    mat2 R = mat2(cos(rot), -sin(rot), sin(rot), cos(rot));
    vec2 tuv = R * (uv * max(uScale, 0.0001));
    // Phase lock: keep texture anchored so it does not "swim" when
    // horizon/perspective are adjusted.
    vec2 suv = fract(tuv + uPhase);
    // Flip Y for uploaded tile texture (top-left origin) while preserving repeat.
    suv.y = 1.0 - suv.y;
    vec3 tile = texture(uTile, suv).rgb;
    vec3 tileLin = toLinear(tile);

    // Photo-aware fit: modulate the material by local photo luminance
    // This helps remove the "sticker" look.
    float fit = clamp(uPhotoFit, 0.0, 1.0);
    float shade = mix(1.0, clamp(0.65 + lum * 0.75, 0.55, 1.35), fit);
    tileLin *= shade;

    // Far fade to reduce moire + add subtle atmospheric integration.
    // If depth is available, prefer it over uv.y, because the real "far" direction may be diagonal.
    float farBase = clamp(uv.y / max(uPlaneD, 1e-6), 0.0, 1.0);
    if(uHasDepth==1){
      float d = texture(uDepth, uvSrc).r; // 0..1 (normalized in AI pipeline)
      float farD = (uDepthFarHigh==1) ? d : (1.0 - d);
      // Stabilize extremes and reduce sensitivity to noisy depth.
      farBase = smoothstep(0.10, 0.95, clamp(farD, 0.0, 1.0));
    }
    float farK = farBase * clamp(uFarFade, 0.0, 1.0);
    float gray = dot(tileLin, vec3(0.2126,0.7152,0.0722));
    tileLin = mix(tileLin, vec3(gray), farK*0.15);
    tileLin = mix(tileLin, vec3(0.5) + (tileLin-vec3(0.5))*0.85, farK*0.35);

    // Depth haze: gently blend towards the photo to reduce "cutout" feeling in the distance.
    // Keep it subtle to avoid visible color shifts.
    float haze = farK * 0.14;
    tileLin = mix(tileLin, photoLin, haze);

    // Contact AO along the edge: use blurred mask halo
    float ao = clamp((mb - m) * 1.8, 0.0, 1.0);
    float aoStr = clamp(uAO, 0.0, 1.0);
    tileLin *= (1.0 - ao * (0.18 * aoStr));

    vec3 outLin;
    if(uBlendMode==1){
      // Multiply against existing content
      outLin = mix(prevLin, prevLin * tileLin, alpha);
    }else{
      // Normal
      outLin = mix(prevLin, tileLin, alpha);
    }

    outColor = vec4(toSRGB(outLin), 1.0);
  }`;

  function init(glCanvas){
    canvas = glCanvas;
    if(!_isWebGL2Supported()){
      throw new Error('WebGL2 is not supported in this browser/environment.');
    }
    // If we are re-initializing after a context restore, previously created GL
    // objects are invalid. Reset caches aggressively.
    for(const e of tileCache.values()){
      try{ if(gl && e && e.tex) gl.deleteTexture(e.tex); }catch(_){ }
    }
    tileCache.clear();
    for(const e of maskCache.values()){
      try{ if(gl && e && e.maskTex) gl.deleteTexture(e.maskTex); }catch(_){ }
      try{ if(gl && e && e.blurTex) gl.deleteTexture(e.blurTex); }catch(_){ }
    }
    maskCache.clear();

    gl = canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance'
    });
    if(!gl){
      throw new Error('Failed to create WebGL2 context.');
    }

    // Extensions / limits
    extAniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('MOZ_EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
    maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048;
    maxRbSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 2048;

    quadVao = _setupQuad();
    progCopy = _createProgram(VS, FS_COPY);
    progZone = _createProgram(VS, FS_ZONE);

    // Global state
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    // Keep upload orientation as-is (top-left). We handle Y conversion in shaders
    // to avoid double-flip issues across browsers and ImageBitmap sources.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.clearColor(0,0,0,1);
  }

  function _uploadPhoto(bitmap, w, h){
    if(!bitmap) return;
    if(photoTex){
      gl.deleteTexture(photoTex);
      photoTex = null;
    }
    photoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, photoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    try{
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    }catch(e){
      gl.bindTexture(gl.TEXTURE_2D, null);
      throw new Error('Failed to upload photo texture to WebGL.');
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    photoW = w;
    photoH = h;
  }

  function setPhoto(bitmap, w, h){
    if(!gl) return;
    if(!bitmap || !w || !h) return;
    _uploadPhoto(bitmap, w, h);
  }

  function getLimits(){
    return {maxTexSize, maxRbSize};
  }

  function resize(renderW, renderH){
    if(!gl) return;
    // Clamp to limits to avoid black outputs on mobile GPUs.
    // IMPORTANT: preserve aspect ratio to avoid visual stretching.
    const lim = Math.max(256, Math.min(maxTexSize, maxRbSize));
    let w = Math.max(1, renderW|0);
    let h = Math.max(1, renderH|0);
    if(w > lim || h > lim){
      const sc = Math.min(lim / w, lim / h);
      w = Math.max(1, Math.floor(w * sc));
      h = Math.max(1, Math.floor(h * sc));
    }
    canvas.width = w;
    canvas.height = h;
    _ensureTargets(w,h);
    gl.viewport(0,0,w,h);
  }

  function _makeTileTexture(img){
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Do not rely on global pixelStore state: Ultra stages may upload other canvases.
    // Force a consistent orientation for tile uploads to avoid sporadic flips.
    try{ gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); }catch(_){/*noop*/}
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // mipmaps for distance stability
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    try{
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      if(extAniso){
        const maxA = gl.getParameter(extAniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 4;
        gl.texParameterf(gl.TEXTURE_2D, extAniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maxA));
      }
    }catch(e){
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.deleteTexture(tex);
      throw new Error('Failed to upload tile texture to WebGL (likely CORS). Ensure Object Storage has CORS headers for this domain.');
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  function _getTileTex(url, img){
    if(tileCache.has(url)){
      const e = tileCache.get(url);
      e.ts = Date.now();
      return e.tex;
    }
    const tex = _makeTileTexture(img);
    tileCache.set(url, {tex, w: img.width||0, h: img.height||0, ts: Date.now()});
    // LRU cap
    if(tileCache.size > 18){
      const entries = [...tileCache.entries()].sort((a,b)=>a[1].ts-b[1].ts);
      for(let i=0;i<Math.max(1, tileCache.size-18);i++){
        try{ gl.deleteTexture(entries[i][1].tex); }catch(_){ }
        tileCache.delete(entries[i][0]);
      }
    }
    return tex;
  }

  function _drawPolyToCtx(tctx, poly, scaleX, scaleY){
    if(!poly || poly.length<3) return;
    tctx.moveTo(poly[0].x * scaleX, poly[0].y * scaleY);
    for(let i=1;i<poly.length;i++) tctx.lineTo(poly[i].x * scaleX, poly[i].y * scaleY);
    tctx.closePath();
  }

  function _buildMaskCanvases(zone, w, h, scaleX, scaleY){
    _maskCanvas.width = w; _maskCanvas.height = h;
    _blurCanvas.width = w; _blurCanvas.height = h;

    _maskCtx.setTransform(1,0,0,1,0,0);
    _maskCtx.clearRect(0,0,w,h);
    _maskCtx.fillStyle = '#fff';
    _maskCtx.beginPath();
    _drawPolyToCtx(_maskCtx, zone.contour, scaleX, scaleY);
    for(const c of (zone.cutouts||[])){
      if(c && c.closed && c.polygon && c.polygon.length>=3) _drawPolyToCtx(_maskCtx, c.polygon, scaleX, scaleY);
    }
    // even-odd fill to support holes
    _maskCtx.fill('evenodd');

    // Blurred mask for feather/AO.
    _blurCtx.setTransform(1,0,0,1,0,0);
    _blurCtx.clearRect(0,0,w,h);
    try{
      _blurCtx.filter = 'blur(6px)';
    }catch(_){
      // ignore
    }
    _blurCtx.drawImage(_maskCanvas, 0, 0);
    try{ _blurCtx.filter = 'none'; }catch(_){ }
  }

  function _uploadMaskTextureFromCanvas(srcCanvas, existingTex){
    let tex = existingTex;
    if(!tex){ tex = gl.createTexture(); }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    try{
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
    }catch(e){
      gl.bindTexture(gl.TEXTURE_2D, null);
      if(!existingTex) gl.deleteTexture(tex);
      throw new Error('Failed to upload mask texture to WebGL.');
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  function _getMaskTextures(key, zone, w, h, scaleX, scaleY){
    const now = Date.now();
    if(maskCache.has(key)){
      const e = maskCache.get(key);
      if(e.w===w && e.h===h){
        e.ts = now;
        return e;
      }
      // size changed => recreate
      try{ gl.deleteTexture(e.maskTex); }catch(_){ }
      try{ gl.deleteTexture(e.blurTex); }catch(_){ }
      maskCache.delete(key);
    }

    _buildMaskCanvases(zone, w, h, scaleX, scaleY);
    const maskTex = _uploadMaskTextureFromCanvas(_maskCanvas, null);
    const blurTex = _uploadMaskTextureFromCanvas(_blurCanvas, null);
    const entry = {maskTex, blurTex, w, h, ts: now};
    maskCache.set(key, entry);
    // LRU cap
    if(maskCache.size > 24){
      const entries = [...maskCache.entries()].sort((a,b)=>a[1].ts-b[1].ts);
      for(let i=0;i<Math.max(1, maskCache.size-24);i++){
        try{ gl.deleteTexture(entries[i][1].maskTex); }catch(_){ }
        try{ gl.deleteTexture(entries[i][1].blurTex); }catch(_){ }
        maskCache.delete(entries[i][0]);
      }
    }
    return entry;
  }

  function _mat3FromArray9(a){
    // GLSL expects column-major. Our editor homography is row-major.
    // Convert row-major [r0 r1 r2 r3 r4 r5 r6 r7 r8] -> column-major float[9]
    return new Float32Array([
      a[0], a[3], a[6],
      a[1], a[4], a[7],
      a[2], a[5], a[8]
    ]);
  }

  function _invert3x3(m){
    const a=m[0], b=m[1], c=m[2],
          d=m[3], e=m[4], f=m[5],
          g=m[6], h=m[7], i=m[8];
    const A=e*i-f*h, B=-(d*i-f*g), C=d*h-e*g;
    const D=-(b*i-c*h), E=a*i-c*g, F=-(a*h-b*g);
    const G=b*f-c*e, H=-(a*f-c*d), I=a*e-b*d;
    const det=a*A + b*B + c*C;
    if(!isFinite(det) || Math.abs(det) < 1e-12) return null;
    const invDet=1/det;
    return [A*invDet, D*invDet, G*invDet,
            B*invDet, E*invDet, H*invDet,
            C*invDet, F*invDet, I*invDet];
  }


function _mul3x3(a,b){
  // row-major 3x3 multiplication: a*b
  return [
    a[0]*b[0]+a[1]*b[3]+a[2]*b[6], a[0]*b[1]+a[1]*b[4]+a[2]*b[7], a[0]*b[2]+a[1]*b[5]+a[2]*b[8],
    a[3]*b[0]+a[4]*b[3]+a[5]*b[6], a[3]*b[1]+a[4]*b[4]+a[5]*b[7], a[3]*b[2]+a[4]*b[5]+a[5]*b[8],
    a[6]*b[0]+a[7]*b[3]+a[8]*b[6], a[6]*b[1]+a[7]*b[4]+a[8]*b[7], a[6]*b[2]+a[7]*b[5]+a[8]*b[8]
  ];
}

function _decomposeHomographyToRT(H, K){
  // Decompose planar homography into world->camera rotation + translation.
  // H: row-major array9 mapping plane (X,Y,1) -> pixel (x,y,w)
  // K: {f,cx,cy} in the SAME pixel space as H (render buffer coords, y-down)
  if(!H || !K) return null;
  const f = +K.f, cx = +K.cx, cy = +K.cy;
  if(!isFinite(f) || f <= 2) return null;

  // K^{-1} for canonical K = [[f,0,cx],[0,f,cy],[0,0,1]]
  const Kinv = [
    1/f, 0, -cx/f,
    0, 1/f, -cy/f,
    0, 0, 1
  ];

  const B = _mul3x3(Kinv, H);
  const b1 = [B[0],B[3],B[6]];
  const b2 = [B[1],B[4],B[7]];
  const b3 = [B[2],B[5],B[8]];
  const n1 = Math.hypot(b1[0],b1[1],b1[2]);
  const n2 = Math.hypot(b2[0],b2[1],b2[2]);
  if(!isFinite(n1) || !isFinite(n2) || n1 < 1e-9 || n2 < 1e-9) return null;

  const s = 2 / (n1 + n2); // scale factor (average normalization)
  let r1 = [b1[0]*s, b1[1]*s, b1[2]*s];
  let r2 = [b2[0]*s, b2[1]*s, b2[2]*s];

  // Orthonormalize r2 against r1 (Gram-Schmidt)
  const d12 = r1[0]*r2[0] + r1[1]*r2[1] + r1[2]*r2[2];
  r2 = [r2[0]-d12*r1[0], r2[1]-d12*r1[1], r2[2]-d12*r1[2]];
  const nr2 = Math.hypot(r2[0],r2[1],r2[2]);
  if(!isFinite(nr2) || nr2 < 1e-9) return null;
  r2 = [r2[0]/nr2, r2[1]/nr2, r2[2]/nr2];

  // r3 = r1 x r2
  let r3 = [
    r1[1]*r2[2] - r1[2]*r2[1],
    r1[2]*r2[0] - r1[0]*r2[2],
    r1[0]*r2[1] - r1[1]*r2[0]
  ];
  const nr3 = Math.hypot(r3[0],r3[1],r3[2]);
  if(!isFinite(nr3) || nr3 < 1e-9) return null;
  r3 = [r3[0]/nr3, r3[1]/nr3, r3[2]/nr3];

  let t = [b3[0]*s, b3[1]*s, b3[2]*s];

  // Ensure the plane is in front of the camera (positive z in camera space).
  // If not, flip the solution.
  if(t[2] < 0){
    r1 = [-r1[0],-r1[1],-r1[2]];
    r2 = [-r2[0],-r2[1],-r2[2]];
    r3 = [-r3[0],-r3[1],-r3[2]];
    t  = [-t[0], -t[1], -t[2]];
  }

  const R = [
    r1[0], r2[0], r3[0],
    r1[1], r2[1], r3[1],
    r1[2], r2[2], r3[2]
  ]; // row-major (rows are camera axes in world coords?) consistent with Xc = R*Xw + t

  return {Kinv, R, t};
}

  // ---------------------------------------------------------------------------
  // Camera-first geometry model (Global Anti-Rubber):
  // - Plane coordinates are metric (from contour-derived quad W,D).
  // - User "horizon" and "perspective" control ONLY camera (pitch + focal length).
  // - UV metric never depends on horizon/perspective (prevents rubber stretching).
  // ---------------------------------------------------------------------------

  function _estimateFocalFromHomography(H, cx, cy, w, h){
    if(!H) return null;
    const maxDim = Math.max(1, w|0, h|0);
    const fMin = 0.40 * maxDim;
    const fMax = 3.50 * maxDim;

    function score(f){
      if(!isFinite(f) || f <= 2) return 1e30;
      const invF = 1.0 / f;
      const Kinv = [
        invF, 0, -cx*invF,
        0, invF, -cy*invF,
        0, 0, 1
      ];
      const B = _mul3x3(Kinv, H);
      const b1 = [B[0], B[3], B[6]];
      const b2 = [B[1], B[4], B[7]];
      const n1 = Math.hypot(b1[0], b1[1], b1[2]);
      const n2 = Math.hypot(b2[0], b2[1], b2[2]);
      if(!isFinite(n1) || !isFinite(n2) || n1 < 1e-9 || n2 < 1e-9) return 1e30;
      const dot = b1[0]*b2[0] + b1[1]*b2[1] + b1[2]*b2[2];
      const dn = (n1 - n2);
      return dot*dot + dn*dn;
    }

    // Coarse log-space scan
    let bestF = null;
    let bestS = Infinity;
    const n = 34;
    const logMin = Math.log(fMin);
    const logMax = Math.log(fMax);
    for(let i=0;i<n;i++){
      const t = i/(n-1);
      const f = Math.exp(logMin + (logMax-logMin)*t);
      const s = score(f);
      if(s < bestS){
        bestS = s;
        bestF = f;
      }
    }
    if(!bestF || !isFinite(bestF)) return null;

    // Local refine in log-space (ternary)
    let lo = Math.max(fMin, bestF/1.6);
    let hi = Math.min(fMax, bestF*1.6);
    for(let it=0; it<18; it++){
      const f1 = Math.exp((2*Math.log(lo) + Math.log(hi))/3);
      const f2 = Math.exp((Math.log(lo) + 2*Math.log(hi))/3);
      const s1 = score(f1);
      const s2 = score(f2);
      if(s1 < s2) hi = f2;
      else lo = f1;
    }
    const fFinal = Math.sqrt(lo*hi);
    return isFinite(fFinal) ? fFinal : bestF;
  }

  function _rotX(rad){
    const c = Math.cos(rad), s = Math.sin(rad);
    return [
      1,0,0,
      0,c,-s,
      0,s,c
    ];
  }

  function _applyPitchToCam(cam, pitchRad){
    if(!cam || !cam.R || !cam.t) return cam;
    const Rx = _rotX(pitchRad);
    const Rn = _mul3x3(Rx, cam.R);
    const t = cam.t;
    const tn = [
      Rx[0]*t[0] + Rx[1]*t[1] + Rx[2]*t[2],
      Rx[3]*t[0] + Rx[4]*t[1] + Rx[5]*t[2],
      Rx[6]*t[0] + Rx[7]*t[1] + Rx[8]*t[2],
    ];
    return {Kinv: cam.Kinv, R: Rn, t: tn};
  }

  function _planePointFromCamPixel(cam, x, y){
    if(!cam || !cam.Kinv || !cam.R || !cam.t) return {x:0,y:0,ok:false};
    const KinvA = cam.Kinv;
    let rx = KinvA[0]*x + KinvA[1]*y + KinvA[2];
    let ry = KinvA[3]*x + KinvA[4]*y + KinvA[5];
    let rz = KinvA[6]*x + KinvA[7]*y + KinvA[8];
    const rlen = Math.hypot(rx, ry, rz) || 1.0;
    rx/=rlen; ry/=rlen; rz/=rlen;

    const RwcA = cam.R;
    const Rcw00 = RwcA[0], Rcw01 = RwcA[3], Rcw02 = RwcA[6];
    const Rcw10 = RwcA[1], Rcw11 = RwcA[4], Rcw12 = RwcA[7];
    const Rcw20 = RwcA[2], Rcw21 = RwcA[5], Rcw22 = RwcA[8];

    const tA = cam.t;
    const cwx = -(Rcw00*tA[0] + Rcw01*tA[1] + Rcw02*tA[2]);
    const cwy = -(Rcw10*tA[0] + Rcw11*tA[1] + Rcw12*tA[2]);
    const cwz = -(Rcw20*tA[0] + Rcw21*tA[1] + Rcw22*tA[2]);

    let rwx = (Rcw00*rx + Rcw01*ry + Rcw02*rz);
    let rwy = (Rcw10*rx + Rcw11*ry + Rcw12*rz);
    let rwz = (Rcw20*rx + Rcw21*ry + Rcw22*rz);
    const rwlen = Math.hypot(rwx, rwy, rwz) || 1.0;
    rwx/=rwlen; rwy/=rwlen; rwz/=rwlen;

    const denom = rwz;
    if(Math.abs(denom) < 1e-6) return {x:0,y:0,ok:false};
    const sRay = -cwz / denom;
    if(!(sRay > 0.0)) return {x:0,y:0,ok:false};
    return {x: cwx + rwx*sRay, y: cwy + rwy*sRay, ok:true};
  }

  function _localMetersPerPixel(cam, ax, ay){
    const p0 = _planePointFromCamPixel(cam, ax, ay);
    if(!p0.ok) return null;
    const px = _planePointFromCamPixel(cam, ax+1.0, ay);
    const py = _planePointFromCamPixel(cam, ax, ay+1.0);
    if(!px.ok || !py.ok) return null;
    const dx = Math.hypot(px.x - p0.x, px.y - p0.y);
    const dy = Math.hypot(py.x - p0.x, py.y - p0.y);
    if(!isFinite(dx) || !isFinite(dy) || dx < 1e-9 || dy < 1e-9) return null;
    return Math.sqrt(dx*dy);
  }


  function _localAnisoInfo(cam, ax, ay){
    const p0 = _planePointFromCamPixel(cam, ax, ay);
    if(!p0.ok) return null;
    const px = _planePointFromCamPixel(cam, ax+1.0, ay);
    const py = _planePointFromCamPixel(cam, ax, ay+1.0);
    if(!px.ok || !py.ok) return null;
    const dx = Math.hypot(px.x - p0.x, px.y - p0.y);
    const dy = Math.hypot(py.x - p0.x, py.y - p0.y);
    if(!isFinite(dx) || !isFinite(dy) || dx < 1e-9 || dy < 1e-9) return null;
    const ratio = dx / dy;
    return {dx, dy, ratio};
  }


  function _homographyRectToQuad(q, srcW, srcH){
    // q: 4 points in render-pixel coords in order: nearL, nearR, farR, farL
    // srcW/srcH: plane rectangle size in UV units
    const W = Math.max(1e-6, +srcW || 1.0);
    const H = Math.max(1e-6, +srcH || 1.0);
    const src = [[0,0],[W,0],[W,H],[0,H]];
    const A = []; const B = [];
    for(let k=0;k<4;k++){
      const u=src[k][0], v=src[k][1];
      const x=q[k].x, y=q[k].y;
      A.push([u,v,1, 0,0,0, -u*x, -v*x]); B.push(x);
      A.push([0,0,0, u,v,1, -u*y, -v*y]); B.push(y);
    }
    const n=8;
    for(let col=0; col<n; col++){
      let pivot=col;
      for(let r=col+1;r<n;r++) if(Math.abs(A[r][col])>Math.abs(A[pivot][col])) pivot=r;
      if(Math.abs(A[pivot][col])<1e-12) return null;
      if(pivot!==col){
        const tmp=A[col];A[col]=A[pivot];A[pivot]=tmp;
        const tb=B[col];B[col]=B[pivot];B[pivot]=tb;
      }
      const div=A[col][col];
      for(let c2=col;c2<n;c2++) A[col][c2]/=div;
      B[col]/=div;
      for(let r=0;r<n;r++){
        if(r===col) continue;
        const factor=A[r][col];
        if(Math.abs(factor)<1e-12) continue;
        for(let c2=col;c2<n;c2++) A[r][c2]-=factor*A[col][c2];
        B[r]-=factor*B[col];
      }
    }
    const h=B;
    return [h[0],h[1],h[2], h[3],h[4],h[5], h[6],h[7],1];
  }

  function _homographyUnitSquareToQuad(q){
    return _homographyRectToQuad(q, 1.0, 1.0);
  }

  function _quadSignedArea(q){
    let a=0;
    for(let i=0;i<4;i++){
      const p=q[i], n=q[(i+1)%4];
      a += (p.x*n.y - n.x*p.y);
    }
    return a/2;
  }

  function _normalizeQuad(q){
    if(!q || q.length!==4) return null;
    const area=_quadSignedArea(q);
    if(!isFinite(area) || Math.abs(area) < 1e-3) return null;
    if(area < 0) return [q[0],q[3],q[2],q[1]];
    return q;
  }

  
function _inferQuadFromContour(contour, params, w, h, lockExtrema){
  // Robust quad inference for "floor plane" from an arbitrary closed contour.
  // Goal: produce a stable quad even while the user drags points.
  // Strategy:
  // 1) Build convex hull.
  // 2) Intersect hull with two horizontal scanlines (yNear/yFar) to obtain left/right points.
  // 3) Apply gentle user controls (perspective + horizon) without changing topology.
  // Output order: nearL, nearR, farR, farL in render-pixel coords.

  if(!contour || contour.length < 3) return null;

  // Convex hull (monotonic chain)
  const pts = contour.map(p=>({x:+p.x, y:+p.y})).filter(p=>isFinite(p.x)&&isFinite(p.y));
  if(pts.length < 3) return null;
  pts.sort((a,b)=> (a.x===b.x ? a.y-b.y : a.x-b.x));
  const cross=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
  const lower=[];
  for(const p of pts){
    while(lower.length>=2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper=[];
  for(let i=pts.length-1;i>=0;i--){
    const p=pts[i];
    while(upper.length>=2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop(); lower.pop();
  const hull = lower.concat(upper);
  if(hull.length < 3) return null;

  // Close hull for edge iteration
  const poly = hull.concat([hull[0]]);

  const ys = hull.map(p=>p.y);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  // Optional drag-stabilization: keep extrema fixed during a drag gesture.
  if(lockExtrema && isFinite(lockExtrema.yMin) && isFinite(lockExtrema.yMax)){
    const dyLock = lockExtrema.yMax - lockExtrema.yMin;
    if(isFinite(dyLock) && dyLock > 2){
      yMin = lockExtrema.yMin;
      yMax = lockExtrema.yMax;
    }
  }
  const dy = yMax - yMin;
  if(!isFinite(dy) || dy < 2) return null;

  // Patch 3.1: AI-guided quad inference with confidence mixing.
  // We always compute a stable default quad (horizontal scanlines),
  // then (optionally) compute an AI-oriented quad and blend between them.
  // This makes the effect observable while remaining safe: low confidence => near-zero influence.

  let nearL = null, nearR = null, farL = null, farR = null;
  let usedAi = false;

  // Default: scanlines slightly inside the hull to avoid vertex-only intersections.
  const inset = Math.max(4, dy * 0.12);
  let yNear = yMax - inset;
  let yFar  = yMin + inset;
  if(yNear <= yFar + 1) {
    yNear = yMax - Math.max(2, dy*0.25);
    yFar  = yMin + Math.max(2, dy*0.25);
    if(yNear <= yFar + 1) return null;
  }

  function xRangeAtY(y){
    const xs = [];
    for(let i=0;i<poly.length-1;i++){
      const a=poly[i], b=poly[i+1];
      // Skip horizontal edges
      if(Math.abs(b.y - a.y) < 1e-9) continue;
      const y0=a.y, y1=b.y;
      const ymin=Math.min(y0,y1), ymax=Math.max(y0,y1);
      // Strict-ish containment to reduce double-hits at vertices
      if(y < ymin || y > ymax) continue;
      const t = (y - a.y) / (b.y - a.y);
      if(t < 0 || t > 1) continue;
      const x = a.x + t*(b.x - a.x);
      if(isFinite(x)) xs.push(x);
    }
    if(xs.length < 2) return null;
    xs.sort((p,q)=>p-q);
    return {min: xs[0], max: xs[xs.length-1]};
  }

  let rNear = xRangeAtY(yNear);
  let rFar  = xRangeAtY(yFar);

  // If we miss due to numeric edge cases, relax inset
  if(!rNear || !rFar){
    const inset2 = Math.max(2, dy * 0.06);
    yNear = yMax - inset2;
    yFar  = yMin + inset2;
    rNear = xRangeAtY(yNear);
    rFar  = xRangeAtY(yFar);
    if(!rNear || !rFar) return null;
  }

  // Baseline (default) endpoints
  const baseNearL = {x: rNear.min, y: yNear};
  const baseNearR = {x: rNear.max, y: yNear};
  const baseFarL  = {x: rFar.min,  y: yFar};
  const baseFarR  = {x: rFar.max,  y: yFar};

  // Optional AI quad (near/far cuts along dominant plane direction).
  let aiNearL=null, aiNearR=null, aiFarL=null, aiFarR=null;
  let aiMix = 0;

  try{
    const aiDirN = params && params._aiPlaneDir ? params._aiPlaneDir : null;
    const aiConf = params && isFinite(params._aiConfidence) ? params._aiConfidence : 0;
    aiMix = params && isFinite(params._aiMix) ? params._aiMix : smoothstep(0.18, 0.55, aiConf);

    if(aiDirN && aiMix > 0.001 && isFinite(aiDirN.x) && isFinite(aiDirN.y)){
      // aiDirN is already normalized in image space with aspect compensation applied
      // by the AI pipeline; do not rescale by photoW/photoH (avoids accidental 90°/flip artifacts).
      const dxp = aiDirN.x;
      const dyp = aiDirN.y;
      let dm = Math.hypot(dxp, dyp);
      if(isFinite(dm) && dm > 1e-6){
        const d = { x: dxp/dm, y: dyp/dm };
        const nrm = { x: -d.y, y: d.x }; // perpendicular (across)

        // Project hull to find near/far extents along d.
        let tMin = Infinity, tMax = -Infinity;
        for(const p of hull){
          const t = p.x*d.x + p.y*d.y;
          if(t < tMin) tMin = t;
          if(t > tMax) tMax = t;
        }
        const dt = tMax - tMin;
        if(isFinite(dt) && dt > 6){
          const insetT = Math.max(4, dt * 0.12);
          let tNear = tMax - insetT;
          let tFar  = tMin + insetT;
          if(tNear <= tFar + 1){
            tNear = tMax - Math.max(2, dt*0.25);
            tFar  = tMin + Math.max(2, dt*0.25);
          }

          function segAtT(t){
            const ips = [];
            for(let i=0;i<poly.length-1;i++){
              const a=poly[i], b=poly[i+1];
              const da = (a.x*d.x + a.y*d.y) - t;
              const db = (b.x*d.x + b.y*d.y) - t;
              if((da > 0 && db > 0) || (da < 0 && db < 0)) continue;
              const denom = (da - db);
              if(Math.abs(denom) < 1e-9) continue;
              const u = da / denom;
              if(u < 0 || u > 1) continue;
              const x = a.x + u*(b.x - a.x);
              const y = a.y + u*(b.y - a.y);
              if(isFinite(x) && isFinite(y)) ips.push({x,y});
            }
            if(ips.length < 2) return null;
            ips.sort((p,q)=> (p.x*nrm.x + p.y*nrm.y) - (q.x*nrm.x + q.y*nrm.y));
            return { min: ips[0], max: ips[ips.length-1] };
          }

          let sNear = segAtT(tNear);
          let sFar  = segAtT(tFar);

          // Relax inset if needed
          if(!sNear || !sFar){
            const inset2 = Math.max(2, dt * 0.06);
            tNear = tMax - inset2;
            tFar  = tMin + inset2;
            sNear = segAtT(tNear);
            sFar  = segAtT(tFar);
          }

          if(sNear && sFar){
            // Stabilize near/far assignment to avoid vertical inversion.
            // In image coordinates (y grows downward), the near edge of the ground plane
            // is typically lower than the far edge. When the direction sign is ambiguous,
            // the two cuts can swap and the homography flips V (texture appears upside-down).
            const midYN = (sNear.min.y + sNear.max.y) * 0.5;
            const midYF = (sFar.min.y + sFar.max.y) * 0.5;
            if(isFinite(midYN) && isFinite(midYF) && midYN < midYF){
              const tmp = sNear; sNear = sFar; sFar = tmp;
            }

            aiNearL = {x: sNear.min.x, y: sNear.min.y};
            aiNearR = {x: sNear.max.x, y: sNear.max.y};
            aiFarL  = {x: sFar.min.x,  y: sFar.min.y};
            aiFarR  = {x: sFar.max.x,  y: sFar.max.y};
          }
        }
      }
    }
  }catch(_){ /* no-op */ }


  // Patch A: Quad Alignment Guard (deterministic, prevents premium inversion/rotation)
  // AI-derived cuts can be ambiguous in sign (near/far) and across-order (left/right) depending on cues.
  // We enumerate consistent permutations and pick the one that best matches the baseline quad topology.
  let _quadGuard = null;
  if(aiNearL && aiNearR && aiFarL && aiFarR){
    const baseQuad = [baseNearL, baseNearR, baseFarR, baseFarL]; // nearL, nearR, farR, farL

    const signedArea = (q)=>{
      let a = 0;
      for(let i=0;i<4;i++){
        const p0=q[i], p1=q[(i+1)%4];
        a += (p0.x*p1.y - p1.x*p0.y);
      }
      return a * 0.5;
    };

    const isConvex = (q)=>{
      let sign = 0;
      for(let i=0;i<4;i++){
        const a=q[i], b=q[(i+1)%4], c=q[(i+2)%4];
        const cross = (b.x-a.x)*(c.y-b.y) - (b.y-a.y)*(c.x-b.x);
        if(!isFinite(cross) || Math.abs(cross) < 1e-6) continue;
        const s = cross > 0 ? 1 : -1;
        if(sign===0) sign = s;
        else if(s !== sign) return false;
      }
      return true;
    };

    const dist2 = (q0,q1)=>{
      let d=0;
      for(let i=0;i<4;i++){
        const dx = (q0[i].x - q1[i].x);
        const dy = (q0[i].y - q1[i].y);
        d += dx*dx + dy*dy;
      }
      return d;
    };

    const baseSign = Math.sign(signedArea(baseQuad)) || 1;

    let best = null;
    let bestScore = Infinity;

    // Enumerate 8 permutations: swap near L/R, swap far L/R, swap near<->far pairs.
    for(let ns=0; ns<2; ns++){
      for(let fs=0; fs<2; fs++){
        for(let nfs=0; nfs<2; nfs++){
          let nL = ns ? aiNearR : aiNearL;
          let nR = ns ? aiNearL : aiNearR;
          let fL = fs ? aiFarR  : aiFarL;
          let fR = fs ? aiFarL  : aiFarR;
          if(nfs){
            const tnL=nL, tnR=nR;
            nL=fL; nR=fR;
            fL=tnL; fR=tnR;
          }

          const q = [nL, nR, fR, fL];

          // Hard constraints + penalties
          let penalty = 0;

          // Non-degenerate widths
          if(Math.hypot(nR.x-nL.x, nR.y-nL.y) < 2 || Math.hypot(fR.x-fL.x, fR.y-fL.y) < 2) penalty += 1e8;

          // Near should be below far in image coords (y grows downward)
          const ny = (nL.y+nR.y)*0.5;
          const fy = (fL.y+fR.y)*0.5;
          if(!(isFinite(ny)&&isFinite(fy))) penalty += 1e8;
          else if(ny < fy) penalty += 1e7;

          // Convexity
          if(!isConvex(q)) penalty += 1e6;

          // Winding consistency with baseline
          const sgn = Math.sign(signedArea(q)) || 1;
          if(sgn !== baseSign) penalty += 1e5;

          const score = dist2(q, baseQuad) + penalty;
          if(score < bestScore){
            bestScore = score;
            best = {q, ns, fs, nfs, score, penalty};
          }
        }
      }
    }

        if(best && isFinite(bestScore) && bestScore < Infinity){
      // best.q is [nearL, nearR, farR, farL]
      aiNearL = {x: best.q[0].x, y: best.q[0].y};
      aiNearR = {x: best.q[1].x, y: best.q[1].y};
      aiFarR  = {x: best.q[2].x, y: best.q[2].y};
      aiFarL  = {x: best.q[3].x, y: best.q[3].y};
      _quadGuard = { ns: best.ns, fs: best.fs, nfs: best.nfs, score: best.score, penalty: best.penalty };
    }
  }

  // Blend baseline and AI quad (if available)
  if(aiNearL && aiNearR && aiFarL && aiFarR && aiMix > 0.001){
    nearL = {x: lerp(baseNearL.x, aiNearL.x, aiMix), y: lerp(baseNearL.y, aiNearL.y, aiMix)};
    nearR = {x: lerp(baseNearR.x, aiNearR.x, aiMix), y: lerp(baseNearR.y, aiNearR.y, aiMix)};
    farL  = {x: lerp(baseFarL.x,  aiFarL.x,  aiMix), y: lerp(baseFarL.y,  aiFarL.y,  aiMix)};
    farR  = {x: lerp(baseFarR.x,  aiFarR.x,  aiMix), y: lerp(baseFarR.y,  aiFarR.y,  aiMix)};
    usedAi = true;

    // Expose quad-guard decision for the AI debug overlay (only when enabled).
    try{
      const st = window.PhotoPaveState && window.PhotoPaveState.state;
      if(st && st.ai && st.ai.debugOverlay){
        if(_quadGuard){
          st.ai._quadGuard = `ns=${_quadGuard.ns} fs=${_quadGuard.fs} nf=${_quadGuard.nfs}`;
        }else{
          st.ai._quadGuard = null;
        }
      }
    }catch(_){/*noop*/}
  }else{
    nearL = baseNearL; nearR = baseNearR; farL = baseFarL; farR = baseFarR;
    usedAi = false;
  }


  // Final safety: ensure near edge is below far edge in image coordinates (y grows downward).
  // This blocks rare vertical homography flips that manifest as an upside-down tile projection.
  const _ny = (nearL.y + nearR.y) * 0.5;
  const _fy = (farL.y + farR.y) * 0.5;
  if(isFinite(_ny) && isFinite(_fy) && _ny < _fy){
    const _tL = nearL; nearL = farL; farL = _tL;
    const _tR = nearR; nearR = farR; farR = _tR;
  }

// Guard against super-thin quads
  if(Math.abs(nearR.x - nearL.x) < 2 || Math.abs(farR.x - farL.x) < 2) return null;

  
  // Metric-lock snapshot BEFORE applying user horizon/perspective controls.
  // We will keep the UV-plane size stable (W,D) regardless of horizon/perspective,
  // so the tile geometry does not "rubber-stretch" when the user tunes the camera feel.
  const _mNearL = {x: nearL.x, y: nearL.y};
  const _mNearR = {x: nearR.x, y: nearR.y};
  const _mFarL  = {x: farL.x,  y: farL.y};
  const _mFarR  = {x: farR.x,  y: farR.y};
// User controls (Global CamPlane contract):
  // IMPORTANT: To eliminate "rubber" texture deformation, we must NOT deform the inferred quad
  // with horizon/perspective here. These sliders are applied later as camera parameters only
  // (pitch / focal). The quad remains purely contour-derived and bottom->up stable.
  const persp = Math.abs(clamp(params?.perspective ?? 0.75, -1, 1)); // kept for downstream camera mapping only
  const horizon = clamp(params?.horizon ?? 0.0, -1, 1);

  const cx = (nearL.x + nearR.x) * 0.5;
  const dyH = horizon * 0.22 * (photoH||h||1);
  farL.y += dyH; farR.y += dyH;

  const conv = Math.max(0, Math.min(0.35, (-horizon)*0.25));
  farL.x = farL.x + (cx - farL.x) * conv;
  farR.x = farR.x + (cx - farR.x) * conv;

  // Ensure far remains "in front" of near along the inferred depth direction.
  // Default behavior uses image-space Y (y grows downward). For AI-guided quads, use projection on ai direction.
  if(usedAi && params && params._aiPlaneDir && isFinite(params._aiPlaneDir.x) && isFinite(params._aiPlaneDir.y)){
    // _aiPlaneDir is already in image space; keep it unit-length in the same metric as contour points.
    const dxp = params._aiPlaneDir.x;
    const dyp = params._aiPlaneDir.y;
    let dm = Math.hypot(dxp, dyp);
    if(isFinite(dm) && dm > 1e-6){
      const d = { x: dxp/dm, y: dyp/dm };
      const tNear = ((nearL.x*d.x + nearL.y*d.y) + (nearR.x*d.x + nearR.y*d.y)) * 0.5;
      const tFar  = ((farL.x*d.x  + farL.y*d.y)  + (farR.x*d.x  + farR.y*d.y)) * 0.5;
      if(tFar >= tNear - 1){
        const push = (tFar - (tNear - 1)) + 1;
        farL.x -= d.x * push; farL.y -= d.y * push;
        farR.x -= d.x * push; farR.y -= d.y * push;
      }
    }
  }else{
    // Ensure far stays above near in image-space (y grows downward)
    if(farL.y >= nearL.y - 1 || farR.y >= nearR.y - 1) {
      // clamp far y just above near to keep valid ordering
      const fy = Math.min(nearL.y, nearR.y) - 1;
      farL.y = Math.min(farL.y, fy);
      farR.y = Math.min(farR.y, fy);
    }
  }


  // Horizon safety: avoid near-singular / folded quads when horizon is pushed far (causes a visible seam and mirrored texture).
  // We clamp effective horizon influence so that the quad remains convex and sufficiently well-conditioned.
  function _quadIsWellConditioned(nL,nR,fR,fL){
    const nearW = Math.hypot(nR.x-nL.x, nR.y-nL.y);
    const farW  = Math.hypot(fR.x-fL.x, fR.y-fL.y);
    if(!isFinite(nearW) || !isFinite(farW)) return false;
    if(nearW < 4 || farW < 4) return false;
    if(farW/nearW < 0.10) return false;
    const p=[nL,nR,fR,fL];
    let sign=0;
    for(let i=0;i<4;i++){
      const a=p[i], b=p[(i+1)%4], c=p[(i+2)%4];
      const cross = (b.x-a.x)*(c.y-b.y) - (b.y-a.y)*(c.x-b.x);
      if(Math.abs(cross) < 1e-6) continue;
      const s = cross>0 ? 1 : -1;
      if(sign===0) sign=s;
      else if(s!==sign) return false;
    }
    return true;
  }

  if(!_quadIsWellConditioned(nearL, nearR, farR, farL)){
    const h0 = horizon;
    // baseline far points with "mild" applied but without horizon shift/convergence
    const baseFarL = { x: nearL.x + (rFar.min - rNear.min)*mild, y: nearL.y + (yFar - nearL.y)*mild };
    const baseFarR = { x: nearR.x + (rFar.max - rNear.max)*mild, y: nearR.y + (yFar - nearR.y)*mild };

    let lo = 0.0, hi = 1.0;
    for(let it=0; it<14; it++){
      const t = (lo+hi)*0.5;

      let fL = {x: baseFarL.x, y: baseFarL.y};
      let fR = {x: baseFarR.x, y: baseFarR.y};

      const dy = (h0 * t) * 0.22 * (photoH||h||1);
      fL.y += dy; fR.y += dy;

      const cconv = Math.max(0, Math.min(0.35, (-(h0*t))*0.25));
      fL.x = fL.x + (cx - fL.x) * cconv;
      fR.x = fR.x + (cx - fR.x) * cconv;

      if(fL.y >= nearL.y - 1 || fR.y >= nearR.y - 1){
        const fy = Math.min(nearL.y, nearR.y) - 1;
        fL.y = Math.min(fL.y, fy);
        fR.y = Math.min(fR.y, fy);
      }

      if(_quadIsWellConditioned(nearL, nearR, fR, fL)){
        lo = t; farL = fL; farR = fR;
      }else{
        hi = t;
      }
    }
  }
  // Map to render pixels (scale from photo px to render px)
  const sx = w / Math.max(1, photoW);
  const sy = h / Math.max(1, photoH);

  const quad = [
    {x: nearL.x*sx, y: nearL.y*sy},
    {x: nearR.x*sx, y: nearR.y*sy},
    {x: farR.x*sx,  y: farR.y*sy},
    {x: farL.x*sx,  y: farL.y*sy}
  ];

  // Stable plane metric in UV units (render-pixel derived):
  // W = near edge length, D = depth from near-mid to far-mid (both in render coords).
  const _mw = Math.hypot((_mNearR.x-_mNearL.x)*sx, (_mNearR.y-_mNearL.y)*sy);
  const _mnx = (_mNearL.x + _mNearR.x) * 0.5;
  const _mny = (_mNearL.y + _mNearR.y) * 0.5;
  const _mfx = (_mFarL.x  + _mFarR.x)  * 0.5;
  const _mfy = (_mFarL.y  + _mFarR.y)  * 0.5;
  const _md = Math.hypot((_mfx-_mnx)*sx, (_mfy-_mny)*sy);

  const metric = { W: Math.max(1.0, _mw), D: Math.max(1.0, _md) };
  return { quad, metric };
}

function _blendModeId(blend){
    const s = String(blend||'').toLowerCase();
    if(s==='multiply') return 1;
    return 0;
  }

  function _bindTex(unit, tex){
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  function _renderCopy(srcTex, dstRT, flipY){
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstRT ? dstRT.fbo : null);
    gl.viewport(0,0, (dstRT?dstRT.w:canvas.width), (dstRT?dstRT.h:canvas.height));
    gl.useProgram(progCopy);
    gl.bindVertexArray(quadVao.vao);
    _bindTex(0, srcTex);
    gl.uniform1i(gl.getUniformLocation(progCopy, 'uTex'), 0);
    gl.uniform1i(gl.getUniformLocation(progCopy, 'uFlipY'), flipY ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  function _renderZonePass(prevTex, dstRT, zone, tileTex, maskEntry, invHArr9, planeMetric, ai, cam3d, cam3dRef, anchorPx){
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstRT.fbo);
    gl.viewport(0,0,dstRT.w,dstRT.h);
    gl.useProgram(progZone);
    gl.bindVertexArray(quadVao.vao);

    const locRes = gl.getUniformLocation(progZone, 'uResolution');
    gl.uniform2f(locRes, dstRT.w, dstRT.h);

    // Textures
    _bindTex(0, prevTex);
    _bindTex(1, photoTex);
    _bindTex(2, tileTex);
    _bindTex(3, maskEntry.maskTex);
    _bindTex(4, maskEntry.blurTex);
    // Optional AI depth texture (Patch 4): used for far fade/haze only.
    const hasDepth = !!aiDepthTex && !!(ai && ai.depthMap && ai.depthMap.canvas);
    _bindTex(5, hasDepth ? aiDepthTex : photoTex);

    // Optional occlusion mask (Patch 4): clip tile under objects.
    const hasOcc = !!aiOccTex && !!(ai && ai.occlusionMask && ai.occlusionMask.canvas) && !(ai && ai.occlusionEnabled === false);
    _bindTex(6, hasOcc ? aiOccTex : photoTex);
    gl.uniform1i(gl.getUniformLocation(progZone,'uPrev'), 0);
    gl.uniform1i(gl.getUniformLocation(progZone,'uPhoto'), 1);
    gl.uniform1i(gl.getUniformLocation(progZone,'uTile'), 2);
    gl.uniform1i(gl.getUniformLocation(progZone,'uMask'), 3);
    gl.uniform1i(gl.getUniformLocation(progZone,'uMaskBlur'), 4);
    gl.uniform1i(gl.getUniformLocation(progZone,'uDepth'), 5);
    gl.uniform1i(gl.getUniformLocation(progZone,'uHasDepth'), hasDepth ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(progZone,'uDepthFarHigh'), (hasDepth && ai && ai.depthFarHigh === false) ? 0 : 1);

    gl.uniform1i(gl.getUniformLocation(progZone,'uOcc'), 6);
    gl.uniform1i(gl.getUniformLocation(progZone,'uHasOcc'), hasOcc ? 1 : 0);

    // Params
    const params = zone.material?.params || {};
    const opaqueFill = !!params.opaqueFill;
    // Bottom->Up invariant (all modes): depth inversion is disabled.
    const vflip = 0;
    gl.uniform1i(gl.getUniformLocation(progZone,'uVFlip'), 0);
    gl.uniform1i(gl.getUniformLocation(progZone,'uOpaqueFill'), (opaqueFill ? 1 : 0));
    // Metric-lock: map plane UV in stable world units (derived from contour) to avoid tile deformation
    const planeW = Math.max(1e-6, (planeMetric && isFinite(planeMetric.W)) ? planeMetric.W : 1.0);
    const planeD = Math.max(1e-6, (planeMetric && isFinite(planeMetric.D)) ? planeMetric.D : 1.0);
    gl.uniform1f(gl.getUniformLocation(progZone,'uPlaneD'), planeD);
    // Keep the "scale" slider semantics: approximately number of repeats across the near edge.
// Global Anti-Rubber: additionally apply an anchor-scale lock so adjusting camera
// (horizon/perspective) does not change tile *geometry* near the bottom.
// This is a uniform correction (no anisotropic scale).
    const baseScaleAcross = (params.scale ?? 1.0);
    let scaleEff = Math.max(0.0001, baseScaleAcross / planeW);

    // Anchor-scale lock (optional but enabled by default when camera model is available)
    let scaleComp = 1.0;
    try{
      const ax = (anchorPx && isFinite(anchorPx.x)) ? anchorPx.x : null;
      const ay = (anchorPx && isFinite(anchorPx.y)) ? anchorPx.y : null;
      if(ax !== null && ay !== null && cam3d && cam3dRef){
        const mppRef = _localMetersPerPixel(cam3dRef, ax, ay);
        const mppCur = _localMetersPerPixel(cam3d, ax, ay);
        if(isFinite(mppRef) && isFinite(mppCur) && mppRef > 1e-9 && mppCur > 1e-9){
          scaleComp = clamp(mppRef / mppCur, 0.25, 4.0);
        }
      }
    }catch(_){ scaleComp = 1.0; }

    scaleEff = Math.max(0.0001, scaleEff * scaleComp);
    gl.uniform1f(gl.getUniformLocation(progZone,'uScale'), scaleEff);

    // Phase lock (anti-swim): keep texture grid anchored to a stable point on the near edge.
    // This prevents the "rubber" feeling where the pattern slides when horizon/perspective changes.
    let phaseX = 0.0, phaseY = 0.0;
    try{
      const ax = (anchorPx && isFinite(anchorPx.x)) ? anchorPx.x : null;
      const ay = (anchorPx && isFinite(anchorPx.y)) ? anchorPx.y : null;
      if(ax !== null && ay !== null){
        // Compute plane coords at anchor pixel.
        let pu = null, pv = null;
        const want3dLocal = !!(cam3d && cam3d.Kinv && cam3d.R && cam3d.t);
        if(want3dLocal){
          const KinvA = cam3d.Kinv;
          const RwcA = cam3d.R;
          const tA = cam3d.t;

          // rayCam = normalize(Kinv * [x,y,1])
          let rx = KinvA[0]*ax + KinvA[1]*ay + KinvA[2];
          let ry = KinvA[3]*ax + KinvA[4]*ay + KinvA[5];
          let rz = KinvA[6]*ax + KinvA[7]*ay + KinvA[8];
          const rlen = Math.hypot(rx, ry, rz) || 1.0;
          rx/=rlen; ry/=rlen; rz/=rlen;

          // Rcw = transpose(Rwc)
          const Rcw00 = RwcA[0], Rcw01 = RwcA[3], Rcw02 = RwcA[6];
          const Rcw10 = RwcA[1], Rcw11 = RwcA[4], Rcw12 = RwcA[7];
          const Rcw20 = RwcA[2], Rcw21 = RwcA[5], Rcw22 = RwcA[8];

          // camPosW = -(Rcw * t)
          const cwx = -(Rcw00*tA[0] + Rcw01*tA[1] + Rcw02*tA[2]);
          const cwy = -(Rcw10*tA[0] + Rcw11*tA[1] + Rcw12*tA[2]);
          const cwz = -(Rcw20*tA[0] + Rcw21*tA[1] + Rcw22*tA[2]);

          // rayW = normalize(Rcw * rayCam)
          let rwx = (Rcw00*rx + Rcw01*ry + Rcw02*rz);
          let rwy = (Rcw10*rx + Rcw11*ry + Rcw12*rz);
          let rwz = (Rcw20*rx + Rcw21*ry + Rcw22*rz);
          const rwlen = Math.hypot(rwx, rwy, rwz) || 1.0;
          rwx/=rwlen; rwy/=rwlen; rwz/=rwlen;

          const denom = rwz;
          if(Math.abs(denom) > 1e-6){
            const sRay = -cwz / denom;
            if(sRay > 0.0){
              const pxw = cwx + rwx * sRay;
              const pyw = cwy + rwy * sRay;
              pu = pxw; pv = pyw;
            }
          }
        }
        if(pu === null || pv === null){
          // Fallback: invH mapping
          const x = ax, y = ay;
          const u = invHArr9[0]*x + invHArr9[1]*y + invHArr9[2];
          const v = invHArr9[3]*x + invHArr9[4]*y + invHArr9[5];
          const wq = invHArr9[6]*x + invHArr9[7]*y + invHArr9[8];
          if(isFinite(wq) && Math.abs(wq) > 1e-9){
            pu = u / wq;
            pv = v / wq;
          }
        }

        if(pu !== null && pv !== null){
          // Apply the same v-flip rule as the shader (only relevant for non-3D legacy and when forceBottomUp is off)
          if(vflip === 1){ pv = planeD - pv; }

          // Compute tuv(anchor) = R * (uv * scale)
          const rotRad = ((params.rotation ?? 0.0) * Math.PI) / 180.0;
          const c = Math.cos(rotRad), s = Math.sin(rotRad);
          const su = pu * scaleEff;
          const sv = pv * scaleEff;
          const tx = c*su - s*sv;
          const ty = s*su + c*sv;
          const fract = (q)=>{
            if(!isFinite(q)) return 0.0;
            const f = q - Math.floor(q);
            return (f < 0) ? (f + 1) : f;
          };
          phaseX = fract(-tx);
          phaseY = fract(-ty);
        }
      }
    }catch(_){ phaseX = 0.0; phaseY = 0.0; }
    gl.uniform2f(gl.getUniformLocation(progZone,'uPhase'), phaseX, phaseY);
    gl.uniform1f(gl.getUniformLocation(progZone,'uRotation'), (params.rotation ?? 0.0));
    gl.uniform1f(gl.getUniformLocation(progZone,'uOpacity'), clamp(params.opacity ?? 1.0, 0, 1));
    gl.uniform1i(gl.getUniformLocation(progZone,'uBlendMode'), (opaqueFill ? 0 : _blendModeId(params.blendMode)));

    // Quality defaults tuned for "pro" look without user knobs
    gl.uniform1f(gl.getUniformLocation(progZone,'uFeather'), 1.0);
    gl.uniform1f(gl.getUniformLocation(progZone,'uAO'), 1.0);
    gl.uniform1f(gl.getUniformLocation(progZone,'uPhotoFit'), (opaqueFill ? 0.0 : 1.0));
    gl.uniform1f(gl.getUniformLocation(progZone,'uFarFade'), 1.0);

    const invH = _mat3FromArray9(invHArr9);
    gl.uniformMatrix3fv(gl.getUniformLocation(progZone,'uInvH'), false, invH);

    // Variant B (3D camera renderer): uniforms for ray-plane mapping
    const use3d = !!(cam3d && cam3d.Kinv && cam3d.R && cam3d.t);
    gl.uniform1i(gl.getUniformLocation(progZone,'uUseCam3D'), use3d ? 1 : 0);
    if(use3d){
      gl.uniformMatrix3fv(gl.getUniformLocation(progZone,'uKinv'), false, _mat3FromArray9(cam3d.Kinv));
      gl.uniformMatrix3fv(gl.getUniformLocation(progZone,'uRwc'), false, _mat3FromArray9(cam3d.R));
      gl.uniform3f(gl.getUniformLocation(progZone,'uTwc'), cam3d.t[0], cam3d.t[1], cam3d.t[2]);
    }else{
      // Safe defaults (won't be used when uUseCam3D==0)
      gl.uniformMatrix3fv(gl.getUniformLocation(progZone,'uKinv'), false, _mat3FromArray9([1,0,0, 0,1,0, 0,0,1]));
      gl.uniformMatrix3fv(gl.getUniformLocation(progZone,'uRwc'), false, _mat3FromArray9([1,0,0, 0,1,0, 0,0,1]));
      gl.uniform3f(gl.getUniformLocation(progZone,'uTwc'), 0,0,1);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  async function render(state){
    const ai = state && state.ai ? state.ai : null; // reserved for Ultra AI (Patch 1), no-op for now

    if(!gl) return;
    const API = window.PhotoPaveAPI;
    if(!state?.assets?.photoBitmap || !photoTex){
      // Clear output
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0,0,canvas.width,canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const w = canvas.width, h = canvas.height;
    _ensureTargets(w,h);

    // Drag-stabilization lifecycle: keep extrema lock only for the active dragged zone.
    try{
      const ui = state && state.ui ? state.ui : null;
      let dragZoneId = null;
      if(ui && ui.isPointerDown && ui.draggingPoint && (ui.draggingPoint.kind === 'contour' || ui.draggingPoint.kind === 'cutout')){
        dragZoneId = ui.activeZoneId || null;
      }
      if(_lastDragZoneId && _lastDragZoneId !== dragZoneId){
        dragLockExtrema.delete(_lastDragZoneId);
      }
      if(!dragZoneId && _lastDragZoneId){
        dragLockExtrema.delete(_lastDragZoneId);
      }
      _lastDragZoneId = dragZoneId;
    }catch(_){ /* no-op */ }


    // Ultra AI resources: upload depth + occlusion (if available). Safe no-ops on errors.
    if(ai){
      try{ _ensureAIDepthTexture(ai); }catch(_){ /* no-op */ }
      try{ _ensureAIOcclusionTexture(ai); }catch(_){ /* no-op */ }

      // If Ultra configuration changes (toggle on/off, new dir sign, etc.) do not reuse
      // a cached inverse homography computed for a different mode.
      const d = ai.planeDir;
      const k = [
        (ai.enabled === false) ? 0 : 1,
        ai.depthReady ? 1 : 0,
        ai.depthFarHigh ? 1 : 0,
        d ? (Math.round((d.x||0)*100)/100) : 0,
        d ? (Math.round((d.y||0)*100)/100) : 0
      ].join('|');
      if(_lastAIModeKey !== k){
        _lastAIModeKey = k;
        try{ lastGoodInvH.clear(); }catch(_){/*noop*/}
      }
    }

    // Start composite with the photo.
    // photoTex is a DOM-backed upload (top-left origin) -> needs flipY during copy
    _renderCopy(photoTex, ping, true);
    let src = ping;
    let dst = pong;

    const sx = w / Math.max(1, photoW);
    const sy = h / Math.max(1, photoH);

    for(const zone of (state.zones||[])){
      if(!zone || !zone.enabled) continue;
      if(!zone.closed || !zone.contour || zone.contour.length < 3) continue;
      const url = zone.material?.textureUrl;
      if(!url) continue;

      // Load image (may throw). We rely on proper CORS for WebGL.
      const img = await API.loadImage(url);
      const tileTex = _getTileTex(url, img);

      // Build mask textures (cache by geometry + render size)
      const key = [
        'm', w, h,
        zone.id,
        zone.contour.length,
        zone.contour.map(p=>((p.x*10)|0)+','+((p.y*10)|0)).join(';'),
        (zone.cutouts||[]).filter(c=>c.closed&&c.polygon&&c.polygon.length>=3).map(c=>'c:'+c.polygon.map(p=>((p.x*10)|0)+','+((p.y*10)|0)).join(';')).join('|')
      ].join('|');
      const maskEntry = _getMaskTextures(key, zone, w, h, sx, sy);

      
// Infer floor quad and homography (stable while dragging)
// We keep the last good inverse-homography per zone and reuse it if the current contour becomes temporarily degenerate.
let invH = null;
// Patch 3: if AI inferred a dominant plane direction with decent confidence, pass it to quad inference.
const baseParams = zone.material?.params||{};

// Patch D: auto-calibration overlay (vanish/horizon) for Ultra.
// We only apply it while the user hasn't manually tuned those sliders in Ultra.
let quadParams = baseParams;
// Premium stability rule: when geomLockBottomUp is enabled, we intentionally DO NOT
// inject AI direction into quad inference. The quad is inferred deterministically
// from the contour using bottom->top scanlines (same as base mode). AI is still used
// for depth-based fade/occlusion, but never for horizon/quad orientation.
if(ai && ai.enabled !== false && !(ai.geomLockBottomUp)){
  const tuned = zone.material?._ultraTuned || {horizon:false,perspective:false};
  const calib = ai.calib;

  // Outdoor paving profile: prefer plane directions that are consistent with the zone contour.
  // We do this cheaply (no CV/ML) every frame, but the math is O(n) and very small.
  // If the alignment is weak, we confidence-gate AI influence instead of forcing a wrong orientation.
  function _contourDominantDir(contour){
    if(!contour || contour.length < 2) return null;
    let best=null; let bestL=0;
    const n = contour.length;
    const closed = !!zone.closed;
    const m = closed ? n : (n-1);
    for(let i=0;i<m;i++){
      const a = contour[i];
      const b = contour[(i+1)%n];
      const dx = (b.x - a.x);
      const dy = (b.y - a.y);
      const L = Math.hypot(dx, dy);
      if(L > bestL && isFinite(L)){
        bestL = L;
        best = {x: dx/L, y: dy/L};
      }
    }
    if(!best) return null;
    // We want "forward" to roughly point upward in image space (towards negative y).
    if(best.y > 0) best = {x:-best.x, y:-best.y};
    return best;
  }

  function _contourPCADir(contour){
    if(!contour || contour.length < 3) return null;
    let sx=0, sy=0;
    const n = contour.length;
    for(let i=0;i<n;i++){
      const p = contour[i];
      sx += (p.x||0); sy += (p.y||0);
    }
    const mx = sx / n, my = sy / n;
    let a=0, b=0, c=0;
    for(let i=0;i<n;i++){
      const p = contour[i];
      const dx = (p.x||0) - mx;
      const dy = (p.y||0) - my;
      a += dx*dx;
      b += dx*dy;
      c += dy*dy;
    }
    a/=n; b/=n; c/=n;
    if(!isFinite(a) || !isFinite(b) || !isFinite(c)) return null;

    let vx=0, vy=0;
    if(Math.abs(b) < 1e-9){
      if(a >= c){ vx=1; vy=0; } else { vx=0; vy=1; }
    }else{
      const tr = a + c;
      const det = a*c - b*b;
      const disc = Math.max(0, (tr*tr)/4 - det);
      const l1 = tr/2 + Math.sqrt(disc); // largest eigenvalue
      vx = b;
      vy = l1 - a;
      let m = Math.hypot(vx, vy);
      if(m < 1e-9){
        vx = l1 - c;
        vy = b;
        m = Math.hypot(vx, vy);
        if(m < 1e-9) return null;
      }
      vx/=m; vy/=m;
    }
    const m2 = Math.hypot(vx, vy);
    if(m2 < 1e-9 || !isFinite(m2)) return null;
    vx/=m2; vy/=m2;

    // Ensure "forward" roughly points upward in image space.
    if(vy > 0){ vx = -vx; vy = -vy; }
    return {x:vx, y:vy};
  }

  function _absDot(a,b){
    if(!a||!b) return 0;
    const d = a.x*b.x + a.y*b.y;
    return isFinite(d) ? Math.abs(d) : 0;
  }

  // Candidate plane directions:
  const dirDepth = (ai.planeDir && isFinite(ai.planeDir.x) && isFinite(ai.planeDir.y)) ? ai.planeDir : null;
  const dirCalib = (calib && calib.status==="ready" && calib.planeDir && isFinite(calib.planeDir.x) && isFinite(calib.planeDir.y) && (calib.confidence||0) >= 0.18)
    ? calib.planeDir
    : null;

  // Blend directions if both exist, otherwise pick the available one.
  let chosenDir = dirDepth || dirCalib || null;
  if(dirDepth && dirCalib){
    const cd = Math.max(0, Math.min(1, (ai.confidence||0)));
    const cc = Math.max(0, Math.min(1, (calib.confidence||0)));
    // Prefer the more confident source, but keep some influence from both to reduce flicker.
    const t = (cc / (cc + cd + 1e-6));
    const bx = dirDepth.x*(1-t) + dirCalib.x*t;
    const by = dirDepth.y*(1-t) + dirCalib.y*t;
    const bm = Math.hypot(bx, by);
    chosenDir = (bm>1e-6 && isFinite(bm)) ? {x:bx/bm, y:by/bm} : dirDepth;
  }


// Safety: ensure chosenDir is finite and non-degenerate. If not, fall back to a stable default.
if(!chosenDir || !isFinite(chosenDir.x) || !isFinite(chosenDir.y)){
  chosenDir = {x:0, y:-1};
} else {
  const cm = Math.hypot(chosenDir.x, chosenDir.y);
  if(!isFinite(cm) || cm < 1e-6){
    chosenDir = {x:0, y:-1};
  } else {
    chosenDir = {x: chosenDir.x/cm, y: chosenDir.y/cm};
    // Force "forward" to point upward in image space (y < 0) to avoid near/far flips.
    if(chosenDir.y > -0.02){
      chosenDir = {x:-chosenDir.x, y:-chosenDir.y};
    }
  }
}

  const pdir = _contourPCADir(zone.contour);

  // Zone-PCA vanishing candidate: robust fallback when the photo has weak linear cues (grass/gravel).
  // We only use it as a direction hint; it never mutates stored params.
  if(pdir){
    const agree = _absDot(chosenDir, pdir);
    // If OpenCV calibration is weak OR strongly disagrees with the zone principal axis,
    // prefer the zone-based direction to avoid inverted/vertical defaults.
    const calibOk = (calib && calib.status==="ready" && (calib.confidence||0) >= 0.22);
    const agreeOk = (agree >= 0.28);
    if(!calibOk || !agreeOk){
      chosenDir = pdir;
    }
  }
  // Contour-aligned direction gating.
  // If the inferred direction conflicts with the dominant contour direction,
  // we flip it (sign ambiguity) or reduce confidence to avoid unstable defaults.
  let alignGate = 1.0;
  const cdir = _contourDominantDir(zone.contour);
  if(chosenDir && cdir){
    const dp = chosenDir.x*cdir.x + chosenDir.y*cdir.y;
    if(isFinite(dp) && dp < 0){
      chosenDir = {x:-chosenDir.x, y:-chosenDir.y};
    }
    const a = Math.abs(dp);
    // Gate in [0..1] based on alignment; below ~0.15 treat as unreliable.
    alignGate = smoothstep(0.15, 0.35, a);
  }

  // Derive effective horizon/perspective from calibration (overlay only; does not mutate stored params).
  let effH = baseParams.horizon;
  let effP = baseParams.perspective;
  let usedAuto = false;
  if(calib && calib.status==="ready" && (calib.confidence||0) >= 0.18){
    const _agreeHP = pdir ? _absDot(calib.planeDir, pdir) : 1.0;
    const _hpOk = (_agreeHP >= 0.28);
    
    if(_hpOk && !tuned.horizon && isFinite(calib.autoHorizon)){
      effH = calib.autoHorizon;
      usedAuto = true;
    }
    if(_hpOk && !tuned.perspective && isFinite(calib.autoPerspective)){
      effP = calib.autoPerspective;
      usedAuto = true;
    }
  }
// Clamp auto-derived values to safe ranges to avoid degenerate homographies.
if(!isFinite(effH)) effH = baseParams.horizon;
if(!isFinite(effP)) effP = baseParams.perspective;
effH = Math.max(-0.85, Math.min(0.85, effH));
effP = Math.max(0.0, Math.min(1.0, effP));


  // Build params overlay only if we actually have something to inject.
  // Variant B rule: when calib3d.contourDefinesAxis/disableAiQuad is on, do not let AI/calib override quad direction.
  const _disableAiQuad = !!(ai && ai.calib3d && ai.calib3d.enabled === true && (ai.calib3d.disableAiQuad || ai.calib3d.contourDefinesAxis));
  if(!_disableAiQuad && (chosenDir || usedAuto)){
    const conf = Math.max(0, Math.min(1, (ai.confidence||0)));
    const confAuto = Math.max(0, Math.min(1, (calib && calib.status==="ready") ? (calib.confidence||0) : 0));
    let confMix = Math.max(conf, confAuto);
    // Apply contour alignment confidence-gate (outdoor paving profile).
    confMix = Math.max(0, Math.min(1, confMix * alignGate));
    const mix = smoothstep(0.18, 0.55, confMix);
    quadParams = Object.assign({}, baseParams, {
      perspective: effP,
      horizon: effH,
      _aiPlaneDir: chosenDir || dirDepth || dirCalib,
      _aiConfidence: confMix,
      _aiMix: mix
    });
    // Expose for debug overlay (read-only).
    try{
      ai._lastMix = mix;
      ai._calibUsed = (calib && calib.status==="ready") ? `${calib.source||"?"}:${(calib.confidence||0).toFixed(2)}` : null;
    }catch(_){/*noop*/}
  }
}
// Work in render-buffer coordinates: scale contour from photo space -> render space.
const contourR = (zone.contour||[]).map(p=>({x:(+p.x||0)*sx, y:(+p.y||0)*sy}));

// While dragging, lock yMin/yMax to pre-drag extrema to avoid sudden near/far scanline jumps.
let lockExtrema = null;
try{
  if(_lastDragZoneId && _lastDragZoneId === zone.id){
    lockExtrema = dragLockExtrema.get(zone.id) || null;
    if(!lockExtrema){
      let yMin = Infinity, yMax = -Infinity;
      for(const p of contourR){
        const y = +p.y;
        if(!isFinite(y)) continue;
        if(y < yMin) yMin = y;
        if(y > yMax) yMax = y;
      }
      if(isFinite(yMin) && isFinite(yMax) && (yMax - yMin) > 2){
        lockExtrema = {yMin, yMax};
        dragLockExtrema.set(zone.id, lockExtrema);
      }
    }
  }
}catch(_){ lockExtrema = null; }


let Hm = null;
// Global Anti-Rubber: infer ONLY a base quad from the contour (no horizon/perspective warping, no AI quad).
// Horizon + Perspective are applied strictly as camera parameters later.
const quadRes = _inferQuadFromContour(contourR, {horizon:0.0, perspective:1.0}, w, h, lockExtrema);
let planeMetric = {W:1.0, D:1.0};
const quad = quadRes && quadRes.quad ? quadRes.quad : null;
if(quadRes && quadRes.metric){ planeMetric = quadRes.metric; }

if(quad){
  const qn = _normalizeQuad(quad);
  if(qn){
    Hm = _homographyRectToQuad(qn, planeMetric.W, planeMetric.D);
    if(Hm){
      invH = _invert3x3(Hm);
    }
  }
}

if(!invH){
  const last = lastGoodInvH.get(zone.id);
  if(last) invH = last;
}
if(!invH){
  invH = [1/Math.max(1,w),0,0, 0,1/Math.max(1,h),0, 0,0,1];
}else{
  lastGoodInvH.set(zone.id, invH);
}

// Global camera model (all modes):
// - Estimate a plausible focal length from the base homography.
// - Apply user horizon/perspective as camera pitch + focal scaling.
// - Provide camCur (for rendering) and camRef (for near-anchor scale lock).
let cam3d = null;
let cam3dRef = null;
try{
  if(Hm){
    let cx = 0.5 * w;
    let cy = 0.5 * h;
    const maxDim = Math.max(1, w, h);

    let fGuess = _estimateFocalFromHomography(Hm, cx, cy, w, h);
    if(!fGuess || !isFinite(fGuess) || fGuess < 2){
      fGuess = 0.95 * maxDim;
    }

    // If manual 3D calibration lines are ready, prefer their intrinsics (scaled to render buffer).
    // This makes the Beta mode meaningful: the on/off difference appears only once the user set A1/A2/B1/B2.
    try{
      const c3 = ai && ai.calib3d;
      const res = c3 && c3.result;
      if(c3 && c3.enabled === true && res && res.ok && res.K){
        const sAvg = (sx + sy) * 0.5;
        const fFrom = (+res.K.f||0) * sAvg;
        const cxFrom = (+res.K.cx||0) * sx;
        const cyFrom = (+res.K.cy||0) * sy;
        if(isFinite(fFrom) && fFrom > 2) fGuess = fFrom;
        if(isFinite(cxFrom)) cx = cxFrom;
        if(isFinite(cyFrom)) cy = cyFrom;
      }
    }catch(_){ /*no-op*/ }

    const params = zone.material?.params || {};
    // Effective values computed above (may be AI-derived), fall back to user params.
    const hVal = clamp((typeof effH === 'number' ? effH : (params.horizon ?? 0.0)), -0.85, 0.85);
    const pVal = clamp((typeof effP === 'number' ? effP : (params.perspective ?? 0.75)), 0.0, 1.0);

    // Perspective slider -> camera distance scaling (NOT focal).
    // Rationale: varying focal/FOV produces strong foreshortening ("squash") at extremes,
    // which users perceive as "rubber" even if the math is correct.
    // We instead vary camera distance while keeping focal near the estimated baseline.
    const perspT = (pVal - 0.5) * 2.0; // [-1..1]
    const distK = 0.70;
    const distScaleBase = clamp(Math.exp(-perspT * distK), 0.45*1.0, 2.20*1.0);

    // Jacobian-based Horizon↔Perspective coupling (Near Metric Guard):
    // When horizon tilt increases, near-field projection can become locally anisotropic (users see "rubber/squash",
    // e.g. a circular pattern becoming a rectangle near the bottom). To preserve near geometry without shrinking
    // horizon range, we auto-increase camera distance (uniformly) to keep the local anisotropy around the near anchor
    // within a safe corridor. This does NOT warp UV; it only adjusts camera distance.
    let distScale = distScaleBase;
    try{
      const anchorPx = (quad && quad.length===4) ? {x:(quad[0].x+quad[1].x)*0.5, y:(quad[0].y+quad[1].y)*0.5} : null;
      if(anchorPx){
        const camBaseTmp = _decomposeHomographyToRT(Hm, {f:fGuess, cx, cy});
        if(!camBaseTmp || !camBaseTmp.R || !camBaseTmp.t) {
          // no stable camera
        } else {
          const pitchMax = 0.35; // keep consistent with pitch below
          const pitchTest = hVal * pitchMax;
          const basePose = _applyPitchToCam(camBaseTmp, pitchTest);

        const buildCamAt = (ds)=>({
          R: basePose.R,
          t: [basePose.t[0]*ds, basePose.t[1]*ds, basePose.t[2]*ds],
          Kinv: [
            1/fGuess, 0, -cx/fGuess,
            0, 1/fGuess, -cy/fGuess,
            0, 0, 1
          ]
        });

        const an0 = _localAnisoInfo(buildCamAt(distScaleBase), anchorPx.x, anchorPx.y);
        if(an0 && isFinite(an0.ratio)){
          const ratio0 = an0.ratio;
          const ratioAbs = (r)=> (r>1? r : (1/r));

          // Target: keep local ratio close to 1.0 (isotropy) in near region.
          // Corridor: allow mild anisotropy; beyond that users perceive "rubber" near the bottom.
          const corridor = 1.10;
          if(ratioAbs(ratio0) > corridor){
            // Search an increased distance multiplier m>=1 that minimizes |log(ratio)| and brings it into corridor.
            let bestM = 1.0;
            let bestScore = Math.abs(Math.log(ratioAbs(ratio0)));

            const evalM = (m)=>{
              const ds = clamp(distScaleBase*m, 0.35, 4.00);
              const an = _localAnisoInfo(buildCamAt(ds), anchorPx.x, anchorPx.y);
              if(!an || !isFinite(an.ratio)) return null;
              const ra = ratioAbs(an.ratio);
              return {m, ds, ra, score: Math.abs(Math.log(ra))};
            };

            // Coarse scan
            const candidates = [1.0, 1.15, 1.35, 1.65, 2.0, 2.5, 3.0, 3.5, 4.0];
            let best = null;
            for(const m of candidates){
              const r = evalM(m);
              if(!r) continue;
              if(!best || r.score < best.score){
                best = r;
              }
            }
            if(best){
              bestM = best.m;
              bestScore = best.score;

              // Refine around the best candidate with a small local search (log-space).
              let lo = Math.max(1.0, bestM/1.35);
              let hi = Math.min(4.0, bestM*1.35);
              for(let it=0; it<8; it++){
                const m1 = Math.exp(Math.log(lo) * (2/3) + Math.log(hi) * (1/3));
                const m2 = Math.exp(Math.log(lo) * (1/3) + Math.log(hi) * (2/3));
                const r1 = evalM(m1);
                const r2 = evalM(m2);
                if(!r1 || !r2) break;
                if(r1.score < r2.score){
                  hi = m2;
                  bestM = m1;
                  bestScore = r1.score;
                }else{
                  lo = m1;
                  bestM = m2;
                  bestScore = r2.score;
                }
              }

              // Apply only if it meaningfully improves or brings into corridor.
              const finalTry = evalM(bestM);
              if(finalTry && (finalTry.ra <= corridor || finalTry.score + 1e-6 < Math.abs(Math.log(ratioAbs(ratio0))))){
                distScale = finalTry.ds;
              }
            }
          }
        }
        }
      }
    }catch(_){ /*no-op*/ }

    // Keep focal stable to preserve tile geometry; perspective comes from distance change + anchor-scale lock.
    const fCur = fGuess;

    // Reference camera for anchor-scale lock: baseline UX (distance=1, h=0).
    const fRef = fGuess;
    const distScaleRef = 1.0;

// Decompose ONCE to get a stable camera pose from the base homography.
    // IMPORTANT: perspective slider must NOT change pose (R,t), only intrinsics (f).
    // Re-solving pose for each f introduces subtle non-rigid distortions ("rubber" feel).
    const camBase = _decomposeHomographyToRT(Hm, {f:fGuess, cx, cy});

    // Horizon slider -> camera pitch (tilt). Kept intentionally conservative.
    const pitchMax = 0.35; // ~20 degrees
    const pitchCur = hVal * pitchMax;

    if(camBase && camBase.R && camBase.t){
      // Current camera: same pose (with optional pitch), different focal (fCur).
      const camPoseCur = _applyPitchToCam(camBase, pitchCur);
      cam3d = {
        R: camPoseCur.R,
        t: [camPoseCur.t[0]*distScale, camPoseCur.t[1]*distScale, camPoseCur.t[2]*distScale],
        Kinv: [
          1/fCur, 0, -cx/fCur,
          0, 1/fCur, -cy/fCur,
          0, 0, 1
        ]
      };

      // Reference camera for anchor-scale lock: baseline UX (h=0, p=0.75).
      cam3dRef = {
        R: camBase.R,
        t: [camBase.t[0]*distScaleRef, camBase.t[1]*distScaleRef, camBase.t[2]*distScaleRef],
        Kinv: [
          1/fRef, 0, -cx/fRef,
          0, 1/fRef, -cy/fRef,
          0, 0, 1
        ]
      };
    }
  }
}catch(_){ cam3d = null; cam3dRef = null; }
    const anchorPx = (quad && quad.length===4) ? {x:(quad[0].x+quad[1].x)*0.5, y:(quad[0].y+quad[1].y)*0.5} : null;
    _renderZonePass(src.tex, dst, zone, tileTex, maskEntry, invH, planeMetric, ai, cam3d, cam3dRef, anchorPx);
const tmp = src; src = dst; dst = tmp;
    }

    // Present to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0,0,w,h);
    // src.tex is an FBO texture -> no flip at display
    _renderCopy(src.tex, null, false);
  }

  function _readPixelsToDataURL(rt){
    const w = rt.w, h = rt.h;
    const buf = new Uint8Array(w*h*4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    gl.readPixels(0,0,w,h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Flip Y for canvas
    const flipped = new Uint8ClampedArray(w*h*4);
    for(let y=0;y<h;y++){
      const srcOff = (h-1-y)*w*4;
      const dstOff = y*w*4;
      flipped.set(buf.subarray(srcOff, srcOff+w*4), dstOff);
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cctx = c.getContext('2d');
    const imgData = new ImageData(flipped, w, h);
    cctx.putImageData(imgData, 0, 0);
    return c.toDataURL('image/png');
  }

  async function _readPixelsToBlob(rt){
    const w = rt.w, h = rt.h;
    const buf = new Uint8Array(w*h*4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    gl.readPixels(0,0,w,h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Flip Y for canvas
    const flipped = new Uint8ClampedArray(w*h*4);
    for(let y=0;y<h;y++){
      const srcOff = (h-1-y)*w*4;
      const dstOff = y*w*4;
      flipped.set(buf.subarray(srcOff, srcOff+w*4), dstOff);
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cctx = c.getContext('2d');
    const imgData = new ImageData(flipped, w, h);
    cctx.putImageData(imgData, 0, 0);
    const blob = await new Promise((resolve)=>{
      try{
        c.toBlob((b)=>resolve(b), 'image/png');
      }catch(_){ resolve(null); }
    });
    if(blob) return blob;
    // Fallback to dataURL if toBlob is unavailable
    const dataURL = c.toDataURL('image/png');
    const resp = await fetch(dataURL);
    return await resp.blob();
  }

  async function exportPNG(state, opts={}){
    if(!gl) throw new Error('WebGL compositor not initialized');
    if(!state?.assets?.photoBitmap || !photoTex) throw new Error('No photo loaded');

    const ai = state && state.ai ? state.ai : null;
    if(ai){
      try{ _ensureAIDepthTexture(ai); }catch(_){ /*no-op*/ }
      try{ _ensureAIOcclusionTexture(ai); }catch(_){ /*no-op*/ }
    }

    const longSide = Math.max(1, photoW, photoH);
    const reqLong = clamp(opts.maxLongSide || longSide, 512, 4096);
    const lim = Math.max(512, Math.min(maxTexSize, maxRbSize));
    const outLong = Math.min(reqLong, lim);
    const sc = outLong / longSide;
    const outW = Math.max(1, Math.round(photoW * sc));
    const outH = Math.max(1, Math.round(photoH * sc));

    // Create temporary targets for export
    const rtA = _createFBO(outW, outH);
    const rtB = _createFBO(outW, outH);

    // Render photo at export scale: we can reuse the same photoTex and sample it.
    gl.viewport(0,0,outW,outH);
    _renderCopy(photoTex, rtA, true);
    let src = rtA;
    let dst = rtB;

    const API = window.PhotoPaveAPI;
    const sx = outW / Math.max(1, photoW);
    const sy = outH / Math.max(1, photoH);

    for(const zone of (state.zones||[])){
      if(!zone || !zone.enabled) continue;
      if(!zone.closed || !zone.contour || zone.contour.length < 3) continue;
      const url = zone.material?.textureUrl;
      if(!url) continue;
      const img = await API.loadImage(url);
      const tileTex = _getTileTex(url, img);

      const key = [
        'mexp', outW, outH,
        zone.id,
        zone.contour.length,
        zone.contour.map(p=>((p.x*10)|0)+','+((p.y*10)|0)).join(';'),
        (zone.cutouts||[]).filter(c=>c.closed&&c.polygon&&c.polygon.length>=3).map(c=>'c:'+c.polygon.map(p=>((p.x*10)|0)+','+((p.y*10)|0)).join(';')).join('|')
      ].join('|');
      const maskEntry = _getMaskTextures(key, zone, outW, outH, sx, sy);

      
let invH = null;
const baseParams = zone.material?.params||{};
const conf = (ai && isFinite(ai.confidence)) ? ai.confidence : 0;
// Keep export geometry identical to on-screen render.
// If premium geometry lock is enabled, we never pass AI plane direction to quad inference.
const quadParams = (ai && ai.enabled !== false && !(ai.geomLockBottomUp) && ai.planeDir) ? Object.assign({}, baseParams, {
  _aiPlaneDir: ai.planeDir,
  _aiConfidence: conf,
  _aiMix: smoothstep(0.18, 0.55, conf)
}) : baseParams;
// Work in render-buffer coordinates: scale contour from photo space -> render space.
const contourR = (zone.contour||[]).map(p=>({x:(+p.x||0)*sx, y:(+p.y||0)*sy}));

let Hm = null;
const quadRes = _inferQuadFromContour(contourR, quadParams, outW, outH, null);
let planeMetric = {W:1.0, D:1.0};
const quad = quadRes && quadRes.quad ? quadRes.quad : null;
if(quadRes && quadRes.metric){ planeMetric = quadRes.metric; }
if(quad){
  const qn = _normalizeQuad(quad);
  if(qn){
    Hm = _homographyRectToQuad(qn, planeMetric.W, planeMetric.D);
    if(Hm){
      invH = _invert3x3(Hm);
    }
  }
}


// Bottom->Up Guard (premium invariant):
// Ensure the inferred mapping keeps near (bottom edge) at v≈0 and far (top edge) at v≈1.
// In rare numeric edge cases this prevents an accidental vertical inversion.
// If detected, we flip the plane V-axis consistently in both Hm and invH.
try{
  if(Hm && invH && quad && quad.length===4){
    const midNear = {x:(quad[0].x+quad[1].x)*0.5, y:(quad[0].y+quad[1].y)*0.5};
    const midFar  = {x:(quad[2].x+quad[3].x)*0.5, y:(quad[2].y+quad[3].y)*0.5};
    const _applyInv = (M, p)=>{
      const x=p.x, y=p.y;
      const u = M[0]*x + M[1]*y + M[2];
      const v = M[3]*x + M[4]*y + M[5];
      const w = M[6]*x + M[7]*y + M[8];
      if(!isFinite(w) || Math.abs(w)<1e-9) return {u:0,v:0,ok:false};
      return {u:u/w, v:v/w, ok:true};
    };
    const uNear = _applyInv(invH, midNear);
    const uFar  = _applyInv(invH, midFar);
    if(uNear.ok && uFar.ok && uNear.v > uFar.v){
      // Flip V in plane coords: M = [[1,0,0],[0,-1,1],[0,0,1]] (involution)
      const D = (planeMetric && isFinite(planeMetric.D)) ? planeMetric.D : 1.0;
      const F = [1,0,0, 0,-1,D, 0,0,1];
      // Hm maps plane->pixel, so Hm' = Hm * F
      Hm = _mul3x3(Hm, F);
      // invH maps pixel->plane, so invH' = F * invH
      invH = _mul3x3(F, invH);
    }
  }
}catch(_){ /*no-op*/ }


if(!invH){
  const last = lastGoodInvH.get(zone.id);
  if(last) invH = last;
}
if(!invH){
  invH = [1/Math.max(1,outW),0,0, 0,1/Math.max(1,outH),0, 0,0,1];
}else{
  lastGoodInvH.set(zone.id, invH);
}

      // Global camera model (export must match on-screen render):
      // - Infer a stable pose from base homography.
      // - Apply horizon/perspective strictly as camera pitch + distance scaling.
      // - If manual calib lines are ready, use their intrinsics as a better baseline.
      let cam3d = null;
      let cam3dRef = null;
      try{
        if(Hm){
          let cx = 0.5 * outW;
          let cy = 0.5 * outH;
          let fGuess = _estimateFocalFromHomography(Hm, cx, cy, outW, outH);
          if(!fGuess || !isFinite(fGuess) || fGuess < 2){
            fGuess = 0.95 * Math.max(1, outW, outH);
          }

          const c3 = ai && ai.calib3d;
          const res = c3 && c3.result;
          if(c3 && c3.enabled === true && res && res.ok && res.K){
            const sAvg = (sx + sy) * 0.5;
            const fFrom = (+res.K.f||0) * sAvg;
            const cxFrom = (+res.K.cx||0) * sx;
            const cyFrom = (+res.K.cy||0) * sy;
            if(isFinite(fFrom) && fFrom > 2) fGuess = fFrom;
            if(isFinite(cxFrom)) cx = cxFrom;
            if(isFinite(cyFrom)) cy = cyFrom;
          }

          const params = zone.material?.params || {};
          const hVal = clamp((params.horizon ?? 0.0), -0.85, 0.85);
          const pVal = clamp((params.perspective ?? 0.75), 0.0, 1.0);

          const perspT = (pVal - 0.5) * 2.0;
          const distK = 0.70;
          const distScaleBase = clamp(Math.exp(-perspT * distK), 0.45*1.0, 2.20*1.0);
          let distScale = distScaleBase;
          const distScaleRef = 1.0;

          const camBase = _decomposeHomographyToRT(Hm, {f:fGuess, cx, cy});
          const pitchMax = 0.35;
          const pitchCur = hVal * pitchMax;

          // Near Metric Guard (export): auto-increase distance under strong horizon tilt to prevent near "rubber/squash".
          try{
            const anchorPx = (quad && quad.length===4) ? {x:(quad[0].x+quad[1].x)*0.5, y:(quad[0].y+quad[1].y)*0.5} : null;
            if(anchorPx && camBase && camBase.R && camBase.t){
              const basePose = _applyPitchToCam(camBase, pitchCur);
              const buildCamAt = (ds)=>({
                R: basePose.R,
                t: [basePose.t[0]*ds, basePose.t[1]*ds, basePose.t[2]*ds],
                Kinv: [
                  1/fGuess, 0, -cx/fGuess,
                  0, 1/fGuess, -cy/fGuess,
                  0, 0, 1
                ]
              });
              const ratioAbs = (r)=> (r>1? r : (1/r));
              const corridor = 1.10;
              const an0 = _localAnisoInfo(buildCamAt(distScaleBase), anchorPx.x, anchorPx.y);
              if(an0 && isFinite(an0.ratio) && ratioAbs(an0.ratio) > corridor){
                let best = {m:1.0, ds:distScaleBase, score: Math.abs(Math.log(ratioAbs(an0.ratio)))};
                const evalM = (m)=>{
                  const ds = clamp(distScaleBase*m, 0.35, 4.00);
                  const an = _localAnisoInfo(buildCamAt(ds), anchorPx.x, anchorPx.y);
                  if(!an || !isFinite(an.ratio)) return null;
                  const ra = ratioAbs(an.ratio);
                  return {m, ds, ra, score: Math.abs(Math.log(ra))};
                };
                const candidates = [1.0,1.15,1.35,1.65,2.0,2.5,3.0,3.5,4.0];
                for(const m of candidates){
                  const r = evalM(m);
                  if(r && r.score < best.score) best = r;
                }
                distScale = best.ds;
              }
            }
          }catch(_){ /*no-op*/ }

          if(camBase && camBase.R && camBase.t){
            const camPoseCur = _applyPitchToCam(camBase, pitchCur);
            cam3d = {
              R: camPoseCur.R,
              t: [camPoseCur.t[0]*distScale, camPoseCur.t[1]*distScale, camPoseCur.t[2]*distScale],
              Kinv: [
                1/fGuess, 0, -cx/fGuess,
                0, 1/fGuess, -cy/fGuess,
                0, 0, 1
              ]
            };
            cam3dRef = {
              R: camBase.R,
              t: [camBase.t[0]*distScaleRef, camBase.t[1]*distScaleRef, camBase.t[2]*distScaleRef],
              Kinv: [
                1/fGuess, 0, -cx/fGuess,
                0, 1/fGuess, -cy/fGuess,
                0, 0, 1
              ]
            };
          }
        }
      }catch(_){ cam3d = null; cam3dRef = null; }

      const anchorPx = (quad && quad.length===4) ? {x:(quad[0].x+quad[1].x)*0.5, y:(quad[0].y+quad[1].y)*0.5} : null;
      _renderZonePass(src.tex, dst, zone, tileTex, maskEntry, invH, planeMetric, ai, cam3d, cam3dRef, anchorPx);
      const tmp = src; src = dst; dst = tmp;
    }

    const dataURL = _readPixelsToDataURL(src);

    // Cleanup
    _destroyFBO(rtA);
    _destroyFBO(rtB);
    return dataURL;
  }

  async function exportPNGBlob(state, opts={}){
    if(!gl) throw new Error('WebGL compositor not initialized');
    if(!state?.assets?.photoBitmap || !photoTex) throw new Error('No photo loaded');

    // Reuse exportPNG logic by rendering to a temp RT and reading pixels as Blob.
    const ai = state && state.ai ? state.ai : null;
    if(ai){
      try{ _ensureAIDepthTexture(ai); }catch(_){ }
      try{ _ensureAIOcclusionTexture(ai); }catch(_){ }
    }

    const longSide = Math.max(1, photoW, photoH);
    const reqLong = clamp(opts.maxLongSide || longSide, 512, 4096);
    const lim = Math.max(512, Math.min(maxTexSize, maxRbSize));
    const outLong = Math.min(reqLong, lim);
    const sc = outLong / longSide;
    const outW = Math.max(1, Math.round(photoW * sc));
    const outH = Math.max(1, Math.round(photoH * sc));

    const rtA = _createFBO(outW, outH);
    const rtB = _createFBO(outW, outH);

    gl.viewport(0,0,outW,outH);
    _renderCopy(photoTex, rtA, true);
    let src = rtA;
    let dst = rtB;

    const API = window.PhotoPaveAPI;
    const sx = outW / Math.max(1, photoW);
    const sy = outH / Math.max(1, photoH);

    for(const zone of (state.zones||[])){
      if(!zone || !zone.enabled) continue;
      if(!zone.closed || !zone.contour || zone.contour.length < 3) continue;
      const url = zone.material?.textureUrl;
      if(!url) continue;
      const img = await API.loadImage(url);
      const tileTex = _getTileTex(url, img);

      const key = [
        'mexp', outW, outH,
        zone.id,
        zone.contour.length,
        zone.contour.map(p=>((p.x*10)|0)+','+((p.y*10)|0)).join(';'),
        (zone.cutouts||[]).filter(c=>c.closed&&c.polygon&&c.polygon.length>=3).map(c=>'c:'+c.polygon.map(p=>((p.x*10)|0)+','+((p.y*10)|0)).join(';')).join('|')
      ].join('|');
      const maskEntry = _getMaskTextures(key, zone, outW, outH, sx, sy);

      // Export geometry must match on-screen render: base quad from contour, camera model applied globally.
      const contourR = (zone.contour||[]).map(p=>({x:(+p.x||0)*sx, y:(+p.y||0)*sy}));
      const quadRes = _inferQuadFromContour(contourR, {horizon:0.0, perspective:1.0}, outW, outH, null);
      let planeMetric = {W:1.0, D:1.0};
      const quad = quadRes && quadRes.quad ? quadRes.quad : null;
      if(quadRes && quadRes.metric){ planeMetric = quadRes.metric; }
      let Hm = null;
      let invH = null;
      if(quad){
        const qn = _normalizeQuad(quad);
        if(qn){
          Hm = _homographyRectToQuad(qn, planeMetric.W, planeMetric.D);
          if(Hm) invH = _invert3x3(Hm);
        }
      }
      if(!invH){ invH = [1/Math.max(1,outW),0,0, 0,1/Math.max(1,outH),0, 0,0,1]; }

      // Build camera model consistent with on-screen path (pose locked, perspective->distance, horizon->pitch).
      let cam3d = null;
      let cam3dRef = null;
      try{
        if(Hm){
          let cx = 0.5*outW;
          let cy = 0.5*outH;
          let fGuess = _estimateFocalFromHomography(Hm, cx, cy, outW, outH);
          if(!fGuess || !isFinite(fGuess) || fGuess < 2){ fGuess = 0.95 * Math.max(1,outW,outH); }

          // If manual calibration lines are ready, use their intrinsics (scaled to export buffer).
          const a = (state && state.ai) ? state.ai : null;
          const c3 = a && a.calib3d;
          const res = c3 && c3.result;
          if(c3 && c3.enabled === true && res && res.ok && res.K){
            const sAvg = (sx + sy) * 0.5;
            const f0 = (+res.K.f||0) * sAvg;
            const cx0 = (+res.K.cx||0) * sx;
            const cy0 = (+res.K.cy||0) * sy;
            if(isFinite(f0) && f0 > 2) fGuess = f0;
            if(isFinite(cx0)) cx = cx0;
            if(isFinite(cy0)) cy = cy0;
          }

          const params = zone.material?.params || {};
          const hVal = clamp((params.horizon ?? 0.0), -0.85, 0.85);
          const pVal = clamp((params.perspective ?? 0.75), 0.0, 1.0);
          const perspT = (pVal - 0.5) * 2.0;
          const distK = 0.70;
          const distScaleBase = clamp(Math.exp(-perspT * distK), 0.45, 2.20);
          let distScale = distScaleBase;
          const distScaleRef = 1.0;
          const camBase = _decomposeHomographyToRT(Hm, {f:fGuess, cx, cy});
          const pitchMax = 0.35;
          const pitchCur = hVal * pitchMax;

          // Near Metric Guard (export): auto-increase distance under strong horizon tilt to prevent near "rubber/squash".
          try{
            const anchorPx = (quad && quad.length===4) ? {x:(quad[0].x+quad[1].x)*0.5, y:(quad[0].y+quad[1].y)*0.5} : null;
            if(anchorPx && camBase && camBase.R && camBase.t){
              const basePose = _applyPitchToCam(camBase, pitchCur);
              const buildCamAt = (ds)=>({
                R: basePose.R,
                t: [basePose.t[0]*ds, basePose.t[1]*ds, basePose.t[2]*ds],
                Kinv: [
                  1/fGuess, 0, -cx/fGuess,
                  0, 1/fGuess, -cy/fGuess,
                  0, 0, 1
                ]
              });
              const ratioAbs = (r)=> (r>1? r : (1/r));
              const corridor = 1.10;
              const an0 = _localAnisoInfo(buildCamAt(distScaleBase), anchorPx.x, anchorPx.y);
              if(an0 && isFinite(an0.ratio) && ratioAbs(an0.ratio) > corridor){
                let best = {m:1.0, ds:distScaleBase, score: Math.abs(Math.log(ratioAbs(an0.ratio)))};
                const evalM = (m)=>{
                  const ds = clamp(distScaleBase*m, 0.35, 4.00);
                  const an = _localAnisoInfo(buildCamAt(ds), anchorPx.x, anchorPx.y);
                  if(!an || !isFinite(an.ratio)) return null;
                  const ra = ratioAbs(an.ratio);
                  return {m, ds, ra, score: Math.abs(Math.log(ra))};
                };
                const candidates = [1.0,1.15,1.35,1.65,2.0,2.5,3.0,3.5,4.0];
                for(const m of candidates){
                  const r = evalM(m);
                  if(r && r.score < best.score) best = r;
                }
                distScale = best.ds;
              }
            }
          }catch(_){ /*no-op*/ }

          if(camBase && camBase.R && camBase.t){
            const camPoseCur = _applyPitchToCam(camBase, pitchCur);
            cam3d = { R: camPoseCur.R, t:[camPoseCur.t[0]*distScale, camPoseCur.t[1]*distScale, camPoseCur.t[2]*distScale],
              Kinv:[ 1/fGuess,0,-cx/fGuess, 0,1/fGuess,-cy/fGuess, 0,0,1 ] };
            cam3dRef = { R: camBase.R, t:[camBase.t[0]*distScaleRef, camBase.t[1]*distScaleRef, camBase.t[2]*distScaleRef],
              Kinv:[ 1/fGuess,0,-cx/fGuess, 0,1/fGuess,-cy/fGuess, 0,0,1 ] };
          }
        }
      }catch(_){ cam3d = null; cam3dRef = null; }

      const anchorPx = (quad && quad.length===4) ? {x:(quad[0].x+quad[1].x)*0.5, y:(quad[0].y+quad[1].y)*0.5} : null;
      _renderZonePass(src.tex, dst, zone, tileTex, maskEntry, invH, planeMetric, state.ai, cam3d, cam3dRef, anchorPx);
      const tmp = src; src = dst; dst = tmp;
    }

    const blob = await _readPixelsToBlob(src);
    _destroyFBO(rtA);
    _destroyFBO(rtB);
    return blob;
  }

  return { init, setPhoto, resize, render, exportPNG, exportPNGBlob, getLimits };
})();
