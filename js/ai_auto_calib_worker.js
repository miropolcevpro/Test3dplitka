self.onunhandledrejection = (e)=>{
  try{ self.postMessage({type:'fatal', id: _lastRunId, error: String(e && (e.reason||e.message||e))}); }catch(_){ }
};

/*
  AI Auto-calibration Worker (OpenCV.js)
  - Loads OpenCV.js (single-file preferred) in a Worker via importScripts().
  - Runs Canny + HoughLinesP to estimate vanishing point and derives:
      - horizonY (normalized)
      - planeDir (normalized, forced to point "up" i.e., y < 0)
      - confidence score
  - Designed to avoid main-thread freezes in iframe/Tilda environments.
*/
let _cv = null;
let _lastRunId = null;

function _norm2(v){
  const l = Math.hypot(v.x, v.y) || 1e-9;
  return {x: v.x/l, y: v.y/l};
}

function _clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }

function _intersect(l1,l2){
  const x1=l1.x1,y1=l1.y1,x2=l1.x2,y2=l1.y2;
  const x3=l2.x1,y3=l2.y1,x4=l2.x2,y4=l2.y2;
  const den = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4);
  if(Math.abs(den) < 1e-6) return null;
  const px = ((x1*y2-y1*x2)*(x3-x4) - (x1-x2)*(x3*y4-y3*x4)) / den;
  const py = ((x1*y2-y1*x2)*(y3-y4) - (y1-y2)*(x3*y4-y3*x4)) / den;
  if(!isFinite(px) || !isFinite(py)) return null;
  return {x:px,y:py};
}

function _histogramPick(points, w, h){
  if(!points.length) return null;
  const xmin = -0.5*w, xmax = 1.5*w;
  const ymin = -0.5*h, ymax = 1.5*h;
  const gx=24, gy=24;
  const bins = new Array(gx*gy).fill(0);
  const sums = new Array(gx*gy).fill(0).map(()=>({x:0,y:0,n:0}));

  for(const p of points){
    if(p.x<xmin||p.x>xmax||p.y<ymin||p.y>ymax) continue;
    const ix = Math.max(0, Math.min(gx-1, Math.floor(((p.x-xmin)/(xmax-xmin))*gx)));
    const iy = Math.max(0, Math.min(gy-1, Math.floor(((p.y-ymin)/(ymax-ymin))*gy)));
    const idx = iy*gx + ix;
    bins[idx]++;
    sums[idx].x += p.x;
    sums[idx].y += p.y;
    sums[idx].n += 1;
  }
  let best=-1, bestCount=0;
  for(let i=0;i<bins.length;i++){
    if(bins[i] > bestCount){ bestCount=bins[i]; best=i; }
  }
  if(best<0 || bestCount<4) return null;
  const s=sums[best];
  return {x:s.x/(s.n||1), y:s.y/(s.n||1), count:bestCount};
}

