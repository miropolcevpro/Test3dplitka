// Paver WebAR MVP (GitHub Pages ready)
// - WebXR immersive-ar on Android Chrome (ARCore)
// - Place rectangle OR draw contour polygon
// - Measurement (distance + area)
// - Tile catalog with cards + variants (color tints)
// - Offline-ish via service worker (caches once visited assets)

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const dbgEl = $("dbg");
function setStatus(msg){ statusEl.textContent = msg; }
function showDebug(err){
  console.error(err);
  const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
  dbgEl.hidden = false;
  dbgEl.textContent = `Ошибка\n\n${msg}`;
}
window.addEventListener("error", (e)=>showDebug(e.error || e.message));
window.addEventListener("unhandledrejection", (e)=>showDebug(e.reason || e.message));


const FALLBACK_URL = "./unsupported.html";

async function ensureXRSupportOrFallback(){
  // Redirect to fallback page if immersive-ar is not supported
  try{
    if(!navigator.xr || !navigator.xr.isSessionSupported){
      location.replace(FALLBACK_URL);
      return false;
    }
    const ok = await navigator.xr.isSessionSupported("immersive-ar");
    if(!ok){
      location.replace(FALLBACK_URL);
      return false;
    }
    return true;
  }catch(_){
    location.replace(FALLBACK_URL);
    return false;
  }
}

function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function fmtM(m){ return (Math.round(m*100)/100).toFixed(2); }
function fmtMM(mm){ return `${Math.round(mm)} мм`; }
function hexToInt(hex){
  if(!hex) return 0xffffff;
  const h = String(hex).replace("#","").trim();
  return parseInt(h, 16);
}
function safeName(s){ return String(s||"").replace(/\s+/g," ").trim(); }

async function registerSW(){
  try{
    if("serviceWorker" in navigator){
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    }
  }catch(e){
    console.warn("SW registration failed", e);
  }
}

async function importThree(){
  const urls = [
    "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "https://unpkg.com/three@0.160.0/build/three.module.js"
  ];
  let last;
  for(const url of urls){
    try{
      const mod = await import(url);
      return mod;
    }catch(e){
      last = e;
      console.warn("THREE import failed:", url, e);
    }
  }
  throw last || new Error("Не удалось загрузить three.module.js");
}

function makeTouchControls({ dom, camera, target }) {
  let enabled = true;
  let isDown = false;
  let lastX = 0, lastY = 0;
  let lastDist = 0;
  let yaw = 0, pitch = 0.45;
  let radius = 3.8;

  function updateCamera(){
    pitch = clamp(pitch, 0.05, 1.35);
    radius = clamp(radius, 1.2, 12);
    const x = target.x + radius * Math.cos(pitch) * Math.sin(yaw);
    const y = target.y + radius * Math.sin(pitch);
    const z = target.z + radius * Math.cos(pitch) * Math.cos(yaw);
    camera.position.set(x,y,z);
    camera.lookAt(target);
  }

  function getTouchDist(t0, t1){
    const dx = t0.clientX - t1.clientX;
    const dy = t0.clientY - t1.clientY;
    return Math.hypot(dx, dy);
  }

  function onDown(e){
    if(!enabled) return;
    isDown = true;
    if(e.touches && e.touches.length===2){
      lastDist = getTouchDist(e.touches[0], e.touches[1]);
    }else{
      lastX = (e.touches? e.touches[0].clientX : e.clientX);
      lastY = (e.touches? e.touches[0].clientY : e.clientY);
    }
  }
  function onMove(e){
    if(!enabled || !isDown) return;
    if(e.touches && e.touches.length===2){
      const d = getTouchDist(e.touches[0], e.touches[1]);
      const delta = d - lastDist;
      lastDist = d;
      radius *= (1 - delta * 0.002);
      updateCamera();
      return;
    }
    const x = (e.touches? e.touches[0].clientX : e.clientX);
    const y = (e.touches? e.touches[0].clientY : e.clientY);
    const dx = x - lastX;
    const dy = y - lastY;
    lastX = x; lastY = y;
    yaw -= dx * 0.006;
    pitch -= dy * 0.006;
    updateCamera();
  }
  function onUp(){ isDown = false; }

  dom.addEventListener("mousedown", onDown);
  dom.addEventListener("mousemove", onMove);
  dom.addEventListener("mouseup", onUp);
  dom.addEventListener("mouseleave", onUp);
  dom.addEventListener("touchstart", onDown, {passive:true});
  dom.addEventListener("touchmove", onMove, {passive:true});
  dom.addEventListener("touchend", onUp);

  updateCamera();

  return {
    setEnabled(v){ enabled = !!v; },
    reset(){
      yaw = 0; pitch = 0.45; radius = 3.8;
      updateCamera();
    }
  };
}

