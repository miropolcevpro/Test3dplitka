export async function loadTiles() {
  const res = await fetch('tiles.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Не удалось загрузить tiles.json');
  return await res.json();
}

export async function loadShapes() {
  const res = await fetch('shapes.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Не удалось загрузить shapes.json');
  return await res.json();
}

export function clamp(v, lo, hi) {
  if (!isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

export function downloadJsonFile(filename, obj) {
  const str = JSON.stringify(obj, null, 2);
  const blob = new Blob([str], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function nowIso() {
  return new Date().toISOString();
}

export function uid() {
  return Math.random().toString(16).slice(2) + '-' + Math.random().toString(16).slice(2);
}
