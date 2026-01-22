
// WebGL plane renderer: projective texture mapping via inverse homography.
// No external deps. Uses WebGL2 if available, falls back to WebGL1.
// Produces an RGBA canvas with the projected tiled texture; caller clips to contour/holes.
const WebGLPlane = (() => {
  let glCanvas = null;
  let gl = null;
  let prog = null;
  let vao = null;
  let uResolution, uInvH, uTileCount, uRot, uFade, uEnableFade;
  let tex = null;
  let texKey = null;

  function createGL(w, h){
    glCanvas = document.createElement("canvas");
    glCanvas.width = w; glCanvas.height = h;
    gl = glCanvas.getContext("webgl2", {alpha:true, premultipliedAlpha:false, antialias:false})
      || glCanvas.getContext("webgl", {alpha:true, premultipliedAlpha:false, antialias:false});
    if(!gl) return false;

    const vsSrc = `
      attribute vec2 aPos;
      varying vec2 vPos;
      void main(){
        vPos = aPos * 0.5 + 0.5;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;
    const fsSrc = `
      precision highp float;
      varying vec2 vPos;
      uniform vec2 uResolution;
      uniform mat3 uInvH;
      uniform float uTileCount;
      uniform float uRot;
      uniform float uFade;        // 0..1 strength
      uniform float uEnableFade;  // 0 or 1

      uniform sampler2D uTex;

      // Rotate around center of unit square (0.5, 0.5)
      vec2 rotUV(vec2 uv, float ang){
        float c = cos(ang);
        float s = sin(ang);
        vec2 p = uv - vec2(0.5);
        vec2 r = vec2(p.x*c - p.y*s, p.x*s + p.y*c);
        return r + vec2(0.5);
      }

      void main(){
        // Convert fragment coords to canvas pixel coords with top-left origin.
        vec2 frag = vec2(vPos.x * uResolution.x, (1.0 - vPos.y) * uResolution.y);
        vec3 hp = uInvH * vec3(frag.x, frag.y, 1.0);
        float z = hp.z;
        if(abs(z) < 1e-6){
          gl_FragColor = vec4(0.0);
          return;
        }
        vec2 uv = hp.xy / z;

        // Only keep inside the inferred quad (unit square)
        if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0){
          gl_FragColor = vec4(0.0);
          return;
        }

        uv = rotUV(uv, uRot);
        vec2 tiled = uv * uTileCount;

        // Repeat
        vec2 tuv = fract(tiled);

        vec4 col = texture2D(uTex, tuv);

        // Simple "distance" fade to avoid sticker look: reduce contrast/alpha in far area.
        if(uEnableFade > 0.5){
          float d = smoothstep(0.55, 1.0, uv.y); // far when uv.y -> 1
          float f = mix(1.0, 0.65, d * uFade);   // fade factor
          // Slight desaturation + alpha reduction in far zone
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
    uTileCount = gl.getUniformLocation(prog, "uTileCount");
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

    try{
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    }catch(e){
      console.warn("[WebGLPlane] texImage2D failed:", e);
      return false;
    }

    // WebGL2 supports NPOT mipmaps in practice; if WebGL1, be conservative.
    const isWebGL2 = (typeof WebGL2RenderingContext !== "undefined") && (gl instanceof WebGL2RenderingContext);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    if(isWebGL2){
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    }else{
      // WebGL1: to avoid NPOT restrictions, use linear without mipmaps.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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

  function render(img, H, params, w, h){
    if(!ensureSize(w,h)) return null;
    gl.useProgram(prog);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if(!setTextureFromImage(img)) return null;

    const inv = invertHomography(H);
    if(!inv) return null;

    gl.uniform2f(uResolution, w, h);

    // WebGL expects column-major for mat3 uniform when using uniformMatrix3fv with transpose=false.
    // Our inv is row-major; convert.
    const invColMajor = new Float32Array([
      inv[0], inv[3], inv[6],
      inv[1], inv[4], inv[7],
      inv[2], inv[5], inv[8]
    ]);
    gl.uniformMatrix3fv(uInvH, false, invColMajor);

    const scale = Math.max(0.1, (params && params.scale) ? params.scale : 1.0);
    const baseRepeat = 6.0;
    const tileCount = baseRepeat / scale;
    gl.uniform1f(uTileCount, tileCount);

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