function _computeVanishingFromBitmap(cv, bitmap, longSide){
  const bw = bitmap?.width || 1;
  const bh = bitmap?.height || 1;
  let w=bw,h=bh;
  const ls=Math.max(bw,bh);
  if(ls>longSide){
    const sc=longSide/ls;
    w=Math.max(1, Math.round(bw*sc));
    h=Math.max(1, Math.round(bh*sc));
  }
  const canvas = new OffscreenCanvas(w,h);
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  ctx.drawImage(bitmap,0,0,w,h);
  const img = ctx.getImageData(0,0,w,h);
  // Build mats
  const src = cv.matFromImageData(img);
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
  cv.GaussianBlur(gray, blur, new cv.Size(5,5), 1.2, 1.2, cv.BORDER_DEFAULT);
  cv.Canny(blur, edges, 60, 150, 3, false);

  const lines = new cv.Mat();
  // HoughLinesP: rho=1, theta=pi/180, threshold=60, minLineLength=30, maxLineGap=10
  cv.HoughLinesP(edges, lines, 1, Math.PI/180, 60, 30, 10);

  const all = [];
  for(let i=0;i<lines.rows;i++){
    const x1=lines.data32S[i*4+0], y1=lines.data32S[i*4+1];
    const x2=lines.data32S[i*4+2], y2=lines.data32S[i*4+3];
    const dx=x2-x1, dy=y2-y1;
    const len=Math.hypot(dx,dy);
    if(len<25) continue;
    // filter near-horizontal and near-vertical
    if(Math.abs(dy) < 4) continue;
    if(Math.abs(dx) < 4) continue;
    const midY=(y1+y2)/2;
    all.push({x1,y1,x2,y2,len,midY});
  }

  // Outdoor profile: prefer bottom-half lines if enough
  const bottom = all.filter(l=>l.midY >= 0.48*h);
  const useBottom = bottom.length >= 18;
  const chosen = (useBottom ? bottom : all).sort((a,b)=>b.len-a.len).slice(0,80);

  // intersections
  const pts = [];
  for(let i=0;i<chosen.length;i++){
    for(let j=i+1;j<chosen.length;j++){
      const p=_intersect(chosen[i], chosen[j]);
      if(!p) continue;
      pts.push(p);
    }
  }
  const pick = _histogramPick(pts, w, h);
  // Cleanup mats
  src.delete(); gray.delete(); blur.delete(); edges.delete(); lines.delete();

  if(!pick){
    return { ok:false, reason:"no_vanish", w,h, lines: all.length, bottom: bottom.length };
  }

  // vanishing raw normalized (may be outside 0..1)
  const vx = pick.x / w;
  const vy = pick.y / h;

  // Compute planeDir from bottom center to vanish point
  let dir = _norm2({ x: (pick.x - 0.5*w), y: (pick.y - 0.98*h) });
  // Force "forward" to be up (y < 0)
  if(dir.y > -0.05){
    dir = {x:-dir.x, y:-dir.y};
  }

  // confidence heuristic: bin count + number of good lines
  const base = Math.min(1, pick.count / 14);
  const lineScore = Math.min(1, chosen.length / 45);
  const conf = _clamp(0.15 + 0.55*base + 0.30*lineScore + (useBottom ? 0.08 : 0), 0, 1);

  // horizon: soft clamp to avoid extremes
  const horizon = _clamp(vy, 0.15, 0.85);

  return {
    ok:true,
    vanishRaw: {x: vx, y: vy},
    horizonY: horizon,
    planeDir: dir,
    confidence: conf,
    meta: {
      linesAll: all.length,
      linesChosen: chosen.length,
      useBottom,
      pickCount: pick.count
    }
  };
}

async function _loadOpenCV(candidates){
  let lastErr = null;
  for(const url of candidates){
    try{
      // Ensure Module exists for emscripten builds; preserve if already set.
      if(!self.Module) self.Module = {};
      // Many builds set cv.onRuntimeInitialized; but in worker we can hook Module.onRuntimeInitialized too.
      await new Promise((resolve, reject)=>{
        let done=false;
        const t=setTimeout(()=>{ if(done) return; done=true; reject(new Error("importScripts timeout")); }, 12000);
        try{
          importScripts(url);
          done=true;
          clearTimeout(t);
          resolve(true);
        }catch(e){
          done=true;
          clearTimeout(t);
          reject(e);
        }
      });
      // OpenCV attaches cv global
      if(self.cv && self.cv.Mat){
        return self.cv;
      }
      // Some builds call cv.onRuntimeInitialized
      if(self.cv){
        await new Promise((resolve,reject)=>{
          let done=false;
          const t=setTimeout(()=>{ if(done) return; done=true; reject(new Error("OpenCV init timeout")); }, 12000);
          const prev = self.cv.onRuntimeInitialized;
          self.cv.onRuntimeInitialized = ()=>{
            if(done) return;
            try{ if(typeof prev === "function") prev(); }catch(_){}
            done=true; clearTimeout(t); resolve(true);
          };
        });
        if(self.cv && self.cv.Mat) return self.cv;
      }
      throw new Error("cv missing after load: " + url);
    }catch(e){
      lastErr = e;
    }
  }
  throw lastErr || new Error("OpenCV load failed");
}

self.onmessage = async (ev)=>{
  const msg = ev.data || {};
  const id = msg.id;
  try{
    if(msg.type === "init"){
      const candidates = msg.candidates || [];
      _cv = await _loadOpenCV(candidates);
      self.postMessage({type:"result", id, payload:{ok:true}});
      return;
    }
    _lastRunId = id;
    if(msg.type === "run"){
      if(!_cv) throw new Error("OpenCV not initialized");
      const bitmap = msg.bitmap;
      const longSide = msg.longSide || 640;
      const r = _computeVanishingFromBitmap(_cv, bitmap, longSide);
      try{ bitmap.close && bitmap.close(); }catch(_){}
      self.postMessage({type:"result", id, payload:r});
      return;
    }
  }catch(e){
    self.postMessage({type:"error", id, payload: (e && e.message) ? e.message : String(e) });
  }
};
