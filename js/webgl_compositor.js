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

  uniform vec2 uResolution; // render target size in pixels
  uniform mat3 uInvH;       // image(px)->plane(uv)
  uniform float uScale;     // tile scale
  uniform float uRotation;  // degrees
  uniform float uOpacity;   // 0..1
  uniform int uBlendMode;   // 0=normal, 1=multiply
  uniform float uFeather;   // 0..1
  uniform float uAO;        // 0..1
  uniform float uPhotoFit;  // 0..1
  uniform float uFarFade;   // 0..1

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

    // Feathered alpha from blurred mask
    float alpha = clamp(mb, 0.0, 1.0);
    // Slightly tighten edge to avoid bleeding
    alpha = smoothstep(0.18, 0.82, alpha);
    alpha = mix(m, alpha, clamp(uFeather, 0.0, 1.0));
    alpha *= clamp(uOpacity, 0.0, 1.0);
    if(alpha <= 0.0005){
      outColor = vec4(toSRGB(prevLin), 1.0);
      return;
    }

    // Projective mapping: image(px) -> plane(uv)
    vec3 q = uInvH * vec3(fragPx, 1.0);
    vec2 uv = q.xy / q.z;

    // If homography is near-singular, keep previous content for this pixel.
    if(abs(q.z) < 1e-6){
      outColor = vec4(toSRGB(prevLin), 1.0);
      return;
    }

    // Tile transform
    float rot = radians(uRotation);
    mat2 R = mat2(cos(rot), -sin(rot), sin(rot), cos(rot));
    vec2 tuv = R * (uv * max(uScale, 0.0001));
    vec2 suv = fract(tuv);
    // Flip Y for uploaded tile texture (top-left origin) while preserving repeat.
    suv.y = 1.0 - suv.y;
    vec3 tile = texture(uTile, suv).rgb;
    vec3 tileLin = toLinear(tile);

    // Photo-aware fit: modulate the material by local photo luminance
    // This helps remove the "sticker" look.
    float fit = clamp(uPhotoFit, 0.0, 1.0);
    float shade = mix(1.0, clamp(0.65 + lum * 0.75, 0.55, 1.35), fit);
    tileLin *= shade;

    // Far fade to reduce moire: gently desaturate and compress contrast as uv.y approaches 1
    float farK = clamp(uv.y, 0.0, 1.0) * clamp(uFarFade, 0.0, 1.0);
    float gray = dot(tileLin, vec3(0.2126,0.7152,0.0722));
    tileLin = mix(tileLin, vec3(gray), farK*0.15);
    tileLin = mix(tileLin, vec3(0.5) + (tileLin-vec3(0.5))*0.85, farK*0.35);

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

  function _homographyUnitSquareToQuad(q){
    // q: 4 points in render-pixel coords in order: (0,0),(1,0),(1,1),(0,1)
    const src = [[0,0],[1,0],[1,1],[0,1]];
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
    if(area > 0) return [q[0],q[3],q[2],q[1]];
    return q;
  }

  
