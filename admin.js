// Admin panel for catalog/catalog.json (static-site friendly)
// Works on GitHub Pages: edits in-browser and exports JSON / ZIP.

const $ = (id) => document.getElementById(id);
const dbgEl = $("adminDbg");

function showDbg(msg){
  dbgEl.hidden = false;
  dbgEl.textContent = msg;
}

function downloadText(filename, text, mime="application/json"){
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
}

function extFromFile(file){
  if(!file) return "png";
  const name = (file.name||"").toLowerCase();
  const m = name.match(/\.(png|jpg|jpeg|webp)$/);
  if(m) return m[1] === "jpeg" ? "jpg" : m[1];
  const type = (file.type||"").toLowerCase();
  if(type.includes("jpeg")) return "jpg";
  if(type.includes("png")) return "png";
  if(type.includes("webp")) return "webp";
  return "png";
}

function sanitizeId(id){
  return String(id||"")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g,"");
}

async function loadCatalog(){
  const res = await fetch("./catalog/catalog.json", { cache:"no-cache" });
  if(!res.ok) throw new Error("Не удалось загрузить ./catalog/catalog.json");
  return await res.json();
}

// UI refs
const itemsList = $("itemsList");
const editor = $("editor");
const editHint = $("editHint");

const fId = $("fId");
const fName = $("fName");
const fCollection = $("fCollection");
const fTech = $("fTech");
const fTh = $("fTh");
const fSizeX = $("fSizeX");
const fSizeY = $("fSizeY");
const fSeam = $("fSeam");
const fPatX = $("fPatX");
const fPatY = $("fPatY");
const fTags = $("fTags");

const btnReload = $("btnReload");
const btnAddItem = $("btnAddItem");
const btnDelItem = $("btnDelItem");
const btnSaveItem = $("btnSaveItem");
const btnAddVar = $("btnAddVar");
const btnExportJson = $("btnExportJson");
const btnExportZip = $("btnExportZip");

const varsList = $("varsList");

// State
let catalog = null;
let selectedIndex = -1;

function ensureDefaults(){
  catalog.version = catalog.version || 1;
  catalog.items = Array.isArray(catalog.items) ? catalog.items : [];
  for(const it of catalog.items){
    it.id = it.id || sanitizeId(it.name||"item");
    it.name = it.name || it.id;
    it.variants = Array.isArray(it.variants) ? it.variants : [];
    for(const v of it.variants){
      v.id = v.id || sanitizeId(v.name||"var");
      v.name = v.name || v.id;
      v.tint = v.tint || "#ffffff";
      v.maps = v.maps || {};
      v._files = v._files || {}; // local only
    }
  }
}

function renderItems(){
  itemsList.innerHTML = "";
  if(!catalog.items.length){
    itemsList.innerHTML = `<div class="note">Каталог пуст. Нажмите “+ Добавить позицию”.</div>`;
    return;
  }
  catalog.items.forEach((it, idx)=>{
    const row = document.createElement("div");
    row.className = "itemRow" + (idx===selectedIndex ? " on": "");
    row.innerHTML = `
      <div class="itemRowTitle">${it.name}</div>
      <div class="itemRowSub">${[it.collection, it.thickness_mm? (it.thickness_mm+" мм"):"", it.technology].filter(Boolean).join(" • ")}</div>
      <div class="itemRowSub muted">${it.id}</div>
    `;
    row.addEventListener("click", ()=>selectItem(idx));
    itemsList.appendChild(row);
  });
}

function selectItem(idx){
  selectedIndex = idx;
  renderItems();
  const it = catalog.items[idx];
  if(!it){
    editor.hidden = true;
    editHint.textContent = "Выберите позицию слева.";
    return;
  }
  editor.hidden = false;
  editHint.textContent = "";

  fId.value = it.id || "";
  fName.value = it.name || "";
  fCollection.value = it.collection || "";
  fTech.value = it.technology || "";
  fTh.value = it.thickness_mm || "";
  fSizeX.value = (it.tile_size_mm && it.tile_size_mm[0]) || "";
  fSizeY.value = (it.tile_size_mm && it.tile_size_mm[1]) || "";
  fSeam.value = it.seam_mm ?? "";
  fPatX.value = (it.patternSize_m && it.patternSize_m[0]) || "";
  fPatY.value = (it.patternSize_m && it.patternSize_m[1]) || "";
  fTags.value = (it.tags || []).join(", ");

  renderVariants();
}

function currentItem(){
  return catalog.items[selectedIndex] || null;
}

