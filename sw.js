// Service worker: busca sempre na rede (conferindo com o servidor se há versão nova)
// e usa a cópia salva só se estiver offline.
const CACHE = "missao-eletrica-v10";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  // Apaga cópias de versões antigas do app
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(
    // "no-cache": o navegador sempre pergunta ao servidor se o arquivo mudou,
    // em vez de reaproveitar a cópia por até 10 minutos (padrão do GitHub Pages).
    fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" })
      .then((resp) => {
        if (resp.ok) {
          const copia = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copia));
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