function _inferQuadFromContour(contour, params, w, h){
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
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const dy = yMax - yMin;
  if(!isFinite(dy) || dy < 2) return null;

  // Scanlines slightly inside the hull to avoid vertex-only intersections
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

  // Construct near/far segment endpoints in image-space
  let nearL = {x: rNear.min, y: yNear};
  let nearR = {x: rNear.max, y: yNear};
  let farL  = {x: rFar.min,  y: yFar};
  let farR  = {x: rFar.max,  y: yFar};

  // Guard against super-thin quads
  if(Math.abs(nearR.x - nearL.x) < 2 || Math.abs(farR.x - farL.x) < 2) return null;

  // User controls: keep them gentle and monotonic
  const persp = clamp(params?.perspective ?? 0.75, 0, 1);
  const horizon = clamp(params?.horizon ?? 0.0, -1, 1);

  const mild = 0.25 + 0.75*persp; // 0.25..1.0
  farL = { x: nearL.x + (farL.x-nearL.x)*mild, y: nearL.y + (farL.y-nearL.y)*mild };
  farR = { x: nearR.x + (farR.x-nearR.x)*mild, y: nearR.y + (farR.y-nearR.y)*mild };

  const cx = (nearL.x + nearR.x) * 0.5;
  const dyH = horizon * 0.22 * (photoH||h||1);
  farL.y += dyH; farR.y += dyH;

  const conv = Math.max(0, Math.min(0.35, (-horizon)*0.25));
  farL.x = farL.x + (cx - farL.x) * conv;
  farR.x = farR.x + (cx - farR.x) * conv;

  // Ensure far stays above near in image-space (y grows downward)
  if(farL.y >= nearL.y - 1 || farR.y >= nearR.y - 1) {
    // clamp far y just above near to keep valid ordering
    const fy = Math.min(nearL.y, nearR.y) - 1;
    farL.y = Math.min(farL.y, fy);
    farR.y = Math.min(farR.y, fy);
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
  return quad;
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

  function _renderZonePass(prevTex, dstRT, zone, tileTex, maskEntry, invHArr9){
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
    gl.uniform1i(gl.getUniformLocation(progZone,'uPrev'), 0);
    gl.uniform1i(gl.getUniformLocation(progZone,'uPhoto'), 1);
    gl.uniform1i(gl.getUniformLocation(progZone,'uTile'), 2);
    gl.uniform1i(gl.getUniformLocation(progZone,'uMask'), 3);
    gl.uniform1i(gl.getUniformLocation(progZone,'uMaskBlur'), 4);

    // Params
    const params = zone.material?.params || {};
    gl.uniform1f(gl.getUniformLocation(progZone,'uScale'), Math.max(0.0001, params.scale ?? 1.0));
    gl.uniform1f(gl.getUniformLocation(progZone,'uRotation'), (params.rotation ?? 0.0));
    gl.uniform1f(gl.getUniformLocation(progZone,'uOpacity'), clamp(params.opacity ?? 1.0, 0, 1));
    gl.uniform1i(gl.getUniformLocation(progZone,'uBlendMode'), _blendModeId(params.blendMode));

    // Quality defaults tuned for "pro" look without user knobs
    gl.uniform1f(gl.getUniformLocation(progZone,'uFeather'), 1.0);
    gl.uniform1f(gl.getUniformLocation(progZone,'uAO'), 1.0);
    gl.uniform1f(gl.getUniformLocation(progZone,'uPhotoFit'), 1.0);
    gl.uniform1f(gl.getUniformLocation(progZone,'uFarFade'), 1.0);

    const invH = _mat3FromArray9(invHArr9);
    gl.uniformMatrix3fv(gl.getUniformLocation(progZone,'uInvH'), false, invH);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  async function render(state){
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
const quad = _inferQuadFromContour(zone.contour, zone.material?.params||{}, w, h);
if(quad){
  const qn = _normalizeQuad(quad);
  if(qn){
    const H = _homographyUnitSquareToQuad(qn);
    if(H){
      invH = _invert3x3(H);
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

_renderZonePass(src.tex, dst, zone, tileTex, maskEntry, invH);
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

  async function exportPNG(state, opts={}){
    if(!gl) throw new Error('WebGL compositor not initialized');
    if(!state?.assets?.photoBitmap || !photoTex) throw new Error('No photo loaded');

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
const quad = _inferQuadFromContour(zone.contour, zone.material?.params||{}, outW, outH);
if(quad){
  const qn = _normalizeQuad(quad);
  if(qn){
    const H = _homographyUnitSquareToQuad(qn);
    if(H){
      invH = _invert3x3(H);
    }
  }
}

if(!invH){
  const last = lastGoodInvH.get(zone.id);
  if(last) invH = last;
}
if(!invH){
  invH = [1/Math.max(1,outW),0,0, 0,1/Math.max(1,outH),0, 0,0,1];
}else{
  lastGoodInvH.set(zone.id, invH);
}

      _renderZonePass(src.tex, dst, zone, tileTex, maskEntry, invH);
      const tmp = src; src = dst; dst = tmp;
    }

    const dataURL = _readPixelsToDataURL(src);

    // Cleanup
    _destroyFBO(rtA);
    _destroyFBO(rtB);
    return dataURL;
  }

  return { init, setPhoto, resize, render, exportPNG, getLimits };
})();