function distXZ(a,b){
  if(!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}


function polygonAreaXZ(points){
  // Shoelace on XZ plane
  if(!points || points.length < 3) return 0;
  let a = 0;
  for(let i=0;i<points.length;i++){
    const p1 = points[i];
    const p2 = points[(i+1)%points.length];
    a += (p1.x * p2.z - p2.x * p1.z);
  }
  return Math.abs(a) * 0.5;
}
function polygonPerimeter(points){
  if(!points || points.length < 2) return 0;
  let p = 0;
  for(let i=0;i<points.length;i++){
    const a = points[i];
    const b = points[(i+1)%points.length];
    p += a.distanceTo(b);
  }
  return p;
}

function pointInUI(target){
  if(!target) return false;
  return !!(target.closest && (target.closest("#panel") || target.closest("#catalogOverlay") || target.closest(".topbar") || target.closest("#help")));
}

(async ()=>{
  await registerSW();

  // Splash
  const splashEl = $("splash");
  function hideSplash(){ if(splashEl) splashEl.classList.add("hidden"); }

  // Fallback for unsupported devices
  const ok = await ensureXRSupportOrFallback();
  if(!ok) return;

  setStatus("загрузка 3D…");
  const THREE = await importThree();

  // UI refs
  const helpEl = $("help");
  const closeHelpBtn = $("closeHelp");
  const helpFab = $("helpFab");
  const menuFab = $("menuFab");
  const catalogFab = $("catalogFab");
  const panelEl = $("panel");
  const hidePanelBtn = $("hidePanelBtn");
  const enterArBtn = $("enterArBtn");
  const exitArBtn = $("exitArBtn");
  const clearBtn = $("clearBtn");
  const calibBtn = $("calibBtn");
  const gridBtn = $("gridBtn");
  const actionBar = $("actionBar");
  const actionBtn = $("actionBtn");
  const actionClose = $("actionClose");

  const modeDrawBtn = $("modeDraw");
  const modeMeasureBtn = $("modeMeasure");
  const modeHint = $("modeHint");

  const drawCard = $("drawCard");
  const measureCard = $("measureCard");

  const undoBtn = $("undoBtn");
  const closePolyBtn = $("closePolyBtn");
  const resetPolyBtn = $("resetPolyBtn");
  const areaOut = $("areaOut");
  const drawStatus = $("drawStatus");

  const clearMeasureBtn = $("clearMeasureBtn");
  const measureOut = $("measureOut");

  const tileNameEl = $("tileName");
  const variantRow = $("variantRow");
  const texScaleSlider = $("texScale");
  const texVal = $("texVal");
  const heightMmSlider = $("heightMm");
  const hVal = $("hVal");
  const layoutSel = $("layout");

  // init labels
  texVal.textContent = (parseFloat(texScaleSlider.value)||1).toFixed(2);
  hVal.textContent = heightMmSlider.value;

  const openCatalogBtn = $("openCatalogBtn");
  const shotBtn = $("shotBtn");

  const catalogOverlay = $("catalogOverlay");
  const closeCatalogBtn = $("closeCatalogBtn");
  const catalogGrid = $("catalogGrid");
  const catalogSearch = $("catalogSearch");
  const filterCollection = $("filterCollection");
  const filterTech = $("filterTech");
  const filterThickness = $("filterThickness");

  function setHelp(visible){
    helpEl.hidden = !visible;
  }
  closeHelpBtn.addEventListener("click", ()=>setHelp(false));
  helpFab.addEventListener("click", ()=>setHelp(!helpEl.hidden));
  setHelp(true);

  function setPanelCollapsed(v){
    panelEl.classList.toggle("collapsed", !!v);
  }
  menuFab.addEventListener("click", ()=>setPanelCollapsed(!panelEl.classList.contains("collapsed")));
  hidePanelBtn.addEventListener("click", ()=>setPanelCollapsed(true));
  catalogFab.addEventListener("click", ()=>openCatalog());


  // Action bar (context CTA)
  let actionHandler = null;
  function hideAction(){
    if(actionBar) actionBar.classList.add("hidden");
    actionHandler = null;
  }
  function showAction(label, {secondary=false}={}, handler=null){
    if(!actionBar || !actionBtn) return;
    actionBar.classList.remove("hidden");
    actionBtn.textContent = label;
    actionBtn.classList.toggle("secondary", !!secondary);
    actionHandler = handler;
  }
  actionClose?.addEventListener("click", hideAction);
  actionBtn?.addEventListener("click", ()=>{
    if(typeof actionHandler === "function") actionHandler();
  });

  // Catalog data
  let catalog = null;
  let currentItem = null;
  let currentVariant = null;

  async function loadCatalog(){
    const res = await fetch("./catalog/catalog.json", { cache:"no-cache" });
    if(!res.ok) throw new Error("Не удалось загрузить catalog/catalog.json");
    return await res.json();
  }

  function buildFilters(){
    const collections = new Set();
    const techs = new Set();
    const thicknesses = new Set();
    for(const it of (catalog?.items||[])){
      if(it.collection) collections.add(it.collection);
      if(it.technology) techs.add(it.technology);
      if(it.thickness_mm) thicknesses.add(String(it.thickness_mm));
    }
    function fillSelect(sel, values){
      const cur = sel.value;
      const first = sel.querySelector("option")?.outerHTML || "<option value=\"\">—</option>";
      sel.innerHTML = first;
      [...values].sort().forEach(v=>{
        const o = document.createElement("option");
        o.value = v; o.textContent = v;
        sel.appendChild(o);
      });
      sel.value = cur;
    }
    fillSelect(filterCollection, collections);
    fillSelect(filterTech, techs);
    fillSelect(filterThickness, thicknesses);
  }

  function catalogMatches(it){
    const q = (catalogSearch.value||"").toLowerCase().trim();
    if(q && !safeName(it.name).toLowerCase().includes(q)) return false;
    const fc = filterCollection.value;
    if(fc && it.collection !== fc) return false;
    const ft = filterTech.value;
    if(ft && it.technology !== ft) return false;
    const th = filterThickness.value;
    if(th && String(it.thickness_mm||"") !== th) return false;
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
      card.innerHTML = `
        <img class="tileThumb" src="${thumb}" alt="" loading="lazy" />
        <div class="tileMeta">
          <div class="tileName">${it.name}</div>
          <div class="tileSub">${[it.collection, it.thickness_mm? (it.thickness_mm+" мм"):"", it.technology].filter(Boolean).join(" • ")}</div>
          <div class="tileTags">
            ${(it.tags||[]).slice(0,3).map(t=>`<span class="tag">${t}</span>`).join("")}
          </div>
        </div>
      `;
      card.addEventListener("click", ()=>{
        selectItem(it);
        closeCatalog();
        setPanelCollapsed(false);
      });
      catalogGrid.appendChild(card);
    }
  }

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
  closeCatalogBtn.addEventListener("click", closeCatalog);
  catalogOverlay.addEventListener("click", (e)=>{ if(e.target === catalogOverlay) closeCatalog(); });
  catalogSearch.addEventListener("input", renderCatalog);
  filterCollection.addEventListener("change", renderCatalog);
  filterTech.addEventListener("change", renderCatalog);
  filterThickness.addEventListener("change", renderCatalog);

  function renderVariants(){
    variantRow.innerHTML = "";
    if(!currentItem || !currentItem.variants || currentItem.variants.length === 0){
      return;
    }
    for(const v of currentItem.variants){
      const sw = document.createElement("button");
      sw.className = "swatch";
      sw.type = "button";
      const tint = v.tint || "#ffffff";
      sw.style.background = tint;
      sw.innerHTML = `<span title="${v.name}">${v.name}</span>`;
      sw.addEventListener("click", ()=>{
        selectVariant(v);
      });
      if(currentVariant && currentVariant.id === v.id) sw.classList.add("on");
      variantRow.appendChild(sw);
    }
  }

  // Three.js init
  const canvas = $("c");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;

  // --- ВАЖНО ДЛЯ WebXR AR ---
  // В режиме immersive-ar видеопоток камеры находится "под" WebGL‑слоем.
  // Если WebGL очищается непрозрачно (alpha = 1), вместо камеры будет "чёрный экран".
  // Поэтому:
  //  - в обычном (не‑AR) режиме делаем фон непрозрачным для удобного предпросмотра;
  //  - при входе в AR переключаемся на прозрачный фон (alpha = 0).
  const PREVIEW_CLEAR = { color: 0x0b0f1a, alpha: 1 };
  renderer.setClearColor(PREVIEW_CLEAR.color, PREVIEW_CLEAR.alpha);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.01, 100);
  const controls = makeTouchControls({ dom: canvas, camera, target: new THREE.Vector3(0,0.2,0) });

  // Lighting (simple but nice)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 0.85);
  sun.position.set(3,6,2);
  scene.add(sun);

  // Preview ground (non-AR)
  const previewGround = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.MeshBasicMaterial({ color: 0x111827, transparent: true, opacity: 0.75 })
  );
  previewGround.rotation.x = -Math.PI/2;
  previewGround.position.y = 0;
  scene.add(previewGround);

  // Reticle (AR hit-test)
  const reticleMat = new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent:true, opacity:0.95 });
  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.08, 0.10, 32).rotateX(-Math.PI/2),
    reticleMat
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // Locked root (calibration / anchors). All placed content lives here.
  const lockedRoot = new THREE.Group();
  lockedRoot.name = "LockedRoot";
  scene.add(lockedRoot);

  function worldToLockedLocal(worldV, out){
    if(!out) out = worldV.clone();
    else out.copy(worldV);
    return lockedRoot.worldToLocal(out);
  }
  function lockedLocalToWorld(localV, out){
    if(!out) out = localV.clone();
    else out.copy(localV);
    return lockedRoot.localToWorld(out);
  }

  // Grid helper (visual floor aid) — shown after calibration
  // Depth-occlusion registry (MUST be initialized before any enableDepthOcclusionOnMaterial() calls)
  let occlusionMaterials = new Set();

  const gridHelper = new THREE.GridHelper(8, 16);
  gridHelper.visible = false;
  gridHelper.material.transparent = true;
  gridHelper.material.opacity = 0.35;
  gridHelper.renderOrder = 5;
  try{ gridHelper.material.depthTest = true; gridHelper.material.depthWrite = false; }catch(_){}
  enableDepthOcclusionOnMaterial(gridHelper.material);
  lockedRoot.add(gridHelper);

  function updateGridUI(){
    if(!gridBtn) return;
    gridBtn.classList.toggle("primary", gridEnabled && floorLocked);
    gridBtn.textContent = gridEnabled ? "Сетка: вкл" : "Сетка: выкл";
    gridHelper.visible = !!(gridEnabled && floorLocked);
  }

  // Groups for surfaces & debug
  const surfaceGroup = new THREE.Group();
  const drawGroup = new THREE.Group();
  lockedRoot.add(surfaceGroup);
  lockedRoot.add(drawGroup);

  // Current surface mesh (single for MVP)
  let surfaceMesh = null;
  let surfacePlaced = false;
  let surfaceType = "poly";      // "rect" | "poly"
  let patternYaw = 0;            // поворот раскладки/текстуры (для заливки внутри контура)
  let surfaceBaseY = 0;          // базовая высота пола в момент установки

  // Drawing state
  let drawPoints = []; // world Vector3
  let drawClosed = false;
  let drawLine = null;
  let drawMarkers = [];
  let drawOrigin = null; // world Vector3 (first point)

  // Measurement state
  let measureA = null;
  let measureB = null;
  let measureLine = null;

  // XR state
  let arSession = null;
  let hitTestSource = null;
  let viewerSpace = null;

  // Last valid hit (for stable placement on floor)
  let lastHitValid = false;
  const lastHitPos = new THREE.Vector3();
  const lastHitQuat = new THREE.Quaternion();
  const _hitScale = new THREE.Vector3(1,1,1);

  const _worldUp = new THREE.Vector3(0,1,0);
  const _tmpMat = new THREE.Matrix4();
  const _tmpPos = new THREE.Vector3();
  const _tmpQuat = new THREE.Quaternion();
  const _bestPos = new THREE.Vector3();
  const _bestQuat = new THREE.Quaternion();
  const _tmpNormal = new THREE.Vector3();
  const _tmpCamPos = new THREE.Vector3();
  const _tmpDir = new THREE.Vector3();
  const _tmpWorldHit = new THREE.Vector3();
  const _tmpVec2 = new THREE.Vector2();
  const _flatEuler = new THREE.Euler(0,0,0,'YXZ');
  const _flatQuat = new THREE.Quaternion();
  const _yawFwd = new THREE.Vector3();
  const _oneScale = new THREE.Vector3(1,1,1);
  function yawOnlyQuatFrom(q, out){
    // Extract yaw (rotation around Y) only. Keeps content perfectly horizontal.
    _yawFwd.set(0,0,-1).applyQuaternion(q);
    _yawFwd.y = 0;
    if(_yawFwd.lengthSq() < 1e-8){
      out.identity();
      return out;
    }
    _yawFwd.normalize();
    // yaw=0 should correspond to looking towards -Z
    const yaw = Math.atan2(_yawFwd.x, -_yawFwd.z);
    out.setFromAxisAngle(_worldUp, yaw);
    return out;
  }


  // -------- Depth-occlusion (WebXR Depth API, CPU -> RGBA8 texture) --------
  // We keep this lightweight:
  // - depth is read ONLY when there is something to occlude (occlusionMaterials.size > 0)
  // - depth is packed into an RGBA8 DataTexture to avoid WebGL2-only formats
  // - materials get a small shader patch that discards fragments behind real-world depth

  // IMPORTANT: initialize BEFORE any function touches it to avoid TDZ ReferenceError.
  // occlusionMaterials initialized above

  function enableDepthOcclusionOnMaterial(material){
    if(!material) return;
    if(material.userData && material.userData.__depthOcclusion) return;
    material.userData = material.userData || {};
    material.userData.__depthOcclusion = true;
    occlusionMaterials.add(material);

    material.onBeforeCompile = (shader) => {
      material.userData.__depthShader = shader;
      shader.uniforms.uDepthTex = { value: depthTex };
      shader.uniforms.uDepthSize = { value: new THREE.Vector2(depthTexW, depthTexH) };
      shader.uniforms.uViewportSize = { value: new THREE.Vector2(1, 1) };
      shader.uniforms.uRawToMeters = { value: depthRawToMeters };
      shader.uniforms.uOcclEps = { value: 0.03 }; // meters (tune if you see edge "popping")
      shader.uniforms.uOcclBias = { value: (material.userData.__occlBias ?? 0.0) };
      // three.js ShaderChunk helpers expect these names for depth -> viewZ conversion.
      shader.uniforms.uCamNear = { value: camera.near };
      shader.uniforms.uCamFar  = { value: camera.far };

      // Make sure packing helpers exist (for perspectiveDepthToViewZ)
      if(!shader.fragmentShader.includes('#include <packing>')){
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          '#include <common>\n#include <packing>'
        );
      }

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        '#include <common>\n' +
        'uniform sampler2D uDepthTex;\n' +
        'uniform vec2 uDepthSize;\n' +
        'uniform vec2 uViewportSize;\n' +
        'uniform float uRawToMeters;\n' +
        'uniform float uOcclEps;\n' +
        'uniform float uOcclBias;\n' +
        'uniform float uCamNear;\n' +
        'uniform float uCamFar;\n'
      );

      const occlChunk = `
// --- Depth occlusion (discard fragments behind real geometry) ---
if(uDepthSize.x > 1.0 && uDepthSize.y > 1.0){
  vec2 uv = gl_FragCoord.xy / uViewportSize;
  // Depth API buffer is packed into RGBA8: R=low byte, G=high byte
  vec4 dd = texture2D(uDepthTex, uv);
  float lowB  = dd.r * 255.0;
  float highB = dd.g * 255.0;
  float rawDepth = lowB + highB * 256.0;        // 0..65535
  float realMeters = rawDepth * uRawToMeters;   // meters from camera
  if(realMeters > 0.0){
    float viewZ = perspectiveDepthToViewZ(gl_FragCoord.z, uCamNear, uCamFar);
    float virtMeters = -viewZ - uOcclBias;
    if(virtMeters > realMeters + uOcclEps) discard;
  }
}
`;

      // Insert occlusion check late in the fragment shader (before dithering)
      if(shader.fragmentShader.includes('#include <dithering_fragment>')){
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          occlChunk + '\n#include <dithering_fragment>'
        );
      }else if(shader.fragmentShader.includes('gl_FragColor')){
        shader.fragmentShader = shader.fragmentShader.replace(
          /gl_FragColor\s*=\s*vec4\(/,
          occlChunk + '\n  gl_FragColor = vec4('
        );
      }else{
        // Fallback: append at end
        shader.fragmentShader += '\n' + occlChunk;
      }
    };

    // Ensure recompilation with the patch
    material.needsUpdate = true;
  }

  function updateDepthOcclusionUniforms(){
    if(!renderer) return;
    const size = renderer.getSize(_tmpVec2);

    // Active camera near/far: in WebXR we get an ArrayCamera.
    let near = (camera && camera.near !== undefined) ? camera.near : 0.01;
    let far  = (camera && camera.far  !== undefined) ? camera.far  : 20.0;

    if(renderer.xr && renderer.xr.isPresenting){
      const xrCam = renderer.xr.getCamera(camera);
      const refCam = (xrCam && xrCam.cameras && xrCam.cameras.length) ? xrCam.cameras[0] : xrCam;
      if(refCam){
        if(refCam.near !== undefined) near = refCam.near;
        if(refCam.far  !== undefined) far  = refCam.far;
      }
    }

    for(const mat of occlusionMaterials){
      if(!mat || !mat.userData || !mat.userData.__depthShader) continue;
      const u = mat.userData.__depthShader.uniforms;
      if(!u) continue;

      u.uDepthTex.value = depthTex;
      u.uDepthSize.value.set(depthTexW, depthTexH);
      u.uViewportSize.value.set(size.x, size.y);
      u.uRawToMeters.value = depthRawToMeters;

      if(u.uCamNear) u.uCamNear.value = near;
      if(u.uCamFar)  u.uCamFar.value  = far;

      // allow per-material tuning
      if(u.uOcclEps && mat.userData.__occlEps !== undefined && mat.userData.__occlEps !== null){
        u.uOcclEps.value = mat.userData.__occlEps;
      }
      if(u.uOcclBias && mat.userData.__occlBias !== undefined && mat.userData.__occlBias !== null){
        u.uOcclBias.value = mat.userData.__occlBias;
      }
    }
  }

