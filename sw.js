const SHELL = "shell-v2";
const TILES = "tiles-v1";
const SHELL_FILES = [
  "./", "index.html", "app.js", "route.js", "manifest.json",
  "vendor/leaflet.js", "vendor/leaflet.css", "icons/icon-192.png", "icons/icon-512.png",
];
const TILE_HOSTS = ["tile.openstreetmap.org", "server.arcgisonline.com"];
const MAX_TILES = 600;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (TILE_HOSTS.includes(url.hostname)) {
    // Map tiles: cache-first, fill on miss.
    e.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") {
          cache.put(req, res.clone());
          trimTiles(cache);
        }
        return res;
      })
    );
    return;
  }

  if (url.origin === location.origin) {
    // App shell: network-first so edits show up, fall back to cache offline.
    e.respondWith(
      fetch(req, { cache: "no-cache" })
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
  // Overpass / Nominatim requests are never intercepted.
});
