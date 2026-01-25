
// WebGL plane renderer: projective texture mapping via inverse homography.
// No external deps. Uses WebGL2 if available, falls back to WebGL1.
// Produces an RGBA canvas with the projected tiled texture; caller clips to contour/holes.
const WebGLPlane = (() => {
  let glCanvas = null;
  let gl = null;
  let prog = null;
  let vao = null;
  let uResolution, uInvH, uScale, uPlaneW, uPlaneD, uRot, uFade, uEnableFade;
  let tex = null;
  let texKey = null;

  function createGL(w, h){
    glCanvas = document.createElement("canvas");
    glCanvas.width = w; glCanvas.height = h;
    gl = glCanvas.getContext("webgl2", {alpha:true, premultipliedAlpha:false, antialias:false})
      || glCanvas.getContext("webgl", {alpha:true, premultipliedAlpha:false, antialias:false});
    if(!gl) return false;

    // Precision capability:
    // - WebGL2 guarantees highp in fragment shader.
    // - WebGL1 may not support highp in fragment shader on some mobile GPUs.
    const highpInfo = (gl && gl.getShaderPrecisionFormat) ? gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT) : null;
    const hasHighpFrag = ((typeof WebGL2RenderingContext !== "undefined") && (gl instanceof WebGL2RenderingContext)) || (highpInfo && highpInfo.precision > 0);
    const fragPrec = hasHighpFrag ? "highp" : "mediump";

    const vsSrc = `
      attribute vec2 aPos;
      varying vec2 vPos;
      void main(){
        vPos = aPos * 0.5 + 0.5;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;
    const fsSrc = `
      precision ${fragPrec} float;
      varying vec2 vPos;
      uniform vec2 uResolution;
      uniform mat3 uInvH;

      // Metric-lock plane definition:
      uniform float uPlaneW;
      uniform float uPlaneD;

      // Tile frequency in world units (same semantics as compositor): repeats per plane unit.
      uniform float uScale;
      uniform float uRot;

      uniform float uFade;        // 0..1 strength
      uniform float uEnableFade;  // 0 or 1

      uniform sampler2D uTex;

      void main(){
        // Use normalized fragment coords in [0..1] to improve numeric stability on mediump GPUs.
        // uInvH is pre-scaled on CPU by the current render resolution (columns 0/1 scaled by w/h).
        vec2 fragN = vec2(vPos.x, 1.0 - vPos.y);
        vec3 hp = uInvH * vec3(fragN.x, fragN.y, 1.0);
        float z = hp.z;
        if(abs(z) < 1e-6){
          gl_FragColor = vec4(0.0);
          return;
        }
        vec2 uv = hp.xy / z;

        // Only keep inside the inferred quad (plane rectangle)
        float W = max(uPlaneW, 1e-6);
        float D = max(uPlaneD, 1e-6);
        if(uv.x < 0.0 || uv.x > W || uv.y < 0.0 || uv.y > D){
          gl_FragColor = vec4(0.0);
          return;
        }

        float rot = uRot;
        float c = cos(rot);
        float s = sin(rot);
        mat2 R = mat2(c, -s, s, c);

        vec2 tuv = R * (uv * max(uScale, 1e-6));
        vec2 suv = fract(tuv + vec2(1000.0)); // stable for negatives
        vec4 col = texture2D(uTex, suv);

        // Simple fade to avoid sticker look: use normalized depth (uv.y / D)
        if(uEnableFade > 0.5){
          float farN = clamp(uv.y / D, 0.0, 1.0);
          float d = smoothstep(0.55, 1.0, farN);
          float f = mix(1.0, 0.65, d * uFade);
          float g = dot(col.rgb, vec3(0.299,0.587,0.114));
          col.rgb = mix(col.rgb, vec3(g), (d * uFade) * 0.25);
          col.rgb *= f;
          col.a *= mix(1.0, 0.85, d * uFade);
        }

        gl_FragColor = col;
      }
    `;

    function compile(type, src){
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
        console.warn("[WebGLPlane] shader compile failed:", gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    }
    const vs = compile(gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    if(!vs || !fs) return false;

    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog, gl.LINK_STATUS)){
      console.warn("[WebGLPlane] program link failed:", gl.getProgramInfoLog(prog));
      return false;
    }
    gl.useProgram(prog);

    const aPos = gl.getAttribLocation(prog, "aPos");
    uResolution = gl.getUniformLocation(prog, "uResolution");
    uInvH = gl.getUniformLocation(prog, "uInvH");
    uScale = gl.getUniformLocation(prog, "uScale");
    uPlaneW = gl.getUniformLocation(prog, "uPlaneW");
    uPlaneD = gl.getUniformLocation(prog, "uPlaneD");
    uRot = gl.getUniformLocation(prog, "uRot");
    uFade = gl.getUniformLocation(prog, "uFade");
    uEnableFade = gl.getUniformLocation(prog, "uEnableFade");

    // Fullscreen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1,  1,-1, -1, 1,
      -1, 1,  1,-1,  1, 1
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Texture unit 0
    const uTex = gl.getUniformLocation(prog, "uTex");
    gl.uniform1i(uTex, 0);

    gl.viewport(0,0,w,h);
    gl.clearColor(0,0,0,0);

    return true;
  }

  function ensureSize(w,h){
    if(!glCanvas || glCanvas.width!==w || glCanvas.height!==h){
      glCanvas = null; gl = null; prog = null; tex = null; texKey = null;
      return createGL(w,h);
    }
    gl.viewport(0,0,w,h);
    return true;
  }

  function setTextureFromImage(img){
    const key = img.currentSrc || img.src || (""+img);
    if(tex && texKey === key) return true;
    texKey = key;

    if(!tex) tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    try{
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    }catch(e){
      console.warn("[WebGLPlane] texImage2D failed:", e);
      return false;
    }

    // Texture parameters: keep WebGL1 NPOT-safe.
// We do tiling in shader via fract(), so we can always clamp in sampler.
const isWebGL2 = (typeof WebGL2RenderingContext !== "undefined") && (gl instanceof WebGL2RenderingContext);

const w = img.naturalWidth || img.videoWidth || img.width || 0;
const h = img.naturalHeight || img.videoHeight || img.height || 0;
const isPOT = (v) => v && ((v & (v - 1)) === 0);
const pot = isPOT(w) && isPOT(h);

// Always clamp; repeat is handled in shader.
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

if(isWebGL2){
  // WebGL2 allows mipmaps for NPOT, and improves distant quality.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);
}else{
  // WebGL1: keep it NPOT-safe (no mipmaps unless POT; but we keep it simple).
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

// Optional anisotropic filtering for additional sharpness at glancing angles.
const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic')
  || gl.getExtension('MOZ_EXT_texture_filter_anisotropic')
  || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
if(anisoExt){
  const max = gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 0;
  if(max > 0){
    gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
}
return true;
  }

  function invertHomography(H){
    // H is {m00..m22} or array length 9 (row-major)
    let a;
    if(Array.isArray(H)) a = H.slice(0,9);
    else a = [H.m00,H.m01,H.m02, H.m10,H.m11,H.m12, H.m20,H.m21,H.m22];

    const m00=a[0], m01=a[1], m02=a[2];
    const m10=a[3], m11=a[4], m12=a[5];
    const m20=a[6], m21=a[7], m22=a[8];

    const b01 = m22*m11 - m12*m21;
    const b11 = -m22*m10 + m12*m20;
    const b21 = m21*m10 - m11*m20;

    let det = m00*b01 + m01*b11 + m02*b21;
    if(Math.abs(det) < 1e-10) return null;
    det = 1.0/det;

    const inv = [
      b01*det,
      (-m22*m01 + m02*m21)*det,
      (m12*m01 - m02*m11)*det,
      b11*det,
      (m22*m00 - m02*m20)*det,
      (-m12*m00 + m02*m10)*det,
      b21*det,
      (-m21*m00 + m01*m20)*det,
      (m11*m00 - m01*m10)*det
    ];
    return inv;
  }

  function render(img, H, params, w, h, planeMetric){
    if(!ensureSize(w,h)) return null;
    gl.useProgram(prog);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if(!setTextureFromImage(img)) return null;

    const inv = invertHomography(H);
    if(!inv) return null;

    gl.uniform2f(uResolution, w, h);

    // WebGL expects column-major for mat3 uniform when using uniformMatrix3fv with transpose=false.
    // Our inv is row-major; convert.
    // For better precision on GPUs where fragment highp is not available, we feed the shader
    // normalized fragment coords (0..1) and pre-scale the inverse homography by the render size.
    // This is equivalent to using pixel coords, but keeps intermediate values small.
    // Scaling by diag(w,h,1) corresponds to scaling the first two columns of the matrix.
    const invColMajor = new Float32Array([
      inv[0] * w, inv[3] * w, inv[6] * w,
      inv[1] * h, inv[4] * h, inv[7] * h,
      inv[2],      inv[5],      inv[8]
    ]);
    gl.uniformMatrix3fv(uInvH, false, invColMajor);

    const planeW = Math.max(1e-6, (planeMetric && isFinite(planeMetric.W)) ? planeMetric.W : 1.0);
    const planeD = Math.max(1e-6, (planeMetric && isFinite(planeMetric.D)) ? planeMetric.D : 1.0);
    gl.uniform1f(uPlaneW, planeW);
    gl.uniform1f(uPlaneD, planeD);

    const baseScale = (params && typeof params.scale === "number") ? params.scale : 1.0;
    const scaleEff = Math.max(0.0001, baseScale / planeW);
    gl.uniform1f(uScale, scaleEff);

    const rot = ((params && params.rotation) ? params.rotation : 0) * Math.PI / 180;
    gl.uniform1f(uRot, rot);

    const fade = (params && typeof params.perspFade === "number") ? params.perspFade : 0.75;
    gl.uniform1f(uFade, Math.max(0.0, Math.min(1.0, fade)));
    gl.uniform1f(uEnableFade, 1.0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return glCanvas;
  }

  return { render };
})();
