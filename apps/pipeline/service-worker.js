/* ============================================================
   mambo · Pipeline — Service Worker
   Precache de los estáticos locales (carga rápida + offline básico).
   Estrategia:
     - navegación  → network-first, fallback a index.html cacheado
     - same-origin → cache-first con relleno en runtime
     - cross-origin (fonts, PapaParse) → network, runtime-cache best-effort
   ============================================================ */

const CACHE = "mambo-pipeline-v4";

// Archivos locales que componen el "app shell".
const PRECACHE = [
  "/",
  "/index.html",
  "/styles.css",
  "/colors_and_type.css",
  "/data.js",
  "/supabase.js",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // addAll falla si alguno 404ea; usamos add individual tolerante.
      Promise.allSettled(PRECACHE.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Nunca cachear: datos en vivo de Supabase ni el endpoint de config.
  // (Realtime usa websockets, que no pasan por aquí.)
  if (url.hostname.endsWith("supabase.co") || (sameOrigin && url.pathname.startsWith("/api/"))) {
    return; // deja pasar a la red directamente
  }

  // Navegaciones (cargar la app): network-first, fallback al shell offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          caches.open(CACHE).then((c) => c.put("/index.html", res.clone())).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || caches.match("/")))
    );
    return;
  }

  // Assets same-origin: cache-first con relleno.
  if (sameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // Cross-origin (Google Fonts, CDN PapaParse): network con runtime-cache best-effort.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && (res.status === 200 || res.type === "opaque")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
