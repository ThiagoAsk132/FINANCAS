// Guarda os arquivos do app para abrir sem internet (os dados ficam no aparelho e no Google Drive).
// Ao mudar qualquer arquivo do app, troque o nome do CACHE (financas-v2, v3...).
const CACHE = "financas-v13";
const VERSAO = "13";
const ARQUIVOS = ["./", "index.html", "config.js", "drive.js", "app.js", "manifest.webmanifest", "icone-192.png", "icone-512.png", "apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS.map(u => new Request(u, { cache: "reload" })))));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// Rede primeiro (pega versão nova do app); sem rede, usa o cache. Google nunca passa pelo cache.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request.url, { cache: "no-cache" }).then(r => {   // no-cache: sempre confere versão nova no GitHub
      const copia = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copia));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
