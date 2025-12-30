import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadTiles, loadShapes, clamp, initAutoTechPalettes, discoverShapeHeroGallery, withBust } from './utils.js';

// ------------------------
// UI
// ------------------------
const UI = {
  overlay: document.getElementById('overlay'),
  canvas: document.getElementById('xrCanvas'),

  // Screens
  screenCatalog: document.getElementById('screenCatalog'),
  screenDetail: document.getElementById('screenDetail'),
  screenAR: document.getElementById('screenAR'),

  // Catalog
  catalogSearch: document.getElementById('catalogSearch'),
  catalogCards: document.getElementById('catalogCards'),

  // Detail
  btnDetailBack: document.getElementById('btnDetailBack'),
  detailTitle: document.getElementById('detailTitle'),
  detailHero: document.getElementById('detailHero'),
  detailName: document.getElementById('detailName'),
  detailSub: document.getElementById('detailSub'),
  detailTech: document.getElementById('detailTech'),
  // Antika tech parameters panel
  techBody: document.getElementById('techBody'),
  btnTechToggle: document.getElementById('btnTechToggle'),
  btnTechClose: document.getElementById('btnTechClose'),
  layoutRow: document.getElementById('layoutRow'),
  colorRow: document.getElementById('colorRow'),
  btnViewAR: document.getElementById('btnViewAR'),

  // AR
  btnArBack: document.getElementById('btnArBack'),
  btnArReset: document.getElementById('btnArReset'),
  arProductTitle: document.getElementById('arProductTitle'),
  arArea: document.getElementById('arArea'),
  scanHint: document.getElementById('scanHint'),
  measureLayer: document.getElementById('measureLayer'),
  arBottomCenter: document.getElementById('arBottomCenter'),
  btnArAdd: document.getElementById('btnArAdd'),
  btnArOk: document.getElementById('btnArOk'),
  postCloseBar: document.getElementById('postCloseBar'),
  btnEditShape: document.getElementById('btnEditShape'),
  btnCutout: document.getElementById('btnCutout'),
  btnDone: document.getElementById('btnDone'),
  finalBar: document.getElementById('finalBar'),
  finalPatterns: document.getElementById('finalPatterns'),
  finalColors: document.getElementById('finalColors'),

  // Hidden tech
  layoutSelect: document.getElementById('layoutSelect'),
  toggleOcclusion: document.getElementById('toggleOcclusion'),
};

function show(el, on = true) {
  if (!el) return;
  if (on) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
}

function setActiveScreen(name) {
  const map = {
    catalog: UI.screenCatalog,
    detail: UI.screenDetail,
    ar: UI.screenAR,
  };
  for (const k of Object.keys(map)) {
    const el = map[k];
    if (!el) continue;
    const isActive = k === name;
    el.classList.toggle('screen--active', isActive);
    show(el, isActive);
  }
}

function fmtMeters(m) {
  return `${m.toFixed(2).replace('.', ',')} м`;
}
function fmtArea(m2) {
  return `${m2.toFixed(2).replace('.', ',')} м²`;
}


function updateArBottomStripVar() {
  try {
    const bar = UI.finalBar;
    const h = (bar && !bar.hasAttribute('hidden')) ? bar.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--ar-bottom-strip', `${Math.ceil(h)}px`);
  } catch (_) {}
}


// ------------------------
// App state
// ------------------------
const state = {
  tiles: [],
  selectedTile: null,
  shapes: [],
  selectedShape: null,
  layout: 'straight', // straight | diagonal | stagger

  // internal guards
  _restartingAR: false,
  _startingAR: false,

  // WebXR
  xrSession: null,
  referenceSpace: null,
  viewerSpace: null,
  hitTestSource: null,
  transientHitTestSource: null,
  transientHitPoses: new Map(),
  lastUiTapTs: 0,
  anchorsSupported: false,
  anchor: null,

  // depth
  depthSupported: false,
  depthInfoSize: null,
  depthTexture: null,
  depthData: null,
  occlusionEnabled: false,

  // tracking / drawing
  phase: 'catalog', // catalog|detail|ar_scan|ar_draw|ar_mask|ar_cut|ar_final
  floorLocked: false,
  floorY: 0,
  // floor scan stabilization
  floorSamples: [],
  floorYEstimate: null,
  floorStable: false,

  reticleVisible: false,
  snapArmed: false,

  points: /** @type {THREE.Vector3[]} */ ([]),
  holes: /** @type {THREE.Vector3[][]} */ ([]),
  holePoints: /** @type {THREE.Vector3[]} */ ([]),
  closed: false,
};

const SNAP_DIST_M = 0.10;

// ------------------------
// Three.js scene
// ------------------------
const renderer = new THREE.WebGLRenderer({
  canvas: UI.canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;

const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 50);
camera.position.set(0, 1.2, 2.2);

scene.add(new THREE.HemisphereLight(0xffffff, 0x202030, 1.0));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(1, 3, 2);
scene.add(dirLight);

const world = new THREE.Group();
scene.add(world);

const anchorGroup = new THREE.Group();
world.add(anchorGroup);

// Reticle
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.06, 0.085, 40, 1).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x2f6cff, transparent: true, opacity: 0.9 })
);
reticle.visible = false;
world.add(reticle);

// Scanning grid (visual hint) — line grid like in the reference app
const scanGrid = new THREE.GridHelper(2.4, 24, 0x2f6cff, 0x2f6cff);
scanGrid.visible = false;
scanGrid.position.y = 0.001;
// soften the grid
try {
  const mats = Array.isArray(scanGrid.material) ? scanGrid.material : [scanGrid.material];
  for (const m of mats) {
    m.transparent = true;
    m.opacity = 0.35;
    m.depthWrite = false;
  }
} catch (_) {}
world.add(scanGrid);

// Desktop fallback preview
const previewPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(3, 3, 1, 1).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x2b2f38 })
);
previewPlane.position.set(0, 0, 0);
world.add(previewPlane);
const previewGrid = new THREE.GridHelper(3, 12, 0x3a6cff, 0x3a3a3a);
previewGrid.position.y = 0.0005;
world.add(previewGrid);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.48;
controls.minDistance = 0.6;
controls.maxDistance = 6;

// Drawing objects
const pointsGroup = new THREE.Group();
anchorGroup.add(pointsGroup);
let line = null;
let fillMesh = null;

// Materials
let tileMaterial = null;
const maskMaterial = new THREE.MeshBasicMaterial({
  color: 0x5aa7ff,
  transparent: true,
  opacity: 0.30,
  depthWrite: false,
});

