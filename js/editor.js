
window.PhotoPaveEditor=(function(){
  const {state,getActiveZone,getActiveCutout,pushHistory}=window.PhotoPaveState;
  const {loadImage}=window.PhotoPaveAPI;
  let canvas,ctx,dpr=1;
  const setHint=(t)=>{const el=document.getElementById("hintText");if(el)el.textContent=t||"";};

  // Interaction tuning in CSS pixels (converted to canvas pixels via boundingClientRect scale)
  const HIT_RADIUS_CSS = 14;      // point pick radius
  const SNAP_CLOSE_CSS = 18;      // close-to-first snap radius
  const DRAG_AUTOCLOSE_CSS = 14;  // if dragging last point near first and release -> auto close
  const DASH_PREVIEW = true;

  // Hover/preview state (canvas pixel coords)
  let hoverCanvas = null;
  let hoverCloseCandidate = false;

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

  async function drawZoneFill(zone){
    const mat=zone.material;
    if(!mat||!mat.textureUrl||!zone.closed||zone.contour.length<3)return;
    try{
      const img=await loadImage(mat.textureUrl);
      const rect=getImageRectInCanvas();

      // Build a lightweight cache key so that after closing a contour we treat the fill as a separate "layer"
      // and only re-render it when geometry/material changes.
      const keyParts=[
        mat.textureUrl,
        String(mat.params.scale??1),
        String(mat.params.rotation??0),
        String(mat.params.opacity??1),
        String(mat.params.blendMode??"multiply"),
        String(zone.contour.length)
      ];
      const rp=(p)=>`${Math.round(p.x*10)/10},${Math.round(p.y*10)/10}`;
      keyParts.push(zone.contour.map(rp).join(";"));
      for(const c of (zone.cutouts||[])){
        if(c.closed&&c.polygon&&c.polygon.length>=3){
          keyParts.push("cut:"+c.polygon.map(rp).join(";"));
        }
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

      // Render fill into an offscreen canvas layer
      const layer=document.createElement("canvas");
      layer.width=canvas.width;
      layer.height=canvas.height;
      const lctx=layer.getContext("2d");

      lctx.save();
      lctx.beginPath();
      polyPathTo(lctx, zone.contour);
      for(const c of (zone.cutouts||[])){
        if(c.closed && c.polygon && c.polygon.length>=3) polyPathTo(lctx, c.polygon);
      }
      lctx.clip("evenodd");

      lctx.globalAlpha=mat.params.opacity??0.85;
      lctx.globalCompositeOperation=mat.params.blendMode??"multiply";

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
    ctx.strokeStyle="rgba(0,229,255,0.85)";ctx.lineWidth=2*dpr;ctx.fillStyle="rgba(0,229,255,0.08)";
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
      ctx.lineWidth=(isActive?2.5:1.5)*dpr;
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
        ctx.lineWidth=(isCut?2.2:1.2)*dpr;
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
    ctx.lineWidth=2*dpr;
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

  let target=null;
  if(state.ui.mode==="plane"){
    const idx=findNearest(state.floorPlane.points,pt);
    if(idx!==null)target={kind:"plane",idx};
  }else if(state.ui.mode==="contour"&&zone){
    const idx=findNearest(zone.contour,pt);
    if(idx!==null)target={kind:"contour",idx};
  }else if(state.ui.mode==="cutout"&&zone&&cut){
    const idx=findNearest(cut.polygon,pt);
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
  if(state.ui.mode==="plane"){
    if(state.floorPlane.closed) return;
    if(isCloseToFirst(state.floorPlane.points,pt)){
      pushHistory();
      state.floorPlane.closed=true;
      render();
      return;
    }
    pushHistory();
    state.floorPlane.points.push(pt);
    if(state.floorPlane.points.length>=3) state.floorPlane.closed=false;
    render();
    return;
  }

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
    if(sel.kind==="plane"){ state.floorPlane.points.splice(sel.idx,1); if(state.floorPlane.points.length<3) state.floorPlane.closed=false; }
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
    state.ui.mode=mode;
    hoverCanvas=null;
    hoverCloseCandidate=false;
    const map={photo:"Загрузите фото или замените его.",plane:"Плоскость (опционально): обведите участок пола и замкните, кликнув рядом с первой точкой.",contour:"Контур зоны: ставьте точки по краю и замкните, кликнув рядом с первой точкой. После замыкания текстура начнёт применяться.",cutout:"Вырез: обведите объект точками и замкните рядом с первой точкой — вырез исключит область из заливки.",view:"Просмотр: меняйте материалы, сохраняйте результат."};
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
