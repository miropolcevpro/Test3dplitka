/*
  Auto-contour (Beta)

  Goal:
  - Provide a fast "auto outline" for the paving area after a photo is loaded.
  - Must NEVER break the main app: on any error, fall back to a safe trapezoid.
  - Output is a polygon in image pixel coordinates that the user can refine manually.

  Design:
  - Runs in a Worker with OpenCV.js (same local-first approach as ai_auto_calib).
  - No changes to WebGL compositor / export pipeline.
*/
(function(){
  const S = window.PhotoPaveState;
  if(!S || !S.state) return;
  const state = S.state;

  function _absUrl(rel){
    try{ return new URL(rel, document.baseURI).toString(); }catch(_){ return rel; }
  }

  function _fallbackTrapezoid(w,h){
    // A conservative bottom-up paving guess. User can adjust points.
    const m = Math.round(Math.min(w,h) * 0.06);
    const topY = Math.round(h * 0.42);
    return [
      {x: m, y: h - m},
      {x: w - m, y: h - m},
      {x: w - Math.round(w*0.18), y: topY},
      {x: Math.round(w*0.18), y: topY}
    ];
  }

  let _w = null;
  let _readyP = null;
  let _reqId = 1;
  const _pending = new Map();

  function _ensureWorker(){
    if(_readyP) return _readyP;
    _readyP = (async ()=>{
      if(typeof Worker === 'undefined') throw new Error('Worker not supported');
      const url = _absUrl('js/ai_auto_contour_worker.js');
      _w = new Worker(url);
      _w.onmessage = (ev)=>{
        const msg = ev.data || {};
        if(msg.type === 'result' || msg.type === 'error'){
          const p = _pending.get(msg.id);
          if(p){
            _pending.delete(msg.id);
            (msg.type === 'result' ? p.resolve : p.reject)(msg.payload);
          }
        }
      };
      _w.onerror = (e)=>{
        for(const [id,p] of _pending.entries()){
          _pending.delete(id);
          p.reject(new Error('Worker error: ' + (e?.message || 'unknown')));
        }
      };

      // Init with OpenCV candidates (absolute)
      const candidates = [
        _absUrl('assets/vendor/opencv/opencv.js'),
        'https://docs.opencv.org/4.x/opencv.js',
        'https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js'
      ];
      const id = _reqId++;
      const initP = new Promise((resolve,reject)=>{
        _pending.set(id, {resolve, reject});
        const t = setTimeout(()=>{
          _pending.delete(id);
          reject(new Error('AutoContour worker init timeout'));
        }, 12000);
        _pending.get(id).resolve = (payload)=>{ clearTimeout(t); resolve(payload); };
        _pending.get(id).reject  = (payload)=>{ clearTimeout(t); reject(payload instanceof Error ? payload : new Error(String(payload))); };
      });
      _w.postMessage({ type:'init', id, candidates });
      await initP;
      return true;
    })();
    return _readyP;
  }

  async function run(){
    const bmp = state.assets?.photoBitmap;
    const w0 = state.assets?.photoW|0;
    const h0 = state.assets?.photoH|0;
    if(!bmp || !w0 || !h0) throw new Error('Photo not loaded');

    // Fast status hook (if API is available)
    try{ window.PhotoPaveAPI?.setStatus?.('Автоконтур: анализ фото…'); }catch(_){ }

    // Try OpenCV worker first.
    let poly = null;
    try{
      await _ensureWorker();

      // Downscale on the main thread (cheap) and send ImageData to Worker.
      const longSide = 720;
      let dw=w0, dh=h0;
      if(Math.max(w0,h0) > longSide){
        if(w0>=h0){ dw=longSide; dh=Math.round((h0/w0)*dw); }
        else { dh=longSide; dw=Math.round((w0/h0)*dh); }
      }
      dw = Math.max(1, dw|0); dh = Math.max(1, dh|0);
      const c = document.createElement('canvas');
      c.width = dw; c.height = dh;
      const ctx = c.getContext('2d', { willReadFrequently:true });
      ctx.drawImage(bmp, 0, 0, dw, dh);
      const imageData = ctx.getImageData(0,0,dw,dh);

      const id = _reqId++;
      const p = new Promise((resolve,reject)=>{
        _pending.set(id, {resolve, reject});
        const t = setTimeout(()=>{
          _pending.delete(id);
          reject(new Error('AutoContour timeout'));
        }, 8000);
        _pending.get(id).resolve = (payload)=>{ clearTimeout(t); resolve(payload); };
        _pending.get(id).reject  = (payload)=>{ clearTimeout(t); reject(payload instanceof Error ? payload : new Error(String(payload))); };
      });

      _w.postMessage({ type:'run', id, longSide, imageData, candidates: [
        _absUrl('assets/vendor/opencv/opencv.js'),
        'https://docs.opencv.org/4.x/opencv.js',
        'https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js'
      ]});
      const out = await p;

      // Worker returns points in downscaled coordinates with scale back factors.
      if(out && out.ok && Array.isArray(out.points) && out.points.length >= 3){
        const sx = w0 / (out.w||dw);
        const sy = h0 / (out.h||dh);
        poly = out.points.map(p=>({x: p.x * sx, y: p.y * sy}));
      }
    }catch(e){
      // Worker failed; fall back.
      poly = null;
    }

    if(!poly || poly.length < 3){
      poly = _fallbackTrapezoid(w0,h0);
    }

    try{ window.PhotoPaveAPI?.setStatus?.('Автоконтур: готово'); }catch(_){ }
    return poly;
  }

  window.PhotoPaveAutoContour = {
    run,
    _fallbackTrapezoid
  };
})();
