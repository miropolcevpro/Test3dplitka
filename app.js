// Paver WebAR (GitHub Pages) — Contour only
// Focus: stable floor placement on Android WebXR (ARCore)
// - Manual floor calibration (required) to lock Y
// - Contour points snap to floor, close-to-first auto close
// - Triangulation + UV in meters using patternSize_m
// - Optional anchors (if supported) for extra stability
// - Demo material catalog + admin catalog uploader (local)

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const dbgEl = $("dbg");

function forceHideSplash(){
  const el = $("splash");
  if(!el) return;
  el.hidden = true;
  el.style.display = "none";
  el.style.pointerEvents = "none";
}

function setStatus(msg){ if(statusEl) statusEl.textContent = msg; }
function showDebug(err){
  console.error(err);
  forceHideSplash();
  const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
  if(dbgEl){ dbgEl.hidden = false; dbgEl.textContent = `Ошибка\n\n${msg}`; }
}
window.addEventListener("error", (e)=>showDebug(e.error || e.message));
window.addEventListener("unhandledrejection", (e)=>showDebug(e.reason || e.message));

function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function distXZ(a,b){ const dx=a.x-b.x, dz=a.z-b.z; return Math.hypot(dx,dz); }
function safeName(s){ return String(s||"").replace(/\s+/g," ").trim(); }
function fmtM(m){ return (Math.round(m*100)/100).toFixed(2); }

async function registerSW(){
  try{ if("serviceWorker" in navigator){ await navigator.serviceWorker.register("./sw.js", { scope:"./" }); } }
  catch(e){ console.warn("SW registration failed", e); }
}

async function importThree(){
  const urls = [
    "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "https://unpkg.com/three@0.160.0/build/three.module.js"
  ];
  let last;
  for(const url of urls){
    try{ return await import(url); }
    catch(e){ last = e; console.warn("THREE import failed:", url, e); }
  }
  throw last || new Error("Не удалось загрузить three.module.js");
}

function pointInUI(target){
  if(!target) return false;
  return !!(target.closest && (target.closest("#panel") || target.closest(".topbar") || target.closest("#catalogOverlay") || target.closest("#help") || target.closest("#splash")));
}

