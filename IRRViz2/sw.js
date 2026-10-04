/* =========================================================================
   IRRViz 2 — service worker : application installable et utilisable hors ligne.

   Stratégie « réseau d'abord » : en ligne, chaque fichier est rechargé depuis
   le serveur (les mises à jour arrivent immédiatement, sans mélange de versions)
   et la copie en cache est rafraîchie ; hors ligne, ou si le réseau ne répond
   pas à temps, la dernière copie en cache est servie.

   Les données de l'utilisateur ne passent pas par ici : elles sont dans le
   localStorage. Les appels au proxy Yahoo (autre origine) ne sont pas interceptés.

   VERSION ne sert qu'à purger les anciens caches : l'incrémenter quand la liste
   APP_SHELL change (fichier ajouté, renommé ou supprimé).
   ========================================================================= */

const VERSION = "1";
const CACHE = `irrviz2-shell-v${VERSION}`;
const NETWORK_TIMEOUT_MS = 4000;

const APP_SHELL = [
  "./",
  "index.html",
  "css/style.css",
  "js/util.js",
  "js/model.js",
  "js/store.js",
  "js/asset.js",
  "js/chart.js",
  "js/csv.js",
  "js/app.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      // `cache: "reload"` contourne le cache HTTP pour partir de fichiers à jour.
      .then(cache => cache.addAll(APP_SHELL.map(url => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("irrviz2-shell-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(request){
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS);
    fetch(request).then(
      res => { clearTimeout(timer); resolve(res); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

async function networkFirst(request){
  const cache = await caches.open(CACHE);
  try{
    const response = await fetchWithTimeout(request);
    if(response && response.ok && response.type === "basic") cache.put(request, response.clone());
    return response;
  }catch(err){
    const cached = await cache.match(request, { ignoreSearch: true })
      // Navigation hors ligne vers une URL inconnue (ex. paramètres) : on sert l'application.
      || (request.mode === "navigate" ? await cache.match("index.html") : null);
    if(cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if(request.method !== "GET") return;
  const url = new URL(request.url);
  // Uniquement les fichiers de l'application (même origine, sous la portée du service worker).
  if(url.origin !== self.location.origin || !url.pathname.startsWith(new URL("./", self.registration.scope).pathname)) return;
  event.respondWith(networkFirst(request));
});