function renderVariants(){
  const it = currentItem();
  varsList.innerHTML = "";
  if(!it) return;

  if(!it.variants.length){
    varsList.innerHTML = `<div class="note">Нет вариантов. Нажмите “+ Вариант цвета”.</div>`;
    return;
  }

  it.variants.forEach((v, vIdx)=>{
    const card = document.createElement("div");
    card.className = "varCard";

    const sw = document.createElement("div");
    sw.className = "varSwatch";
    sw.style.background = v.tint || "#ffffff";

    const top = document.createElement("div");
    top.className = "varTop";
    top.appendChild(sw);

    const topTxt = document.createElement("div");
    topTxt.innerHTML = `<div class="varName">${v.name}</div><div class="varSub">${v.id}</div>`;
    top.appendChild(topTxt);

    const delBtn = document.createElement("button");
    delBtn.className = "btn danger";
    delBtn.textContent = "Удалить вариант";
    delBtn.addEventListener("click", ()=>{
      it.variants.splice(vIdx, 1);
      renderVariants();
    });

    const grid = document.createElement("div");
    grid.className = "varGrid";
    grid.innerHTML = `
      <label class="aField">
        <span>Variant ID</span>
        <input data-k="id" type="text" value="${v.id||""}" />
      </label>
      <label class="aField">
        <span>Название варианта</span>
        <input data-k="name" type="text" value="${v.name||""}" />
      </label>
      <label class="aField">
        <span>Tint (цвет)</span>
        <input data-k="tint" type="text" value="${v.tint||"#ffffff"}" />
      </label>
      <div class="fileRow">
        <span class="muted">Base color (albedo)</span>
        <input data-file="base" type="file" accept="image/*" />
        <div class="note">${v.maps?.base || "—"}</div>
      </div>
      <div class="fileRow">
        <span class="muted">Normal</span>
        <input data-file="normal" type="file" accept="image/*" />
        <div class="note">${v.maps?.normal || "—"}</div>
      </div>
      <div class="fileRow">
        <span class="muted">Roughness</span>
        <input data-file="roughness" type="file" accept="image/*" />
        <div class="note">${v.maps?.roughness || "—"}</div>
      </div>
      <div class="fileRow">
        <span class="muted">Thumb (превью)</span>
        <input data-file="thumb" type="file" accept="image/*" />
        <div class="note">${v.thumb || "—"}</div>
      </div>
    `;

    // wire inputs
    grid.querySelectorAll("input[data-k]").forEach(inp=>{
      inp.addEventListener("input", ()=>{
        const k = inp.getAttribute("data-k");
        if(k==="id") v.id = sanitizeId(inp.value);
        else if(k==="name") v.name = inp.value.trim();
        else if(k==="tint") v.tint = inp.value.trim() || "#ffffff";
        sw.style.background = v.tint || "#ffffff";
        topTxt.innerHTML = `<div class="varName">${v.name}</div><div class="varSub">${v.id}</div>`;
      });
    });

    grid.querySelectorAll("input[data-file]").forEach(inp=>{
      inp.addEventListener("change", ()=>{
        const kind = inp.getAttribute("data-file");
        const file = inp.files && inp.files[0];
        if(!file) return;
        v._files = v._files || {};
        v._files[kind] = file;

        // auto-set paths based on item+variant ids
        const itId = sanitizeId(fId.value || it.id);
        const vId = sanitizeId(v.id || "variant");
        const ext = extFromFile(file);

        if(kind === "thumb"){
          v.thumb = `./catalog/tiles/${itId}/${vId}/thumb.${ext}`;
        }else{
          v.maps = v.maps || {};
          v.maps[kind] = `./catalog/tiles/${itId}/${vId}/${kind}.${ext}`;
        }

        // rerender to show updated paths
        renderVariants();
      });
    });

    card.appendChild(top);
    card.appendChild(grid);
    card.appendChild(delBtn);
    varsList.appendChild(card);
  });
}

function readEditorToItem(it){
  it.id = sanitizeId(fId.value || it.id);
  it.name = (fName.value||"").trim() || it.id;
  it.collection = (fCollection.value||"").trim();
  it.technology = (fTech.value||"").trim();
  it.thickness_mm = fTh.value ? parseInt(fTh.value,10) : null;

  const sx = fSizeX.value ? parseInt(fSizeX.value,10) : null;
  const sy = fSizeY.value ? parseInt(fSizeY.value,10) : null;
  it.tile_size_mm = (sx && sy) ? [sx, sy] : null;

  it.seam_mm = fSeam.value ? parseInt(fSeam.value,10) : null;

  const px = fPatX.value ? parseFloat(fPatX.value) : null;
  const py = fPatY.value ? parseFloat(fPatY.value) : null;
  it.patternSize_m = (px && py) ? [px, py] : (px ? [px, px] : null);

  it.tags = (fTags.value||"").split(",").map(s=>s.trim()).filter(Boolean);

  // ensure variant ids stable with new item id
  for(const v of it.variants){
    v.id = sanitizeId(v.id);
    v.maps = v.maps || {};
    v._files = v._files || {};
  }
  return it;
}