const HIT_NORMAL_DOT = 0.90;   // чем выше, тем «горизонтальнее» должна быть плоскость (пол)
  const CLOSE_SNAP_DIST = 0.12; // м — радиус «прилипания» к первой точке для замыкания контура

  // Small vertical offset (meters) to avoid z-fighting and depth-edge artifacts.
  // Keep it tiny; larger values will make the surface visibly "float" above the floor.
  const SURFACE_FLOAT_EPS = 0.001; // 1mm
  // Floor lock & helpers
  let floorLocked = false;
  let lockedFloorY = 0;
  let gridEnabled = false; // default OFF (grid was confusing / often misleads users)
  let floorAnchor = null;
  let lastBestHit = null;
  let depthSensingAvailable = false;


// Depth occlusion state (WebXR Depth Sensing)
// We upload XR depth data into a small DataTexture each frame and use it in fragment shaders to discard
// pixels that should be hidden behind real-world geometry.
let depthOcclusionEnabled = true; // default ON (auto-falls back if Depth API not available)
let depthTex = null;          // THREE.DataTexture (LuminanceAlpha packed 16-bit depth)
let depthTexW = 0, depthTexH = 0;
let depthRawToMeters = 0.001; // updated from XRDepthInformation
let hasDepthThisFrame = false;
	// occlusionMaterials is initialized earlier (above enableDepthOcclusionOnMaterial)
