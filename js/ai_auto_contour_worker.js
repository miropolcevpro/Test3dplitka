/*
  AutoContour Worker (OpenCV.js)

  Protocol:
    - {type:'init', id, candidates:[url,...]}
    - {type:'run', id, longSide, imageData:{width,height,data}}

  Returns:
    - {type:'result', id, payload:{ok:true, points:[{x,y},...], w,h}}
    - {type:'error',  id, payload:'...'}
*/

let _cvReady = false;
let _cvInitP = null;

function _loadScript(url){
  return new Promise((resolve,reject)=>{
    try{
      importScripts(url);
      resolve(true);
    }catch(e){
      reject(e);
    }
  });
}

async function ensureCV(candidates){
  if(_cvReady && self.cv) return true;
  if(_cvInitP) return _cvInitP;

  _cvInitP = (async ()=>{
    let lastErr=null;
    for(const u of (candidates||[])){
      try{
        await _loadScript(u);
        if(self.cv){
          // Wait for runtime init if present
          if(cv && typeof cv.onRuntimeInitialized === 'function'){
            await new Promise((res,rej)=>{
              const t=setTimeout(()=>rej(new Error('cv init timeout')), 8000);
              cv.onRuntimeInitialized = ()=>{ clearTimeout(t); res(true); };
            });
          }
          _cvReady = true;
          return true;
        }
      }catch(e){
        lastErr = e;
      }
    }
    throw lastErr || new Error('Failed to load OpenCV');
  })();

  return _cvInitP;
}

function _clamp(v,a,b){ return v<a?a:(v>b?b:v); }

function _autoContourFromImageData(imageData){
  const w = imageData.width|0;
  const h = imageData.height|0;
  if(!w || !h) throw new Error('bad image');

  const src = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3,3));
  const dil = new cv.Mat();

  try{
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5,5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(blur, edges, 60, 160);
    cv.dilate(edges, dil, kernel);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(dil, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    let bestIdx=-1;
    let bestScore=-1;

    for(let i=0;i<contours.size();i++){
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if(area < (w*h*0.02)) { c.delete(); continue; }
      const rect = cv.boundingRect(c);
      // Prefer contours that touch lower part (paving usually bottom)
      const bottomTouch = (rect.y + rect.height) / h;
      const yBias = Math.max(0, bottomTouch - 0.55); // 0..0.45
      const score = area * (1.0 + yBias*1.6);
      if(score > bestScore){ bestScore=score; bestIdx=i; }
      c.delete();
    }

    let pts=[];
    if(bestIdx>=0){
      const c = contours.get(bestIdx);
      const peri = cv.arcLength(c, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.01*peri, true);
      // Convert approx to points
      for(let i=0;i<approx.rows;i++){
        const x = approx.intAt(i,0);
        const y = approx.intAt(i,1);
        pts.push({x:+x, y:+y});
      }
      approx.delete();
      c.delete();
    }

    contours.delete();
    hierarchy.delete();

    // Sanity + simplify to max 64
    if(pts.length > 64){
      const step = pts.length/64;
      const out=[];
      for(let i=0;i<64;i++) out.push(pts[Math.floor(i*step)]);
      pts = out;
    }

    // Clamp points
    pts = pts.map(p=>({x:_clamp(p.x,0,w-1), y:_clamp(p.y,0,h-1)}));
    if(pts.length < 3) return { ok:false, points:[], w, h };
    return { ok:true, points:pts, w, h };
  }finally{
    src.delete(); gray.delete(); blur.delete(); edges.delete(); kernel.delete(); dil.delete();
  }
}

self.onmessage = async (ev)=>{
  const msg = ev.data || {};
  const id = msg.id;
  try{
    if(msg.type === 'init'){
      await ensureCV(msg.candidates);
      self.postMessage({type:'result', id, payload:{ok:true}});
      return;
    }
    if(msg.type === 'run'){
      await ensureCV(msg.candidates || []);
      const imageData = msg.imageData;
      if(!imageData) throw new Error('missing imageData');
      const res = _autoContourFromImageData(imageData);
      self.postMessage({type:'result', id, payload:res});
      return;
    }
  }catch(e){
    self.postMessage({type:'error', id, payload: String(e && (e.message||e) || e)});
  }
};
