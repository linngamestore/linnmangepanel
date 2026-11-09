/* LINN Admin — service worker (PWA + push).
   One file does all the jobs: it makes the panel installable, shows the offline page when there is no
   internet, and draws the push notifications with the app's own name/icon/badge.
   The Worker sends admin pushes as DATA-ONLY, so this is the one place a notification is drawn. */
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyC9soIo8J-NP5bc4STi_eOB1oP94IvcOL8",
  authDomain: "linngametopupstore.firebaseapp.com",
  projectId: "linngametopupstore",
  storageBucket: "linngametopupstore.firebasestorage.app",
  messagingSenderId: "1081466939722",
  appId: "1:1081466939722:web:affbccdedc64a28ca439b3"
});
const messaging = firebase.messaging();

const WORKER_URL = 'https://linnmanagebot.linngamestore.workers.dev';
const SHELL_CACHE = 'linn-admin-shell-v2';
const OFFLINE_URL = '/offline.html';

/* ---------- install / update / offline ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try { const c = await caches.open(SHELL_CACHE); await c.addAll([OFFLINE_URL, '/admin-192.png']); } catch (err) { /* offline page is optional */ }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  try { const keys = await caches.keys(); await Promise.all(keys.filter(k => k.startsWith('linn-admin-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k))); } catch (err) {}
  await self.clients.claim();
})()));
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });
/* Pages go to the network as normal; only when that fails (no internet) the offline page is shown. */
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(async () => (await caches.match(OFFLINE_URL)) || Response.error()));
});

/* ---------- how each kind of notification feels ---------- */
/* Web notifications cannot pick a custom sound; what CAN differ per type is the vibration pattern,
   whether it stays on screen, and whether it is silent (quiet hours). */
const PROFILE = {
  order:    { vibrate: [220, 100, 220],                 stay: false },
  topup:    { vibrate: [120, 70, 120, 70, 360],         stay: false },
  chat:     { vibrate: [70, 50, 70],                    stay: false },
  reminder: { vibrate: [420, 160, 420, 160, 420],       stay: true  },
  test:     { vibrate: [120, 60, 120],                  stay: false }
};
const BIG_VIBRATE = [600, 150, 600, 150, 600];

messaging.onBackgroundMessage(async (payload) => {
  // Old-style payload with a "notification" block: the SDK already shows it, don't duplicate.
  if (payload.notification) return;
  const d = payload.data || {};
  const kind = PROFILE[d.kind] ? d.kind : 'order';
  const prof = PROFILE[kind];
  const big = d.big === '1';
  const quiet = d.silent === '1';           // quiet hours: show it, but no sound / vibration
  const tag = d.tag || undefined;

  let title = d.title || 'LINN Admin';
  let body = d.body || '';
  let url = d.url || '/';
  let count = 1;
  let canAct = d.act === '1' && !!d.sig;

  // Several new orders / top-ups in a row: one notification that counts up instead of a pile of them.
  if (tag === 'orders' || tag === 'topups') {
    try {
      const open = await self.registration.getNotifications({ tag });
      const prev = open.reduce((n, x) => n + (Number(x.data && x.data.count) || 1), 0);
      count = prev + 1;
      if (count > 1) {
        title = (tag === 'orders' ? 'Order အသစ် ' : 'Top Up အသစ် ') + count + ' ခု';
        body = 'နောက်ဆုံး — ' + (d.body || '');
        url = d.listUrl || url;
        canAct = false;                      // buttons are for ONE item only
      }
    } catch (err) { /* fall back to a single notification */ }
  }

  const opts = {
    body,
    icon: '/admin-192.png',
    badge: '/badge-96.png',
    tag,
    renotify: !!tag && !quiet,
    silent: quiet,
    requireInteraction: !quiet && (big || prof.stay),
    data: { url, count, ak: d.ak, aid: d.aid, dev: d.dev, exp: d.exp, sig: d.sig, act: canAct, kind, listUrl: d.listUrl || '/' }
  };
  if (!quiet) opts.vibrate = big ? BIG_VIBRATE : prof.vibrate;
  if (canAct) opts.actions = [{ action: 'confirm', title: 'Confirm' }, { action: 'reject', title: 'Reject' }];
  if (d.image) opts.image = d.image;
  return self.registration.showNotification(title, opts);
});

/* ---------- Confirm / Reject straight from the notification ---------- */
async function runAction(data, action) {
  const label = data.ak === 'topup' ? 'Top Up' : 'Order';
  const resTag = 'act-' + (data.aid || '');
  const show = (title, body, url, stay) => self.registration.showNotification(title, {
    body, icon: '/admin-192.png', badge: '/badge-96.png', tag: resTag, renotify: true,
    requireInteraction: !!stay, data: { url: url || data.listUrl || '/' }
  });
  let res = null;
  try {
    const r = await fetch(WORKER_URL + '/admin-push-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: data.ak, id: data.aid, act: action, dev: data.dev, exp: Number(data.exp), sig: data.sig })
    });
    res = await r.json().catch(() => null);
  } catch (err) { /* offline / worker down */ }

  const itemUrl = data.url || '/';
  if (res && res.ok && res.already) return show(label + ' ကိုင်ပြီးသား', 'Status: ' + (res.status || ''), itemUrl);
  if (res && res.ok) {
    return show(label + (action === 'confirm' ? ' Confirm လုပ်ပြီးပါပြီ' : ' Reject လုပ်ပြီးပါပြီ'),
      (res.status ? 'Status: ' + res.status : '') + (res.note ? ' — ' + res.note : ''), itemUrl);
  }
  if (res && res.needsPin) return show('PIN လိုပါတယ်', 'ပမာဏကြီးလို့ Panel / Telegram မှာ PIN နဲ့ Confirm လုပ်ပါ', itemUrl, true);
  return show(label + ' မအောင်မြင်ပါ', (res && res.error) || 'Internet စစ်ပြီး Panel ထဲက ကိုင်ပါ', itemUrl, true);
}

async function openTarget(path) {
  const target = new URL(path || '/', self.location.origin).href;
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of list) {
    if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
      await c.focus();
      try { c.postMessage({ type: 'LINN_NAV', url: target }); } catch (err) {}   // panel is already open: jump to the order
      return;
    }
  }
  return self.clients.openWindow(target);
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  if ((event.action === 'confirm' || event.action === 'reject') && data.act && data.sig) {
    event.waitUntil(runAction(data, event.action));
    return;
  }
  event.waitUntil(openTarget(data.url || '/'));
});
