// sw.js — Service Worker for RPS push notifications
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch(err) { data = { title: 'RPS', body: e.data.text() }; }

  const options = {
    body:  data.body || '',
    icon:  '/icon-192.png',
    badge: '/icon-192.png',
    data:  data.data || {},
    vibrate: [200, 100, 200],
    actions: data.data?.type === 'play_invite'
      ? [{ action:'accept', title:'Accept ⚔️' }, { action:'decline', title:'Decline' }]
      : [],
  };

  e.waitUntil(self.registration.showNotification(data.title || 'RPS', options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
