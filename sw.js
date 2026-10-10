/* CS 饰品仓位管理 · Service Worker
   离线可用 + 更新必达：
     · 页面（html）与数据（json）→ 联网优先（network-first），打开就是最新；断网才回退缓存
     · 静态资源（图标/manifest）→ 缓存优先
   只在 https / localhost 下注册。 */
const CACHE = 'cs-skin-app-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];
/* 这些请求永远优先联网：否则用户会一直看到旧版（上一版就是这个问题） */
const NET_FIRST = /\.(html?|json)(\?|$)/i;

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;

  const isNav = req.mode === 'navigate' || NET_FIRST.test(url.pathname + url.search);

  if (isNav){
    /* 联网优先：拿到就更新缓存并返回；失败再回退缓存（保证离线也能开） */
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic'){
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  /* 静态资源：缓存优先 */
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic'){
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
