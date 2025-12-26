// Simple service worker for GitHub Pages (offline after first visit)
// Bump this version when you deploy updates so clients don't keep stale cached JS/CSS.
const CACHE = "paver-ar-cache-v5f4-fix8";
const CORE = [
  "./",
  "./index.html",
  "./unsupported.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./catalog/catalog.json",
  "./admin.html",
  "./admin.css",
  "./admin.js",
  "./assets/logo.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (e)=>{
  e.waitUntil((async()=>{
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e)=>{
  e.waitUntil((async()=>{
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k===CACHE ? null : caches.delete(k)));
    self.clients.claim();
  })());
});

function isAsset(req){
  const url = new URL(req.url);
  const p = url.pathname.toLowerCase();
  return p.endsWith(".js") || p.endsWith(".css") || p.endsWith(".png") || p.endsWith(".jpg") || p.endsWith(".jpeg") || p.endsWith(".webp") || p.endsWith(".json") || p.endsWith(".webmanifest");
}

self.addEventListener("fetch", (e)=>{
  const req = e.request;
  if(req.method !== "GET") return;

  const url = new URL(req.url);

  // Ignore non-http(s)
  if(url.protocol !== "http:" && url.protocol !== "https:") return;

  // HTML (навигация) — только для same-origin
  if(req.mode === "navigate" || req.headers.get("accept")?.includes("text/html")){
    if(url.origin !== location.origin) return;
    e.respondWith((async()=>{
      try{
        const res = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
        return res;
      }catch(_){
        const cached = await caches.match(req);
        return cached || caches.match("./index.html");
      }
    })());
    return;
  }

  // Assets: cache-first
  if(isAsset(req)){
    e.respondWith((async()=>{
      const cached = await caches.match(req);
      if(cached) return cached;
      const res = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
      return res;
    })());
  }
});