function makeTileMaterial(texture) {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uTex: { value: texture },
      uTileSize: { value: new THREE.Vector2(0.2, 0.2) },
      uLayoutMode: { value: 0 }, // 0 straight, 1 diagonal, 2 stagger
      uLightDir: { value: new THREE.Vector3(1, 2, 1).normalize() },
      uAmbient: { value: 0.35 },
      uUseOcclusion: { value: 0 },
      uDepthTex: { value: null },
      uDepthValid: { value: 0 },
      uOcclusionEps: { value: 0.02 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vViewPos;
      varying vec4 vClipPos;

      uniform vec2 uTileSize;
      uniform int uLayoutMode;

      mat2 rot(float a){
        float c = cos(a), s = sin(a);
        return mat2(c, -s, s, c);
      }

      void main(){
        vec3 pos = position;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        vViewPos = mv.xyz;
        vClipPos = projectionMatrix * mv;

        vNormalW = normalize((modelMatrix * vec4(normal,0.0)).xyz);

        vec2 uv = vec2(pos.x / uTileSize.x, pos.z / uTileSize.y);

        if (uLayoutMode == 1) {
          uv = rot(0.78539816339) * uv; // 45°
        } else if (uLayoutMode == 2) {
          float row = floor(uv.y);
          uv.x += 0.5 * mod(row, 2.0);
        }

        vUv = uv;
        gl_Position = vClipPos;
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vViewPos;
      varying vec4 vClipPos;

      uniform sampler2D uTex;
      uniform vec3 uLightDir;
      uniform float uAmbient;

      uniform int uUseOcclusion;
      uniform sampler2D uDepthTex;
      uniform int uDepthValid;
      uniform float uOcclusionEps;

      vec2 safeFract(vec2 v){ return v - floor(v); }

      void main(){
        if (uUseOcclusion == 1 && uDepthValid == 1) {
          vec3 ndc = (vClipPos.xyz / vClipPos.w);
          vec2 suv = ndc.xy * 0.5 + 0.5;
          if (suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0) {
            float sceneDepth = texture2D(uDepthTex, suv).r;
            float fragDist = length(vViewPos);
            if (sceneDepth > 0.0 && sceneDepth < (fragDist - uOcclusionEps)) {
              discard;
            }
          }
        }

        vec3 albedo = texture2D(uTex, safeFract(vUv)).rgb;

        vec3 N = normalize(vNormalW);
        vec3 L = normalize(uLightDir);
        float diff = max(dot(N, L), 0.0);
        float light = uAmbient + (1.0 - uAmbient) * diff;

        vec3 color = albedo * light;
        gl_FragColor = vec4(color, 0.98);
      }
    `,
  });
  return mat;
}

// ------------------------
// Geometry helpers
// ------------------------
function distXZ(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}

function polyArea2(points) {
  // points: Vector3[] in local space, use x,z
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    s += (a.x * b.z - b.x * a.z);
  }
  return s * 0.5;
}

function computeAreaM2() {
  if (state.points.length < 3) return 0;
  let outer = Math.abs(polyArea2(state.points));
  let holes = 0;
  for (const h of state.holes) {
    if (h.length >= 3) holes += Math.abs(polyArea2(h));
  }
  return Math.max(0, outer - holes);
}

function setLayout(layout) {
  state.layout = layout;
  if (UI.layoutSelect) UI.layoutSelect.value = layout;
  if (tileMaterial) {
    tileMaterial.uniforms.uLayoutMode.value = layout === 'straight' ? 0 : (layout === 'diagonal' ? 1 : 2);
  }
  // UI: pattern tabs
  UI.finalPatterns?.querySelectorAll('.patternTab').forEach(btn => {
    btn.classList.toggle('patternTab--active', btn.dataset.layout === layout);
  });
  UI.layoutRow?.querySelectorAll('.layoutCard').forEach(btn => {
    btn.classList.toggle('layoutCard--active', btn.dataset.layout === layout);
  });
}

async function selectTile(tileId) {
  const t = state.tiles.find(x => x.id === tileId);
  if (!t) return;
  state.selectedTile = t;

  const tex = await new THREE.TextureLoader().loadAsync(t.texture);
  tileMaterial = makeTileMaterial(tex);
  tileMaterial.uniforms.uTileSize.value.set(t.tileSizeM.w, t.tileSizeM.h);
  setLayout(state.layout);

  // desktop preview
  previewPlane.material.map = tex;
  previewPlane.material.needsUpdate = true;
  previewPlane.material.map.repeat.set(3 / t.tileSizeM.w, 3 / t.tileSizeM.h);

  // update detail hero
  if (UI.detailHero) {
    const hasHeroGallery = !!(state.selectedShape && Array.isArray(state.selectedShape.gallery) && state.selectedShape.gallery.length);
    if (!hasHeroGallery) {
      UI.detailHero.style.backgroundImage = `url(${withBust(t.preview)})`;
    }
  }

  // update selected in color rows
  const updateSwatches = (wrap) => {
    wrap?.querySelectorAll('[data-tile-id]').forEach(el => {
      el.classList.toggle('swatch--active', String(tileId) === el.dataset.tileId);
    });
  };
  updateSwatches(UI.colorRow);
  updateSwatches(UI.finalColors);

  // update AR title
  if (UI.arProductTitle) UI.arProductTitle.textContent = t.name;
}

// ------------------------
// Catalog + Detail rendering (Формы -> деталка формы -> выбор цветов/текстур)
// ------------------------
function renderCatalog(list) {
  if (!UI.catalogCards) return;
  UI.catalogCards.innerHTML = '';
  list.forEach(shape => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'catalogCard catalogCard--square';
    card.style.backgroundImage = `url(${shape.icon || shape.hero || ''})`;
    card.setAttribute('aria-label', shape.name || shape.id || 'Форма');
    card.addEventListener('click', () => openDetail(shape.id));
    UI.catalogCards.appendChild(card);
  });
}

async function openDetail(shapeId) {
  const s = state.shapes.find(x => x.id === shapeId);
  if (!s) return;
  state.selectedShape = s;

  // Fill UI
  UI.detailTitle.textContent = s.name;
  UI.detailName.textContent = s.name;
  UI.detailSub.textContent = s.subtitle || 'Тротуарная плитка';
  // Шапка: предпочитаем авто-подхват из папки assets/gallery/<shapeId>/
  // (чтобы новые файлы появлялись без правки shapes.json)
  let gallery = await discoverShapeHeroGallery(s.id);
  if (!gallery.length) {
    gallery = Array.isArray(s.gallery) ? s.gallery.filter(Boolean) : [];
  }
  // cache-busting for replaced files
  gallery = gallery.map((src) => withBust(src));
  // keep in-memory for subsequent logic (e.g. selectTile)
  s.gallery = gallery;

  if (gallery.length > 0) {
    UI.detailHero.style.backgroundImage = 'none';
    UI.detailHero.innerHTML = `
      <div class="heroCarousel">
        <div class="heroTrack" id="heroTrack">
          ${gallery.map((src, idx) => `
            <div class="heroSlide" data-idx="${idx}">
              <img src="${src}" alt="">
            </div>`).join('')}
        </div>
        <div class="heroDots" id="heroDots">
          ${gallery.map((_, idx) => `<div class="heroDot ${idx===0?'active':''}" data-idx="${idx}"></div>`).join('')}
        </div>
      </div>
    `;
    const track = UI.detailHero.querySelector('#heroTrack');
    const dots = [...UI.detailHero.querySelectorAll('.heroDot')];
    const activateDot = (i) => dots.forEach((d, di) => d.classList.toggle('active', di===i));
    track.addEventListener('scroll', () => {
      const w = track.clientWidth || 1;
      const idx = Math.round(track.scrollLeft / w);
      activateDot(Math.max(0, Math.min(dots.length-1, idx)));
    }, { passive: true });
  } else {
    UI.detailHero.innerHTML = '';
    UI.detailHero.style.backgroundImage = `url(${withBust(s.hero || s.icon || '')})`;
  }

  // tech
  UI.detailTech.innerHTML = '';
  const tech = s.tech || {
    'Толщина': '—',
    'Назначение': '—',
    'Класс': '—',
  };
  for (const [k, v] of Object.entries(tech)) {
    const key = String(k);
    const val = String(v);

    // Толщина выводим одной строкой слева: "Толщина - 60мм" (как в OZON)
    if (/^\s*Толщина/.test(key)) {
      const row = document.createElement('div');
      row.className = 'kvRow kvRowFull';
      row.innerHTML = `<div class="kvFull">${key.replace(/\s*,\s*мм\s*$/i,'')} - ${val.replace(/\s*мм\s*$/i,'')}мм</div>`;
      UI.detailTech.appendChild(row);
      continue;
    }

    const row = document.createElement('div');
    row.className = 'kvRow';
    row.innerHTML = `<div class="kvK">${key}</div><div class="kvV">${val}</div>`;
    UI.detailTech.appendChild(row);
  }
  if (UI.techBody) UI.techBody.hidden = true;
  if (UI.btnTechToggle) UI.btnTechToggle.hidden = false;

  // Layout buttons
  UI.layoutRow.querySelectorAll('.layoutCard').forEach(btn => {
    btn.onclick = () => setLayout(btn.dataset.layout);
  });
  setLayout(state.layout);

  // Colors for this shape (fallback: all tiles)
  const allowed = Array.isArray(s.tileIds) && s.tileIds.length
    ? s.tileIds.map(id => state.tiles.find(t => t.id === id)).filter(Boolean)
    : state.tiles;
  renderColorRow(UI.colorRow, allowed);

  // Choose default tile for this shape
  const defaultTile = allowed[0] || state.tiles[0];
  if (defaultTile) selectTile(defaultTile.id);

  setActiveScreen('detail');
  state.phase = 'detail';
}

function renderColorRow(container, tiles) {
  if (!container) return;
  container.innerHTML = '';
  tiles.forEach(t => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch';
    sw.dataset.tileId = String(t.id);
    sw.style.backgroundImage = `url(${t.preview})`;
    sw.title = t.name;
    sw.addEventListener('click', () => selectTile(t.id));
    container.appendChild(sw);
  });
}

// ------------------------
// XR setup
// ------------------------
async function checkXrSupport() {
  if (!navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported('immersive-ar');
  } catch {
    return false;
  }
}

async function startAR() {
  if (state._startingAR) return;
  state._startingAR = true;
  try {

  if (!navigator.xr) {
    alert('WebXR недоступен в этом браузере. Откройте сайт в Chrome на Android.');
    return;
  }
  const supported = await checkXrSupport();
  if (!supported) {
    alert('immersive-ar не поддерживается. Нужен Chrome на Android с ARCore.');
    return;
  }

  const wantsDepth = !!UI.toggleOcclusion?.checked;
  const canRequestDepth = wantsDepth && (typeof XRWebGLBinding !== 'undefined');

  const sessionInit = {
    requiredFeatures: ['hit-test', 'dom-overlay'],
    optionalFeatures: ['anchors', ...(canRequestDepth ? ['depth-sensing'] : [])],
    domOverlay: { root: UI.overlay },
    ...(canRequestDepth ? {
      depthSensing: {
        usagePreference: ['cpu-optimized', 'gpu-optimized'],
        dataFormatPreference: ['luminance-alpha', 'float32'],
      },
    } : {}),
  };

  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', sessionInit);
  } catch (e) {
    console.error(e);
    alert('Не удалось запустить AR-сессию. Проверьте разрешения камеры.');
    return;
  }

  state.xrSession = session;
  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(session);

  state.referenceSpace = await session.requestReferenceSpace('local');
  state.viewerSpace = await session.requestReferenceSpace('viewer');

  state.hitTestSource = await session.requestHitTestSource({ space: state.viewerSpace });

  // IMPORTANT:
  // In the reference app, points are placed ONLY by pressing the on-screen "+" button
  // (using the reticle / center hit-test). We intentionally do NOT place points on
  // general screen taps (XR "select"), to avoid accidental points.
  state.transientHitTestSource = null;
  state.transientHitPoses = new Map();

  // floor scan
  state.floorSamples = [];
  state.floorYEstimate = null;
  state.floorStable = false;
  state._onXRSelect = null;

  // anchors
  state.anchorsSupported = typeof session.requestAnchor === 'function';

  // depth
  state.depthSupported = false;
  state.occlusionEnabled = false;
  try {
    const enabled = session.enabledFeatures ? Array.from(session.enabledFeatures) : [];
    state.depthSupported = enabled.includes('depth-sensing');
  } catch (_) {}

  session.addEventListener('end', () => {
    cleanupXR();
  });

  // enter AR UI
  setActiveScreen('ar');
  state.phase = 'ar_scan';
  resetAll(false); // всегда начинаем с нового сканирования
  UI.scanHint.classList.remove('hidden');
  show(UI.scanHint, true);

  // grid visible while scanning
  scanGrid.visible = true;

  // Hide desktop preview objects in AR (they otherwise appear floating)
  previewPlane.visible = false;
  previewGrid.visible = false;

  // Show bottom pattern strip in AR (like in the native app)
  show(UI.finalBar, true);
  show(UI.finalColors, false);
  updateArBottomStripVar();
  // main add button area visible at start
  show(UI.arBottomCenter, false);
  show(UI.btnArAdd, false);
  show(UI.btnArOk, false);
  } finally {
    state._startingAR = false;
  }
}

function cleanupXR() {
  state.xrSession = null;
  state.referenceSpace = null;
  state.viewerSpace = null;
  state.hitTestSource = null;
  state.transientHitTestSource = null;
  state.transientHitPoses = new Map();

  // depth
  state.depthSupported = false;
  state.depthInfoSize = null;
  state.depthTexture = null;
  state.depthData = null;

  // reset floor scan state when leaving AR so the next start begins from scanning
  state.floorLocked = false;
  state.floorStable = false;
  state.floorY = 0;
  state.floorSamples = [];
  state.floorYEstimate = null;


  reticle.visible = false;
  scanGrid.visible = false;

  // Restore desktop preview objects
  previewPlane.visible = true;
  previewGrid.visible = true;

  // UI
  if (!state._restartingAR) {
    setActiveScreen('detail');
    state.phase = 'detail';
  }
}

async function stopAR() {
  const s = state.xrSession;
  if (!s) return;
  try {
    if (state._onXRSelect) s.removeEventListener('select', state._onXRSelect);
  } catch (_) {}
  try { await s.end(); } catch (_) {}
}


async function fullRestartAR() {
  // Full restart of the AR session to guarantee a clean scan/placement cycle
  if (state._startingAR || state._restartingAR) return;

  state._restartingAR = true;

  // Disable controls during restart (prevents double clicks)
  try {
    UI.btnArReset?.setAttribute('disabled', '');
    UI.btnArAdd?.setAttribute('disabled', '');
    UI.btnArOk?.setAttribute('disabled', '');
    UI.btnDone?.setAttribute('disabled', '');
  } catch (_) {}

  // End current session (if any) and wait until it is fully cleaned up
  const s = state.xrSession;
  if (s) {
    await new Promise((resolve) => {
      const onEnd = () => resolve();
      try { s.addEventListener('end', onEnd, { once: true }); } catch (_) {}
      try { s.end().catch(() => resolve()); } catch (_) { resolve(); }
      // Safety: never hang forever
      setTimeout(resolve, 1200);
    });
  }

  // Now start again (startAR always resets and begins from scanning)
  try {
    await startAR();
  } finally {
    state._restartingAR = false;
    try {
      UI.btnArReset?.removeAttribute('disabled');
      UI.btnArAdd?.removeAttribute('disabled');
      UI.btnArOk?.removeAttribute('disabled');
      UI.btnDone?.removeAttribute('disabled');
    } catch (_) {}
  }
}

// ------------------------
// Floor lock + points
// ------------------------
function ensureFloorLocked() {
  if (state.floorLocked) return;
  if (!reticle.visible) return;
  state.floorLocked = true;
  state.floorY = reticle.position.y;

  // lock scanning grid to the floor (and then hide it — it is only for scanning)
  scanGrid.position.set(reticle.position.x, state.floorY + 0.001, reticle.position.z);
  scanGrid.visible = false;

  // hide scan hint
  show(UI.scanHint, false);
  state.phase = 'ar_draw';
}

function addPointAtWorld(worldPos) {
  if (!state.xrSession) return;

  // auto-lock floor on first action
  ensureFloorLocked();
  if (!state.floorLocked) return;

  // Clamp on floor
  const hitWorld = worldPos.clone();
  hitWorld.y = state.floorY;

  // Convert to local space (anchorGroup)
  const local = anchorGroup.worldToLocal(hitWorld);

  // If cutting a hole
  if (state.phase === 'ar_cut') {
    addHolePointLocal(local);
    return;
  }

  // protect duplicates
  if (state.points.length) {
    const d = distXZ(state.points[state.points.length - 1], local);
    if (d < 0.04) return;
  }

  // magnet close
  if (!state.closed && state.points.length >= 3) {
    const d0 = distXZ(state.points[0], local);
    if (d0 < SNAP_DIST_M) {
      closeContour();
      return;
    }
  }

  state.points.push(local);
  state.closed = false;
  rebuildMarkersAndLine(false);
  pointsGroup.visible = true;
  if (line) line.visible = true;
  if (UI.measureLayer) UI.measureLayer.style.display = 'block';
  show(UI.finalColors, false);
  updateArBottomStripVar();
  rebuildFill();
  updateAreaUI();

  if (state.points.length >= 3) show(UI.btnArOk, true);
}

function addPointFromReticle() {
  if (!state.xrSession) return;
  if (!state.floorLocked || state.phase === 'ar_scan') return;
  if (!reticle.visible) return;
  addPointAtWorld(reticle.position);
}

function addHolePointLocal(local) {
  // local already clamped to floor
  if (state.holePoints.length) {
    const d = distXZ(state.holePoints[state.holePoints.length - 1], local);
    if (d < 0.04) return;
  }

  if (state.holePoints.length >= 3) {
    const d0 = distXZ(state.holePoints[0], local);
    if (d0 < SNAP_DIST_M) {
      closeHole();
      return;
    }
  }

  state.holePoints.push(local);
  rebuildMarkersAndLine(state.closed);
  rebuildFill();
  updateAreaUI();

  if (state.holePoints.length >= 3) show(UI.btnArOk, true);
}

function closeHole() {
  if (state.holePoints.length < 3) return;
  // store hole and exit cut mode
  state.holes.push(state.holePoints.map(p => p.clone()));
  state.holePoints = [];
  state.phase = 'ar_mask';
  // hide cutout hint and restore default scan hint text
  try {
    const t = UI.scanHint?.querySelector('.scanTitle');
    const s = UI.scanHint?.querySelector('.scanText');
    if (t) t.textContent = 'СКАНИРУЙТЕ ПОВЕРХНОСТЬ';
    if (s) {
      s.textContent = 'Плавно двигайте телефон влево-вправо и направляйте камеру на пол. Разметка работает после фиксации плоскости.';
    }
  } catch (_) {}
  show(UI.scanHint, false);
  show(UI.btnArOk, false);
  show(UI.btnArAdd, false);
  show(UI.arBottomCenter, false);
  show(UI.postCloseBar, true);
  show(UI.finalColors, false);
  updateArBottomStripVar();
  rebuildFill();
  updateAreaUI();
}

function closeContour() {
  if (state.points.length < 3) return;
  state.closed = true;
  state.phase = 'ar_mask';

  rebuildMarkersAndLine(true);
  rebuildFill();
  updateAreaUI();

  // UI
  show(UI.btnArAdd, false);
  show(UI.btnArOk, false);
  show(UI.arBottomCenter, false);
  show(UI.postCloseBar, true);
  show(UI.finalColors, false);
  updateArBottomStripVar();
} 


function resetAll(keepFloor = false) {
  state.points = [];
  state.holes = [];
  state.holePoints = [];
  state.closed = false;

  if (!keepFloor) {
    state.floorLocked = false;
    state.floorY = 0;
    // floor stabilization state (may exist depending on build)
    if ('floorSamples' in state) state.floorSamples = [];
    if ('floorYEstimate' in state) state.floorYEstimate = null;
    if ('floorStable' in state) state.floorStable = false;

    state.phase = 'ar_scan';
    show(UI.scanHint, true);
    if (typeof scanGrid !== 'undefined' && scanGrid) scanGrid.visible = true;
  } else {
    state.phase = state.xrSession ? (state.floorLocked ? 'ar_draw' : 'ar_scan') : state.phase;
  }

  // remove line/fill and markers
  pointsGroup.clear();

  if (line) {
    anchorGroup.remove(line);
    disposeObject3D(line);
    line = null;
  }

  if (fillMesh) {
    anchorGroup.remove(fillMesh);
    fillMesh.geometry.dispose();
    // material is shared shader; don't dispose here
    fillMesh = null;
  }

  clearMeasureLabels();

  // UI
  show(UI.postCloseBar, false);
  // Bottom strip: keep patterns available in AR; colors appear only after "Готово"
  if (state.xrSession) {
    show(UI.finalBar, true);
    show(UI.finalColors, false);
  } else {
    show(UI.finalBar, false);
  }

  const inScan = (state.phase === 'ar_scan' && !state.floorLocked);
  show(UI.arBottomCenter, !inScan);
  show(UI.btnArAdd, !inScan);
  show(UI.btnArOk, false);

  // restore guides visibility (they may be hidden in final mode)
  pointsGroup.visible = true;
  if (UI.measureLayer) UI.measureLayer.style.display = 'block';

  if (typeof updateArBottomStripVar === 'function') updateArBottomStripVar();
  updateAreaUI();
}



// ------------------------
// Markers / line / fill
// ------------------------
function disposeObject3D(obj) {
  if (!obj) return;
  obj.traverse?.((n) => {
    if (n.geometry) n.geometry.dispose?.();
    if (n.material) {
      if (Array.isArray(n.material)) n.material.forEach(m => m.dispose?.());
      else n.material.dispose?.();
    }
  });
}

// "Флажок" как в OZON: заметный маркер на полу (с большой hit-зоной)
function createFlagMarker({
  baseColor = 0xffffff,
  ringColor = 0x2f6cff,
  poleColor = 0xffffff,
  withRing = false,
} = {}) {
  const g = new THREE.Group();
  g.name = 'flagMarker';

  // --- Визуал маркера ближе к OZON: ободок + белый центр + короткий шток ---
  // Лёгкая тень на полу (чтобы было читаемо на светлой поверхности)
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.034, 28).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18, depthWrite: false })
  );
  shadow.position.y = 0.0005;
  g.add(shadow);

  // Белый центр
  const disk = new THREE.Mesh(
    new THREE.CircleGeometry(0.0165, 28).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: baseColor })
  );
  disk.position.y = 0.001;
  g.add(disk);

  // Синий ободок (всегда присутствует)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.0188, 0.0285, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.95, depthWrite: false })
  );
  ring.name = 'baseRing';
  ring.position.y = 0.0011;
  g.add(ring);

  // Дополнительное подсвечивающее кольцо (для первой точки/«магнита»)
  if (withRing) {
    const firstRing = new THREE.Mesh(
      new THREE.RingGeometry(0.030, 0.052, 44).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: ringColor, transparent: true, opacity: 0.55, depthWrite: false })
    );
    firstRing.name = 'firstRing';
    firstRing.position.y = 0.0012;
    g.add(firstRing);
  }

  // Короткий "штырь" (шток) — чуть выше и тоньше, как в референсе
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0024, 0.0024, 0.16, 12),
    new THREE.MeshBasicMaterial({ color: poleColor, transparent: true, opacity: 0.95 })
  );
  pole.position.y = 0.08;
  g.add(pole);

  // Небольшая "головка" сверху
  const top = new THREE.Mesh(
    new THREE.SphereGeometry(0.0065, 16, 12),
    new THREE.MeshBasicMaterial({ color: poleColor, transparent: true, opacity: 0.95 })
  );
  top.position.y = 0.16;
  g.add(top);

  // Большая невидимая hit-зона (на будущее для редактирования)
  const hit = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, depthWrite: false })
  );
  hit.name = 'hit';
  hit.position.y = 0.06;
  g.add(hit);

  return g;
}

function rebuildThickLine(closed = false) {
  // Remove previous
  if (line) {
    anchorGroup.remove(line);
    disposeObject3D(line);
    line = null;
  }

  const pts = state.points.slice();
  if (pts.length < 2) return;

  const drawPts = pts.slice();
  if (closed) drawPts.push(pts[0].clone());

  const group = new THREE.Group();
  group.name = 'polyLine';
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
  const radius = 0.0045; // толщина линий как в OZON (видно на улице)

  for (let i = 0; i < drawPts.length - 1; i++) {
    const a = drawPts[i];
    const b = drawPts[i + 1];
    const len = distXZ(a, b);
    if (len < 1e-6) continue;

    const mid = new THREE.Vector3((a.x + b.x) / 2, state.floorY + 0.008, (a.z + b.z) / 2);
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 10), mat);
    cyl.position.copy(mid);

    // orient cylinder along segment on XZ
    const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    cyl.quaternion.copy(quat);

    group.add(cyl);
  }

  line = group;
  anchorGroup.add(line);
}
function rebuildMarkersAndLine(closed = false) {
  pointsGroup.clear();

  // Флажки вместо "точек" — как в референсе OZON
  const allOuter = state.points;
  allOuter.forEach((p, i) => {
    const flag = createFlagMarker({ withRing: i === 0 });
    flag.position.copy(p);
    pointsGroup.add(flag);
  });

  // Hole markers (in cut mode)
  if (state.phase === 'ar_cut') {
    state.holePoints.forEach((p, i) => {
      const flag = createFlagMarker({
        baseColor: 0x5aa7ff,
        ringColor: 0x5aa7ff,
        poleColor: 0xffffff,
        withRing: i === 0,
      });
      flag.name = 'holeFlagMarker';
      flag.position.copy(p);
      pointsGroup.add(flag);
    });
  }

  // Толстые линии контура (хорошо видно в светлую погоду)
  rebuildThickLine(closed);
}

function rebuildFill() {
  if (fillMesh) {
    anchorGroup.remove(fillMesh);
    fillMesh.geometry.dispose();
    fillMesh = null;
  }

  const isClosed = state.closed && state.points.length >= 3;
  if (!isClosed) return;

  // IMPORTANT:
  // THREE.Shape/ShapeGeometry is generated in the XY plane.
  // We later rotate it onto XZ with rotateX(-PI/2). That rotation maps
  // original "Y" -> "-Z". If we used (x, z) directly, the resulting mesh
  // would be mirrored on Z and appear in the wrong place after pressing
  // "Готово".
  // So we pre-flip the second component: (x, -z), then after rotation we
  // get final Z == +z, matching the polyline markers exactly.
  const pts2 = state.points.map(p => new THREE.Vector2(p.x, -p.z));
  const shape = new THREE.Shape(pts2);

  // holes
  for (const hole of state.holes) {
    if (hole.length < 3) continue;
    const hp2 = hole.map(p => new THREE.Vector2(p.x, -p.z));
    const path = new THREE.Path(hp2);
    shape.holes.push(path);
  }

  const geom = new THREE.ShapeGeometry(shape, 1);
  geom.rotateX(-Math.PI / 2);

  // lift a bit to avoid z-fighting
  const baseY = state.floorY;
  geom.translate(0, baseY + 0.002, 0);

  const mat = (state.phase === 'ar_final') ? tileMaterial : maskMaterial;
  if (!mat) return;

  fillMesh = new THREE.Mesh(geom, mat);
  fillMesh.renderOrder = 2;
  anchorGroup.add(fillMesh);
}

// ------------------------
// Measurements overlay
// ------------------------
const measureEls = [];

function clearMeasureLabels() {
  measureEls.splice(0, measureEls.length);
  if (UI.measureLayer) UI.measureLayer.innerHTML = '';
}

function ensureMeasureEl(i) {
  if (!UI.measureLayer) return null;
  if (measureEls[i]) return measureEls[i];
  const el = document.createElement('div');
  el.className = 'measureLabel';
  UI.measureLayer.appendChild(el);
  measureEls[i] = el;
  return el;
}

function updateMeasureLabels(xrCam) {
  if (state.phase === 'ar_final') {
    clearMeasureLabels();
    return;
  }
  if (!state.floorLocked) {
    clearMeasureLabels();
    return;
  }

  const pts = state.points;
  if (pts.length < 2) {
    clearMeasureLabels();
    return;
  }

  const segCount = state.closed ? pts.length : (pts.length - 1);

  // remove extra
  for (let i = segCount; i < measureEls.length; i++) {
    measureEls[i]?.remove();
  }
  measureEls.length = segCount;

  const w = window.innerWidth;
  const h = window.innerHeight;

  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const d = distXZ(a, b);

    const mid = new THREE.Vector3((a.x + b.x) / 2, state.floorY + 0.02, (a.z + b.z) / 2);
    const midW = anchorGroup.localToWorld(mid.clone());

    const v = midW.clone().project(xrCam);
    const x = (v.x * 0.5 + 0.5) * w;
    const y = (-v.y * 0.5 + 0.5) * h;

    const el = ensureMeasureEl(i);
    if (!el) continue;

    const visible = v.z >= -1 && v.z <= 1;
    el.style.display = visible ? 'block' : 'none';
    el.textContent = fmtMeters(d);
    el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
  }
}

function updateAreaUI() {
  if (!UI.arArea) return;

  const areaText = (state.points.length >= 3) ? fmtArea(computeAreaM2()) : '—';

  // In final visualization, show only total area in the header (less distraction)
  if (state.phase === 'ar_final') {
    if (UI.arProductTitle) UI.arProductTitle.textContent = `Площадь: ${areaText}`;
    UI.arArea.textContent = '';
    return;
  }

  // Otherwise show product name + current area (as in the reference flow)
  if (UI.arProductTitle && state.selectedTile) UI.arProductTitle.textContent = state.selectedTile.name;
  UI.arArea.textContent = state.closed ? fmtArea(computeAreaM2()) : areaText;
}

// ------------------------
// XR frame update
// ------------------------
const __tmpUp = new THREE.Vector3();
const __tmpCamPos = new THREE.Vector3();
const __tmpFwd = new THREE.Vector3();

function updateXR(frame) {
  // Center hit test (used mainly to estimate floor height while scanning)
  let gotHit = false;
  let hitY = null;

  if (state.hitTestSource && state.referenceSpace) {
    const hits = frame.getHitTestResults(state.hitTestSource);
    if (hits.length) {
      const pose = hits[0].getPose(state.referenceSpace);
      if (pose) {
        reticle.matrix.fromArray(pose.transform.matrix);
        reticle.matrix.decompose(reticle.position, reticle.quaternion, reticle.scale);

        // Filter out obviously non-horizontal hits using the reported orientation
        __tmpUp.set(0, 1, 0).applyQuaternion(reticle.quaternion);
        if (__tmpUp.y >= 0.75) {
          gotHit = true;
          hitY = reticle.position.y;
        } else {
          gotHit = false;
        }
      }
    }
  }

  // During scanning: accumulate floor Y samples only when the camera is pitched down
  if (!state.floorLocked && state.phase === 'ar_scan' && gotHit && hitY != null) {
    const xrCam = renderer.xr.getCamera(camera);
    const cam = xrCam.cameras && xrCam.cameras.length ? xrCam.cameras[0] : xrCam;
    __tmpFwd.set(0, 0, -1).applyQuaternion(cam.quaternion);

    if (__tmpFwd.y < -0.15) {
      state.floorSamples.push(hitY);
      if (state.floorSamples.length > 40) state.floorSamples.shift();

      const sorted = state.floorSamples.slice().sort((a, b) => a - b);
      const p = (q) => {
        if (!sorted.length) return null;
        const pos = (sorted.length - 1) * q;
        const lo = Math.floor(pos), hi = Math.ceil(pos);
        const t = pos - lo;
        return sorted[lo] * (1 - t) + sorted[hi] * t;
      };

      const p20 = p(0.20);
      const p80 = p(0.80);
      state.floorYEstimate = p20;

      // Consider floor stable when spread is small and enough samples collected
      const spread = (p80 != null && p20 != null) ? (p80 - p20) : 999;
      if ((sorted.length >= 12 && spread < 0.04) || sorted.length >= 25) {
        state.floorLocked = true;
        state.floorStable = true;
        state.floorY = p20;

        // Switch to drawing phase (match app: + appears after scanning/floor lock)
        state.phase = 'ar_draw';
        show(UI.scanHint, false);
        show(UI.arBottomCenter, true);
        show(UI.btnArAdd, true);
        show(UI.btnArOk, false);
      }
    }
  }

  // Reticle placement: ALWAYS project to the active floor plane (prevents "sticking" to walls)
  const activeY = state.floorLocked ? state.floorY : (state.floorYEstimate != null ? state.floorYEstimate : hitY);
  const xrCam2 = renderer.xr.getCamera(camera);
  const cam2 = xrCam2.cameras && xrCam2.cameras.length ? xrCam2.cameras[0] : xrCam2;

  __tmpCamPos.setFromMatrixPosition(cam2.matrixWorld);
  __tmpFwd.set(0, 0, -1).applyQuaternion(cam2.quaternion);

  let reticleOk = false;
  if (activeY != null && __tmpFwd.y < -0.02) {
    const t = (activeY - __tmpCamPos.y) / __tmpFwd.y;
    if (t > 0.05 && t < 12.0) {
      reticle.position.copy(__tmpCamPos).addScaledVector(__tmpFwd, t);
      reticle.position.y = activeY;
      reticle.quaternion.set(0, 0, 0, 1); // keep flat
      reticle.visible = true;
      reticleOk = true;
    }
  }
  if (!reticleOk) reticle.visible = false;

  // Scan grid: show only while scanning AND only when we have a valid projected reticle
  if (!state.floorLocked && state.phase === 'ar_scan') {
    scanGrid.visible = reticle.visible;
    if (scanGrid.visible) {
      scanGrid.position.set(reticle.position.x, activeY + 0.001, reticle.position.z);
      scanGrid.rotation.set(0, 0, 0);
    }
  } else {
    scanGrid.visible = false;
  }

  // If floor is locked, clamp reticle exactly to floorY (extra safety)
  if (state.floorLocked && reticle.visible) {
    reticle.position.y = state.floorY;
  }


  // transient hit results
  if (state.transientHitTestSource && state.referenceSpace) {
    try {
      state.transientHitPoses.clear();
      const transientResults = frame.getHitTestResultsForTransientInput(state.transientHitTestSource);
      for (const tr of transientResults) {
        if (!tr.results || !tr.results.length) continue;
        const pose = tr.results[0].getPose(state.referenceSpace);
        if (!pose) continue;

        const q = new THREE.Quaternion(
          pose.transform.orientation.x,
          pose.transform.orientation.y,
          pose.transform.orientation.z,
          pose.transform.orientation.w
        );
        __tmpUp.set(0, 1, 0).applyQuaternion(q);
        if (__tmpUp.y < 0.75) continue;

        state.transientHitPoses.set(tr.inputSource, pose);
      }
    } catch (_) {}
  }

  // magnet highlight
  state.snapArmed = false;
  if (state.floorLocked && !state.closed && state.phase === 'ar_draw' && state.points.length >= 3 && reticle.visible) {
    const wpos = reticle.position.clone(); wpos.y = state.floorY;
    const loc = anchorGroup.worldToLocal(wpos);
    const d0 = distXZ(state.points[0], loc);
    state.snapArmed = d0 < SNAP_DIST_M;
  }
  if (reticle.material?.color) {
    reticle.material.color.setHex(state.snapArmed ? 0x36d399 : 0x2f6cff);
  }
  // "firstRing" теперь находится внутри флажка (вложенный объект)
  let firstRing = null;
  pointsGroup.traverse((o) => {
    if (!firstRing && o.name === 'firstRing') firstRing = o;
  });
  if (firstRing?.material?.color) {
    firstRing.material.color.setHex(state.snapArmed ? 0x36d399 : 0x2f6cff);
  }

  state.reticleVisible = gotHit;
  if (!gotHit) reticle.visible = false;

  // Keep scan grid only when we have a valid floor hit before the floor is locked
  if (!state.floorLocked) {
    scanGrid.visible = !!gotHit;
  } else {
    scanGrid.visible = false;
  }

  // depth (best-effort)
  if (state.xrSession && state.depthSupported) {
    const views = frame.getViewerPose(state.referenceSpace)?.views;
    if (views && views.length) {
      try {
        const depthInfo = frame.getDepthInformation?.(views[0]);
        if (depthInfo && depthInfo.width && depthInfo.height && depthInfo.data) {
          const w = depthInfo.width, h = depthInfo.height;
          const key = `${w}x${h}`;
          if (!state.depthInfoSize || state.depthInfoSize !== key) {
            state.depthInfoSize = key;
            state.depthData = new Float32Array(w * h);
            state.depthTexture = new THREE.DataTexture(state.depthData, w, h, THREE.RedFormat, THREE.FloatType);
            state.depthTexture.needsUpdate = true;
            state.depthTexture.magFilter = THREE.NearestFilter;
            state.depthTexture.minFilter = THREE.NearestFilter;
            if (tileMaterial) {
              tileMaterial.uniforms.uDepthTex.value = state.depthTexture;
              tileMaterial.uniforms.uDepthValid.value = 1;
            }
          }

          const raw = depthInfo.data;
          const scale = depthInfo.rawValueToMeters || 1.0;
          const u16 = new Uint16Array(raw);
          const n = Math.min(u16.length, state.depthData.length);
          for (let i = 0; i < n; i++) state.depthData[i] = u16[i] * scale;
          state.depthTexture.needsUpdate = true;

          // occlusion toggle
          state.occlusionEnabled = !!UI.toggleOcclusion?.checked;
          if (tileMaterial) tileMaterial.uniforms.uUseOcclusion.value = state.occlusionEnabled ? 1 : 0;
        } else {
          if (tileMaterial) tileMaterial.uniforms.uDepthValid.value = 0;
        }
      } catch (_) {
        if (tileMaterial) tileMaterial.uniforms.uDepthValid.value = 0;
      }
    }
  }

  // UI measure labels
  const xrCam = renderer.xr.getCamera(camera);
  updateMeasureLabels(xrCam);
}

// ------------------------
// Events
// ------------------------
// UI clicks should not place points
UI.overlay?.addEventListener('pointerdown', (e) => {
  if (!state.xrSession) return;
  state.lastUiTapTs = performance.now();
}, true);

UI.catalogSearch?.addEventListener('input', () => {
  const q = UI.catalogSearch.value.trim().toLowerCase();
  if (!q) renderCatalog(state.shapes);
  else renderCatalog(state.shapes.filter(s => (s.name || '').toLowerCase().includes(q)));
});

UI.btnDetailBack?.addEventListener('click', () => {
  setActiveScreen('catalog');
  state.phase = 'catalog';
});

// Аккордеон характеристик (по умолчанию скрыто)
UI.btnTechToggle?.addEventListener('click', (e) => {
  e.preventDefault();
  if (UI.detailTechCard?.hidden) return;
  UI.techBody.hidden = false;
  UI.btnTechToggle.hidden = true;
});

UI.btnTechClose?.addEventListener('click', (e) => {
  e.preventDefault();
  UI.techBody.hidden = true;
  UI.btnTechToggle.hidden = false;
});
UI.btnViewAR?.addEventListener('click', async () => {
  await startAR();
});

UI.btnArBack?.addEventListener('click', async () => {
  await stopAR();
});

UI.btnArReset?.addEventListener('click', async () => {
  await fullRestartAR();
});

UI.btnArAdd?.addEventListener('click', () => {
  addPointFromReticle();
});

UI.btnArOk?.addEventListener('click', () => {
  if (state.phase === 'ar_cut') closeHole();
  else closeContour();
});

UI.btnEditShape?.addEventListener('click', () => {
  // return to drawing mode, keep points
  show(UI.finalColors, false);
  if (typeof updateArBottomStripVar === 'function') updateArBottomStripVar();

  state.closed = false;
  state.phase = 'ar_draw';
  // In the reference app, changing the outer shape resets any existing cutouts.
  state.holes = [];
  state.holePoints = [];

  show(UI.postCloseBar, false);
  show(UI.btnArAdd, true);
  show(UI.btnArOk, state.points.length >= 3);
  show(UI.arBottomCenter, true);

  rebuildMarkersAndLine(false);
  // restore guides (they may be hidden after "Готово")
  pointsGroup.visible = true;
  if (line) line.visible = true;
  if (UI.measureLayer) UI.measureLayer.style.display = 'block';

  if (fillMesh) { anchorGroup.remove(fillMesh); fillMesh.geometry.dispose(); fillMesh = null; }
  clearMeasureLabels();
  updateAreaUI();
});

UI.btnCutout?.addEventListener('click', () => {
  // cutout mode
  show(UI.finalColors, false);
  if (typeof updateArBottomStripVar === 'function') updateArBottomStripVar();

  state.phase = 'ar_cut';
  state.holePoints = [];

  show(UI.postCloseBar, false);
  show(UI.btnArAdd, true);
  show(UI.btnArOk, false);
  show(UI.arBottomCenter, true);

  // show hint
  UI.scanHint.querySelector('.scanTitle').textContent = 'СДЕЛАЙТЕ ВЫРЕЗ';
  UI.scanHint.querySelector('.scanText').textContent = 'Поставьте точки внутри области. Замкните контур рядом с первой точкой.';
  show(UI.scanHint, true);

  rebuildMarkersAndLine(true);
  // restore guides
  pointsGroup.visible = true;
  if (line) line.visible = true;
  if (UI.measureLayer) UI.measureLayer.style.display = 'block';
});

UI.btnDone?.addEventListener('click', () => {
  state.phase = 'ar_final';
  show(UI.postCloseBar, false);
  show(UI.arBottomCenter, false);
  show(UI.finalBar, true);
  show(UI.finalColors, true);

  // Hide guides (points/lines/distances) in final visualization
  pointsGroup.visible = false;
  if (line) line.visible = false;
  if (UI.measureLayer) UI.measureLayer.style.display = 'none';
  clearMeasureLabels();
  updateArBottomStripVar();

  rebuildFill();
  updateAreaUI();

  // Build bottom controls
  UI.finalPatterns?.querySelectorAll('.patternTab').forEach(btn => {
    btn.onclick = () => setLayout(btn.dataset.layout);
  });
  setLayout(state.layout);

  renderColorRow(UI.finalColors, state.tiles);

  // hide hint
  show(UI.scanHint, false);
});

window.addEventListener('resize', () => {
  if (state.xrSession) {
    updateArBottomStripVar();
  } else {
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ------------------------
// Main
// ------------------------
async function init() {
  const data = await loadTiles();
  state.tiles = data.tiles || [];

  // load формы
  try {
    const shapesData = await loadShapes();
    state.shapes = shapesData.shapes || [];
  } catch (e) {
    console.warn('shapes.json не найден или повреждён — используем плитки как каталог', e);
    // fallback: каждая плитка как отдельная "форма"
    state.shapes = state.tiles.map(t => ({
      id: String(t.id),
      name: t.name,
      icon: t.preview,
      hero: t.preview,
      tileIds: [t.id],
      tech: { 'Размер': `${t.tileSizeM.w.toFixed(2)}×${t.tileSizeM.h.toFixed(2)} м` },
    }));
  }

  // initial
  renderCatalog(state.shapes);
  setActiveScreen('catalog');
  state.phase = 'catalog';

  // Auto-fill "Доступно в технологиях" palettes by probing files in folders.
  // Runs asynchronously and does not block app start.
  initAutoTechPalettes().catch((e) => console.warn('auto palettes failed', e));

  // choose default tile
  const defaultId = state.tiles[0]?.id;
  if (defaultId) await selectTile(defaultId);

  // AR title
  if (UI.arProductTitle && state.selectedTile) UI.arProductTitle.textContent = state.selectedTile.name;

  // set initial layout
  setLayout('straight');
}

renderer.setAnimationLoop((t, frame) => {
  if (state.xrSession && frame) {
    updateXR(frame);
  } else {
    controls.update();
  }
  renderer.render(scene, camera);
});

init().catch(err => {
  console.error(err);
  alert('Ошибка инициализации: ' + (err?.message || err));
});