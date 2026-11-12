/* Service Worker：应用壳离线可用；API / 录音 / 照片 始终走网络
 * v10 修正：JS/CSS 改网络优先——旧版缓存优先策略导致服务端更新后
 * 用户要刷新两次才能看到新功能（表现为"代码更新了页面却没变化"）
 */
const CACHE = "hwbench-v12";
const SHELL = [
  "./", "./index.html", "./css/style.css", "./manifest.json", "./icons/icon.svg",
  "./js/pinyin.js", "./js/sound.js", "./js/store.js", "./js/parser.js", "./js/ai.js",
  "./js/auth.js", "./js/remind.js", "./js/parent.js", "./js/child.js", "./js/main.js"
];

/* 点击通知：聚焦已有窗口，否则打开提醒对应的页面 */
self.addEventListener("notificationclick", e=>{
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./#/child";
  e.waitUntil(clients.matchAll({type:"window", includeUncontrolled:true}).then(list=>{
    for(const c of list){ if("focus" in c){ c.navigate(target); return c.focus(); } }
    return clients.openWindow(target);
  }));
});

self.addEventListener("install", e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", e=>{
  const url = new URL(e.request.url);
  if(e.request.method!=="GET") return;
  if(url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) return; // 数据与媒体不缓存

  /* 页面导航与 JS/CSS：网络优先——服务端更新后刷新一次即生效；离线才回退缓存 */
  const isShell = e.request.mode==="navigate" || /\.(js|css|html)$/.test(url.pathname);
  if(isShell){
    const key = e.request.mode==="navigate" ? "./index.html" : e.request;
    e.respondWith(fetch(e.request).then(res=>{
      if(res && res.status===200 && url.origin===location.origin){
        const copy=res.clone(); caches.open(CACHE).then(c=>c.put(key, copy));
      }
      return res;
    }).catch(()=>caches.match(key)));
    return;
  }

  /* 图标等其余静态资源：缓存优先，后台更新 */
  e.respondWith(
    caches.match(e.request).then(hit=>{
      const net = fetch(e.request).then(res=>{
        if(res && res.status===200 && url.origin===location.origin){
          const copy=res.clone(); caches.open(CACHE).then(c=>c.put(e.request, copy));
        }
        return res;
      }).catch(()=>hit);
      return hit || net;
    })
  );
});
