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

  window.PhotoPaveCameraCalib = {
    lineFromPts,
    intersectLines,
    computeFromLines
  };
})();
