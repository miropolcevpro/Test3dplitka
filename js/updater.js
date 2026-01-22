// Lightweight self-updater to mitigate aggressive caching (iframe, CDN, browser).
// Loads VERSION.txt with no-store and, if it differs from the loaded build,
// forces a reload with a cache-busting query param.
(function () {
  try {
    var localVer = (window.state && state.build && state.build.version) ? String(state.build.version) : '';
    var url = new URL(window.location.href);
    var already = url.searchParams.get('v') || '';

    // Fetch VERSION.txt bypassing caches.
    fetch('VERSION.txt?ts=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (txt) {
        var serverVer = String(txt || '').trim();
        if (!serverVer) return;

        // If we are already on the latest, do nothing.
        if (serverVer === localVer) return;

        // If we've already tried to load this server version, avoid loop.
        if (already === serverVer) return;

        // Force reload with cache-busting query param.
        url.searchParams.set('v', serverVer);
        window.location.replace(url.toString());
      })
      .catch(function () { /* ignore */ });
  } catch (e) {
    // ignore
  }
})();