let depthCPUBufferRGBA = null; // Uint8Array RGBA packed depth
let depthCPUW = 0, depthCPUH = 0;


  const HIT_SMOOTHING = 0.25;    // сглаживание позиции/ориентации ретикла (меньше дрожание)
  const DRAW_SNAP_M = 0.12;      // «магнит» к первой точке при замыкании контура
  const FLOOR_Y_TOL = 0.06;      // допуск по высоте после калибровки (м)
  const LOCK_RAY_MIN_DIR_Y = -0.06; // нужно смотреть вниз
  const LOCK_RAY_MAX_DIST = 20.0;      // макс дистанция пересечения (м)
  const FLOOR_MIN_BELOW_CAM = 0.45; // пол должен быть заметно ниже камеры при калибровке (м)
  const HIT_NORMAL_DOT_STRICT = Math.max(HIT_NORMAL_DOT, 0.97); // более строгий порог для калибровки
  let lastHitIsFloor = false;

  // Material/texture cache
  const texCache = new Map();
  let currentMaterial = null;
  let currentPatternSize = [0.3, 0.3];

  // Плавное появление (анимация) — визуально «дороже» и скрывает микродрожание в первый момент
  let surfaceFadeStart = 0;
  let surfaceFadeDur = 0;
  function startSurfaceFade(durMs = 280){
    if(!surfaceMesh || !surfaceMesh.material) return;
    try{
      surfaceMesh.material.transparent = true;
      surfaceMesh.material.opacity = 0;
      surfaceFadeStart = performance.now();
      surfaceFadeDur = durMs;
    }catch(_){}
  }
  function updateSurfaceFade(now){
    if(!surfaceMesh || !surfaceMesh.material) return;
    if(surfaceFadeDur <= 0) return;
    const t = clamp((now - surfaceFadeStart) / surfaceFadeDur, 0, 1);
    surfaceMesh.material.opacity = t;
    if(t >= 1){
      surfaceMesh.material.opacity = 1;
      surfaceFadeDur = 0;
    }
  }


  async function loadTexture(url, { srgb=false } = {}){
    if(!url) return null;
    const key = url + (srgb? "|srgb":"|lin");
    if(texCache.has(key)) return texCache.get(key);
    const loader = new THREE.TextureLoader();
    const tex = await new Promise((res, rej)=>loader.load(url, res, undefined, rej));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1,1);
    tex.offset.set(0,0);
    tex.center.set(0,0);
    tex.rotation = 0;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 16);
    texCache.set(key, tex);
    return tex;
  }

  async function buildMaterialForVariant(variant){
    const maps = variant?.maps || {};
    const base = await loadTexture(maps.base, { srgb:true });
    const normal = await loadTexture(maps.normal, { srgb:false });
    const rough = await loadTexture(maps.roughness, { srgb:false });

    const mat = new THREE.MeshStandardMaterial({
      map: base || null,
      normalMap: normal || null,
      roughnessMap: rough || null,
      roughness: 1.0,
      metalness: 0.0
    });

    enableDepthOcclusionOnMaterial(mat);

    // Tint (multiply)
    const tint = variant?.tint ? hexToInt(variant.tint) : 0xffffff;
    mat.color.setHex(tint);

    // Small anti-z-fighting
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -1;
    mat.polygonOffsetUnits = -1;

    return mat;
  }

  function disposeMesh(m){
    if(!m) return;
    if(m.geometry) m.geometry.dispose();
    // keep material cached? We keep currentMaterial reference, so don't dispose it here.
    surfaceGroup.remove(m);
  }

  
  function setModeUI(m){
    if(modeDrawBtn) modeDrawBtn.classList.toggle("segOn", m==="draw");
    if(modeMeasureBtn) modeMeasureBtn.classList.toggle("segOn", m==="measure");
    if(drawCard) drawCard.hidden = m!=="draw";
    if(measureCard) measureCard.hidden = m!=="measure";

    if(!modeHint) return;

    if(m==="draw"){
      modeHint.textContent = floorLocked
        ? "Контур: тапайте точки по полу → замкните контур → «Визуализировать»."
        : "Контур: сначала наведите маркер на пол и нажмите «Калибр. пол».";
    } else {
      modeHint.textContent = floorLocked
        ? "Замер: 2 тапа по полу — расстояние."
        : "Замер: сначала нажмите «Калибр. пол», чтобы зафиксировать пол.";
    }

    updateDrawUI();
    updateGridUI();
  }

  let mode = "draw";
  setModeUI(mode);

  modeDrawBtn.addEventListener("click", ()=>{ mode="draw"; setModeUI(mode); });
  modeMeasureBtn.addEventListener("click", ()=>{ mode="measure"; setModeUI(mode); });

  function applyHeightOffset(){
    if(!surfaceMesh) return;
    const offsetM = parseFloat(heightMmSlider.value)/1000;
    surfaceMesh.position.y = surfaceBaseY + offsetM + SURFACE_FLOAT_EPS;
  }


  function applyUVs(geometry){
    if(!geometry || !geometry.attributes || !geometry.attributes.position) return;
    const pos = geometry.attributes.position;
    const uv = geometry.attributes.uv || new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    const sx = (currentPatternSize && currentPatternSize[0]) ? currentPatternSize[0] : 0.3;
    const sy = (currentPatternSize && currentPatternSize[1]) ? currentPatternSize[1] : sx;
    const scale = parseFloat(texScaleSlider.value) || 1.0;
    const layout = layoutSel.value || "straight";

    const c45 = Math.cos(Math.PI/4), s45 = Math.sin(Math.PI/4);

    for(let i=0;i<pos.count;i++){
      const x = pos.getX(i);
      const y = pos.getY(i);
      let u = x / sx;
      let v = y / sy;

      // Extra rotation of the pattern (only for polygon fill), without moving the contour itself
      if(surfaceType === "poly" && patternYaw !== 0){
        const c = Math.cos(patternYaw);
        const s = Math.sin(patternYaw);
        const ru = u * c - v * s;
        const rv = u * s + v * c;
        u = ru; v = rv;
      }

      // Layout transforms
      if(layout === "diagonal"){
        const ru = u * c45 - v * s45;
        const rv = u * s45 + v * c45;
        u = ru; v = rv;
      } else if(layout === "cross"){
        // 90° rotation in UV space
        const ru = -v;
        const rv = u;
        u = ru; v = rv;
      } else if(layout === "running"){
        const row = Math.floor(v);
        if(row % 2 !== 0) u += 0.5;
      }

      // Texture scale (bigger scale => larger texture => fewer repeats)
      u /= scale;
      v /= scale;

      uv.setXY(i, u, v);
    }
    geometry.setAttribute("uv", uv);
    uv.needsUpdate = true;
  }

  function ensureSurfaceMesh(){
    if(surfaceMesh) return;
    const geom = new THREE.PlaneGeometry(2,2, 1,1); // in XY
    applyUVs(geom);
    surfaceMesh = new THREE.Mesh(geom, currentMaterial || new THREE.MeshStandardMaterial({ color:0xffffff }));
    surfaceMesh.rotation.set(-Math.PI/2, 0, 0);
    surfaceMesh.position.set(0,0,0);
    surfaceMesh.receiveShadow = false;
    surfaceGroup.add(surfaceMesh);
  }

  function clearSurface(){
    surfacePlaced = false;
    surfaceType = "poly";
    patternYaw = 0;
    drawClosed = false;
    lastHitValid = false;

    if(surfaceMesh){
      disposeMesh(surfaceMesh);
      surfaceMesh = null;
    }
    clearDraw();
    clearMeasure();
  }

  clearBtn.addEventListener("click", clearSurface);


  function resetForRecalibration(){
    // reset geometry/points on recalibration, keep выбранную плитку
    clearSurface();
    hideAction();
  }

  calibBtn?.addEventListener("click", async ()=>{
    if(!arSession){
      alert("Сначала нажмите «Включить AR».");
      return;
    }
    if(!reticle.visible || !lastBestHit){
      alert("Наведите маркер на пол, дождитесь зелёного индикатора и попробуйте снова.");
      return;
    }

    // Recalibration resets contour
    resetForRecalibration();

    // Remove old anchor if any
    try{ if(floorAnchor && floorAnchor.delete) floorAnchor.delete(); }catch(_){}
    floorAnchor = null;

    const refSpace = renderer.xr.getReferenceSpace();
    try{
      if(lastBestHit.createAnchor){
        floorAnchor = await lastBestHit.createAnchor();
      }
    }catch(e){
      console.warn("Anchor not available:", e);
      floorAnchor = null;
    }

    // Lock root to current hit pose (fallback if anchors unavailable)
    lockedRoot.matrixAutoUpdate = false;
    // Keep it perfectly horizontal: yaw-only rotation + unit scale
    yawOnlyQuatFrom(camera.quaternion, _flatQuat); // yaw from camera, not plane pose

    lockedRoot.matrix.compose(lastHitPos, _flatQuat, _oneScale);
    lockedRoot.matrix.decompose(lockedRoot.position, lockedRoot.quaternion, lockedRoot.scale);
    lockedRoot.scale.copy(_oneScale);
    lockedFloorY = lockedRoot.position.y;
    floorLocked = true;
    lockedRoot.updateMatrixWorld(true);


    updateGridUI();
    setModeUI(mode);
    setStatus("Пол откалиброван ✓");
    try{ if(navigator.vibrate) navigator.vibrate(15); }catch(_){}
  });

  gridBtn?.addEventListener("click", ()=>{
    gridEnabled = !gridEnabled;
    updateGridUI();
  });

  function normalizeAngle(a){
    const twoPi = Math.PI * 2;
    a = a % twoPi;
    if(a > Math.PI) a -= twoPi;
    if(a < -Math.PI) a += twoPi;
    return a;
  }

  function applySurfaceRotation(){
    if(!surfaceMesh) return;
    surfaceMesh.rotation.set(-Math.PI/2, 0, 0);
    if(surfaceMesh.geometry) applyUVs(surfaceMesh.geometry);
  }


  texScaleSlider.addEventListener("input", ()=>{
    texVal.textContent = (parseFloat(texScaleSlider.value)||1).toFixed(2);
    if(surfaceMesh) applyUVs(surfaceMesh.geometry);
  });
  heightMmSlider.addEventListener("input", ()=>{
    hVal.textContent = heightMmSlider.value;
    if(!surfaceMesh) return;
    // если поверхность еще не "поставлена" и мы в AR — она и так будет привязана к reticle
    // но высоту применяем всегда относительно surfaceBaseY
    applyHeightOffset();
  });
  layoutSel.addEventListener("change", ()=>{
    if(surfaceMesh) applyUVs(surfaceMesh.geometry);
  });

  // Draw mode helpers
  function clearDraw(){
    drawPoints = [];
    drawOrigin = null;
    drawClosed = false;

    if(drawLine){
      drawGroup.remove(drawLine);
      drawLine.geometry.dispose();
      drawLine.material.dispose();
      drawLine=null;
    }
    for(const m of drawMarkers){
      drawGroup.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    drawMarkers = [];
    areaOut.textContent = "—";
    if(drawStatus) drawStatus.textContent = "";
    updateDrawUI();
  }

  
  function updateDrawUI(){
    if(mode !== "draw"){
      hideAction();
      drawStatus.textContent = "";
      return;
    }

    // Require floor calibration before allowing points
    if(!floorLocked){
      closePolyBtn.textContent = "Замкнуть контур";
      closePolyBtn.disabled = true;
      drawStatus.textContent = "Наведите маркер на пол и нажмите «Калибр. пол», затем ставьте точки.";
      hideAction();
      return;
    }

    if(drawPoints.length === 0){
      areaOut.textContent = "—";
      closePolyBtn.textContent = "Замкнуть контур";
      closePolyBtn.disabled = true;
      drawStatus.textContent = "Тапайте по полу, чтобы поставить точки контура.";
      hideAction();
      return;
    }

    if(!drawClosed){
      closePolyBtn.textContent = "Замкнуть контур";
      closePolyBtn.disabled = (drawPoints.length < 3);
      if(drawPoints.length < 3){
        drawStatus.textContent = "Поставьте минимум 3 точки, чтобы замкнуть контур.";
      } else {
        drawStatus.textContent = "Чтобы замкнуть: нажмите «Замкнуть контур» или тапните рядом с первой точкой.";
      }
      hideAction();
      return;
    }

    // drawClosed === true  → show CTA
    closePolyBtn.textContent = "Контур замкнут";
    closePolyBtn.disabled = true;

    if(surfacePlaced && surfaceType === "poly"){
      drawStatus.textContent = "Заливка выполнена. Можно сделать скриншот.";
      showAction("Сделать скриншот", {secondary:true}, ()=>takeScreenshot());
    }else{
      drawStatus.textContent = "Контур замкнут. Нажмите «Визуализировать».";
      showAction("Визуализировать", {}, ()=>{
        closePolygon();
        updateDrawUI();
      });
    }
  }

  function rebuildDrawLine(livePoint){
    if(drawLine){
      drawGroup.remove(drawLine);
      drawLine.geometry.dispose();
      drawLine.material.dispose();
      drawLine = null;
    }

    const pts = drawPoints.slice();

    // preview: last segment to current reticle (only while contour is open)
    if(livePoint && !drawClosed){
      const lp = livePoint.clone();
      if(drawOrigin) lp.y = drawOrigin.y;
      pts.push(lp);
    }

    // closed contour: connect last to first
    if(drawClosed && pts.length >= 2){
      const first = drawOrigin || pts[0];
      if(first) pts.push(first);
    }

    if(pts.length < 2) return;

    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0x93c5fd });
    enableDepthOcclusionOnMaterial(mat);
    drawLine = new THREE.Line(geom, mat);
    drawLine.renderOrder = 10;
    drawLine.material.depthTest = false;
    drawLine.material.depthWrite = false;
    drawGroup.add(drawLine);
  }
  function addDrawPoint(p){
    if(!p) return;

    // Если контур уже замкнут — не добавляем новые точки (сначала Undo/Reset)
    if(drawClosed){
      updateDrawUI();
      return;
    }

    // Делаем контур ПЛОСКИМ: фиксируем Y по первой точке (так линия и заливка будут строго по полу)
    const pp = p.clone();
    if(drawOrigin) pp.y = drawOrigin.y;

    // Авто-замыкание: если тапнули рядом с первой точкой (считаем дистанцию по полу, в XZ)
    const CLOSE_THRESH_M = 0.12; // 12 см (точнее, чем 22 см)
    if(drawOrigin && drawPoints.length >= 3){
      const d = distXZ(pp, drawOrigin);
      if(d < CLOSE_THRESH_M){
        drawClosed = true;

        // лёгкая тактильная обратная связь, если доступно
        try { if(navigator.vibrate) navigator.vibrate(20); } catch(e){}

        // Обновим линию (замкнётся на первую точку)
        rebuildDrawLine(null);

        // Площадь/периметр по уже набранным точкам
        const area = polygonAreaXZ(drawPoints);
        const per = polygonPerimeter(drawPoints);
        areaOut.textContent = `Точек: ${drawPoints.length} • площадь ~ ${area.toFixed(2)} м² • периметр ~ ${per.toFixed(2)} м`;

        updateDrawUI();
        return;
      }
    }

    drawPoints.push(pp.clone());
    if(!drawOrigin) drawOrigin = pp.clone();

    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.015, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0x60a5fa })
    );
    marker.position.copy(pp);
    drawGroup.add(marker);
    drawMarkers.push(marker);

    if(drawPoints.length >= 3){
      const area = polygonAreaXZ(drawPoints);
      const per = polygonPerimeter(drawPoints);
      areaOut.textContent = `Точек: ${drawPoints.length} • площадь ~ ${area.toFixed(2)} м² • периметр ~ ${per.toFixed(2)} м`;
    } else {
      areaOut.textContent = `Точек: ${drawPoints.length}`;
    }

    rebuildDrawLine(null);
    updateDrawUI();
  }
  function closePolygon(){
    if(drawPoints.length < 3){
      areaOut.textContent = "Нужно минимум 3 точки.";
      return;
    }
    // Build polygon mesh
    ensureSurfaceMesh();
    // compute local points relative to origin
    const origin = drawOrigin || drawPoints[0];
    // ВНИМАНИЕ: ShapeGeometry строится в плоскости XY, а мы хотим XZ.
    // При повороте -90° вокруг X оси координата Y превращается в -Z.
    // Поэтому используем -(dz), чтобы заливка НЕ зеркалилась относительно контура.
    let pts2 = drawPoints.map(p => new THREE.Vector2(p.x - origin.x, -(p.z - origin.z)));

    // Приводим направление обхода к корректному (наружный контур — против часовой)
    if(THREE.ShapeUtils && THREE.ShapeUtils.isClockWise(pts2)) pts2 = pts2.reverse();

    const shape = new THREE.Shape(pts2);
    const geom = new THREE.ShapeGeometry(shape); // in XY
    applyUVs(geom);

    const old = surfaceMesh.geometry;
    surfaceMesh.geometry = geom;
    if(old) old.dispose();

    surfaceMesh.position.set(origin.x, origin.y, origin.z);
    // Для заливки внутри контура НЕ вращаем саму геометрию по Y (иначе она уедет относительно точек).
    surfaceType = "poly";
    surfaceMesh.rotation.set(-Math.PI/2, 0, 0);

    surfaceBaseY = origin.y;
    applyHeightOffset();

    surfacePlaced = true;
    startSurfaceFade(360);

    const area = polygonAreaXZ(drawPoints);
    const per = polygonPerimeter(drawPoints);
    areaOut.textContent = `Готово • Площадь: ${fmtM(area)} м² • Периметр: ${fmtM(per)} м`;

    // Keep markers/line? For clarity, hide after close
    rebuildDrawLine(null);
  }

  undoBtn.addEventListener("click", ()=>{
    // Если контур замкнут — первый Undo просто "размыкает" его
    if(drawClosed){
      drawClosed = false;
      rebuildDrawLine(null);

      if(drawPoints.length >= 3){
        const area = polygonAreaXZ(drawPoints);
        const per = polygonPerimeter(drawPoints);
        areaOut.textContent = `Точек: ${drawPoints.length} • площадь ~ ${area.toFixed(2)} м² • периметр ~ ${per.toFixed(2)} м`;
      } else if(drawPoints.length > 0){
        areaOut.textContent = `Точек: ${drawPoints.length}`;
      } else {
        areaOut.textContent = "—";
        drawOrigin = null;
      }

      updateDrawUI();
      return;
    }

    if(drawPoints.length === 0) return;

    drawPoints.pop();
    const marker = drawMarkers.pop();
    if(marker){
      drawGroup.remove(marker);
      marker.geometry.dispose();
      marker.material.dispose();
    }

    rebuildDrawLine(null);

    if(drawPoints.length >= 3){
      const area = polygonAreaXZ(drawPoints);
      const per = polygonPerimeter(drawPoints);
      areaOut.textContent = `Точек: ${drawPoints.length} • площадь ~ ${area.toFixed(2)} м² • периметр ~ ${per.toFixed(2)} м`;
    }else if(drawPoints.length>0){
      areaOut.textContent = `Точек: ${drawPoints.length}`;
    }else{
      areaOut.textContent = "—";
      drawOrigin = null;
    }

    updateDrawUI();
  });
  resetPolyBtn.addEventListener("click", clearDraw);
  closePolyBtn.addEventListener("click", ()=>{
    if(mode !== "draw") return;

    // 1) Если контур ещё открыт — "Замкнуть контур"
    if(!drawClosed){
      if(drawPoints.length < 3){
        updateDrawUI();
        return;
      }
      drawClosed = true;
      rebuildDrawLine(null);

      const area = polygonAreaXZ(drawPoints);
      const per = polygonPerimeter(drawPoints);
      areaOut.textContent = `Точек: ${drawPoints.length} • площадь ~ ${area.toFixed(2)} м² • периметр ~ ${per.toFixed(2)} м`;

      updateDrawUI();
      return;
    }

    // 2) Если контур уже замкнут — дальнейшие действия через кнопку «Визуализировать» внизу
    updateDrawUI();
  });

  // Measurement
  function clearMeasure(){
    measureA = null; measureB = null;
    measureOut.textContent = "—";
    if(measureLine){
      lockedRoot.remove(measureLine);
      measureLine.geometry.dispose();
      measureLine.material.dispose();
      measureLine = null;
    }
  }
  clearMeasureBtn.addEventListener("click", clearMeasure);

  function setMeasurePoint(p){
    if(!measureA){
      measureA = p.clone();
      measureOut.textContent = "Точка A установлена. Тапните точку B.";
      return;
    }
    measureB = p.clone();
    const dist = measureA.distanceTo(measureB);
    measureOut.textContent = `Расстояние: ${fmtM(dist)} м`;

    // line
    if(measureLine){
      lockedRoot.remove(measureLine);
      measureLine.geometry.dispose();
      measureLine.material.dispose();
      measureLine=null;
    }
    const geom = new THREE.BufferGeometry().setFromPoints([measureA, measureB]);
    const mat = new THREE.LineBasicMaterial({ color: 0xf59e0b });
    enableDepthOcclusionOnMaterial(mat);
    measureLine = new THREE.Line(geom, mat);
    lockedRoot.add(measureLine);
  }

  // Tile selection
  async function selectVariant(variant){
    if(!variant) return;
    currentVariant = variant;
    renderVariants();
    tileNameEl.textContent = `${currentItem?.name || ""} — ${variant.name || ""}`.trim();

    setStatus("загрузка текстур…");
    currentMaterial = await buildMaterialForVariant(variant);
    setStatus(arSession ? "AR активен" : "3D‑превью");

    if(surfaceMesh){
      surfaceMesh.material = currentMaterial;
      // Depth-occlusion tuning for floor overlays (reduces "popping" on flat surfaces)
      surfaceMesh.material.userData.__occlEps = 0.03;
      surfaceMesh.material.userData.__occlBias = 0.01;
      surfaceMesh.material.polygonOffset = true;
      surfaceMesh.material.polygonOffsetFactor = -1;
      surfaceMesh.material.polygonOffsetUnits = -1;
      // держим прозрачность включенной — так можно делать плавные появления/исчезновения
      surfaceMesh.material.transparent = true;
      surfaceMesh.material.opacity = 1;
    }
  }

  async function selectItem(item){
    currentItem = item;
    const pattern = item?.patternSize_m;
    currentPatternSize = Array.isArray(pattern) ? pattern : [0.3, 0.3];
    renderVariants();
    if(item?.variants && item.variants.length){
      await selectVariant(item.variants[0]);
    }
  }

  // Load catalog & select first item
  setStatus("загрузка каталога…");
  catalog = await loadCatalog();
  // Hide splash once core assets are ready
  hideSplash();
  buildFilters();
  renderCatalog();
  if(catalog.items && catalog.items.length){
    await selectItem(catalog.items[0]);
  } else {
    tileNameEl.textContent = "Каталог пуст";
  }

  // Init surface container
  ensureSurfaceMesh();
  // start hidden until visualized
  if(surfaceMesh){ surfaceMesh.material.transparent = true; surfaceMesh.material.opacity = 0; }

  // Screenshot
  function takeScreenshot(){
    try{
      const url = renderer.domElement.toDataURL("image/png");
      const win = window.open();
      if(win) win.document.write(`<img src="${url}" style="width:100%;height:auto"/>`);
    }catch(e){ showDebug(e); }
  }
  shotBtn.addEventListener("click", takeScreenshot);

  // WebXR start/stop
  async function isARSupported(){
    try{
      if(!navigator.xr) return false;
      return await navigator.xr.isSessionSupported("immersive-ar");
    }catch(e){
      return false;
    }
  }

  
  async function requestSessionWithFallback(){
    // Try with dom-overlay + depth-sensing + anchors, then fallback progressively
    const base = {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay", "anchors", "light-estimation", "depth-sensing"],
      domOverlay: { root: document.body },
      depthSensing: {
        usagePreference: ["gpu-optimized", "cpu-optimized"],
        dataFormatPreference: ["luminance-alpha", "float32"]
      }
    };

    try{
      return await navigator.xr.requestSession("immersive-ar", base);
    }catch(e1){
      console.warn("requestSession(full) failed, retrying without depth-sensing", e1);
      try{
        return await navigator.xr.requestSession("immersive-ar", {
          requiredFeatures: ["hit-test"],
          optionalFeatures: ["dom-overlay", "anchors", "light-estimation"],
          domOverlay: { root: document.body }
        });
      }catch(e2){
        console.warn("requestSession(dom-overlay) failed, retrying without domOverlay", e2);
        return await navigator.xr.requestSession("immersive-ar", {
          requiredFeatures: ["hit-test"],
          optionalFeatures: ["anchors", "light-estimation"]
        });
      }
    }
  }

  async function chooseRefSpaceType(session){
    const types = ["local-floor", "bounded-floor", "local"];
    for(const t of types){
      try{
        await session.requestReferenceSpace(t);
        return t;
      }catch(e){ /* try next */ }
    }
    return "local";
  }

  async function startAR(){
    try{
      if(arSession) return;
      setHelp(false);

      const supported = await isARSupported();
      if(!supported){
        setStatus("AR недоступен (показано 3D‑превью)");
        alert("WebXR AR недоступен в этом браузере.\n\nОткройте в Chrome на Android (ARCore). На iPhone Safari WebXR AR обычно не работает.");
        return;
      }

      enterArBtn.disabled = true;

      const session = await requestSessionWithFallback();

      const refType = await chooseRefSpaceType(session);
      renderer.xr.setReferenceSpaceType(refType);

      // Three.js will create the WebGLLayer and manage camera
      await renderer.xr.setSession(session);

      // Чуть стабильнее картинка на некоторых устройствах
      try{ renderer.xr.setFoveation(0); }catch(_){ }

      // Делаем WebGL‑слой прозрачным: тогда видеопоток камеры будет виден.
      // Если оставить непрозрачный clear, WebXR сессия запускается,
      // разрешение на камеру даётся, но пользователь видит "чёрный экран".
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.style.backgroundColor = "transparent";

      viewerSpace = await session.requestReferenceSpace("viewer");
      // Просим hit-test только по плоскостям (если поддерживается) — меньше "хитов в воздухе"
      try{
        hitTestSource = await session.requestHitTestSource({ space: viewerSpace, entityTypes: ["plane"] });
      }catch(_){
        hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
      }

      lastHitValid = false;
      reticle.visible = false;

      arSession = session;
      arSession.addEventListener("end", onSessionEnd);

      // UI
      exitArBtn.disabled = false;
      enterArBtn.disabled = true;
      setStatus("AR активен — наведите на пол");
      depthSensingAvailable = false;
      controls.setEnabled(false);
      previewGround.visible = false;
      setPanelCollapsed(true);

      // Need manual calibration for stable floor-locked content
      floorLocked = false;
      lockedRoot.matrixAutoUpdate = true;
      lockedRoot.position.set(0,0,0);
      lockedRoot.quaternion.identity();
      lockedRoot.scale.set(1,1,1);
      lockedRoot.updateMatrixWorld(true);
      updateGridUI();
      setModeUI(mode);
      showAction("Калибр. пол", {secondary:true}, ()=>calibBtn?.click());

    }catch(e){
      enterArBtn.disabled = false;
      showDebug(e);
      setStatus("ошибка запуска AR");
    }
  }

  async function stopAR(){
    try{
      if(!arSession) return;
      await arSession.end();
    }catch(e){
      showDebug(e);
    }
  }

  function onSessionEnd(){
    // cleanup
    try{
      if(arSession){
        arSession.removeEventListener("end", onSessionEnd);
      }
    }catch(_){}
    arSession = null;

    hitTestSource = null;
    viewerSpace = null;
    reticle.visible = false;
    lastHitValid = false;

    exitArBtn.disabled = true;
    enterArBtn.disabled = false;
    setStatus("3D‑превью");
    controls.setEnabled(true);
    previewGround.visible = true;

    // Возвращаем непрозрачный фон для 3D‑превью.
    renderer.setClearColor(PREVIEW_CLEAR.color, PREVIEW_CLEAR.alpha);
    renderer.domElement.style.backgroundColor = "";

    // reset calibration/anchors
    floorLocked = false;
    lockedFloorY = 0;
    try{ if(floorAnchor && floorAnchor.delete) floorAnchor.delete(); }catch(_){ }
    floorAnchor = null;
    lastBestHit = null;
    lockedRoot.matrixAutoUpdate = true;
    lockedRoot.position.set(0,0,0);
    lockedRoot.quaternion.identity();
    lockedRoot.scale.set(1,1,1);
    lockedRoot.updateMatrixWorld(true);
    updateGridUI();
    hideAction();
    setModeUI(mode);
  }

  enterArBtn.addEventListener("click", startAR);
  exitArBtn.addEventListener("click", stopAR);

  // Tap handling
  
  // Tap handling
  window.addEventListener("pointerdown", (e)=>{
    if(pointInUI(e.target)) return;
    if(!arSession) return;
    if(!reticle.visible) return;

    // Require calibration for placing points/measurements (prevents фиксацию на стенах и уменьшает дрейф)
    if(!floorLocked && (mode==="draw" || mode==="measure")){
      // small hint
      showAction("Калибр. пол", {secondary:true}, ()=>calibBtn?.click());
      return;
    }

    const pWorld = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
    const p = worldToLockedLocal(pWorld, new THREE.Vector3());

    if(mode === "draw"){
      addDrawPoint(p);
      rebuildDrawLine(null);
    } else if(mode === "measure"){
      setMeasurePoint(p);
    }
  }, { passive:true });

  // Resize
  window.addEventListener("resize", ()=>{
    // В WebXR размер framebuffer контролируется сессией.
    // setSize во время presenting может кидать ошибку на некоторых браузерах.
    if(renderer.xr && renderer.xr.isPresenting) return;

    camera.aspect = innerWidth/innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  });

  // Main render loop (works for both preview and XR)
  renderer.setAnimationLoop((t, frame)=>{

// Update depth texture for occlusion (WebXR Depth API)
// NOTE: depth read + upload can be expensive, so we only do it when something actually needs occlusion.
if(depthOcclusionEnabled && occlusionMaterials.size > 0 && frame && typeof frame.getDepthInformation === 'function'){
  hasDepthThisFrame = false;
  try{
    const ref = renderer.xr.getReferenceSpace();
    const viewerPose = frame.getViewerPose(ref);
    if(viewerPose && viewerPose.views && viewerPose.views[0]){
      const view = viewerPose.views[0];
      const depthInfo = frame.getDepthInformation(view);
      if(depthInfo && depthInfo.data){
        hasDepthThisFrame = true;
        depthSensingAvailable = true;
        depthRawToMeters = depthInfo.rawValueToMeters || depthRawToMeters;

        const w = depthInfo.width|0;
        const h = depthInfo.height|0;

        // Allocate / resize buffers & texture if needed
        if(!depthCPUBufferRGBA || w !== depthCPUW || h !== depthCPUH || !depthTex){
          depthCPUW = w; depthCPUH = h;
          depthCPUBufferRGBA = new Uint8Array(w * h * 4);
          depthTexW = w; depthTexH = h;

          depthTex = new THREE.DataTexture(depthCPUBufferRGBA, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
          depthTex.flipY = false;
          depthTex.generateMipmaps = false;
          depthTex.minFilter = THREE.NearestFilter;
          depthTex.magFilter = THREE.NearestFilter;
          depthTex.needsUpdate = true;
        }else{
          depthTexW = w; depthTexH = h;
        }

        // Pack Uint16 depth into RGBA8 (R=low byte, G=high byte)
        const u16 = new Uint16Array(depthInfo.data);
        const rgba = depthCPUBufferRGBA;
        const n = Math.min(u16.length, w * h);
        for(let i=0, j=0; i<n; i++, j+=4){
          const v = u16[i];
          rgba[j]   = v & 255;
          rgba[j+1] = (v >> 8) & 255;
          rgba[j+2] = 0;
          rgba[j+3] = 255;
        }
        depthTex.needsUpdate = true;

        if(typeof updateDepthOcclusionUniforms === 'function') updateDepthOcclusionUniforms();
      }
    }
  }catch(e){
    // depth not available this frame on this device/session
  }
}
    // Update locked root from anchor (reduces drift) if available
    if(frame && floorAnchor && floorAnchor.anchorSpace){
      try{
        const refSpace = renderer.xr.getReferenceSpace();
        const ap = frame.getPose(floorAnchor.anchorSpace, refSpace);
        if(ap){
          _tmpMat.fromArray(ap.transform.matrix);
          lockedRoot.matrixAutoUpdate = false;
          lockedRoot.matrix.copy(_tmpMat);
          lockedRoot.matrix.decompose(lockedRoot.position, lockedRoot.quaternion, lockedRoot.scale);

          // Remove pitch/roll from anchor orientation: keep only yaw so the floor stays perfectly horizontal
          yawOnlyQuatFrom(lockedRoot.quaternion, _flatQuat);
          lockedRoot.quaternion.copy(_flatQuat);

          lockedRoot.scale.copy(_oneScale);
          lockedRoot.matrix.compose(lockedRoot.position, lockedRoot.quaternion, lockedRoot.scale);

          lockedRoot.updateMatrixWorld(true);
          lockedFloorY = lockedRoot.position.y;
        }
      }catch(e){ /* ignore */ }
    }

    // Depth sensing (occlusion support) detection
    if(frame && !depthSensingAvailable && frame.getDepthInformation){
      try{
        const refSpace = renderer.xr.getReferenceSpace();
        const pose = frame.getViewerPose(refSpace);
        const view = pose?.views?.[0];
        const di = view ? frame.getDepthInformation(view) : null;
        if(di){
          depthSensingAvailable = true;
          console.log("Depth sensing available:", di);
        }
      }catch(_){ }
    }

    // XR hit-test (стабильная привязка к полу)
        if(frame && hitTestSource){
      const refSpace = renderer.xr.getReferenceSpace();

      const xrCam = renderer.xr.getCamera(camera);
      xrCam.getWorldPosition(_tmpCamPos);
      xrCam.getWorldDirection(_tmpDir);
      const camY = _tmpCamPos.y;

      if(floorLocked){
        // После калибровки перестаем использовать hit-test для позиционирования.
        // Вместо этого пересекаем луч камеры с зафиксированной горизонтальной плоскостью пола.
        // Так точки не будут ставиться на стены/предметы, а сетка/контур перестанут "липнуть" куда попало.
        lastHitIsFloor = false;
        lastHitValid = false;

        // Нужно смотреть достаточно вниз, иначе луч может не пересечь пол (или пересечет слишком далеко).
        if(_tmpDir.y <= LOCK_RAY_MIN_DIR_Y){
          const floorY = lockedRoot.position.y;
          const tHit = (floorY - _tmpCamPos.y) / _tmpDir.y; // _tmpDir.y отрицательный при взгляде вниз
          if(tHit > 0 && tHit < LOCK_RAY_MAX_DIST){
            _tmpWorldHit.copy(_tmpCamPos).addScaledVector(_tmpDir, tHit);

            // сглаживание, чтобы ретикл не дрожал
            lastHitPos.lerp(_tmpWorldHit, HIT_SMOOTHING);
            lastHitQuat.identity();

            lastHitIsFloor = true;
            lastHitValid = true;

            // базовый вид ретикла
            reticleMat.color.setHex(0x22c55e);
            _hitScale.set(1,1,1);

            // Подсветка "замыкания" полигона
            if(mode==="draw" && drawOrigin && !drawClosed){
              const liveLocal = worldToLockedLocal(lastHitPos, _tmpPos);
              liveLocal.y = drawOrigin.y;
              const dSnap = distXZ(liveLocal, drawOrigin);
              if(dSnap < CLOSE_SNAP_DIST){
                reticleMat.color.setHex(0xf59e0b);
                _hitScale.set(1.35,1.35,1.35);
              }
            }

            reticle.matrix.compose(lastHitPos, lastHitQuat, _hitScale);
            reticle.matrix.decompose(reticle.position, reticle.quaternion, reticle.scale);
            reticle.visible = true;

            // Live preview линии (в локальных координатах lockedRoot)
            if(mode==="draw" && drawPoints.length>0 && !drawClosed){
              const _liveLocal = worldToLockedLocal(lastHitPos, _tmpPos);
              _liveLocal.y = drawOrigin ? drawOrigin.y : 0;
              rebuildDrawLine(_liveLocal);
            } else if(mode==="draw" && drawPoints.length>0){
              rebuildDrawLine(null);
            }
          } else {
            reticle.visible = false;
            if(mode==="draw" && drawPoints.length>0) rebuildDrawLine(null);
          }
        } else {
          reticle.visible = false;
          if(mode==="draw" && drawPoints.length>0) rebuildDrawLine(null);
        }
      } else {
        const hits = frame.getHitTestResults(hitTestSource);

      lastHitIsFloor = false;

      let found = false;
      let bestY = Infinity;
      let bestDot = -1;

      let _bestHitResult = null;
      for(const hit of hits){
        const pose = hit.getPose(refSpace);
        if(!pose) continue;

        _tmpMat.fromArray(pose.transform.matrix);
        _tmpPos.setFromMatrixPosition(_tmpMat);
        _tmpQuat.setFromRotationMatrix(_tmpMat);

        // Нормаль плоскости (локальная Y ось позы). На поддерживаемых ARCore устройствах это помогает отсеять стены.
        _tmpNormal.set(0,1,0).applyQuaternion(_tmpQuat);
        const dot = _tmpNormal.dot(_worldUp);

        // Всегда требуем "почти горизонталь"
        if(dot < HIT_NORMAL_DOT_STRICT) continue;

        if(!floorLocked){
          // До калибровки не даём калибр. на поверхностях около уровня камеры
          if(_tmpPos.y > camY - FLOOR_MIN_BELOW_CAM) continue;
        } else {
          // После калибровки принимаем хиты только рядом с зафиксированным уровнем пола
          if(Math.abs(_tmpPos.y - lockedFloorY) > FLOOR_Y_TOL) continue;
        }

        const y = _tmpPos.y;
        if(!found || y < bestY - 0.01 || (Math.abs(y - bestY) < 0.01 && dot > bestDot)){
          found = true;
          bestY = y;
          bestDot = dot;
          _bestPos.copy(_tmpPos);
          _bestQuat.copy(_tmpQuat);
          _bestHitResult = hit;
        }
      }

      lastHitIsFloor = found;

      if(found){
        // store best hit for calibration/anchors
        lastBestHit = _bestHitResult || lastBestHit;

        if(!lastHitValid){
          lastHitPos.copy(_bestPos);
          lastHitQuat.copy(_bestQuat);
          lastHitValid = true;
        }else{
          lastHitPos.lerp(_bestPos, HIT_SMOOTHING);
          lastHitQuat.slerp(_bestQuat, HIT_SMOOTHING);
        }

        reticle.visible = true;

        // Подсветка «замкнуть контур»: когда прицел рядом с первой точкой — делаем его оранжевым и чуть больше
        if(mode==="draw" && drawOrigin && drawPoints.length >= 3 && !drawClosed){
          const _tmpLocal = worldToLockedLocal(lastHitPos, new THREE.Vector3());
          const dSnap = distXZ(_tmpLocal, drawOrigin);
          if(dSnap < DRAW_SNAP_M){
            reticleMat.color.setHex(0xf59e0b);
            _hitScale.set(1.35, 1.35, 1.35);
          }else{
            reticleMat.color.setHex(0x22c55e);
            _hitScale.set(1,1,1);
          }
        }else{
          reticleMat.color.setHex(0x22c55e);
          _hitScale.set(1,1,1);
        }

        reticle.matrix.compose(lastHitPos, lastHitQuat, _hitScale);

        // live draw line preview
        if(mode==="draw" && drawPoints.length){
          const _liveLocal = worldToLockedLocal(lastHitPos, new THREE.Vector3());
          rebuildDrawLine(_liveLocal);
        }
      } else {
        reticle.visible = false;
        lastHitValid = false;
        lastBestHit = null;

        // если контур открыт — уберём "живой" сегмент
        if(mode==="draw" && drawPoints.length){
          rebuildDrawLine(null);
        }
      }
      }
    }

    // Non-AR preview: keep surface on origin
    if(!arSession){
      // 3D preview: показываем только если уже была визуализация
      if(surfaceMesh){
        surfaceMesh.visible = !!surfacePlaced;
      }
    }

    updateSurfaceFade(t || performance.now());

    renderer.render(scene, camera);
  });

  // Initial status
  const arOk = await isARSupported();
  setStatus(arOk ? "готово (AR доступен)" : "готово (AR недоступен — 3D‑превью)");
  enterArBtn.disabled = !arOk;
  exitArBtn.disabled = true;

})().catch(showDebug);