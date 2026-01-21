
window.PhotoPaveEditor=(function(){
  const {state,getActiveZone,getActiveCutout,pushHistory}=window.PhotoPaveState;
  const {loadImage}=window.PhotoPaveAPI;
  let canvas,ctx,dpr=1;
  const setHint=(t)=>{const el=document.getElementById("hintText");if(el)el.textContent=t||"";};

  function init(c){
    canvas=c;ctx=canvas.getContext("2d");dpr=Math.max(1,window.devicePixelRatio||1);
    window.addEventListener("resize",resize);resize();
    setHint("Загрузите фото. Затем задайте плоскость пола (4 точки), после — зоны и вырезы.");
  }
  function resize(){
    const r=canvas.getBoundingClientRect();
    canvas.width=Math.floor(r.width*dpr);canvas.height=Math.floor(r.height*dpr);
    render();
  }
  function getImageRectInCanvas(){
    const w=canvas.width,h=canvas.height,{photoW,photoH}=state.assets;
    if(!photoW||!photoH)return {x:0,y:0,w:w,h:h,scale:1};
    const sc=Math.min(w/photoW,h/photoH),iw=photoW*sc,ih=photoH*sc;
    return {x:(w-iw)/2,y:(h-ih)/2,w:iw,h:ih,scale:sc};
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
  function findNearest(points,imgPt,maxDist=18){
    if(!points||!points.length)return null;
    const rect=getImageRectInCanvas();
    const tx=rect.x+(imgPt.x/state.assets.photoW)*rect.w;
    const ty=rect.y+(imgPt.y/state.assets.photoH)*rect.h;
    const md=maxDist*dpr;let best=null,bd=1e9;
    for(let i=0;i<points.length;i++){
      const p=imgToCanvasPt(points[i]);
      const d=Math.hypot(p.x-tx,p.y-ty);
      if(d<bd){bd=d;best=i;}
    }
    return (best!==null&&bd<=md)?best:null;
  }

  async function drawZoneFill(zone){
    const mat=zone.material;
    if(!mat||!mat.textureUrl||zone.contour.length<3)return;
    try{
      const img=await loadImage(mat.textureUrl);
      const rect=getImageRectInCanvas();

      ctx.save();
      ctx.beginPath();
      polyPath(zone.contour);
      for(const c of (zone.cutouts||[])){ if(c.polygon&&c.polygon.length>=3) polyPath(c.polygon); }
      ctx.clip("evenodd");

      ctx.globalAlpha=mat.params.opacity??0.85;
      ctx.globalCompositeOperation=mat.params.blendMode??"multiply";

      const pattern=ctx.createPattern(img,"repeat");
      if(pattern){
        const scale=mat.params.scale??1.0;
        const rot=((mat.params.rotation??0)*Math.PI)/180;
        const cx=rect.x+rect.w/2,cy=rect.y+rect.h/2;
        ctx.translate(cx,cy);ctx.rotate(rot);ctx.scale(scale,scale);ctx.translate(-cx,-cy);
        ctx.fillStyle=pattern;
        ctx.fillRect(rect.x-rect.w,rect.y-rect.h,rect.w*3,rect.h*3);
      }
      ctx.restore();
    }catch(e){
      try{ctx.restore();}catch(_){}
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
      if(pts.length===4){ctx.closePath();ctx.fill();}
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
        ctx.stroke();
        if(isCut&&state.ui.mode==="cutout"){for(let i=0;i<c.polygon.length;i++) drawPoint(c.polygon[i],i,true,"rgba(255,77,79,1)");}
      }
    }
    ctx.restore();
  }

  async function render(){
    if(!ctx)return;
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
    ctx.restore();
  }

  function onPointerDown(ev){
    state.ui.isPointerDown=true;
    const pt=canvasToImgPt(ev.offsetX*dpr,ev.offsetY*dpr);
    const zone=getActiveZone();const cut=getActiveCutout(zone);
    let target=null;
    if(state.ui.mode==="plane"){const idx=findNearest(state.floorPlane.points,pt);if(idx!==null)target={kind:"plane",idx};}
    else if(state.ui.mode==="contour"&&zone){const idx=findNearest(zone.contour,pt);if(idx!==null)target={kind:"contour",idx};}
    else if(state.ui.mode==="cutout"&&zone&&cut){const idx=findNearest(cut.polygon,pt);if(idx!==null)target={kind:"cutout",idx};}
    if(target){state.ui.draggingPoint=target;state.ui.selectedPoint=target;render();return;}

    if(state.ui.mode==="plane"){
      if(state.floorPlane.points.length<4){pushHistory();state.floorPlane.points.push(pt);render();}
      return;
    }
    if(state.ui.mode==="contour"&&zone){
      pushHistory();zone.contour.push(pt);render();return;
    }
    if(state.ui.mode==="cutout"&&zone&&cut){
      pushHistory();cut.polygon.push(pt);render();return;
    }
  }
  function onPointerMove(ev){
    if(!state.ui.isPointerDown||!state.ui.draggingPoint)return;
    const pt=canvasToImgPt(ev.offsetX*dpr,ev.offsetY*dpr);
    const drag=state.ui.draggingPoint;
    if(drag.kind==="plane"){state.floorPlane.points[drag.idx]=pt;}
    else{
      const zone=getActiveZone();if(!zone)return;
      if(drag.kind==="contour"){zone.contour[drag.idx]=pt;}
      else if(drag.kind==="cutout"){const cut=getActiveCutout(zone);if(!cut)return;cut.polygon[drag.idx]=pt;}
    }
    render();
  }
  function onPointerUp(){state.ui.isPointerDown=false;state.ui.draggingPoint=null;}
  function deleteSelectedPoint(){
    const sel=state.ui.selectedPoint;if(!sel)return false;
    pushHistory();
    if(sel.kind==="plane") state.floorPlane.points.splice(sel.idx,1);
    else{
      const zone=getActiveZone();if(!zone)return false;
      if(sel.kind==="contour") zone.contour.splice(sel.idx,1);
      else if(sel.kind==="cutout"){const cut=getActiveCutout(zone);if(!cut)return false;cut.polygon.splice(sel.idx,1);}
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
    const map={photo:"Загрузите фото или замените его.",plane:"Плоскость пола: поставьте 4 точки на земле.",contour:"Контур: выберите зону и поставьте точки.",cutout:"Вырез: добавьте вырез и обведите объект.",view:"Просмотр: меняйте материалы, сохраняйте результат."};
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
