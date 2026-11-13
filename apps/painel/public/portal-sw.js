// Service worker do portal: permite instalar como app. Sempre busca na rede (dados mudam a toda hora);
// sem internet, mostra uma página simples em vez do erro do navegador.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request).catch(
      () => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;background:#F8F4EB;color:#2b231d;padding:40px 20px;text-align:center"><h2>Sem internet</h2><p>Conecte-se e abra o app de novo.</p></body>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    ),
  );
});
