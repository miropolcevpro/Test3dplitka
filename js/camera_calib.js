(function(){
  "use strict";

  const EPS = 1e-9;

  const _isNum = (v)=> typeof v === "number" && isFinite(v);
  const _clamp = (v,a,b)=> Math.max(a, Math.min(b, v));
  const _sub = (a,b)=> ({x:a.x-b.x, y:a.y-b.y});
  const _dot = (a,b)=> a.x*b.x + a.y*b.y;
  const _len = (v)=> Math.hypot(v.x, v.y);
  const _norm = (v)=>{ const L=_len(v); return (L>EPS)? {x:v.x/L, y:v.y/L} : {x:0,y:0}; };

  function lineFromPts(p1, p2){
    if(!p1 || !p2) return null;
    if(!_isNum(p1.x)||!_isNum(p1.y)||!_isNum(p2.x)||!_isNum(p2.y)) return null;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const L = Math.hypot(dx, dy);
    if(L < 2) return null;
    // line in implicit form: a*x + b*y + c = 0
    // normal n = (dy, -dx)
    let a = dy;
    let b = -dx;
    let c = -(a*p1.x + b*p1.y);
    // normalize (a,b) to unit for stability
    const nL = Math.hypot(a,b);
    if(nL < EPS) return null;
    a/=nL; b/=nL; c/=nL;
    const dir = {x: dx/L, y: dy/L};
    return {a,b,c, dir};
  }

  function intersectLines(L1, L2){
    if(!L1 || !L2) return {ok:false, reason:"missing"};
    const {a:a1,b:b1,c:c1} = L1;
    const {a:a2,b:b2,c:c2} = L2;
    const det = a1*b2 - a2*b1;
    if(Math.abs(det) < 1e-6) return {ok:false, reason:"parallel"};
    const x = (b1*c2 - b2*c1)/det;
    const y = (c1*a2 - c2*a1)/det;
    if(!isFinite(x) || !isFinite(y)) return {ok:false, reason:"nan"};
    return {ok:true, x, y};
  }

  
  function _absDot2(a,b){ return Math.abs((a.x*b.x + a.y*b.y)); }
  function _sinAngleFromDirs(d1, d2){
    if(!d1 || !d2) return 0;
    const c = Math.max(-1, Math.min(1, d1.x*d2.x + d1.y*d2.y));
    const s2 = Math.max(0, 1 - c*c);
    return Math.sqrt(s2);
  }
function _softClamp01(v){
    const x = +v;
    if(!isFinite(x)) return 0.5;
    const delta = _clamp(x - 0.5, -0.35, 0.35);
    return 0.5 + delta;
  }

  function deriveControlsFromVanish(vanishNorm){
    const vy = _softClamp01(vanishNorm && vanishNorm.y);
    const autoH = _clamp((vy - 0.5) * 1.8, -1, 1);
    const autoP = _clamp(0.78 + (0.5 - vy) * 0.55, 0.45, 1.0);
    return { autoHorizon:autoH, autoPerspective:autoP, vy };
  }

  function computeFromLines(lines, imgW, imgH){
    const W = Math.max(1, imgW||1);
    const H = Math.max(1, imgH||1);
    const c = {x: W*0.5, y: H*0.5};

    const A1 = lineFromPts(lines && lines.A1 && lines.A1.p1, lines && lines.A1 && lines.A1.p2);
    const A2 = lineFromPts(lines && lines.A2 && lines.A2.p1, lines && lines.A2 && lines.A2.p2);
    const B1 = lineFromPts(lines && lines.B1 && lines.B1.p1, lines && lines.B1 && lines.B1.p2);
    const B2 = lineFromPts(lines && lines.B2 && lines.B2.p1, lines && lines.B2 && lines.B2.p2);

    // Reject near-parallel line pairs early to avoid huge, unstable vanishing points.
    if(A1 && A2 && A1.dir && A2.dir){
      const sA = _sinAngleFromDirs(A1.dir, A2.dir);
      if(sA < 0.035) return {ok:false, reason:"vanishA:near_parallel"};
    }
    const iA = intersectLines(A1, A2);
    if(!iA.ok) return {ok:false, reason:"vanishA:"+iA.reason};
    if(B1 && B2 && B1.dir && B2.dir){
      const sB = _sinAngleFromDirs(B1.dir, B2.dir);
      if(sB < 0.035) return {ok:false, reason:"vanishB:near_parallel"};
    }
    const iB = intersectLines(B1, B2);
    if(!iB.ok) return {ok:false, reason:"vanishB:"+iB.reason};

    const VA = {x:iA.x, y:iA.y};
    const VB = {x:iB.x, y:iB.y};

    // Outlier guard: extremely distant vanishing points usually mean noisy/near-parallel lines.
    const distApx = Math.hypot(VA.x - c.x, VA.y - c.y);
    const distBpx = Math.hypot(VB.x - c.x, VB.y - c.y);
    const distMax = 60 * Math.max(W, H);
    if(distApx > distMax || distBpx > distMax){
      return {ok:false, reason:"vanish:outlier"};
    }

    // Estimate focal length from orthogonality constraint of vanishing points.
    // (VA - c)·(VB - c) + f^2 = 0
    const da = _sub(VA, c);
    const db = _sub(VB, c);
    const f2 = -_dot(da, db);
    if(!(f2 > 50)){
      // Too small/negative => inconsistent lines (not orthogonal or too noisy)
      return {ok:false, reason:"invalid_focal"};
    }
    let f = Math.sqrt(f2);
    // Guard f to reasonable range (in pixels) to avoid unstable projections.
    const fMin = 0.25 * Math.max(W, H);
    const fMax = 6.0 * Math.max(W, H);
    if(!(f>=fMin && f<=fMax)){
      return {ok:false, reason:"invalid_focal_range"};
    }

    // Horizon line through VA and VB: (y - VA.y) = m (x - VA.x)
    // Evaluate horizonY at x=cx for UX mapping.
    let horizonYpx = null;
    const dx = VB.x - VA.x;
    const dy = VB.y - VA.y;
    if(Math.abs(dx) > EPS){
      const m = dy/dx;
      horizonYpx = VA.y + m*(c.x - VA.x);
    }else{
      // Vertical horizon is unusual; fallback to average y.
      horizonYpx = 0.5*(VA.y + VB.y);
    }
    const horizonY = _clamp(horizonYpx / H, -2, 2);

    const vanishANorm = {x: VA.x/W, y: VA.y/H};
    const vanishBNorm = {x: VB.x/W, y: VB.y/H};

    const ctrl = deriveControlsFromVanish(vanishANorm);

    // Provide camera intrinsics K (canonical form) and basis vectors for future 3D renderer.
    const K = {f, cx:c.x, cy:c.y};

    // Direction vectors in camera coordinates (up to scale)
    // r1 ~ K^{-1} [VA.x, VA.y, 1]^T
    function KinvMul(v){
      return {x:(v.x - c.x)/f, y:(v.y - c.y)/f, z:1};
    }
    const r1 = KinvMul(VA);
    const r2 = KinvMul(VB);
    const n1 = Math.hypot(r1.x, r1.y, r1.z);
    const n2 = Math.hypot(r2.x, r2.y, r2.z);
    const R1 = {x:r1.x/n1, y:r1.y/n1, z:r1.z/n1};
    const R2raw = {x:r2.x/n2, y:r2.y/n2, z:r2.z/n2};

    // Orthonormalize R2 against R1 (Gram-Schmidt)
    const d12 = R1.x*R2raw.x + R1.y*R2raw.y + R1.z*R2raw.z;
    let R2 = {x:R2raw.x - d12*R1.x, y:R2raw.y - d12*R1.y, z:R2raw.z - d12*R1.z};
    const n2o = Math.hypot(R2.x, R2.y, R2.z);
    if(n2o > EPS){ R2 = {x:R2.x/n2o, y:R2.y/n2o, z:R2.z/n2o}; }

    // R3 = R1 x R2
    let R3 = {
      x: R1.y*R2.z - R1.z*R2.y,
      y: R1.z*R2.x - R1.x*R2.z,
      z: R1.x*R2.y - R1.y*R2.x
    };
    const n3 = Math.hypot(R3.x, R3.y, R3.z);
    if(n3 > EPS){ R3 = {x:R3.x/n3, y:R3.y/n3, z:R3.z/n3}; }

    const R = {
      // columns
      r1:R1,
      r2:R2,
      r3:R3
    };

    // Simple confidence heuristic: farther and stable vanishing points are better.
    const distA = Math.hypot(VA.x - c.x, VA.y - c.y);
    const distB = Math.hypot(VB.x - c.x, VB.y - c.y);
    const conf = _clamp(Math.min(distA, distB) / Math.max(200, Math.min(W,H)), 0, 1);

    return {
      ok:true,
      vanishA:VA,
      vanishB:VB,
      vanishANorm,
      vanishBNorm,
      horizonY,
      horizonLine:{p1:VA, p2:VB},
      K,
      R,
      confidence:conf,
      autoHorizon:ctrl.autoHorizon,
      autoPerspective:ctrl.autoPerspective
    };
  }

  // --- Auto (contour-based) calibration helpers ---
  // Provide a low-friction "auto" entry point based on the already drawn contour.
  // We infer two dominant directions from contour edges and build synthetic A1/A2/B1/B2
  // lines (endpoints from the longest contour segments in each direction cluster).
  // This is intended as a UX convenience; if the contour does not represent road edges,
  // the solver may reject it and the caller should fall back to the manual mode.

  function _wrapPi(a){
    // map angle to [0, PI)
    let x = a % Math.PI;
    if(x < 0) x += Math.PI;
    return x;
  }

  function _angleDist(a,b){
    // circular distance on [0, PI)
    const d = Math.abs(a-b);
    return Math.min(d, Math.PI - d);
  }

  function _histPeaks(angles, bins){
    const B = Math.max(8, bins|0);
    const h = new Array(B).fill(0);
    for(const a of angles){
      const ix = Math.max(0, Math.min(B-1, Math.floor((a/Math.PI)*B)));
      h[ix]++;
    }
    // pick top 2 peaks with separation
    let p1=-1, c1=-1;
    for(let i=0;i<B;i++){ if(h[i]>c1){ c1=h[i]; p1=i; } }
    if(p1<0) return null;
    let p2=-1, c2=-1;
    for(let i=0;i<B;i++){
      const sep = Math.abs(i-p1);
      if(sep < Math.max(2, Math.floor(B*0.12))) continue;
      if(h[i]>c2){ c2=h[i]; p2=i; }
    }
    if(p2<0) return null;
    const a1 = (p1 + 0.5) * (Math.PI / B);
    const a2 = (p2 + 0.5) * (Math.PI / B);
    return {a1, a2, c1, c2};
  }

  function autoLinesFromContour(contour, imgW, imgH, opts){
    // New auto heuristic (v2):
    // 1) Estimate "depth" axis vA using PCA (pick eigenvector closer to screen-up).
    // 2) Split contour samples into left/right rails by projection on vB (perp to vA) and fit TLS lines => A1/A2.
    // 3) Split into bottom/top bands by projection on vA and fit TLS lines => B1/B2.
    // This avoids failures where horizontal edges dominate, while matching the common "bottom->horizon" photo framing.

    const W = Math.max(1, imgW||1);
    const H = Math.max(1, imgH||1);
    const o = opts || {};
    const minLenPx = Math.max(18, (o.minLenPx||0), 0.05*Math.hypot(W,H));
    if(!Array.isArray(contour) || contour.length < 4) return {ok:false, reason:"contour_too_small"};

    // --- Resample contour edges to get stable statistics (avoid short-segment noise).
    const pts = [];
    for(let i=0;i<contour.length;i++){
      const p1 = contour[i];
      const p2 = contour[(i+1)%contour.length];
      if(!p1||!p2) continue;
      const dx = (p2.x - p1.x);
      const dy = (p2.y - p1.y);
      const L = Math.hypot(dx,dy);
      if(!(L>1)) continue;
      const steps = Math.max(1, Math.min(24, Math.floor(L/18)));
      for(let s=0;s<=steps;s++){
        const t = s/steps;
        pts.push({x:p1.x + dx*t, y:p1.y + dy*t});
      }
    }
    if(pts.length < 24) return {ok:false, reason:"contour_samples_weak"};

    // --- PCA on samples.
    let mx=0,my=0;
    for(const p of pts){ mx += p.x; my += p.y; }
    mx/=pts.length; my/=pts.length;
    let cxx=0,cxy=0,cyy=0;
    for(const p of pts){
      const x = p.x-mx, y = p.y-my;
      cxx += x*x; cxy += x*y; cyy += y*y;
    }
    cxx/=pts.length; cxy/=pts.length; cyy/=pts.length;

    // Eigenvectors of 2x2 covariance.
    const tr = cxx + cyy;
    const det = cxx*cyy - cxy*cxy;
    const disc = Math.max(0, tr*tr - 4*det);
    const sdisc = Math.sqrt(disc);
    const l1 = 0.5*(tr + sdisc);
    const l2 = Math.max(EPS, 0.5*(tr - sdisc));
    const elong = l1 / l2;

    // First eigenvector (for l1)
    // Handle near-diagonal covariance.
    let v1;
    if(Math.abs(cxy) > 1e-8){
      const a = l1 - cyy;
      const b = cxy;
      v1 = _norm({x:a, y:b});
    } else {
      v1 = (cxx >= cyy) ? {x:1,y:0} : {x:0,y:1};
    }
    // Second eigenvector is orthogonal.
    const v2 = {x:-v1.y, y:v1.x};

    // Choose vA as the eigenvector closer to screen-up (0,-1).
    const up = {x:0,y:-1};
    const d1 = Math.abs(_dot(v1, up));
    const d2 = Math.abs(_dot(v2, up));
    let vA = (d1 >= d2) ? v1 : v2;
    // Ensure vA points upward (y decreasing).
    if(vA.y > 0){ vA = {x:-vA.x, y:-vA.y}; }
    let vB = {x:-vA.y, y:vA.x};

    // If contour is too "round/square", PCA can be unreliable. Fallback to a
    // framing-based axis: connect centroid of bottom band to centroid of top band.
    const minElong = (o.minElong||1.18);
    if(elong < minElong){
      // bottom/top bands in screen Y (not PCA space)
      let yMin=+Infinity, yMax=-Infinity;
      for(const p of pts){ if(p.y<yMin) yMin=p.y; if(p.y>yMax) yMax=p.y; }
      const yRange = Math.max(EPS, yMax-yMin);
      const yBot = yMax - 0.12*yRange;
      const yTop = yMin + 0.12*yRange;
      let cbx=0,cby=0, ctn=0;
      let ctx=0,cty=0, cbn=0;
      for(const p of pts){
        if(p.y >= yBot){ cbx+=p.x; cby+=p.y; cbn++; }
        if(p.y <= yTop){ ctx+=p.x; cty+=p.y; ctn++; }
      }
      if(cbn>=6 && ctn>=6){
        const Cbot = {x:cbx/cbn, y:cby/cbn};
        const Ctop = {x:ctx/ctn, y:cty/ctn};
        const v = _sub(Ctop, Cbot);
        const L = _len(v);
        if(L > 20){
          vA = _norm(v);
          if(vA.y > 0){ vA = {x:-vA.x, y:-vA.y}; }
          vB = {x:-vA.y, y:vA.x};
        }
      }
    }

    // Projections for band selection.
    let minA=+Infinity, maxA=-Infinity, minB=+Infinity, maxB=-Infinity;
    const proj = new Array(pts.length);
    for(let i=0;i<pts.length;i++){
      const p = pts[i];
      const rx = p.x-mx, ry = p.y-my;
      const a = rx*vA.x + ry*vA.y;
      const b = rx*vB.x + ry*vB.y;
      proj[i] = {p, a, b};
      if(a<minA) minA=a; if(a>maxA) maxA=a;
      if(b<minB) minB=b; if(b>maxB) maxB=b;
    }
    const rangeA = Math.max(EPS, maxA-minA);
    const rangeB = Math.max(EPS, maxB-minB);

    // Band helper
    function pickBand(testFn, minCount){
      const out=[];
      for(const q of proj){ if(testFn(q)) out.push(q.p); }
      if(out.length >= (minCount||12)) return out;
      return out;
    }

    // Initial quantiles.
    let qSide = 0.26;
    let qDepth = 0.22;
    let left=[], right=[], bottom=[], top=[];
    for(let tries=0; tries<4; tries++){
      const bL = minB + qSide*rangeB;
      const bR = maxB - qSide*rangeB;
      const aBot = minA + qDepth*rangeA;
      const aTop = maxA - qDepth*rangeA;
      left = pickBand(q=>q.b <= bL, 14);
      right = pickBand(q=>q.b >= bR, 14);
      bottom = pickBand(q=>q.a <= aBot, 14);
      top = pickBand(q=>q.a >= aTop, 14);
      if(left.length>=14 && right.length>=14 && bottom.length>=14 && top.length>=14) break;
      qSide = Math.min(0.42, qSide + 0.06);
      qDepth = Math.min(0.36, qDepth + 0.05);
    }
    if(left.length < 10 || right.length < 10) return {ok:false, reason:"rails_weak"};
    if(bottom.length < 10 || top.length < 10) return {ok:false, reason:"bands_weak"};

    // TLS line fit
    function fitLineTLS(points){
      if(!points || points.length < 2) return null;
      let mx=0,my=0;
      for(const p of points){ mx+=p.x; my+=p.y; }
      mx/=points.length; my/=points.length;
      let cxx=0,cxy=0,cyy=0;
      for(const p of points){
        const x=p.x-mx, y=p.y-my;
        cxx += x*x; cxy += x*y; cyy += y*y;
      }
      cxx/=points.length; cxy/=points.length; cyy/=points.length;
      const tr = cxx+cyy;
      const det = cxx*cyy - cxy*cxy;
      const disc = Math.max(0, tr*tr - 4*det);
      const sdisc = Math.sqrt(disc);
      const l1 = 0.5*(tr + sdisc);
      let dir;
      if(Math.abs(cxy) > 1e-9){
        dir = _norm({x:(l1-cyy), y:cxy});
      } else {
        dir = (cxx >= cyy) ? {x:1,y:0} : {x:0,y:1};
      }
      // endpoints from projection spread
      let tMin=+Infinity, tMax=-Infinity;
      for(const p of points){
        const t = (p.x-mx)*dir.x + (p.y-my)*dir.y;
        if(t<tMin) tMin=t; if(t>tMax) tMax=t;
      }
      const p1 = {x:mx + dir.x*tMin, y:my + dir.y*tMin};
      const p2 = {x:mx + dir.x*tMax, y:my + dir.y*tMax};
      if(Math.hypot(p2.x-p1.x, p2.y-p1.y) < minLenPx) return null;
      return {p1,p2, dir};
    }

    const A1 = fitLineTLS(left);
    const A2 = fitLineTLS(right);
    const B1 = fitLineTLS(bottom);
    const B2 = fitLineTLS(top);
    if(!A1 || !A2 || !B1 || !B2) return {ok:false, reason:"fit_failed"};

    // Sanity: avoid near-parallel pairs (will explode vanishing). If too parallel, reject.
    const sA = _sinAngleFromDirs(A1.dir, A2.dir);
    const sB = _sinAngleFromDirs(B1.dir, B2.dir);
    if(sA < 0.02) return {ok:false, reason:"A_pair_near_parallel", meta:{sA}};
    if(sB < 0.02) return {ok:false, reason:"B_pair_near_parallel", meta:{sB}};

    const lines = {
      A1:{p1:A1.p1, p2:A1.p2},
      A2:{p1:A2.p1, p2:A2.p2},
      B1:{p1:B1.p1, p2:B1.p2},
      B2:{p1:B2.p1, p2:B2.p2}
    };

    return {ok:true, lines, meta:{minLenPx, samples:pts.length, elongation:elong, qSide, qDepth}};
  }

  window.PhotoPaveCameraCalib = {
    lineFromPts,
    intersectLines,
    computeFromLines,
    autoLinesFromContour
  };
})();
