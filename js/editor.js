
window.PhotoPaveEditor=(function(){
  const {state,getActiveZone,getActiveCutout,pushHistory}=window.PhotoPaveState;
  const {loadImage}=window.PhotoPaveAPI;
  let canvas,ctx,dpr=1;
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

  function init(c){
    canvas=c;ctx=canvas.getContext("2d");dpr=Math.max(1,window.devicePixelRatio||1);
    window.addEventListener("resize",resize);resize();
    setHint("Загрузите фото. Затем в режиме «Контур» обведите зону мощения точками и замкните, кликнув рядом с первой точкой. При необходимости добавьте «Вырез» и также замкните его.");
  }
  function resize(){
    const wrap = canvas.parentElement;
    const aw = wrap ? Math.max(1, wrap.clientWidth) : Math.max(1, canvas.getBoundingClientRect().width);
    const ah = wrap ? Math.max(1, wrap.clientHeight) : Math.max(1, canvas.getBoundingClientRect().height);
    const {photoW,photoH} = state.assets;

    if(photoW && photoH){
      // Tie canvas buffer to the photo to avoid aspect distortion and maximize quality
      canvas.width = Math.round(photoW * dpr);
      canvas.height = Math.round(photoH * dpr);

      // Fit the displayed canvas inside available area while preserving aspect
      const sc = Math.min(aw / photoW, ah / photoH);
      canvas.style.width = Math.floor(photoW * sc) + "px";
      canvas.style.height = Math.floor(photoH * sc) + "px";
    }else{
      // No photo: fill available area
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.width = Math.floor(aw * dpr);
      canvas.height = Math.floor(ah * dpr);
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
function homographyUnitSquareToQuad(q){
  // Unknowns: h11 h12 h13 h21 h22 h23 h31 h32 (h33=1)
  // For each correspondence: x = (h11*u + h12*v + h13) / (h31*u + h32*v + 1)
  //                         y = (h21*u + h22*v + h23) / (h31*u + h32*v + 1)
  const src = [
    [0,0],[1,0],[1,1],[0,1]
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

function projectedUV(u,v, mat){
  const scale = Math.max(0.1, mat.params.scale ?? 1.0);
  const rot = ((mat.params.rotation ?? 0) * Math.PI) / 180;
  const baseRepeat = 6; // tiles across plane at scale=1
  const tileCount = baseRepeat / scale;

  // rotate around center for nicer control
  const cx=0.5, cy=0.5;
  let x=u-cx, y=v-cy;
  const xr = x*Math.cos(rot) - y*Math.sin(rot);
  const yr = x*Math.sin(rot) + y*Math.cos(rot);
  u = xr + cx; v = yr + cy;

  const uu = u * tileCount;
  const vv = v * tileCount;
  return {uu, vv};
}

// Render the tiled texture projected by the floor plane homography.
// We draw a subdivided grid in unit-square plane space, project via H to canvas, and map pattern coords per cell.
function drawProjectedTiledPlane(tctx, H, mat, patternCanvas, gridN){
  // Draw on full canvas (caller must clip to zone+holes)
  const N = gridN;
  for(let iy=0; iy<N; iy++){
    const v0 = iy / N;
    const v1 = (iy+1) / N;
    for(let ix=0; ix<N; ix++){
      const u0 = ix / N;
      const u1 = (ix+1) / N;

      // two triangles: (u0,v0)-(u1,v0)-(u1,v1) and (u0,v0)-(u1,v1)-(u0,v1)
      const p00 = applyHomography(H,u0,v0);
      const p10 = applyHomography(H,u1,v0);
      const p11 = applyHomography(H,u1,v1);
      const p01 = applyHomography(H,u0,v1);

      const uv00 = projectedUV(u0,v0,mat);
      const uv10 = projectedUV(u1,v0,mat);
      const uv11 = projectedUV(u1,v1,mat);
      const uv01 = projectedUV(u0,v1,mat);

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
  function inferQuadFromContour(imgPts){
    if(!imgPts || imgPts.length < 4) return null;
    let cx=0; for(const p of imgPts) cx+=p.x; cx/=imgPts.length;
    let left=imgPts.filter(p=>p.x<=cx);
    let right=imgPts.filter(p=>p.x>cx);
    if(left.length<2 || right.length<2){
      // fallback split by median X
      const xs=imgPts.map(p=>p.x).sort((a,b)=>a-b);
      const med=xs[Math.floor(xs.length/2)]||cx;
      left=imgPts.filter(p=>p.x<=med);
      right=imgPts.filter(p=>p.x>med);
    }
    if(left.length<2 || right.length<2) return null;
    const farL=left.reduce((a,b)=> (b.y<a.y?b:a));
    const nearL=left.reduce((a,b)=> (b.y>a.y?b:a));
    const farR=right.reduce((a,b)=> (b.y<a.y?b:a));
    const nearR=right.reduce((a,b)=> (b.y>a.y?b:a));
    // Ensure a reasonable trapezoid (near should be below far)
    if(nearL.y <= farL.y || nearR.y <= farR.y) return null;
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
      let H=null, gridN=28;
      const quadImg = inferQuadFromContour(zone.contour);
      if(quadImg){
        const quad = orderQuadCCW(quadImg.map(imgToCanvasPt));
        H = homographyUnitSquareToQuad(quad);
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
        ctx.save();
        ctx.globalAlpha=1;
        ctx.globalCompositeOperation="source-over";
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

      lctx.globalAlpha=mat.params.opacity??0.85;
      lctx.globalCompositeOperation=mat.params.blendMode??"multiply";

      if(usePerspective){
        // Project tiled pattern through homography (AR-like "floor going into distance")
        const patternCanvas = buildPatternCanvas(img);
        const matTmp = {params: mat.params, _texW: img.width, _texH: img.height};
        drawProjectedTiledPlane(lctx, H, matTmp, patternCanvas, gridN);
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
      ctx.globalAlpha=1;
      ctx.globalCompositeOperation="source-over";
      ctx.drawImage(layer,0,0);
      ctx.restore();
    }catch(e){
      // ignore
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
    const p=imgToCanvasPt(imgPt),r=6*dpr;
    ctx.beginPath();ctx.fillStyle=color;ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle="rgba(0,0,0,0.5)";ctx.lineWidth=2*dpr;ctx.stroke();
    if(showIdx){ctx.fillStyle="rgba(0,0,0,0.65)";ctx.font=`${10*dpr}px sans-serif`;ctx.fillText(String(idx+1),p.x+8*dpr,p.y-8*dpr);}
  }

  function drawPlaneOverlay(){
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
    for(const zone of state.zones){
      if(!zone.contour||zone.contour.length<2)continue;
      const isActive=zone.id===state.ui.activeZoneId;
      ctx.strokeStyle=isActive?"rgba(0,229,255,0.95)":"rgba(255,255,255,0.35)";
      ctx.lineWidth=(isActive?3.8:2.2)*dpr;
      ctx.beginPath();
      const p0=imgToCanvasPt(zone.contour[0]);ctx.moveTo(p0.x,p0.y);
      for(let i=1;i<zone.contour.length;i++){const p=imgToCanvasPt(zone.contour[i]);ctx.lineTo(p.x,p.y);} 
      if(zone.closed && zone.contour.length>=3){ctx.closePath();ctx.fillStyle=isActive?"rgba(0,229,255,0.08)":"rgba(255,255,255,0.05)";ctx.fill();}
      ctx.stroke();
      if(isActive&&state.ui.mode==="contour"){for(let i=0;i<zone.contour.length;i++) drawPoint(zone.contour[i],i,true);}
      for(const c of (zone.cutouts||[])){
        if(!c.polygon||c.polygon.length<2)continue;
        const isCut=isActive&&(c.id===state.ui.activeCutoutId);
        ctx.strokeStyle=isCut?"rgba(255,77,79,0.95)":"rgba(255,77,79,0.45)";
        ctx.lineWidth=(isCut?3.2:2.0)*dpr;
        ctx.beginPath();
        const q0=imgToCanvasPt(c.polygon[0]);ctx.moveTo(q0.x,q0.y);
        for(let i=1;i<c.polygon.length;i++){const q=imgToCanvasPt(c.polygon[i]);ctx.lineTo(q.x,q.y);} 
        if(c.closed && c.polygon.length>=3){ctx.closePath();ctx.fillStyle="rgba(255,77,79,0.10)";ctx.fill();}
        ctx.stroke();
        if(isCut&&state.ui.mode==="cutout"){for(let i=0;i<c.polygon.length;i++) drawPoint(c.polygon[i],i,true,"rgba(255,77,79,1)");}
      }
    }
    ctx.restore();
  }

  function getOpenPolyForMode(){
    if(state.ui.mode==="plane"){
      return {kind:"plane", points:state.floorPlane.points, closed:state.floorPlane.closed};
    }
    const zone=getActiveZone();
    if(!zone) return null;
    if(state.ui.mode==="contour"){
      return {kind:"contour", points:zone.contour, closed:zone.closed, zone};
    }
    if(state.ui.mode==="cutout"){
      const cut=getActiveCutout(zone);
      if(!cut) return null;
      return {kind:"cutout", points:cut.polygon, closed:cut.closed, zone, cutout:cut};
    }
    return null;
  }

  function drawLivePreview(){
    if(!DASH_PREVIEW) return;
    if(state.ui.isPointerDown) return;
    if(!hoverCanvas) return;
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
    ctx.save();ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle="#0b0e14";ctx.fillRect(0,0,canvas.width,canvas.height);

    const rect=getImageRectInCanvas();
    if(state.assets.photoBitmap){
      ctx.drawImage(state.assets.photoBitmap,rect.x,rect.y,rect.w,rect.h);
    }else{
      ctx.fillStyle="rgba(255,255,255,0.06)";ctx.fillRect(rect.x,rect.y,rect.w,rect.h);
      ctx.fillStyle="rgba(255,255,255,0.65)";ctx.font=`${14*dpr}px sans-serif`;
      ctx.fillText("Загрузите фотографию",rect.x+18*dpr,rect.y+28*dpr);
    }

    for(const zone of state.zones){ if(zone.enabled) await drawZoneFill(zone); }

    drawPlaneOverlay();
    drawZonesOverlay();
    drawLivePreview();
    ctx.restore();
  }

  function onPointerDown(ev){
  state.ui.isPointerDown=true;
  try{ canvas.setPointerCapture(ev.pointerId); }catch(_){}
  const pt=eventToImgPt(ev);
  const zone=getActiveZone();const cut=getActiveCutout(zone);

  // Reset pending close candidate each pointerdown
  pendingClose = null;

  let target=null;

  // Unified editing: the "floor plane" is always present (4 draggable handles).
  // This avoids a separate "plane placing" mode and reduces user steps.
  const pIdx=findNearest(state.floorPlane.points,pt);
  if(pIdx!==null){
    target={kind:"plane",idx:pIdx};
  }else if(state.ui.mode==="contour"&&zone){
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
      render();
      return;
    }
    pushHistory();
    zone.contour.push(pt);
    zone.closed=false;
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
      if(drag.kind==="plane"){state.floorPlane.points[drag.idx]=pt;}
      else{
        const zone=getActiveZone();if(!zone)return;
        if(drag.kind==="contour"){zone.contour[drag.idx]=pt;}
        else if(drag.kind==="cutout"){const cut=getActiveCutout(zone);if(!cut)return;cut.polygon[drag.idx]=pt;}
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
      pendingClose=null;
    }
    // If user dragged the last point near the first point, auto-close.
    if(state.ui.draggingPoint){
      maybeAutoCloseOnDragRelease();
    }
    state.ui.draggingPoint=null;
    try{canvas.releasePointerCapture(ev && ev.pointerId);}catch(_){}
    render();
  }
  function deleteSelectedPoint(){
    const sel=state.ui.selectedPoint;if(!sel)return false;
    pushHistory();
    if(sel.kind==="plane"){ state.floorPlane.points.splice(sel.idx,1); if(state.floorPlane.points.length<4) state.floorPlane.closed=false; }
    else{
      const zone=getActiveZone();if(!zone)return false;
      if(sel.kind==="contour"){ zone.contour.splice(sel.idx,1); if(zone.contour.length<3) zone.closed=false; }
      else if(sel.kind==="cutout"){const cut=getActiveCutout(zone);if(!cut)return false;cut.polygon.splice(sel.idx,1); if(cut.polygon.length<3) cut.closed=false;}
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
    const map={photo:"Загрузите фото или замените его.",plane:"Контур: ставьте точки по краю зоны и замкните к первой точке (магнит). Плоскость определяется автоматически. Точки можно двигать.",contour:"Контур зоны: ставьте точки по краю и замкните, кликнув рядом с первой точкой. После замыкания текстура начнёт применяться.",cutout:"Вырез: обведите объект точками и замкните рядом с первой точкой — вырез исключит область из заливки.",view:"Просмотр: меняйте материалы, сохраняйте результат."};
    setHint(map[mode]||"");render();
  }
  function exportPNG(){
    const a=document.createElement("a");
    a.download="paving_preview.png";
    a.href=canvas.toDataURL("image/png");
    a.click();
  }
  return {init,bindInput,render,resize,setMode,exportPNG};
})();
