import { loadTiles, downloadJsonFile, clamp } from './utils.js';

const els = {
  list: document.getElementById('list'),
  form: document.getElementById('tileForm'),
  editId: document.getElementById('editId'),
  name: document.getElementById('name'),
  texture: document.getElementById('texture'),
  preview: document.getElementById('preview'),
  w: document.getElementById('w'),
  h: document.getElementById('h'),
  layouts: document.getElementById('layouts'),
  btnReset: document.getElementById('btnReset'),
  btnDownload: document.getElementById('btnDownload'),
};

let data = await loadTiles();
let tiles = data.tiles ?? [];

function render() {
  els.list.innerHTML = '';
  tiles.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `
      <div class="item__left">
        <img class="item__img" src="${t.preview}" alt="${t.name}">
        <div class="item__meta">
          <div class="item__name">${escapeHtml(t.name)}</div>
          <div class="item__sub">ID: ${t.id} • Размер: ${fmt(t.tileSizeM?.w)}×${fmt(t.tileSizeM?.h)} м</div>
        </div>
      </div>
      <div class="item__actions">
        <button class="btn btn-primary" data-act="edit" data-id="${t.id}">Редактировать</button>
        <button class="btn" data-act="del" data-id="${t.id}">Удалить</button>
      </div>
    `;
    row.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const act = btn.dataset.act;
        if (act === 'edit') startEdit(id);
        if (act === 'del') removeTile(id);
      });
    });
    els.list.appendChild(row);
  });
}

function startEdit(id) {
  const t = tiles.find(x => x.id === id);
  if (!t) return;
  els.editId.value = String(t.id);
  els.name.value = t.name ?? '';
  els.texture.value = t.texture ?? '';
  els.preview.value = t.preview ?? '';
  els.w.value = String(t.tileSizeM?.w ?? 0.2);
  els.h.value = String(t.tileSizeM?.h ?? 0.2);
  els.layouts.value = (t.recommendedLayouts ?? []).join(', ');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function removeTile(id) {
  if (!confirm('Удалить плитку из каталога?')) return;
  tiles = tiles.filter(x => x.id !== id);
  resetForm();
  render();
}

function resetForm() {
  els.editId.value = '';
  els.form.reset();
}

els.btnReset.addEventListener('click', resetForm);

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = els.name.value.trim();
  const texture = els.texture.value.trim();
  const preview = els.preview.value.trim();
  const w = clamp(parseFloat(els.w.value), 0.01, 10);
  const h = clamp(parseFloat(els.h.value), 0.01, 10);
  const layouts = (els.layouts.value || '').split(',').map(s => s.trim()).filter(Boolean);

  if (!name || !texture || !preview) {
    alert('Заполните название, текстуру и превью.');
    return;
  }

  const existingId = els.editId.value ? Number(els.editId.value) : null;
  if (existingId) {
    const idx = tiles.findIndex(x => x.id === existingId);
    if (idx !== -1) {
      tiles[idx] = {
        ...tiles[idx],
        name, texture, preview,
        tileSizeM: { w, h },
        recommendedLayouts: layouts.length ? layouts : tiles[idx].recommendedLayouts ?? []
      };
    }
  } else {
    const nextId = tiles.length ? Math.max(...tiles.map(t => t.id)) + 1 : 1;
    tiles.push({
      id: nextId,
      name, texture, preview,
      tileSizeM: { w, h },
      recommendedLayouts: layouts.length ? layouts : ['Прямая', 'Диагональ 45°', 'Вразбежку']
    });
  }

  resetForm();
  render();
});

els.btnDownload.addEventListener('click', () => {
  const out = { version: 1, tiles };
  downloadJsonFile('tiles.json', out);
});

function fmt(x) {
  if (typeof x !== 'number' || !isFinite(x)) return '—';
  return x.toFixed(2);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

render();
