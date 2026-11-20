// Guarda os arquivos do app para abrir sem internet (os dados ficam no aparelho e no Google Drive).
// Ao mudar qualquer arquivo do app, troque o nome do CACHE (financas-v2, v3...).
const CACHE = "financas-v15";
const VERSAO = "15";
const ARQUIVOS = ["./", "index.html", "config.js", "drive.js", "app.js", "comprovante.js", "manifest.webmanifest", "icone-192.png", "icone-512.png", "apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS.map(u => new Request(u, { cache: "reload" })))));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== "comprovante-recebido").map(k => caches.delete(k)))));
  self.clients.claim();
});
// Rede primeiro (pega versão nova do app); sem rede, usa o cache. Google nunca passa pelo cache.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // comprovante compartilhado pelo app do banco (Android): guarda o arquivo e abre o app para ler
  if (e.request.method === "POST" && url.pathname.endsWith("/compartilhar")) {
    e.respondWith((async () => {
      const fd = await e.request.formData(), arq = fd.get("comprovante");
      if (arq && arq.size) {
        const c = await caches.open("comprovante-recebido");
        await c.put("ultimo-comprovante", new Response(arq, { headers: { "content-type": arq.type || "application/octet-stream", "x-nome": encodeURIComponent(arq.name || "comprovante") } }));
      }
      return Response.redirect("./?comprovante=1", 303);
    })());
    return;
  }
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request.url, { cache: "no-cache" }).then(r => {   // no-cache: sempre confere versão nova no GitHub
      const copia = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copia));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
