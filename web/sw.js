/* CC_Code Service Worker：外壳预缓存 + 编译器资源按需缓存 */
const VER = 'cccode-v1.6.0';
const SHELL_CACHE = VER + '-shell';
// 编译器资源缓存名固定：升级只重下几百 KB 外壳，不重下 28MB 编译器
const ASSET_CACHE = 'cccode-clang-v1';

const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/editor.js',
  './js/hl.js',
  './js/complete.js',
  './js/fs.js',
  './js/worker.js',
  './js/plugins.js',
  './js/plugins/cph.js',
  './js/lint.js',
  './vendor/clang-wasm.global.js',
  './fonts/JetBrainsMono-Regular.woff2',
  './fonts/SourceCodePro-Regular.woff2',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 一次性迁移：把旧版本的 clang 缓存搬进固定缓存，避免升级重下 28MB
    const before = await caches.keys();
    if (!before.includes(ASSET_CACHE)) {
      for (const old of before.filter((k) => k !== ASSET_CACHE && /-clang$/.test(k))) {
        const from = await caches.open(old);
        const reqs = await from.keys();
        if (reqs.length) {
          const to = await caches.open(ASSET_CACHE);
          for (const r of reqs) {
            const res = await from.match(r);
            if (res) await to.put(r, res);
          }
        }
        await caches.delete(old);
      }
    }
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== ASSET_CACHE && !k.startsWith(VER)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // 编译器大资源：缓存优先，命中后离线可用
  if (url.pathname.includes('/clang/')) {
    e.respondWith(
      caches.open(ASSET_CACHE).then((cache) =>
        cache.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        }))
      )
    );
    return;
  }

  // 页面导航：网络优先，离线回退外壳
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() =>
        caches.match('./index.html').then((r) => r || caches.match('./'))
      )
    );
    return;
  }

  // 其他静态资源：缓存优先 + 后台更新
  e.respondWith(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.match(e.request).then((hit) => {
        const fetching = fetch(e.request).then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => hit);
        return hit || fetching;
      })
    )
  );
});
