/**
 * 最小 service worker：Web Push 事件 → 系统通知；点击通知聚焦/打开 PWA。
 * 负载约定（桌面侧推送）：JSON { title?: string; body?: string }，标题/正文原样展示；
 * 非 JSON 负载按纯文本正文处理。
 */

self.addEventListener("push", (event) => {
  let title = "Spcod 远程控制";
  let body = "";
  if (event.data) {
    try {
      const data = event.data.json();
      if (data && typeof data === "object") {
        if (typeof data.title === "string" && data.title) title = data.title;
        if (typeof data.body === "string") body = data.body;
      }
    } catch {
      try {
        body = event.data.text();
      } catch {
        // 空负载：只显示默认标题
      }
    }
  }
  event.waitUntil(self.registration.showNotification(title, { body }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) return c.focus();
      }
      return clients.openWindow("./");
    }),
  );
});