btnReload.addEventListener("click", async ()=>{
  try{
    catalog = await loadCatalog();
    ensureDefaults();
    selectedIndex = -1;
    renderItems();
    selectItem(-1);
  }catch(e){
    showDbg(String(e.stack||e.message||e));
  }
});

btnAddItem.addEventListener("click", ()=>{
  const it = {
    id: "new_item",
    name: "Новая позиция",
    collection: "",
    technology: "",
    thickness_mm: 60,
    tile_size_mm: [200,100],
    seam_mm: 4,
    patternSize_m: [0.30,0.30],
    tags: [],
    variants: [
      { id:"default", name:"Основной", tint:"#ffffff", thumb:"", maps:{}, _files:{} }
    ]
  };
  catalog.items.push(it);
  selectItem(catalog.items.length - 1);
  renderItems();
});

btnDelItem.addEventListener("click", ()=>{
  const it = currentItem();
  if(!it) return;
  if(!confirm(`Удалить позицию "${it.name}"?`)) return;
  catalog.items.splice(selectedIndex, 1);
  selectedIndex = -1;
  renderItems();
  editor.hidden = true;
  editHint.textContent = "Выберите позицию слева.";
});

btnAddVar.addEventListener("click", ()=>{
  const it = currentItem();
  if(!it) return;
  it.variants.push({ id:`var${it.variants.length+1}`, name:`Вариант ${it.variants.length+1}`, tint:"#ffffff", thumb:"", maps:{}, _files:{} });
  renderVariants();
});

btnSaveItem.addEventListener("click", ()=>{
  const it = currentItem();
  if(!it) return;
  readEditorToItem(it);
  // also normalize map paths to new ids if files are present
  for(const v of it.variants){
    const itId = it.id;
    const vId = sanitizeId(v.id);
    v.id = vId;
    if(v._files?.thumb){
      v.thumb = v.thumb || `./catalog/tiles/${itId}/${vId}/thumb.${extFromFile(v._files.thumb)}`;
    }
    for(const k of ["base","normal","roughness"]){
      if(v._files?.[k]){
        v.maps = v.maps || {};
        v.maps[k] = v.maps[k] || `./catalog/tiles/${itId}/${vId}/${k}.${extFromFile(v._files[k])}`;
      }
    }
  }
  renderItems();
  renderVariants();
  alert("Сохранено (в памяти браузера). Теперь экспортируйте JSON/ZIP.");
});

btnExportJson.addEventListener("click", ()=>{
  try{
    // Deep copy without _files
    const clean = JSON.parse(JSON.stringify(catalog));
    for(const it of clean.items){
      for(const v of (it.variants||[])){
        delete v._files;
      }
    }
    downloadText("catalog.json", JSON.stringify(clean, null, 2));
  }catch(e){
    showDbg(String(e.stack||e.message||e));
  }
});

btnExportZip.addEventListener("click", async ()=>{
  try{
    if(!window.JSZip){
      alert("JSZip не загрузился. Проверьте интернет/блокировщики.");
      return;
    }
    const zip = new window.JSZip();

    // catalog json (clean)
    const clean = JSON.parse(JSON.stringify(catalog));
    for(const it of clean.items){
      for(const v of (it.variants||[])){
        delete v._files;
      }
    }
    zip.file("catalog/catalog.json", JSON.stringify(clean, null, 2));

    // add uploaded files only
    for(const it of catalog.items){
      const itId = sanitizeId(it.id);
      for(const v of (it.variants||[])){
        const vId = sanitizeId(v.id);
        const files = v._files || {};
        for(const kind of ["base","normal","roughness","thumb"]){
          const file = files[kind];
          if(!file) continue;
          const ext = extFromFile(file);
          const path = `catalog/tiles/${itId}/${vId}/${kind}.${ext}`;
          zip.file(path, file);
        }
      }
    }

    const blob = await zip.generateAsync({ type:"blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "catalog_pack.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 2000);

  }catch(e){
    showDbg(String(e.stack||e.message||e));
  }
});

// Boot
(async ()=>{
  try{
    catalog = await loadCatalog();
    ensureDefaults();
    renderItems();
    if(catalog.items.length){
      selectItem(0);
    }else{
      editor.hidden = true;
      editHint.textContent = "Каталог пуст. Нажмите “+ Добавить позицию”.";
    }
  }catch(e){
    showDbg(String(e.stack||e.message||e));
  }
})();