(async ()=>{
  await registerSW();

  // Splash show every load
  const splashEl = $("splash");
  const splashText = $("splashText");
  const splashSub = $("splashSub");
  function setSplash(text, sub){ if(splashText) splashText.textContent=text||""; if(splashSub) splashSub.textContent=sub||""; }
  function hideSplash(){
    if(!splashEl) return;
    splashEl.hidden = true;
    // Extra safety: make sure it cannot block clicks even if some CSS overrides [hidden]
    splashEl.style.display = "none";
    splashEl.style.pointerEvents = "none";
  }

  // Watchdog: even if some async step fails (or the tab was paused),
  // do not keep the splash forever. UI (and debug text) must remain accessible.
  const splashWatchdog = setTimeout(()=>{
    hideSplash();
    setStatus("Нажмите «Включить AR».");
  }, 3000);
  window.addEventListener("pointerdown", ()=>{
    hideSplash();
    setStatus("Нажмите «Включить AR».");
  }, { once:true });

  setSplash("Загрузка…", "Инициализация WebAR");

  // Support check (no permission prompts)
  let xrSupported = false;
  try{
    xrSupported = !!(navigator.xr && await navigator.xr.isSessionSupported("immersive-ar"));
  }catch(_){ xrSupported = false; }

  if(!xrSupported){
    setSplash("WebXR AR не поддерживается", "Откроется страница с подсказкой");
    setTimeout(()=>{ window.location.href = "./unsupported.html"; }, 900);
    return;
  }

  setSplash("Загрузка 3D…", "Подключаем Three.js");
  const THREE = await importThree();

  // UI refs
  const helpEl = $("help");
  const closeHelpBtn = $("closeHelp");
  const helpFab = $("helpFab");
  const menuFab = $("menuFab");
  const panelEl = $("panel");
  const hidePanelBtn = $("hidePanelBtn");

  const enterArBtn = $("enterArBtn");
  const exitArBtn = $("exitArBtn");
  const calibrateBtn = $("calibrateBtn");
  const undoBtn = $("undoBtn");
  const clearBtn = $("clearBtn");
  const visualizeBtn = $("visualizeBtn");
  const shotBtn = $("shotBtn");
  const areaOut = $("areaOut");
  // Optional element (some UI versions had a second area label)
  const areaOut2 = $("areaOut2") || { textContent: "" };

  const gridToggle = $("gridToggle");
  const openCatalogBtn = $("openCatalogBtn");
  const catalogFab = $("catalogFab");
  const catalogOverlay = $("catalogOverlay");
  const closeCatalogBtn = $("closeCatalogBtn");
  const catalogGrid = $("catalogGrid");
  const catalogSearch = $("catalogSearch");
  const tileNameEl = $("tileName");
  const variantRow = $("variantRow");
  const texScale = $("texScale");
  const texVal = $("texVal");
  // Optional controls: some builds hide advanced sliders (e.g. height offset).
  // Provide safe fallbacks so desktop preview and cached pages don't crash.
  const heightMm = $("heightMm") || { value: "-3", addEventListener: ()=>{} };
  const hVal = $("hVal") || { textContent: "" };
  const layoutSel = $("layout");

  function setHelp(visible){ helpEl.hidden = !visible; }
  closeHelpBtn.addEventListener("click", ()=>setHelp(false));
  helpFab.addEventListener("click", ()=>setHelp(helpEl.hidden));
  setHelp(true);

  function setPanelCollapsed(v){ panelEl.classList.toggle("collapsed", !!v); }
  menuFab.addEventListener("click", ()=>setPanelCollapsed(!panelEl.classList.contains("collapsed")));
  hidePanelBtn.addEventListener("click", ()=>setPanelCollapsed(true));

  function openCatalog(){
    catalogOverlay.classList.remove("hidden");
    catalogOverlay.setAttribute("aria-hidden","false");
    setHelp(false);
  }
  function closeCatalog(){
    catalogOverlay.classList.add("hidden");
    catalogOverlay.setAttribute("aria-hidden","true");
  }
  openCatalogBtn.addEventListener("click", openCatalog);
  catalogFab.addEventListener("click", openCatalog);
  closeCatalogBtn.addEventListener("click", closeCatalog);
  catalogOverlay.addEventListener("click", (e)=>{ if(e.target===catalogOverlay) closeCatalog(); });

  // labels
  texVal.textContent = (parseFloat(texScale.value)||1).toFixed(2);
  texScale.addEventListener("input", ()=>{ texVal.textContent = (parseFloat(texScale.value)||1).toFixed(2); if(filledMesh) applyMaterialAndUV(); });
  hVal.textContent = heightMm.value;
  heightMm.addEventListener("input", ()=>{ hVal.textContent = heightMm.value; updateHeights(); });
  layoutSel.addEventListener("change", ()=>{ if(filledMesh) applyMaterialAndUV(); });

  // ----- Catalog (demo + optional local override via admin)
  let catalog = null;
  let currentItem = null;
  let currentVariant = null;

  function getLocalCatalog(){
    try{
      const raw = localStorage.getItem("paver_catalog_override_v1");
      if(!raw) return null;
      const obj = JSON.parse(raw);
      if(obj && Array.isArray(obj.items)) return obj;
    }catch(_){ }
    return null;
  }

  async function loadCatalog(){
    const override = getLocalCatalog();
    if(override) return override;
    const res = await fetch("./catalog/catalog.json", { cache: "no-cache" });
    if(!res.ok) throw new Error("Не удалось загрузить catalog/catalog.json");
    return await res.json();
  }

  function catalogMatches(it){
    const q = (catalogSearch.value||"").toLowerCase().trim();
    if(q && !safeName(it.name).toLowerCase().includes(q)) return false;
    return true;
  }

  function renderCatalog(){
    catalogGrid.innerHTML = "";
    const items = (catalog?.items||[]).filter(catalogMatches);
    if(!items.length){
      const empty = document.createElement("div");
      empty.className = "note";
      empty.style.padding = "12px";
      empty.textContent = "Ничего не найдено.";
      catalogGrid.appendChild(empty);
      return;
    }

    for(const it of items){
      const thumb = (it.variants && it.variants[0] && it.variants[0].thumb) || "";
      const card = document.createElement("div");
      card.className = "tileCard";
      const meta = [it.collection, it.thickness_mm? (it.thickness_mm+" мм"):"", it.technology].filter(Boolean).join(" • ");
      card.innerHTML = `
        <img class="tileThumb" src="${thumb}" alt="" loading="lazy" />
        <div class="tileMeta">
          <div class="tileName">${it.name}</div>
          <div class="tileSub">${meta}</div>
          <div class="tileTags">${(it.tags||[]).slice(0,3).map(t=>`<span class="tag">${t}</span>`).join("")}</div>
        </div>
      `;
      card.addEventListener("click", async ()=>{
        await selectItem(it);
        closeCatalog();
        setPanelCollapsed(false);
      });
      catalogGrid.appendChild(card);
    }
  }

  function renderVariants(){
    variantRow.innerHTML = "";
    if(!currentItem || !Array.isArray(currentItem.variants)) return;
    for(const v of currentItem.variants){
      const sw = document.createElement("button");
      sw.className = "swatch";
      sw.type = "button";
      sw.style.background = v.tint || "#ffffff";
      sw.innerHTML = `<span title="${v.name}">${v.name}</span>`;
      sw.addEventListener("click", async ()=>{ await selectVariant(v); });
      if(currentVariant && currentVariant.id === v.id) sw.classList.add("on");
      variantRow.appendChild(sw);
    }
  }

  // ----- Three.js init
  const canvas = $("c");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true, preserveDrawingBuffer:true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;

  // Preview background (non-AR)
  const PREVIEW_CLEAR = { color: 0x0b0f1a, alpha: 1 };
  renderer.setClearColor(PREVIEW_CLEAR.color, PREVIEW_CLEAR.alpha);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.01, 100);
  camera.position.set(0.8, 1.2, 2.2);
  camera.lookAt(0,0,0);

  // Lighting
  scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(3, 6, 2);
  scene.add(sun);

  // Preview ground (non-AR)
  const previewGround = new THREE.Mesh(
    new THREE.PlaneGeometry(10,10),
    new THREE.MeshBasicMaterial({ color: 0x111827, transparent:true, opacity:0.75 })
  );
  previewGround.rotation.x = -Math.PI/2;
  previewGround.position.y = 0;
  scene.add(previewGround);

  // Grid helper (shown in AR too)
  const grid = new THREE.GridHelper(6, 60);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  grid.position.y = 0;
  scene.add(grid);
  if(gridToggle){ gridToggle.checked = true; }

  gridToggle.addEventListener("change", ()=>{ grid.visible = !!gridToggle.checked; });
  grid.visible = true;

  // Reticle
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.10, 32).rotateX(-Math.PI/2),
    new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent:true, opacity:0.95 })
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // Contour visuals
  const contourGroup = new THREE.Group();
  scene.add(contourGroup);

  const pointGeo = new THREE.SphereGeometry(0.018, 16, 16);
  const pointMat = new THREE.MeshStandardMaterial({ color: 0x60a5fa, roughness: 0.55, metalness: 0.0 });
  const pointMatClosed = new THREE.MeshStandardMaterial({ color: 0x22c55e, roughness: 0.45, metalness: 0.0 });

  const lineMat = new THREE.LineBasicMaterial({ color: 0x60a5fa, transparent:true, opacity:0.95 });
  const line = new THREE.Line(new THREE.BufferGeometry(), lineMat);
  contourGroup.add(line);

  let points = [];         // Vector3 world
  let pointMeshes = [];
  let isClosed = false;
  let floorY = null;
  let calibrated = false;
  let filledMesh = null;
  let filledGroup = null;
  let anchor = null;
  let anchorSupported = false;
  let requestAnchorCreate = false;

  // XR session state
  let xrSession = null;
  let refSpace = null;
  let viewerSpace = null;
  let hitTestSource = null;
  let glBinding = null;
  let depthSupported = false;

  // smoothing hit position
  const hitPos = new THREE.Vector3();
  const hitQuat = new THREE.Quaternion();
  const hitScale = new THREE.Vector3();
  const smoothPos = new THREE.Vector3();
  let hasSmooth = false;

  function resetContour(){
    // remove points meshes
    for(const m of pointMeshes) contourGroup.remove(m);
    pointMeshes = [];
    points = [];
    isClosed = false;
    visualizeBtn.classList.add("hidden");
    shotBtn.classList.add("hidden");
    areaOut.textContent = "–";
    areaOut2.textContent = "–";
    line.geometry.dispose();
    line.geometry = new THREE.BufferGeometry();

    // remove fill
    if(filledGroup){
      scene.remove(filledGroup);
      filledGroup.traverse(o=>{ if(o.geometry) o.geometry.dispose(); if(o.material && o.material.dispose) o.material.dispose(); });
      filledGroup = null;
      filledMesh = null;
    }
    anchor = null;
  }

  function updateLine(){
    const pts = points.slice();
    if(isClosed && points.length>=2) pts.push(points[0]);

    const arr = new Float32Array(Math.max(2, pts.length) * 3);
    for(let i=0;i<pts.length;i++){
      arr[i*3+0] = pts[i].x;
      arr[i*3+1] = pts[i].y;
      arr[i*3+2] = pts[i].z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(arr,3));
    line.geometry.dispose();
    line.geometry = g;
    line.computeLineDistances?.();
  }

  function updateHeights(){
    const eps = (parseFloat(heightMm.value)||6) / 1000;
    // contour points
    for(let i=0;i<points.length;i++) points[i].y = (floorY ?? points[i].y) + eps;
    for(let i=0;i<pointMeshes.length;i++) pointMeshes[i].position.y = points[i].y;
    updateLine();
    // fill
    if(filledGroup){
      filledGroup.position.y = (floorY ?? filledGroup.position.y) + eps;
    }
  }

  // --- Materials / Textures
  const texLoader = new THREE.TextureLoader();
  const texCache = new Map();

  function loadTex(url){
    if(!url) return Promise.resolve(null);
    if(texCache.has(url)) return texCache.get(url);
    const p = new Promise((resolve, reject)=>{
      texLoader.load(url, (t)=>resolve(t), undefined, (e)=>reject(e));
    });
    texCache.set(url, p);
    return p;
  }

  let currentMaterial = null;
  let currentMaps = null;

  async function selectItem(item){
    currentItem = item;
    currentVariant = (item.variants && item.variants[0]) || null;
    tileNameEl.textContent = item?.name || "–";
    renderVariants();
    await selectVariant(currentVariant);
  }

  async function selectVariant(variant){
    currentVariant = variant;
    renderVariants();
    await buildCurrentMaterial();
    if(filledMesh) applyMaterialAndUV();
  }

  async function buildCurrentMaterial(){
    if(!currentVariant){
      currentMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness:0.0 });
      currentMaps = null;
      return;
    }
    const maps = currentVariant.maps || {};
    currentMaps = maps;

    const [base, normal, roughness] = await Promise.all([
      loadTex(maps.base),
      loadTex(maps.normal),
      loadTex(maps.roughness)
    ]);

    if(base){ base.colorSpace = THREE.SRGBColorSpace; base.wrapS = base.wrapT = THREE.RepeatWrapping; base.anisotropy = renderer.capabilities.getMaxAnisotropy(); }
    if(normal){ normal.wrapS = normal.wrapT = THREE.RepeatWrapping; normal.anisotropy = renderer.capabilities.getMaxAnisotropy(); }
    if(roughness){ roughness.wrapS = roughness.wrapT = THREE.RepeatWrapping; roughness.anisotropy = renderer.capabilities.getMaxAnisotropy(); }

    currentMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(currentVariant.tint || "#ffffff"),
      map: base || null,
      normalMap: normal || null,
      roughnessMap: roughness || null,
      roughness: roughness ? 1.0 : 0.82,
      metalness: 0.0,
      transparent: true,
      opacity: 1.0,
      side: THREE.DoubleSide
    });
  }

  function getPatternMeters(){
    const ps = currentItem?.patternSize_m;
    if(Array.isArray(ps) && ps.length===2){
      return { w: Math.max(0.05, Number(ps[0])||0.3), h: Math.max(0.05, Number(ps[1])||0.3) };
    }
    return { w: 0.3, h: 0.3 };
  }

  function layoutUV(u,v){
    const layout = layoutSel.value;
    if(layout === "diagonal"){
      // rotate 45deg around origin
      const a = Math.PI/4;
      const cu = Math.cos(a), su = Math.sin(a);
      const uu = u*cu - v*su;
      const vv = u*su + v*cu;
      return {u:uu, v:vv};
    }
    if(layout === "running"){
      // simple stagger: shift every other "row" based on v
      const row = Math.floor(v);
      const shift = (row % 2) * 0.5;
      return {u:u+shift, v:v};
    }
    if(layout === "cross"){
      // mild secondary rotation
      const a = Math.PI/8;
      const cu = Math.cos(a), su = Math.sin(a);
      const uu = u*cu - v*su;
      const vv = u*su + v*cu;
      return {u:uu, v:vv};
    }
    return {u,v};
  }

  function applyMaterialAndUV(){
    if(!filledMesh) return;

    const g = filledMesh.geometry;
    const pos = g.getAttribute("position");
    const uv = new Float32Array(pos.count * 2);

    const pat = getPatternMeters();
    const scale = clamp(parseFloat(texScale.value)||1, 0.1, 4);
    const invW = 1 / (pat.w * scale);
    const invH = 1 / (pat.h * scale);

    for(let i=0;i<pos.count;i++){
      const x = pos.getX(i);
      const z = pos.getZ(i);
      let u = x * invW;
      let v = z * invH;
      const r = layoutUV(u,v);
      uv[i*2+0] = r.u;
      uv[i*2+1] = r.v;
    }

    g.setAttribute("uv", new THREE.BufferAttribute(uv,2));
    g.attributes.uv.needsUpdate = true;

    filledMesh.material = currentMaterial;
    if(currentMaterial.map){ currentMaterial.map.needsUpdate = true; }
    if(currentMaterial.normalMap){ currentMaterial.normalMap.needsUpdate = true; }
    if(currentMaterial.roughnessMap){ currentMaterial.roughnessMap.needsUpdate = true; }

    // subtle appear animation (scale Y)
    filledMesh.scale.set(1, 0.01, 1);
    const t0 = performance.now();
    const dur = 280;
    function anim(){
      const t = (performance.now()-t0)/dur;
      const k = clamp(t,0,1);
      const ease = k*k*(3-2*k);
      filledMesh.scale.y = 0.01 + 0.99*ease;
      if(k < 1) requestAnimationFrame(anim);
      else filledMesh.scale.y = 1;
    }
    requestAnimationFrame(anim);
  }

  function computeAreaAndShow(){
    if(points.length < 3 || !isClosed){
      areaOut.textContent = "–";
      areaOut2.textContent = "–";
      return;
    }
    // shoelace on XZ (world)
    let a = 0;
    for(let i=0;i<points.length;i++){
      const p1 = points[i];
      const p2 = points[(i+1)%points.length];
      a += (p1.x*p2.z - p2.x*p1.z);
    }
    a = Math.abs(a) * 0.5;
    areaOut.textContent = `${fmtM(a)} м²`;
    areaOut2.textContent = `${fmtM(a)} м²`;
  }

  function tryClose(newPoint){
    if(points.length < 3) return false;
    const d = distXZ(newPoint, points[0]);
    const threshold = 0.18; // ~18 cm
    if(d <= threshold){
      isClosed = true;
      // make all points green
      for(const m of pointMeshes) m.material = pointMatClosed;
      updateLine();
      computeAreaAndShow();
      visualizeBtn.classList.remove("hidden");
      setHelp(false);
      setStatus("Контур замкнут. Нажмите «Визуализировать». ");
      return true;
    }
    return false;
  }

  function addPointFromReticle(){
    if(!calibrated || floorY === null){
      setStatus("Сначала нажмите «Калибр. пол». ");
      return;
    }
    if(!reticle.visible) return;
    if(isClosed) return;

    const eps = (parseFloat(heightMm.value)||6) / 1000;

    // use smoothed pose
    const p = smoothPos.clone();
    p.y = floorY + eps;

    // avoid extremely close duplicates
    if(points.length){
      const d = distXZ(points[points.length-1], p);
      if(d < 0.04) return; // 4 cm
    }

    points.push(p);

    const marker = new THREE.Mesh(pointGeo, pointMat);
    marker.position.copy(p);
    contourGroup.add(marker);
    pointMeshes.push(marker);

    // auto close if close to first
    const didClose = tryClose(p);
    if(!didClose){
      updateLine();
      if(points.length >= 2){
        setStatus("Добавляйте точки по периметру. Замкните контур, вернувшись к первой точке.");
      }
    }
  }

  function undoPoint(){
    if(isClosed) return;
    if(!points.length) return;
    points.pop();
    const m = pointMeshes.pop();
    if(m){ contourGroup.remove(m); m.geometry.dispose(); }
    updateLine();
    computeAreaAndShow();
  }

  function clearAll(){
    resetContour();
    setStatus(calibrated? "Контур очищен." : "Нажмите «Калибр. пол», затем ставьте точки.");
  }

  // --- Fill polygon
  function buildFilledMesh(){
    if(!isClosed || points.length < 3) return;

    const eps = (parseFloat(heightMm.value)||6) / 1000;

    const p0 = points[0].clone();
    p0.y = floorY + eps;

    // local 2D points (x,z)
    const contour2 = points.map(p => new THREE.Vector2(p.x - p0.x, p.z - p0.z));

    // triangulate
    const tris = THREE.ShapeUtils.triangulateShape(contour2, []);
    if(!tris || tris.length === 0){
      setStatus("Не удалось построить заливку (контур самопересекается?).");
      return;
    }

    // build geometry
    const verts = new Float32Array(contour2.length * 3);
    for(let i=0;i<contour2.length;i++){
      verts[i*3+0] = contour2[i].x;
      verts[i*3+1] = 0; // local Y
      verts[i*3+2] = contour2[i].y;
    }

    const indices = new Uint32Array(tris.length * 3);
    for(let i=0;i<tris.length;i++){
      indices[i*3+0] = tris[i][0];
      indices[i*3+1] = tris[i][1];
      indices[i*3+2] = tris[i][2];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(verts,3));
    geo.setIndex(new THREE.BufferAttribute(indices,1));
    geo.computeVertexNormals();

    // ensure normals point up
    const n = new THREE.Vector3(0,1,0);
    // if first normal points down, flip
    const normals = geo.getAttribute("normal");
    if(normals && normals.count>0){
      const ny = normals.getY(0);
      if(ny < 0){
        // flip winding by swapping b/c for each tri
        const idx = geo.getIndex();
        for(let i=0;i<idx.count;i+=3){
          const b = idx.getX(i+1);
          const c = idx.getX(i+2);
          idx.setX(i+1,c);
          idx.setX(i+2,b);
        }
        idx.needsUpdate = true;
        geo.computeVertexNormals();
      }
    }

    filledMesh = new THREE.Mesh(geo, currentMaterial);
    filledMesh.receiveShadow = false;
    filledMesh.renderOrder = 2;

    filledGroup = new THREE.Group();
    filledGroup.position.set(p0.x, p0.y, p0.z);
    filledGroup.add(filledMesh);
    scene.add(filledGroup);

    applyMaterialAndUV();

    shotBtn.classList.remove("hidden");
  }

  // --- Screenshot
  function doScreenshot(){
    try{
      const url = renderer.domElement.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `paver_ar_${Date.now()}.png`;
      a.click();
    }catch(e){
      showDebug(e);
    }
  }

  // ----- XR init
  async function startAR(){
    if(xrSession) return;

    setStatus("Запуск AR…");

    // transparent clear for camera
    renderer.setClearColor(0x000000, 0);
    previewGround.visible = false;
    // Some WebXR implementations reject sessions if a requested feature
    // (e.g. dom-overlay / depth-sensing) isn't supported. Try "full" init first,
    // then fall back to a minimal session so AR can still start.
    const sessionInitFull = {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay", "anchors", "depth-sensing", "light-estimation"],
      domOverlay: { root: document.body },
      depthSensing: {
        usagePreference: ["gpu-optimized", "cpu-optimized"],
        dataFormatPreference: ["luminance-alpha", "float32"]
      }
    };

    const sessionInitLite = { requiredFeatures: ["hit-test"] };

    try{
      xrSession = await navigator.xr.requestSession("immersive-ar", sessionInitFull);
    }catch(e){
      console.warn("requestSession(full) failed, retrying minimal init:", e);
      xrSession = await navigator.xr.requestSession("immersive-ar", sessionInitLite);
    }

    // reference space + three.js session setup
    // Some devices don't support 'local-floor' for immersive-ar. Three.js also requests a reference space
    // during renderer.xr.setSession(), so we must set a supported type BEFORE calling setSession.
    const refTypeCandidates = ["local-floor", "local", "viewer"];
    let refType = null;
    refSpace = null;

    let sessionSet = false;
    for(const t of refTypeCandidates){
      try{
        if(renderer && renderer.xr && renderer.xr.setReferenceSpaceType){
          renderer.xr.setReferenceSpaceType(t);
        }
        await renderer.xr.setSession(xrSession);
        refType = t;
        sessionSet = true;
        break;
      }catch(e){
        if(e && e.name === "NotSupportedError"){
          console.warn("renderer.xr.setSession failed for referenceSpaceType =", t, e);
          continue;
        }
        throw e;
      }
    }
    if(!sessionSet){
      throw new Error("WebXR: this device doesn't support required reference spaces (local-floor/local/viewer).");
    }

    // Request the actual reference space instance. If it fails for the chosen type, fall back to 'viewer'.
    try{
      refSpace = await xrSession.requestReferenceSpace(refType);
    }catch(e){
      console.warn("xrSession.requestReferenceSpace failed for", refType, "retrying 'viewer'", e);
      refType = "viewer";
      if(renderer && renderer.xr && renderer.xr.setReferenceSpaceType){
        renderer.xr.setReferenceSpaceType("viewer");
      }
      refSpace = await xrSession.requestReferenceSpace("viewer");
    }

    // hit test
    viewerSpace = await xrSession.requestReferenceSpace("viewer");
    hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });

    // optional depth detection (no rendering changes)
    depthSupported = !!xrSession.depthUsage;

    // anchors support detection
    anchorSupported = (typeof XRFrame !== "undefined") && !!(XRFrame.prototype && XRFrame.prototype.createAnchor);
    // webgl binding (for future depth/occlusion work)
    try{
      const gl = renderer.getContext();
      if("XRWebGLBinding" in window){
        glBinding = new XRWebGLBinding(xrSession, gl);
      }
    }catch(_){ }

    // ensure renderer uses the same reference space instance for hit tests/poses

    if(renderer && renderer.xr && renderer.xr.setReferenceSpace){
      await renderer.xr.setReferenceSpace(refSpace);
    }

    enterArBtn.classList.add("hidden");
    exitArBtn.classList.remove("hidden");

    xrSession.addEventListener("end", onSessionEnd);

    // reset & require calibration
    calibrated = false;
    floorY = null;
    resetContour();
    grid.position.y = 0;
    setStatus("Наведите на пол и нажмите «Калибр. пол». ");

    renderer.setAnimationLoop(render);
  }

  function onSessionEnd(){
    xrSession?.removeEventListener("end", onSessionEnd);
    xrSession = null;
    refSpace = null;
    viewerSpace = null;
    hitTestSource = null;
    glBinding = null;
    depthSupported = false;

    // restore preview
    renderer.setAnimationLoop(null);
    renderer.setClearColor(PREVIEW_CLEAR.color, PREVIEW_CLEAR.alpha);
    previewGround.visible = true;
    reticle.visible = false;
    enterArBtn.classList.remove("hidden");
    exitArBtn.classList.add("hidden");

    calibrated = false;
    floorY = null;
    resetContour();
    grid.position.y = 0;

    setStatus("AR остановлен.");
  }

  async function stopAR(){
    try{ await xrSession?.end(); }catch(e){ console.warn(e); }
  }

  function calibrateFloor(){
    if(!xrSession){ setStatus("Сначала включите AR."); return; }
    if(!reticle.visible){ setStatus("Наведите на пол (зелёное кольцо). "); return; }

    // floorY from smoothed hit
    floorY = smoothPos.y;
    calibrated = true;

    // reset contours on recalibration
    resetContour();

    // move grid to floor
    grid.position.y = floorY + 0.001;

    setStatus("Пол зафиксирован. Теперь тапайте по периметру, чтобы поставить точки.");
    setHelp(false);
  }

  // Render loop
  const tmpMat4 = new THREE.Matrix4();
  const tmpUp = new THREE.Vector3();
  const tmpVec = new THREE.Vector3();

  function updateReticle(frame){
    if(!hitTestSource || !refSpace) return;

    const hits = frame.getHitTestResults(hitTestSource);
    if(!hits || hits.length === 0){
      reticle.visible = false;
      return;
    }

    const pose = hits[0].getPose(refSpace);
    if(!pose){ reticle.visible = false; return; }

    tmpMat4.fromArray(pose.transform.matrix);
    tmpMat4.decompose(hitPos, hitQuat, hitScale);

    // Reject non-horizontal surfaces (semi-automatic filtering)
    tmpUp.set(0,1,0).applyQuaternion(hitQuat);
    if(tmpUp.y < 0.75){
      reticle.visible = false;
      return;
    }

    // Smooth position to reduce jitter
    if(!hasSmooth){
      smoothPos.copy(hitPos);
      hasSmooth = true;
    }else{
      smoothPos.lerp(hitPos, 0.35);
    }

    // Set reticle pose (but don't force floorY until calibrated)
    tmpMat4.compose(smoothPos, hitQuat, hitScale);
    reticle.matrix.fromArray(tmpMat4.elements);
    reticle.visible = true;
  }

  function render(timestamp, frame){
    if(xrSession && frame){
      updateReticle(frame);

      // If calibrated, keep reticle on floor plane
      if(calibrated && reticle.visible){
        // overwrite Y only (keep rotation)
        tmpMat4.fromArray(reticle.matrix.elements);
        tmpMat4.decompose(tmpVec, hitQuat, hitScale);
        tmpVec.y = floorY + 0.001;
        tmpMat4.compose(tmpVec, hitQuat, hitScale);
        reticle.matrix.fromArray(tmpMat4.elements);
      }


      // Create anchor once (if supported) to reduce drift (best-effort).
      if(requestAnchorCreate && !anchor && anchorSupported && typeof frame.createAnchor === "function" && refSpace && filledGroup){
        requestAnchorCreate = false;
        try{
          const p = filledGroup.position;
          const q = filledGroup.quaternion;
          const xrTransform = new XRRigidTransform(
            {x: p.x, y: p.y, z: p.z},
            {x: q.x, y: q.y, z: q.z, w: q.w}
          );
          frame.createAnchor(xrTransform, refSpace).then((a)=>{ anchor = a; }).catch(()=>{ /* ignore */ });
        }catch(_){ /* ignore */ }
      }

      // anchors update (if we created anchor)
      if(anchor && refSpace){
        try{
          const pose = frame.getPose(anchor.anchorSpace, refSpace);
          if(pose && filledGroup){
            tmpMat4.fromArray(pose.transform.matrix);
            tmpMat4.decompose(tmpVec, hitQuat, hitScale);
            filledGroup.position.copy(tmpVec);
            filledGroup.quaternion.copy(hitQuat);
          }
        }catch(_){ }
      }

      // Status line
      if(depthSupported){
        // do not claim real occlusion; just show support state
        setStatus(calibrated ? "Пол зафиксирован • Depth API: поддерживается" : "Наведите на пол и нажмите «Калибр. пол» • Depth API: поддерживается");
      }
    }
    renderer.render(scene, camera);
  }

  // --- Input
  // Add point by tapping on the screen (outside UI)
  window.addEventListener("pointerup", (e)=>{
    if(!xrSession) return;
    if(pointInUI(e.target)) return;
    addPointFromReticle();
  });

  // Buttons
  enterArBtn.addEventListener("click", ()=>startAR().catch(showDebug));
  exitArBtn.addEventListener("click", ()=>stopAR().catch(showDebug));

  calibrateBtn.addEventListener("click", calibrateFloor);
  undoBtn.addEventListener("click", undoPoint);
  clearBtn.addEventListener("click", clearAll);
  visualizeBtn.addEventListener("click", ()=>{
    buildFilledMesh();
    computeAreaAndShow();
    visualizeBtn.classList.add("hidden");
    setStatus("Визуализация построена.");
    if(xrSession && anchorSupported && refSpace && filledGroup && !anchor){
      requestAnchorCreate = true;
    }
  });

  shotBtn.addEventListener("click", doScreenshot);

  // Resize
  addEventListener("resize", ()=>{
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth/innerHeight;
    camera.updateProjectionMatrix();
  });

  // Load catalog
  setSplash("Загрузка каталога…", "Материалы и демо-образцы");
  catalog = await loadCatalog();
  renderCatalog();
  catalogSearch.addEventListener("input", renderCatalog);

  if(catalog.items && catalog.items.length){
    await selectItem(catalog.items[0]);
  }else{
    tileNameEl.textContent = "Каталог пуст";
    await buildCurrentMaterial();
  }

  // Splash timer: always show 2.5s
  setSplash("Готово", "Нажмите «Включить AR» (кнопка снизу), затем наведите камеру на пол");

// Hide splash after 2.5s, but also hide on first user tap/click (на случай, если таймеры/вкладка «подвисли»)
const __hideSplashOnce = ()=>{
  clearTimeout(splashWatchdog);
  hideSplash();
  setStatus("Нажмите «Включить AR».");
};
setTimeout(__hideSplashOnce, 2500);
window.addEventListener("pointerdown", __hideSplashOnce, { once:true });
// First frame (preview)
  renderer.setAnimationLoop(()=>renderer.render(scene,camera));

})();
