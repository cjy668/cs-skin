/* CS 饰品仓位管理 · Service Worker
   离线可用 + 更新必达：
     · 页面（html）→ 联网优先（network-first），打开就是最新；断网回退缓存
     · 实时数据（live.json / api）→ 联网优先，永远要最新价
     · 大文件行情（market.json / catalog.json 等）→ 缓存优先 + 后台更新
       （market.json 已扩到 2.2 万件 ≈ 3.5 MB，每次打开都重下太浪费流量；它一天只更新 3 次）
     · 静态资源（图标/manifest）→ 缓存优先
   只在 https / localhost 下注册。 */
const CACHE = 'cs-skin-app-v4';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];
/* 页面与实时数据：永远优先联网 */
const NET_FIRST = /\.html?(\?|$)|\/api\/|live\.json/i;

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
