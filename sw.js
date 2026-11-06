const CACHE_NAME = 'v75-base64-logo';
const OFFLINE_ASSETS = ['/assets/vendor/xlsx.full.min.js'];
self.addEventListener('install', e => self.skipWaiting()); self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).then(() => self.registration.unregister())); });
