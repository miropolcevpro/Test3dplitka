
window.PhotoPaveEditor=(function(){
  const {state,getActiveZone,getActiveCutout,pushHistory}=window.PhotoPaveState;
  const {loadImage}=window.PhotoPaveAPI;
  let canvas,ctx,dpr=1;
  let glCanvas=null;
  let compositor=null;
  const ENABLE_PLANE=false; // unified mode: plane handles disabled

  const setHint=(t)=>{const el=document.getElementById("hintText");if(el)el.textContent=t||"";};

  // Interaction tuning in CSS pixels (converted to canvas pixels via boundingClientRect scale)
  const HIT_RADIUS_CSS = 14;      // point pick radius
  // Slightly larger snap radius makes closure far more predictable on large photos / iframe scaling.
  const SNAP_CLOSE_CSS = 24;      // close-to-first snap radius
  const DRAG_AUTOCLOSE_CSS = 14;  // if dragging last point near first and release -> auto close
  const DRAG_THRESHOLD_CSS = 6;   // pointer movement threshold to start drag instead of closing
  const DASH_PREVIEW = true;

  // Hover/preview state (canvas pixel coords)
  let hoverCanvas = null;
  let hoverCloseCandidate = false;
  // If user clicks the first point on an open polygon, we treat it as a "tap to close" unless they start dragging.
  let pendingClose = null;

  function init(overlayCanvas, baseGlCanvas){
    canvas=overlayCanvas;
    glCanvas=baseGlCanvas;
    ctx=canvas.getContext("2d",{alpha:true});
    dpr=Math.max(1,window.devicePixelRatio||1);

    // WebGL compositor (no 2D fill fallback)
    compositor=window.PhotoPaveCompositor;
    try{
      compositor.init(glCanvas);
    }catch(e){
      console.error(e);
      window.PhotoPaveAPI.setStatus("WebGL2 недоступен — требуется современный браузер");
    }

    if(glCanvas){
      glCanvas.addEventListener('webglcontextlost', (ev)=>{
        try{ ev.preventDefault(); }catch(_){ }
        window.PhotoPaveAPI.setStatus('3D-движок был сброшен браузером. Перезагрузите страницу.');
      }, {passive:false});
      glCanvas.addEventListener('webglcontextrestored', ()=>{
        try{
          compositor.init(glCanvas);
          if(state.assets.photoBitmap && state.assets.photoW && state.assets.photoH){
            compositor.setPhoto(state.assets.photoBitmap, state.assets.photoW, state.assets.photoH);
          }
          if(compositor && glCanvas) compositor.resize(glCanvas.width||1, glCanvas.height||1);
          render();
        }catch(e){ console.error(e); }
      });
    }
    window.addEventListener("resize",resize);resize();
    setHint("Загрузите фото. Затем в режиме «Контур» обведите зону мощения точками и замкните, кликнув рядом с первой точкой. При необходимости добавьте «Вырез» и также замкните его.");
  }
  function resize(){
    const wrap = canvas.parentElement;
    const aw = wrap ? Math.max(1, wrap.clientWidth) : Math.max(1, canvas.getBoundingClientRect().width);
    const ah = wrap ? Math.max(1, wrap.clientHeight) : Math.max(1, canvas.getBoundingClientRect().height);
    const {photoW,photoH} = state.assets;

    if(photoW && photoH){
      // Display size (CSS) — fit inside available area
      const sc = Math.min(aw / photoW, ah / photoH);
      const cssW = Math.floor(photoW * sc);
      const cssH = Math.floor(photoH * sc);

      // Render buffer size (WebGL + overlay). We keep it bounded for stability.
      // Use compositor WebGL limits when available to avoid any aspect distortion
      // from downstream clamping.
      const longSide = Math.max(photoW, photoH);
      let limLong = 2048;
      if(compositor && typeof compositor.getLimits === 'function'){
        try{
          const lim = compositor.getLimits();
          const glLim = Math.min(lim.maxTexSize||2048, lim.maxRbSize||2048);
          // Small safety margin for driver quirks.
          limLong = Math.max(256, Math.min(limLong, glLim - 64));
        }catch(_){ /* ignore */ }
      }
      const targetLong = Math.min(longSide, limLong);
      const rsc = Math.max(0.15, Math.min(1.0, targetLong / Math.max(1, longSide)));
      const rw = Math.max(1, Math.round(photoW * rsc));
      const rh = Math.max(1, Math.round(photoH * rsc));

      canvas.width = rw;
      canvas.height = rh;
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";

      if(glCanvas){
        glCanvas.width = rw;
        glCanvas.height = rh;
        glCanvas.style.width = cssW + "px";
        glCanvas.style.height = cssH + "px";
      }

      // Actual pixel ratio for crisp overlay sizing
      const r = canvas.getBoundingClientRect();
      dpr = canvas.width / Math.max(1, r.width);

      if(compositor && glCanvas){
        try{ compositor.resize(rw, rh); }catch(e){ console.warn(e); }
        if(state.assets.photoBitmap){
          try{ compositor.setPhoto(state.assets.photoBitmap, photoW, photoH); }catch(e){ console.warn(e); }
        }
      }
    }else{
      // No photo: fill available area
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.width = Math.floor(aw * dpr);
      canvas.height = Math.floor(ah * dpr);

      if(glCanvas){
        glCanvas.style.width = "100%";
        glCanvas.style.height = "100%";
        glCanvas.width = canvas.width;
        glCanvas.height = canvas.height;
        if(compositor){ try{ compositor.resize(glCanvas.width, glCanvas.height); }catch(e){ } }
      }
    }

    render();
  }

  function getImageRectInCanvas(){
    const w=canvas.width,h=canvas.height,{photoW,photoH}=state.assets;
    if(!photoW||!photoH)return {x:0,y:0,w:w,h:h,scale:1};
    // With photo loaded we draw it to full canvas (canvas itself is already aspect-correct)
    return {x:0,y:0,w:w,h:h,scale:(w/Math.max(1,photoW))};
  }
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  function imgToCanvasPt(p){
    const rect=getImageRectInCanvas();
    return {x:rect.x+(p.x/state.assets.photoW)*rect.w,y:rect.y+(p.y/state.assets.photoH)*rect.h};
  }
  function canvasToImgPt(cx,cy){
    const rect=getImageRectInCanvas();
    const nx=(cx-rect.x)/rect.w,ny=(cy-rect.y)/rect.h;
    return {x:clamp(nx,0,1)*state.assets.photoW,y:clamp(ny,0,1)*state.assets.photoH};
  }

function eventToCanvasPx(ev){
  const r=canvas.getBoundingClientRect();
  const sx = canvas.width / Math.max(1, r.width);
  const sy = canvas.height / Math.max(1, r.height);
  const cx = (ev.clientX - r.left) * sx;
  const cy = (ev.clientY - r.top) * sy;
  return {cx,cy};
}

function getRectScale(){
  const r=canvas.getBoundingClientRect();
  const sx = canvas.width / Math.max(1, r.width);
  const sy = canvas.height / Math.max(1, r.height);
  return {sx,sy,r};
}

// --- Perspective helpers (floor plane -> photo) ---
// We approximate "AR-like" floor projection by asking user to mark 4 points of the floor plane.
// Then we project a tiled texture through a homography and clip it by the zone polygon.
//
// Quad ordering: we accept any click order, then normalize to CCW and pick a stable start.
function orderQuadCCW(pts){
  const c = pts.reduce((a,p)=>({x:a.x+p.x,y:a.y+p.y}),{x:0,y:0});
  c.x/=pts.length; c.y/=pts.length;
  const withAng = pts.map(p=>({p, ang: Math.atan2(p.y-c.y, p.x-c.x)})).sort((a,b)=>a.ang-b.ang);
  let ccw = withAng.map(o=>o.p);
  // rotate so first is top-left-ish (min x+y)
  let bestIdx=0, best=1e18;
  for(let i=0;i<ccw.length;i++){
    const v=ccw[i].x+ccw[i].y;
    if(v<best){best=v;bestIdx=i;}
  }
  ccw = ccw.slice(bestIdx).concat(ccw.slice(0,bestIdx));
  return ccw;
}
  function quadSignedArea(q){
    // q: [{x,y}...4] in order
    let a=0;
    for(let i=0;i<4;i++){
      const p=q[i], n=q[(i+1)%4];
      a += (p.x*n.y - n.x*p.y);
    }
    return a/2;
  }

  function segmentsIntersect(a,b,c,d){
    // Proper segment intersection excluding shared endpoints, using orientation tests
    const orient = (p,q,r)=> (q.x-p.x)*(r.y-p.y) - (q.y-p.y)*(r.x-p.x);
    const onSeg = (p,q,r)=> Math.min(p.x,r.x)-1e-9<=q.x && q.x<=Math.max(p.x,r.x)+1e-9 &&
                           Math.min(p.y,r.y)-1e-9<=q.y && q.y<=Math.max(p.y,r.y)+1e-9;
    const o1=orient(a,b,c), o2=orient(a,b,d), o3=orient(c,d,a), o4=orient(c,d,b);
    if(Math.abs(o1)<1e-12 && onSeg(a,c,b)) return true;
    if(Math.abs(o2)<1e-12 && onSeg(a,d,b)) return true;
    if(Math.abs(o3)<1e-12 && onSeg(c,a,d)) return true;
    if(Math.abs(o4)<1e-12 && onSeg(c,b,d)) return true;
    return (o1>0)!=(o2>0) && (o3>0)!=(o4>0);
  }

  function normalizeQuad(q){
    // Ensure consistent CCW winding and avoid self-intersection. Return null if invalid.
    if(!q || q.length!==4) return null;
    const area = quadSignedArea(q);
    if(!isFinite(area) || Math.abs(area) < 1e-3) return null;
    let qq = q;
    if(area < 0) qq = [q[0],q[3],q[2],q[1]]; // reverse winding

    // Reject bow-tie / self-intersecting quads
    if(segmentsIntersect(qq[0],qq[1],qq[2],qq[3]) || segmentsIntersect(qq[1],qq[2],qq[3],qq[0])) return null;

    return qq;
  }


function invert3x3(m){
  const a=m[0], b=m[1], c=m[2],
        d=m[3], e=m[4], f=m[5],
        g=m[6], h=m[7], i=m[8];
  const A=e*i-f*h, B=-(d*i-f*g), C=d*h-e*g;
  const D=-(b*i-c*h), E=a*i-c*g, F=-(a*h-b*g);
  const G=b*f-c*e, H=-(a*f-c*d), I=a*e-b*d;
  const det=a*A + b*B + c*C;
  if(Math.abs(det) < 1e-12) return null;
  const invDet=1/det;
  return [A*invDet, D*invDet, G*invDet,
          B*invDet, E*invDet, H*invDet,
          C*invDet, F*invDet, I*invDet];
}

// Solve homography H that maps unit square (0,0),(1,0),(1,1),(0,1) to quad points (x,y) in canvas space.
// H is 3x3, returned as flat array length 9.
function homographyRectToQuad(q, srcW, srcH){
  // Unknowns: h11 h12 h13 h21 h22 h23 h31 h32 (h33=1)
  // For each correspondence: x = (h11*u + h12*v + h13) / (h31*u + h32*v + 1)
  //                         y = (h21*u + h22*v + h23) / (h31*u + h32*v + 1)
  const W = Math.max(1e-6, +srcW || 1.0);
  const Hh = Math.max(1e-6, +srcH || 1.0);
  const src = [
    [0,0],[W,0],[W,Hh],[0,Hh]
  ];
  const A = []; // 8x8
  const B = []; // 8
  for(let k=0;k<4;k++){
    const u=src[k][0], v=src[k][1];
    const x=q[k].x, y=q[k].y;
    // x row
    A.push([u,v,1, 0,0,0, -u*x, -v*x]); B.push(x);
    // y row
    A.push([0,0,0, u,v,1, -u*y, -v*y]); B.push(y);
  }
  // Gaussian elimination
  const n=8;
  for(let col=0; col<n; col++){
    // pivot
    let pivot=col;
    for(let r=col+1;r<n;r++) if(Math.abs(A[r][col])>Math.abs(A[pivot][col])) pivot=r;
    if(Math.abs(A[pivot][col])<1e-12) return null;
    if(pivot!==col){
      A[col],A[pivot]=A[pivot],A[col];
      B[col],B[pivot]=B[pivot],B[col];
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
  const h=B; // solved
  const H=[
    h[0],h[1],h[2],
    h[3],h[4],h[5],
    h[6],h[7],1
  ];
  return H;
}

function homographyUnitSquareToQuad(q){
  return homographyRectToQuad(q, 1.0, 1.0);
}

function applyHomography(H, u, v){
  const x = H[0]*u + H[1]*v + H[2];
  const y = H[3]*u + H[4]*v + H[5];
  const w = H[6]*u + H[7]*v + H[8];
  return {x: x/w, y: y/w};
}

const PATTERN_SIZE = 2048;
const _patternCache = new Map(); // key -> canvas

function buildPatternCanvas(img){
  const key = img.src + "::" + PATTERN_SIZE;
  if(_patternCache.has(key)) return _patternCache.get(key);
  const pc = document.createElement("canvas");
  pc.width = PATTERN_SIZE;
  pc.height = PATTERN_SIZE;
  const pctx = pc.getContext("2d");
  // tile image
  const w = img.width, h = img.height;
  for(let y=0; y<PATTERN_SIZE; y+=h){
    for(let x=0; x<PATTERN_SIZE; x+=w){
      pctx.drawImage(img, x, y, w, h);
    }
  }
  _patternCache.set(key, pc);
  return pc;
}

// Draw an image into destination triangle using an affine mapping from source triangle.
// Standard "textured triangle" approach; perspective correctness comes from subdividing into many small triangles.
function drawTexturedTriangle(tctx, img, s0,t0,s1,t1,s2,t2, x0,y0,x1,y1,x2,y2){
  const denom = (s0*(t1-t2) + s1*(t2-t0) + s2*(t0-t1));
  if(Math.abs(denom) < 1e-12) return;
  const a = (x0*(t1-t2) + x1*(t2-t0) + x2*(t0-t1)) / denom;
  const c = (x0*(s2-s1) + x1*(s0-s2) + x2*(s1-s0)) / denom;
  const e = (x0*(s1*t2 - s2*t1) + x1*(s2*t0 - s0*t2) + x2*(s0*t1 - s1*t0)) / denom;

  const b = (y0*(t1-t2) + y1*(t2-t0) + y2*(t0-t1)) / denom;
  const d = (y0*(s2-s1) + y1*(s0-s2) + y2*(s1-s0)) / denom;
  const f = (y0*(s1*t2 - s2*t1) + y1*(s2*t0 - s0*t2) + y2*(s0*t1 - s1*t0)) / denom;

  tctx.save();
  tctx.beginPath();
  tctx.moveTo(x0,y0); tctx.lineTo(x1,y1); tctx.lineTo(x2,y2);
  tctx.closePath();
  tctx.clip();
  tctx.setTransform(a,b,c,d,e,f);
  tctx.drawImage(img, 0,0);
  tctx.restore();
}

function projectedUV(u,v, mat, planeMetric){
  const planeW = Math.max(1e-6, (planeMetric && isFinite(planeMetric.W)) ? planeMetric.W : 1.0);
  const planeD = Math.max(1e-6, (planeMetric && isFinite(planeMetric.D)) ? planeMetric.D : 1.0);

  const baseScale = Math.max(0.1, mat.params.scale ?? 1.0);
  const scaleEff = Math.max(0.0001, baseScale / planeW);

  const rot = ((mat.params.rotation ?? 0) * Math.PI) / 180;

  // Rotate in world plane around its center (keeps control predictable)
  const cx = planeW * 0.5;
  const cy = planeD * 0.5;
  let x = u - cx, y = v - cy;
  const c = Math.cos(rot), s = Math.sin(rot);
  const xr = x*c - y*s;
  const yr = x*s + y*c;

  const uu = (xr + cx) * scaleEff;
  const vv = (yr + cy) * scaleEff;
  return {uu, vv};
}

// Render the tiled texture projected by the floor plane homography.
// We draw a subdivided grid in unit-square plane space, project via H to canvas, and map pattern coords per cell.
function drawProjectedTiledPlane(tctx, H, mat, patternCanvas, gridN, planeMetric){
  // Draw on full canvas (caller must clip to zone+holes)
  const N = gridN;
  const planeW = Math.max(1e-6, (planeMetric && isFinite(planeMetric.W)) ? planeMetric.W : 1.0);
  const planeD = Math.max(1e-6, (planeMetric && isFinite(planeMetric.D)) ? planeMetric.D : 1.0);
  for(let iy=0; iy<N; iy++){
    const v0 = iy / N;
    const v1 = (iy+1) / N;
    for(let ix=0; ix<N; ix++){
      const u0 = ix / N;
      const u1 = (ix+1) / N;

      // two triangles: (u0,v0)-(u1,v0)-(u1,v1) and (u0,v0)-(u1,v1)-(u0,v1)
      const p00 = applyHomography(H,u0*planeW,v0*planeD);
      const p10 = applyHomography(H,u1*planeW,v0*planeD);
      const p11 = applyHomography(H,u1*planeW,v1*planeD);
      const p01 = applyHomography(H,u0*planeW,v1*planeD);

      const uv00 = projectedUV(u0*planeW,v0*planeD,mat,planeMetric);
      const uv10 = projectedUV(u1*planeW,v0*planeD,mat,planeMetric);
      const uv11 = projectedUV(u1*planeW,v1*planeD,mat,planeMetric);
      const uv01 = projectedUV(u0*planeW,v1*planeD,mat,planeMetric);

      // map to pattern canvas pixels
      const wImg = mat._texW || 512;
      const hImg = mat._texH || 512;

      // Use image size to keep tile aspect correct. Pattern is tiled with that image.
      const s00 = ((uv00.uu * wImg) % PATTERN_SIZE + PATTERN_SIZE) % PATTERN_SIZE;
      const t00 = ((uv00.vv * hImg) % PATTERN_SIZE + PATTERN_SIZE) % PATTERN_SIZE;
      const s10 = ((uv10.uu * wImg) % PATTERN_SIZE + PATTERN_SIZE) % PATTERN_SIZE;
      const t10 = ((uv10.vv * hImg) % PATTERN_SIZE + PATTERN_SIZE) % PATTERN_SIZE;
      const s11 = ((uv11.uu * wImg) % PATTERN_SIZE + PATTERN_SIZE) % PATTERN_SIZE;
      const t11 = ((uv11.vv * hImg) % PATTERN_SIZE + PATTERN_SIZE) % PATTERN_SIZE;
      const s01 = ((uv01.uu * wImg) % PATTERN_SIZE + PATTERN_SIZE) % PATTERN_SIZE;
      const t01 = ((uv01.vv * hImg) % PATTERN_SIZE + PATTERN_SIZE) % PATTERN_SIZE;

      // triangle 1
      drawTexturedTriangle(tctx, patternCanvas,
        s00,t00, s10,t10, s11,t11,
        p00.x,p00.y, p10.x,p10.y, p11.x,p11.y
      );
      // triangle 2
      drawTexturedTriangle(tctx, patternCanvas,
        s00,t00, s11,t11, s01,t01,
        p00.x,p00.y, p11.x,p11.y, p01.x,p01.y
      );
    }
  }
}
function cssToCanvasPx(css){
  const {sx,sy}=getRectScale();
  // Use min scale to keep interaction generous even if aspect differs slightly
  return css * Math.min(sx,sy);
}
function eventToImgPt(ev){
  const p = eventToCanvasPx(ev);
  return canvasToImgPt(p.cx,p.cy);
}
function distCanvasFromImg(a,b){
  const pa=imgToCanvasPt(a), pb=imgToCanvasPt(b);
  return Math.hypot(pa.x-pb.x, pa.y-pb.y);
}
  function findNearest(points,imgPt,maxDistCss=HIT_RADIUS_CSS){
    if(!points||!points.length)return null;
    const rect=getImageRectInCanvas();
    const tx=rect.x+(imgPt.x/state.assets.photoW)*rect.w;
    const ty=rect.y+(imgPt.y/state.assets.photoH)*rect.h;
    const md=cssToCanvasPx(maxDistCss);let best=null,bd=1e9;
    for(let i=0;i<points.length;i++){
      const p=imgToCanvasPt(points[i]);
      const d=Math.hypot(p.x-tx,p.y-ty);
      if(d<bd){bd=d;best=i;}
    }
    return (best!==null&&bd<=md)?best:null;
  }

  function isCloseToFirst(points, imgPt, snapCss=SNAP_CLOSE_CSS){
    if(!points||points.length<3) return false;
    return distCanvasFromImg(points[0], imgPt) <= cssToCanvasPx(snapCss);
  }



  // Infer a "floor" quadrilateral from a polygon contour.
  // This lets us project the texture with perspective *without* asking users to place 4 plane points.
  // Heuristic: split by centroid X into left/right; take minY (far) and maxY (near) on each side.
  function inferQuadFromContour(imgPts, opts){
    // Robust quad inference from an arbitrary closed contour.
    // Returns [nearL, nearR, farR, farL] in IMAGE coordinates (y grows downward), or null.
    if(!imgPts || imgPts.length < 4) return null;
    const params = (opts && opts.params) ? opts.params : {};
    // Perspective slider supports negative values as an "invert depth" control.
    // For quad inference we only need the strength.
    const persp = Math.abs(Math.max(-1, Math.min(1, (params.perspective ?? 0.75))));
    const horizon = Math.max(-1, Math.min(1, (params.horizon ?? 0.0)));

    // Convex hull for stability on concave contours
    const pts = imgPts.map(p=>({x:p.x, y:p.y}));
    pts.sort((a,b)=> a.x===b.x ? a.y-b.y : a.x-b.x);
    const cross=(o,a,b)=> (a.x-o.x)*(b.y-o.y) - (a.y-o.y)*(b.x-o.x);
    const buildHull=(arr)=>{
      const h=[];
      for(const p of arr){
        while(h.length>=2 && cross(h[h.length-2], h[h.length-1], p) <= 0) h.pop();
        h.push(p);
      }
      return h;
    };
    const lower=buildHull(pts);
    const upper=buildHull(pts.slice().reverse());
    upper.pop(); lower.pop();
    const hull = lower.concat(upper);
    const base = (hull.length>=4) ? hull : pts;
    if(base.length < 4) return null;

    // Bounds
    let minY=Infinity, maxY=-Infinity, minX=Infinity, maxX=-Infinity;
    for(const p of base){ minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); }
    const h = Math.max(1, maxY-minY);
    const band = Math.max(10, h*0.12);

    const pickBand = (isNear)=>{
      const y0 = isNear ? (maxY-band) : (minY+band);
      const candidates = base.filter(p=> isNear ? (p.y>=y0) : (p.y<=y0));
      if(candidates.length>=2){
        const left = candidates.reduce((a,b)=> (b.x<a.x?b:a));
        const right = candidates.reduce((a,b)=> (b.x>a.x?b:a));
        return [left,right];
      }
      return null;
    };

    let near = pickBand(true);
    let far  = pickBand(false);

    // Fallback: split by median X and pick near/far per side
    if(!near || !far){
      const xs = base.map(p=>p.x).slice().sort((a,b)=>a-b);
      const med = xs[Math.floor(xs.length/2)] ?? ((minX+maxX)/2);
      const leftPts = base.filter(p=>p.x<=med);
      const rightPts = base.filter(p=>p.x>med);
      if(leftPts.length>=2 && rightPts.length>=2){
        const farL = leftPts.reduce((a,b)=> (b.y<a.y?b:a));
        const nearL = leftPts.reduce((a,b)=> (b.y>a.y?b:a));
        const farR = rightPts.reduce((a,b)=> (b.y<a.y?b:a));
        const nearR = rightPts.reduce((a,b)=> (b.y>a.y?b:a));
        near = [nearL, nearR];
        far  = [farL, farR];
      }
    }

    if(!near || !far) return null;
    let nearL=near[0], nearR=near[1], farL=far[0], farR=far[1];

    // Ensure near is below far
    if(!(nearL.y > farL.y && nearR.y > farR.y)){
      // Attempt swap if inverted
      const tL=nearL; nearL=farL; farL=tL;
      const tR=nearR; nearR=farR; farR=tR;
      if(!(nearL.y > farL.y && nearR.y > farR.y)) return null;
    }

    // Apply user controls:
    // - perspective: blend far edge towards its inferred position (0 => mild, 1 => full)
    // - horizon: shifts far edge up/down and slightly converges towards center when pushing up
    const cx = (nearL.x + nearR.x) * 0.5;
    const mild = 0.25 + 0.75*persp; // never fully collapse
    farL = { x: nearL.x + (farL.x-nearL.x)*mild, y: nearL.y + (farL.y-nearL.y)*mild };
    farR = { x: nearR.x + (farR.x-nearR.x)*mild, y: nearR.y + (farR.y-nearR.y)*mild };

    const dy = horizon * 0.22 * h; // up: negative, down: positive
    farL.y += dy; farR.y += dy;
    // Converge far edge when moving horizon up (horizon<0)
    const conv = Math.max(0, Math.min(0.35, (-horizon)*0.25));
    farL.x = farL.x + (cx - farL.x) * conv;
    farR.x = farR.x + (cx - farR.x) * conv;

    return [nearL, nearR, farR, farL];
  }
  async function drawZoneFill(zone){
    const mat=zone.material;
    if(!mat||!mat.textureUrl||!zone.closed||zone.contour.length<3)return;
    try{
      const img=await loadImage(mat.textureUrl);
      const rect=getImageRectInCanvas();
      // AR-like floor projection without explicit plane mode: infer a quadrilateral from the contour.
      let usePerspective=false;
      let H=null, gridN=28, planeMetric=null;
      const quadImg = inferQuadFromContour(zone.contour, {params: mat.params});
      if(quadImg){
        // Keep the inferred near/near/far/far order; only normalize winding and validate.
        const quadRaw = quadImg.map(imgToCanvasPt);
        const quad = normalizeQuad(quadRaw);
        if(quad){
          const planeW = Math.max(1.0, Math.hypot(quad[1].x-quad[0].x, quad[1].y-quad[0].y));
          const midNear = {x:(quad[0].x+quad[1].x)*0.5, y:(quad[0].y+quad[1].y)*0.5};
          const midFar  = {x:(quad[2].x+quad[3].x)*0.5, y:(quad[2].y+quad[3].y)*0.5};
          const planeD = Math.max(1.0, Math.hypot(midFar.x-midNear.x, midFar.y-midNear.y));
          planeMetric = {W: planeW, D: planeD};
          H = homographyRectToQuad(quad, planeW, planeD);
        }
        if(H){
          usePerspective=true;
          const edge=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
          const maxEdge = Math.max(edge(quad[0],quad[1]),edge(quad[1],quad[2]),edge(quad[2],quad[3]),edge(quad[3],quad[0]))/Math.max(1,dpr);
          gridN = Math.max(18, Math.min(64, Math.round(maxEdge/26)));
        }
      }

      // Cache key: geometry + material + (optionally) plane definition
      const keyParts=[
        mat.textureUrl,
        String(mat.params.scale??1),
        String(mat.params.rotation??0),
        String(mat.params.opacity??1),
        String(mat.params.blendMode??"multiply"),
        String(mat.params.perspective??0.75),
        String(mat.params.horizon??0.0),
        String(usePerspective?1:0),
        String(gridN),
        String(zone.contour.length)
      ];
      const rp=(p)=>`${Math.round(p.x*10)/10},${Math.round(p.y*10)/10}`;
      keyParts.push(zone.contour.map(rp).join(";"));
      for(const c of (zone.cutouts||[])){
        if(c.closed&&c.polygon&&c.polygon.length>=3){
          keyParts.push("cut:"+c.polygon.map(rp).join(";"));
        }
      }
      if(usePerspective && quadImg){
        keyParts.push("quad:"+quadImg.map(rp).join(";"));
      }
      const key=keyParts.join("|");

      if(zone._fillCache && zone._fillCache.key===key && zone._fillCache.w===canvas.width && zone._fillCache.h===canvas.height){
        // Composite cached layer onto the already-rendered photo.
        ctx.save();
        ctx.globalAlpha=mat.params.opacity??0.85;
        ctx.globalCompositeOperation=mat.params.blendMode??"multiply";
        ctx.drawImage(zone._fillCache.layer,0,0);
        ctx.restore();
        return;
      }

      // Render fill into an offscreen canvas layer (a dedicated "fill layer" after closing)
      const layer=document.createElement("canvas");
      layer.width=canvas.width;
      layer.height=canvas.height;
      const lctx=layer.getContext("2d");

      // Clip to zone contour and holes
      lctx.save();
      lctx.beginPath();
      polyPathTo(lctx, zone.contour);
      for(const c of (zone.cutouts||[])){
        if(c.closed && c.polygon && c.polygon.length>=3) polyPathTo(lctx, c.polygon);
      }
      lctx.clip("evenodd");

      // IMPORTANT: Do NOT apply blend modes like "multiply" inside the offscreen layer.
      // The layer has a transparent background, so blending against transparency will
      // effectively cancel the texture (especially for multiply/screen/etc.).
      // We render the texture into the layer using normal compositing, then blend the
      // whole layer onto the main canvas (where the photo already exists).
      lctx.globalAlpha=1;
      lctx.globalCompositeOperation="source-over";

      if(usePerspective){
        // WebGL plane render (Fix10): projective mapping on GPU for stronger "floor" feel.
        // Falls back to CPU grid projection if WebGL is unavailable.
        let planeCanvas = null;
        try{
          if(typeof WebGLPlane!=="undefined" && WebGLPlane && H){
            planeCanvas = WebGLPlane.render(img, H, mat.params, canvas.width, canvas.height, planeMetric);
          }
        }catch(e){ console.warn("[WebGLPlane] render failed:", e); planeCanvas=null; }
        if(planeCanvas){
          lctx.globalCompositeOperation="source-over";
          lctx.globalAlpha=1;
          lctx.drawImage(planeCanvas,0,0);
        }else{
          // CPU fallback
          const patternCanvas = buildPatternCanvas(img);
          const matTmp = {params: mat.params, _texW: img.width, _texH: img.height};
          drawProjectedTiledPlane(lctx, H, matTmp, patternCanvas, gridN, planeMetric);
        }
      }else{
        // Fallback: simple 2D tiling (no perspective plane)
        const pattern=lctx.createPattern(img,"repeat");
        if(pattern){
          const scale=mat.params.scale??1.0;
          const rot=((mat.params.rotation??0)*Math.PI)/180;
          const cx=rect.x+rect.w/2,cy=rect.y+rect.h/2;
          lctx.translate(cx,cy);
          lctx.rotate(rot);
          lctx.scale(scale,scale);
          lctx.translate(-cx,-cy);
          lctx.fillStyle=pattern;
          lctx.fillRect(rect.x-rect.w,rect.y-rect.h,rect.w*3,rect.h*3);
        }
      }

      lctx.restore();

      // Cache and composite
      zone._fillCache={key,layer,w:canvas.width,h:canvas.height};
      ctx.save();
      ctx.globalAlpha=mat.params.opacity??0.85;
      ctx.globalCompositeOperation=mat.params.blendMode??"multiply";
      ctx.drawImage(layer,0,0);
      ctx.restore();
    }catch(e){
      console.warn("[fill] drawZoneFill failed:", e);
    }finally{
      ctx.globalCompositeOperation="source-over";ctx.globalAlpha=1;
    }
  }
function polyPath(points){
    const p0=imgToCanvasPt(points[0]);
    ctx.moveTo(p0.x,p0.y);
    for(let i=1;i<points.length;i++){const p=imgToCanvasPt(points[i]);ctx.lineTo(p.x,p.y);}
    ctx.closePath();
  }

  function polyPathTo(tctx, points){
    const p0=imgToCanvasPt(points[0]);
    tctx.moveTo(p0.x,p0.y);
    for(let i=1;i<points.length;i++){const p=imgToCanvasPt(points[i]);tctx.lineTo(p.x,p.y);}
    tctx.closePath();
  }

  function drawPoint(imgPt,idx,showIdx=false,color="rgba(0,229,255,1)"){
    // Visual size is intentionally small for precision work. Interaction hit-testing
    // is controlled separately via HIT_RADIUS_CSS / SNAP_CLOSE_CSS.
    const p=imgToCanvasPt(imgPt);
    const r=3.2*dpr;
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle=color;
    ctx.arc(p.x,p.y,r,0,Math.PI*2);
    ctx.fill();
    // Thin high-contrast outline to keep points readable on any photo.
    ctx.lineWidth=1.25*dpr;
    ctx.strokeStyle="rgba(0,0,0,0.70)";
    ctx.stroke();
    ctx.lineWidth=0.75*dpr;
    ctx.strokeStyle="rgba(255,255,255,0.55)";
    ctx.stroke();
    if(showIdx){
      ctx.fillStyle="rgba(0,0,0,0.70)";
      ctx.font=`${10*dpr}px sans-serif`;
      ctx.fillText(String(idx+1),p.x+6*dpr,p.y-6*dpr);
    }
    ctx.restore();
  }

  function drawPlaneOverlay(){
    if(!ENABLE_PLANE) return;
    const pts=state.floorPlane.points;if(!pts.length)return;
    ctx.save();
    ctx.strokeStyle="rgba(0,229,255,0.85)";ctx.lineWidth=3.5*dpr;ctx.fillStyle="rgba(0,229,255,0.08)";
    if(pts.length>=2){
      ctx.beginPath();
      const p0=imgToCanvasPt(pts[0]);ctx.moveTo(p0.x,p0.y);
      for(let i=1;i<pts.length;i++){const p=imgToCanvasPt(pts[i]);ctx.lineTo(p.x,p.y);}
      if(state.floorPlane.closed && pts.length>=3){ctx.closePath();ctx.fill();}
      ctx.stroke();
    }
    for(let i=0;i<pts.length;i++) drawPoint(pts[i],i,state.ui.mode==="plane");
    ctx.restore();
  }

  function drawZonesOverlay(){
    ctx.save();
    const show = !(state.ui && state.ui.showContour === false);
    // Apply contour visibility toggle immediately in all modes.
    // Previously we only hid overlays in "view" mode, forcing an extra "Просмотр" click.
    if(!show){ ctx.restore(); return; }
    for(const zone of state.zones){
      if(!zone.contour||zone.contour.length<2)continue;
      const isActive=zone.id===state.ui.activeZoneId;
      ctx.strokeStyle=isActive?"rgba(0,229,255,0.95)":"rgba(255,255,255,0.35)";
      // Make contour lines thinner for precision editing while keeping them readable.
      ctx.lineWidth=(isActive?2.0:1.2)*dpr;
      ctx.lineJoin='round';
      ctx.lineCap='round';
      ctx.beginPath();
      const p0=imgToCanvasPt(zone.contour[0]);ctx.moveTo(p0.x,p0.y);
      for(let i=1;i<zone.contour.length;i++){const p=imgToCanvasPt(zone.contour[i]);ctx.lineTo(p.x,p.y);} 
      // Closed contour fill is a UX hint before material selection.
      // Once a material/texture is applied, keep the contour lines/points but remove the tint.
      const hasTexture = !!(
        zone.material && (
          zone.material.textureId ||
          zone.material.textureUrl ||
          (zone.material.maps && zone.material.maps.albedo)
        )
      );
      if(zone.closed && zone.contour.length>=3){
        ctx.closePath();
        if(!hasTexture){
          ctx.fillStyle=isActive?"rgba(0,229,255,0.08)":"rgba(255,255,255,0.05)";
          ctx.fill();
        }
      }
      ctx.stroke();
      if(isActive&&state.ui.mode==="contour"){for(let i=0;i<zone.contour.length;i++) drawPoint(zone.contour[i],i,true);}
      for(const c of (zone.cutouts||[])){
        if(!c.polygon||c.polygon.length<2)continue;
        const isCut=isActive&&(c.id===state.ui.activeCutoutId);
        ctx.strokeStyle=isCut?"rgba(255,77,79,0.95)":"rgba(255,77,79,0.45)";
        ctx.lineWidth=(isCut?1.8:1.1)*dpr;
        ctx.lineJoin='round';
        ctx.lineCap='round';
        ctx.beginPath();
        const q0=imgToCanvasPt(c.polygon[0]);ctx.moveTo(q0.x,q0.y);
        for(let i=1;i<c.polygon.length;i++){const q=imgToCanvasPt(c.polygon[i]);ctx.lineTo(q.x,q.y);} 
        if(c.closed && c.polygon.length>=3){ctx.closePath();ctx.fillStyle="rgba(255,77,79,0.10)";ctx.fill();}
        ctx.stroke();
        if(isCut&&state.ui.mode==="cutout"){for(let i=0;i<c.polygon.length;i++) drawPoint(c.polygon[i],i,true,"rgba(255,77,79,1)");}
      }
    }

    // Z-S: Split draft overlay (subzone selection inside master zone).
    // Drawn when state.ui.mode === "split". Uses the same visual language as active contour.
    try{
      if(state.ui && state.ui.mode === "split" && state.ui.splitDraft && state.ui.splitDraft.points && state.ui.splitDraft.points.length){
        const pts = state.ui.splitDraft.points;
        ctx.strokeStyle = "rgba(0,229,255,0.95)";
        ctx.lineWidth = 2.0*dpr;
        ctx.lineJoin='round';
        ctx.lineCap='round';
        ctx.beginPath();
        const p0=imgToCanvasPt(pts[0]);ctx.moveTo(p0.x,p0.y);
        for(let i=1;i<pts.length;i++){const p=imgToCanvasPt(pts[i]);ctx.lineTo(p.x,p.y);} 
        if(state.ui.splitDraft.closed && pts.length>=3){ ctx.closePath(); ctx.fillStyle="rgba(0,229,255,0.06)"; ctx.fill(); }
        ctx.stroke();
        for(let i=0;i<pts.length;i++) drawPoint(pts[i],i,true);
      }
    }catch(_){ }
    ctx.restore();
  }

  function getOpenPolyForMode(){
    if(state.ui.mode==="plane"){
      if(!ENABLE_PLANE) return null;
      return {kind:"plane", points:state.floorPlane.points, closed:state.floorPlane.closed};
    }
    const zone=getActiveZone();
    if(!zone) return null;
    if(state.ui.mode==="contour"){
      return {kind:"contour", points:zone.contour, closed:zone.closed, zone};
    }
    if(state.ui.mode==="split"){
      const d = state.ui && state.ui.splitDraft;
      if(!d || !d.points) return null;
      return {kind:"split", points:d.points, closed:!!d.closed, draft:d};
    }
    if(state.ui.mode==="cutout"){
      const cut=getActiveCutout(zone);
      if(!cut) return null;
      return {kind:"cutout", points:cut.polygon, closed:cut.closed, zone, cutout:cut};
    }
    return null;
  }

  function _dispatchSplitClosed(){
    try{ window.dispatchEvent(new Event("pp:splitClosed")); }catch(_){ }
  }

  function drawLivePreview(){
    if(!DASH_PREVIEW) return;
    if(state.ui.isPointerDown) return;
    if(!hoverCanvas) return;
    const show = !(state.ui && state.ui.showContour === false);
    if(!show) return;
    const poly=getOpenPolyForMode();
    if(!poly || poly.closed) return;
    const pts=poly.points;
    if(!pts || pts.length===0) return;

    const last=imgToCanvasPt(pts[pts.length-1]);
    let end={x:hoverCanvas.cx,y:hoverCanvas.cy};
    if(hoverCloseCandidate && pts.length>=3){
      const first=imgToCanvasPt(pts[0]);
      end={x:first.x,y:first.y};
    }

    ctx.save();
    ctx.setLineDash([6*dpr,6*dpr]);
    ctx.strokeStyle="rgba(0,229,255,0.65)";
    ctx.lineWidth=3*dpr;
    ctx.beginPath();
    ctx.moveTo(last.x,last.y);
    ctx.lineTo(end.x,end.y);
    ctx.stroke();
    ctx.setLineDash([]);

    if(hoverCloseCandidate && pts.length>=3){
      const first=imgToCanvasPt(pts[0]);
      // highlight first point
      drawPoint(pts[0],0,false,"rgba(255,215,0,1)");
      // label
      ctx.fillStyle="rgba(0,0,0,0.65)";
      ctx.font=`${12*dpr}px sans-serif`;
      const tx=first.x+12*dpr, ty=first.y-12*dpr;
      ctx.fillText("Кликните, чтобы замкнуть", tx, ty);
    }
    ctx.restore();
  }

  async function render(){
    if(!ctx)return;
    const ov=document.getElementById("uploadOverlay");
    if(ov){ov.style.display=state.assets.photoBitmap?"none":"flex";}
    // 1) WebGL base render
    if(compositor && glCanvas && state.assets.photoBitmap){
      try{
        await compositor.render(state);
      }catch(e){
        console.warn("[WebGLCompositor] render failed:", e);
        window.PhotoPaveAPI.setStatus("Ошибка WebGL-рендера (см. консоль)");
      }
    }

    // 2) Overlay (UI): contours, points, handles
    ctx.save();
    ctx.clearRect(0,0,canvas.width,canvas.height);
    // subtle dim when no photo
    if(!state.assets.photoBitmap){
      ctx.fillStyle="#0b0e14";ctx.fillRect(0,0,canvas.width,canvas.height);
      const rect=getImageRectInCanvas();
      ctx.fillStyle="rgba(255,255,255,0.06)";ctx.fillRect(rect.x,rect.y,rect.w,rect.h);
      ctx.fillStyle="rgba(255,255,255,0.65)";ctx.font=`${14*dpr}px sans-serif`;
      ctx.fillText("Загрузите фотографию",rect.x+18*dpr,rect.y+28*dpr);
    }

    drawPlaneOverlay();
    drawCalib3DOverlay();
    drawZonesOverlay();
    drawLivePreview();
    ctx.restore();
  }

  function drawCalib3DOverlay(){
    try{
      const a = state.ai;
      const c = a && a.calib3d;
      if(!c || c.enabled !== true) return;
      const forceShow = (state.ui && state.ui.mode === "calib");
      if(!forceShow && c.showLines !== true) return;
      if(!state.assets.photoW || !state.assets.photoH) return;
      const rect = getImageRectInCanvas();
      const lines = c.lines || {};

      const drawLine = (L, label, isActive)=>{
        if(!L || !L.p1 || !L.p2) return;
        const p1 = imgToCanvasPt(L.p1);
        const p2 = imgToCanvasPt(L.p2);
        ctx.save();
        ctx.lineWidth = Math.max(1.5, 2.0*dpr);
        ctx.strokeStyle = isActive ? "rgba(120,200,255,0.95)" : "rgba(255,255,255,0.65)";
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        // label
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        const lx = (p1.x+p2.x)*0.5;
        const ly = (p1.y+p2.y)*0.5;
        ctx.fillRect(lx-18*dpr, ly-10*dpr, 36*dpr, 20*dpr);
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.font = `${12*dpr}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, lx, ly);
        ctx.restore();
      };

      drawLine(lines.A1, "A1", c.active==="A1");
      drawLine(lines.A2, "A2", c.active==="A2");
      drawLine(lines.B1, "B1", c.active==="B1");
      drawLine(lines.B2, "B2", c.active==="B2");

      // Render vanishing points and horizon if available
      const res = c.result;
      if(res && res.ok && res.horizonLine && res.vanishA && res.vanishB){
        // horizon line segment clipped to canvas rect
        const vA = imgToCanvasPt(res.vanishA);
        const vB = imgToCanvasPt(res.vanishB);
        ctx.save();
        ctx.strokeStyle = "rgba(255,220,120,0.85)";
        ctx.lineWidth = Math.max(1.0, 1.6*dpr);
        ctx.setLineDash([6*dpr, 6*dpr]);
        ctx.beginPath();
        ctx.moveTo(vA.x, vA.y);
        ctx.lineTo(vB.x, vB.y);
        ctx.stroke();
        ctx.setLineDash([]);

        const drawVP = (p, t)=>{
          const cp = imgToCanvasPt(p);
          ctx.fillStyle = "rgba(255,220,120,0.95)";
          ctx.beginPath();
          ctx.arc(cp.x, cp.y, 4.2*dpr, 0, Math.PI*2);
          ctx.fill();
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(cp.x-16*dpr, cp.y-18*dpr, 32*dpr, 16*dpr);
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.font = `${11*dpr}px sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(t, cp.x, cp.y-10*dpr);
        };
        drawVP(res.vanishA, "VA");
        drawVP(res.vanishB, "VB");
        ctx.restore();
      }

      // UX helper when in calib mode
      if(state.ui.mode === "calib"){
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(rect.x+10*dpr, rect.y+10*dpr, rect.w-20*dpr, 28*dpr);
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.font = `${12*dpr}px sans-serif`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const active = c.active ? (`${c.active}`) : "выберите линию";
        ctx.fillText(`Калибровка: ${active}. Клик = точка, Shift+клик = очистить линию.`, rect.x+18*dpr, rect.y+24*dpr);
        ctx.restore();
      }
    }catch(e){ /* no-op */ }
  }

  function onPointerDown(ev){
  // Do not forcibly re-enable contour overlay on any click.
  // Users can now hide the contour and keep it hidden while tuning materials
  // without needing to enter "Просмотр".

  state.ui.isPointerDown=true;
  try{ canvas.setPointerCapture(ev.pointerId); }catch(_){ }
  state.ui.pointerCaptureId = ev.pointerId;
  const pt=eventToImgPt(ev);
  const zone=getActiveZone();const cut=getActiveCutout(zone);
  const splitDraft = (state.ui && state.ui.splitDraft) ? state.ui.splitDraft : null;

  // Patch 4: Interactive occlusion pick mode (premium)
  // When enabled, a click on the photo selects an object to be excluded from tiling.
  try{
    const a = state.ai || null;
    const hasPhoto = !!(state.assets && state.assets.photoBitmap && state.assets.photoW && state.assets.photoH);
    if(hasPhoto && a && a.enabled !== false && a.occlusionEnabled !== false && a._occPickMode && window.AIUltraPipeline && typeof window.AIUltraPipeline.pickOcclusionAt === "function"){
      const nx = (pt.x / Math.max(1, state.assets.photoW));
      const ny = (pt.y / Math.max(1, state.assets.photoH));
      // Shift+click removes from mask.
      window.AIUltraPipeline.pickOcclusionAt(nx, ny, {mode: ev.shiftKey ? "sub" : "add"})
        .then(()=>{ try{ window.dispatchEvent(new Event("ai:occlusionReady")); }catch(_){ } render(); })
        .catch((e)=>{ console.warn("[AI] occlusion pick error", e); try{ window.dispatchEvent(new Event("ai:error")); }catch(_){ } });
      // Do not interact with contour editing while in pick mode.
      return;
    }
  }catch(_){ }

  // Premium 3D calibration (Variant B - MVP): capture user-defined perspective lines.
  try{
    const a = state.ai;
    const c3 = a && a.calib3d;
    if(c3 && c3.enabled === true && state.ui.mode === "calib" && c3.active){
      const key = c3.active;
      c3.lines = c3.lines || {A1:null,A2:null,B1:null,B2:null};
      // Shift+click clears the active line.
      if(ev.shiftKey){
        c3.lines[key] = null;
        c3.result = null;
        c3.status = "editing";
        c3.error = null;
        try{ window.dispatchEvent(new Event("calib3d:change")); }catch(_){ }
        render();
        return;
      }
      const L = c3.lines[key] || {p1:null,p2:null};
      if(!L.p1){ L.p1 = pt; }
      else if(!L.p2){ L.p2 = pt; }
      else { L.p1 = pt; L.p2 = null; }
      c3.lines[key] = L;
      c3.status = "editing";
      c3.error = null;

      // If all four lines have two points, compute calibration.
      const ready = ["A1","A2","B1","B2"].every(k=>{
        const x=c3.lines[k];
        return x && x.p1 && x.p2;
      });
      if(ready && window.PhotoPaveCameraCalib && typeof window.PhotoPaveCameraCalib.computeFromLines === "function"){
        const prevOk = (c3.result && c3.result.ok) ? c3.result : (c3.lastGoodResult && c3.lastGoodResult.ok ? c3.lastGoodResult : null);
        const res = window.PhotoPaveCameraCalib.computeFromLines(c3.lines, state.assets.photoW, state.assets.photoH);
        if(res && res.ok){
          c3.result = res;
          c3.lastGoodResult = res;
          c3.status = "ready";

          // Variant B rule: calibration does not change paving direction.
          // Optional mapping to legacy sliders is allowed, but kept OFF by default.
          if(c3.applyToActiveZone !== false){
            const z = getActiveZone();
            if(z && z.material && z.material.params){
              z.material.params.horizon = res.autoHorizon;
              z.material.params.perspective = res.autoPerspective;
              // Mark as not manually tuned so it can be re-applied.
              z.material._ultraTuned = z.material._ultraTuned || {horizon:false, perspective:false};
              z.material._ultraTuned.horizon = false;
              z.material._ultraTuned.perspective = false;
            }
          }
          c3.error = null;
          c3.warn = null;
        }else{
          // Soft fallback: keep the last good calibration (if any) and keep the mode operational.
          // This avoids "error mode" when lines are nearly parallel/noisy.
          c3.result = prevOk || {ok:false, reason:(res && res.reason) ? String(res.reason) : "calibration_weak", fallback:true};
          c3.status = "ready";
          c3.error = null;
          c3.warn = (res && res.reason) ? String(res.reason) : "calibration_weak";
        }
      }

      try{ window.dispatchEvent(new Event("calib3d:change")); }catch(_){ }
      render();
      return;
    }
  }catch(_){ }

  // Reset pending close candidate each pointerdown
  pendingClose = null;

  let target=null;

  // Unified mode: plane handles are disabled; perspective is inferred from the closed contour.
  if(ENABLE_PLANE){
    const pIdx=findNearest(state.floorPlane.points,pt);
    if(pIdx!==null){
      target={kind:"plane",idx:pIdx};
    }
  }

  if(!target && state.ui.mode==="contour"&&zone){
    const idx=findNearest(zone.contour,pt);
    if(idx===0 && !zone.closed && zone.contour.length>=3 && isCloseToFirst(zone.contour, pt)){
      pendingClose={kind:"contour", start:eventToCanvasPx(ev)};
      state.ui.selectedPoint={kind:"contour", idx:0};
      render();
      return;
    }
    if(idx!==null)target={kind:"contour",idx};
  }else if(state.ui.mode==="cutout"&&zone&&cut){
    const idx=findNearest(cut.polygon,pt);
    if(idx===0 && !cut.closed && cut.polygon.length>=3 && isCloseToFirst(cut.polygon, pt)){
      pendingClose={kind:"cutout", start:eventToCanvasPx(ev)};
      state.ui.selectedPoint={kind:"cutout", idx:0};
      render();
      return;
    }
    if(idx!==null)target={kind:"cutout",idx};
  }else if(state.ui.mode==="split" && splitDraft){
    const idx=findNearest(splitDraft.points,pt);
    if(idx===0 && !splitDraft.closed && splitDraft.points.length>=3 && isCloseToFirst(splitDraft.points, pt)){
      pendingClose={kind:"split", start:eventToCanvasPx(ev)};
      state.ui.selectedPoint={kind:"split", idx:0};
      render();
      return;
    }
    if(idx!==null)target={kind:"split",idx};
  }

  if(target){
    // start drag (single history snapshot)
    pushHistory();
    state.ui.draggingPoint=target;
    state.ui.selectedPoint=target;
    render();
    return;
  }

  // Add points / close polygons
if(state.ui.mode==="contour"&&zone){
    if(zone.closed) return;
    if(isCloseToFirst(zone.contour,pt)){
      pushHistory();
      zone.closed=true;
  // AUTO_HIDE_CONTOUR_ON_CLOSE
  try{
    const st = window.PhotoPaveState && window.PhotoPaveState.state;
    if(st){
      const z = (typeof getActiveZone==="function") ? getActiveZone() : null;
      const zone2 = z || zone;
      if(zone2 && zone2.material && zone2.material.textureId){
        st.ui = st.ui || {};
        st.ui.showContour = false;
      }
    }
  }catch(e){}

      render();
      return;
    }
    pushHistory();
    zone.contour.push(pt);
    // Mobile-friendly auto-close: if the last added point lands near the first point,
    // close the polygon without requiring a perfectly accurate tap on the first handle.
    if(isCloseToFirst(zone.contour, zone.contour[zone.contour.length-1], SNAP_CLOSE_CSS*1.3)){
      zone.contour.pop();
      zone.closed=true;
    }
    // Preserve auto-close result if it triggered.
    zone.closed = !!zone.closed;
    render();
    return;
  }

  if(state.ui.mode==="split" && splitDraft){
    if(splitDraft.closed) return;
    if(isCloseToFirst(splitDraft.points,pt)){
      pushHistory();
      splitDraft.closed = true;
      try{ window.dispatchEvent(new Event("pp:splitClosed")); }catch(_){ }
      render();
      return;
    }
    pushHistory();
    splitDraft.points.push(pt);
    // Mobile-friendly auto-close
    if(isCloseToFirst(splitDraft.points, splitDraft.points[splitDraft.points.length-1], SNAP_CLOSE_CSS*1.3)){
      splitDraft.points.pop();
      splitDraft.closed = true;
      try{ window.dispatchEvent(new Event("pp:splitClosed")); }catch(_){ }
    }
    splitDraft.closed = !!splitDraft.closed;
    render();
    return;
  }

  if(state.ui.mode==="cutout"&&zone&&cut){
    if(cut.closed) return;
    if(isCloseToFirst(cut.polygon,pt)){
      pushHistory();
      cut.closed=true;
      render();
      return;
    }
    pushHistory();
    cut.polygon.push(pt);
    cut.closed=false;
    render();
    return;
  }

  if(state.ui.mode==="split" && splitDraft){
    if(splitDraft.closed) return;
    if(isCloseToFirst(splitDraft.points,pt)){
      pushHistory();
      splitDraft.closed=true;
      // Notify app layer: split draft is closed and ready to be applied.
      try{ window.dispatchEvent(new Event("pp:splitClosed")); }catch(_){ }
      render();
      return;
    }
    pushHistory();
    splitDraft.points.push(pt);
    // Mobile-friendly auto-close
    if(isCloseToFirst(splitDraft.points, splitDraft.points[splitDraft.points.length-1], SNAP_CLOSE_CSS*1.3)){
      splitDraft.points.pop();
      splitDraft.closed=true;
      try{ window.dispatchEvent(new Event("pp:splitClosed")); }catch(_){ }
    }
    splitDraft.closed = !!splitDraft.closed;
    render();
    return;
  }
}
  let rafMove=0, lastMoveEv=null;
  function onPointerMove(ev){
    // If pointerdown happened on the first point, we delay the decision: tap closes, drag edits.
    if(state.ui.isPointerDown && pendingClose && !state.ui.draggingPoint){
      const now = eventToCanvasPx(ev);
      const st = (pendingClose && pendingClose.start) ? pendingClose.start : now;
      const dx = now.cx - st.cx;
      const dy = now.cy - st.cy;
      const moved = Math.hypot(dx,dy) > cssToCanvasPx(DRAG_THRESHOLD_CSS);
      if(moved){
        // Convert to drag of the first point
        pushHistory();
        state.ui.draggingPoint = {kind: pendingClose.kind, idx:0};
        state.ui.selectedPoint = {kind: pendingClose.kind, idx:0};
        pendingClose = null;
        // fall through to drag logic below (this move will update point)
      }else{
        // Just update hover preview for magnetic label
        hoverCanvas = now;
        const imgPt = canvasToImgPt(hoverCanvas.cx, hoverCanvas.cy);
        const poly = getOpenPolyForMode();
        if(poly && !poly.closed && poly.points && poly.points.length>=3){
          hoverCloseCandidate = isCloseToFirst(poly.points, imgPt);
        }else{
          hoverCloseCandidate = false;
        }
        render();
        return;
      }
    }
    // Hover preview (when not dragging)
    if(!state.ui.isPointerDown || !state.ui.draggingPoint){
      hoverCanvas = eventToCanvasPx(ev);
      const imgPt = canvasToImgPt(hoverCanvas.cx, hoverCanvas.cy);
      const poly = getOpenPolyForMode();
      if(poly && !poly.closed && poly.points && poly.points.length>=3){
        hoverCloseCandidate = isCloseToFirst(poly.points, imgPt);
      }else{
        hoverCloseCandidate = false;
      }
      render();
      return;
    }

    // Drag point (throttled)
    lastMoveEv=ev;
    if(rafMove) return;
    rafMove=requestAnimationFrame(()=>{
      rafMove=0;
      const ev2=lastMoveEv; if(!ev2) return;
      const pt=eventToImgPt(ev2);
	      const drag=state.ui.draggingPoint;
	      // PointerUp may have cleared draggingPoint before this RAF runs.
	      if(!drag) return;
	      if(drag.kind==="plane" && ENABLE_PLANE){state.floorPlane.points[drag.idx]=pt;}
      else{
        const zone=getActiveZone();if(!zone)return;
        if(drag.kind==="contour"){zone.contour[drag.idx]=pt;}
        else if(drag.kind==="cutout"){const cut=getActiveCutout(zone);if(!cut)return;cut.polygon[drag.idx]=pt;}
        else if(drag.kind==="split"){if(state.ui && state.ui.splitDraft && state.ui.splitDraft.points){ state.ui.splitDraft.points[drag.idx]=pt; }}
      }
      // update hover for magnet/label while dragging last point
      hoverCanvas = eventToCanvasPx(ev2);
      const poly = getOpenPolyForMode();
      if(poly && !poly.closed && poly.points && poly.points.length>=3){
        const imgPt2 = canvasToImgPt(hoverCanvas.cx, hoverCanvas.cy);
        hoverCloseCandidate = isCloseToFirst(poly.points, imgPt2);
      }else{
        hoverCloseCandidate = false;
      }
      render();
    });
  }

  function maybeAutoCloseOnDragRelease(){
    const sel=state.ui.selectedPoint;
    if(!sel) return;
    if(sel.kind==="plane"){
      const pts=state.floorPlane.points;
      if(!state.floorPlane.closed && pts.length>=3 && sel.idx===pts.length-1){
        if(isCloseToFirst(pts, pts[sel.idx], DRAG_AUTOCLOSE_CSS)) state.floorPlane.closed=true;
      }
      return;
    }
    const zone=getActiveZone();
    if(!zone) return;
    if(sel.kind==="contour"){
      const pts=zone.contour;
      if(!zone.closed && pts.length>=3 && sel.idx===pts.length-1){
        if(isCloseToFirst(pts, pts[sel.idx], DRAG_AUTOCLOSE_CSS)) zone.closed=true;
      }
      return;
    }
    if(sel.kind==="cutout"){
      const cut=getActiveCutout(zone);
      if(!cut) return;
      const pts=cut.polygon;
      if(!cut.closed && pts.length>=3 && sel.idx===pts.length-1){
        if(isCloseToFirst(pts, pts[sel.idx], DRAG_AUTOCLOSE_CSS)) cut.closed=true;
      }
    }
  }

  function onPointerUp(ev){
    state.ui.isPointerDown=false;
    // If user tapped the first point (without dragging), close the current polygon.
    if(pendingClose && !state.ui.draggingPoint){
      pushHistory();
      if(pendingClose.kind==="contour"){ const z=getActiveZone(); if(z) z.closed=true; }
      else if(pendingClose.kind==="cutout"){ const z=getActiveZone(); if(z){ const c=getActiveCutout(z); if(c) c.closed=true; } }
      else if(pendingClose.kind==="split"){ if(state.ui && state.ui.splitDraft){ state.ui.splitDraft.closed=true; try{ window.dispatchEvent(new Event("pp:splitClosed")); }catch(_){ } } }
      pendingClose=null;
    }
    // If user dragged the last point near the first point, auto-close.
    if(state.ui.draggingPoint){
      maybeAutoCloseOnDragRelease();
    }
    state.ui.draggingPoint=null;
    try{canvas.releasePointerCapture(ev && ev.pointerId);}catch(_){ }
    state.ui.pointerCaptureId = null;
    render();
  }
  function resetInteraction(){
    // Hard reset all interactive state to avoid "sticky" mode/drag when switching zones or starting a new contour.
    state.ui.isPointerDown = false;
    state.ui.draggingPoint = null;
    state.ui.selectedPoint = null;
    hoverCanvas = null;
    hoverCloseCandidate = false;
    pendingClose = null;
    try{
      if(state.ui.pointerCaptureId != null){
        canvas.releasePointerCapture(state.ui.pointerCaptureId);
      }
    }catch(_){ }
    state.ui.pointerCaptureId = null;
  }

  function deleteSelectedPoint(){
    const sel=state.ui.selectedPoint;if(!sel)return false;
    pushHistory();
    if(sel.kind==="plane" && ENABLE_PLANE){ state.floorPlane.points.splice(sel.idx,1); if(state.floorPlane.points.length<4) state.floorPlane.closed=false; }
    else{
      const zone=getActiveZone();if(!zone)return false;
      if(sel.kind==="contour"){ zone.contour.splice(sel.idx,1); if(zone.contour.length<3) zone.closed=false; }
      else if(sel.kind==="cutout"){const cut=getActiveCutout(zone);if(!cut)return false;cut.polygon.splice(sel.idx,1); if(cut.polygon.length<3) cut.closed=false;}
      else if(sel.kind==="split"){ if(state.ui && state.ui.splitDraft && state.ui.splitDraft.points){ state.ui.splitDraft.points.splice(sel.idx,1); if(state.ui.splitDraft.points.length<3) state.ui.splitDraft.closed=false; } }
    }
    state.ui.selectedPoint=null;render();return true;
  }
  function bindInput(){
    canvas.addEventListener("pointerdown",onPointerDown);
    canvas.addEventListener("pointermove",onPointerMove);
    canvas.addEventListener("pointerup",onPointerUp);
    canvas.addEventListener("pointerleave",onPointerUp);
    window.addEventListener("keydown",(e)=>{if(e.key==="Delete"||e.key==="Backspace"){if(deleteSelectedPoint())e.preventDefault();}});
  }
  function setMode(mode){
    if(mode==="plane") mode="contour";
    state.ui.mode=mode;
    hoverCanvas=null;
    hoverCloseCandidate=false;
    const map={
      photo:"Загрузите фото или замените его.",
      plane:"Контур: ставьте точки по краю зоны и замкните к первой точке (магнит). Плоскость определяется автоматически. Точки можно двигать.",
      contour:"Контур зоны: ставьте точки по краю и замкните, кликнув рядом с первой точке. После замыкания текстура начнёт применяться.",
      cutout:"Вырез: обведите объект точками и замкните рядом с первой точкой — вырез исключит область из заливки.",
      split:"Разделение: обведите под‑участок внутри зоны и замкните — участок станет новой зоной, а в основной зоне будет вырез.",
      view:"Просмотр: меняйте материалы, сохраняйте результат.",
      calib:"3D‑калибровка: выберите кнопку линии (A1/A2/B1/B2), затем поставьте 2 точки на фото. A — вдоль укладки (в глубину), B — поперёк. Shift+клик очищает текущую линию."
    };
    setHint(map[mode]||"");render();
  }
  function exportPNG(){
    (async ()=>{
      try{
        if(!compositor){
          window.PhotoPaveAPI.setStatus("Экспорт недоступен: WebGL композитор не инициализирован");
          return;
        }
        // Robust download: prefer Blob/ObjectURL to avoid data: URL limits and blocked clicks in some browsers/iframes.
        const fileName = "paving_preview.png";
        let blob = null;
        if(compositor && typeof compositor.exportPNGBlob === "function"){
          blob = await compositor.exportPNGBlob(state, {maxLongSide: Math.max(1, state.assets.photoW, state.assets.photoH)});
        }
        if(!blob){
          const dataURL = await compositor.exportPNG(state, {maxLongSide: Math.max(1, state.assets.photoW, state.assets.photoH)});
          // Convert dataURL -> Blob
          const resp = await fetch(dataURL);
          blob = await resp.blob();
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.download = fileName;
        a.href = url;
        a.rel = "noopener";
        a.style.display = "none";
        document.body.appendChild(a);
        // Some environments block synthetic clicks unless the element is in DOM.
        try{ a.click(); }
        catch(_){
          try{ window.open(url, "_blank"); }catch(__){}
        }
        setTimeout(()=>{
          try{ document.body.removeChild(a); }catch(_){ }
          try{ URL.revokeObjectURL(url); }catch(_){ }
        }, 1500);
      }catch(e){
        console.warn(e);
        window.PhotoPaveAPI.setStatus("Не удалось экспортировать PNG (см. консоль)");
      }
    })();
  }
  return {init,bindInput,render,resize,setMode,resetInteraction,exportPNG};
})();
