/* CareLoop service worker. Its only jobs: let the browser offer "Install app", and show a clear
   message when there is no internet. It deliberately caches NOTHING, so resident data is never
   stored on the device by the app and a new deployment always shows up straight away. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

const OFFLINE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>CareLoop</title><body style="font:18px system-ui,sans-serif;max-width:30rem;margin:18vh auto;padding:0 20px;text-align:center">' +
  '<h1>You are offline</h1><p>CareLoop needs an internet connection to show current doses and alerts. ' +
  'Check your connection, then reload this page.</p></body>'

self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
  }
})
