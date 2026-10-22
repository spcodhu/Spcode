/** Push bodies are generic, desktop-localized messages; never derive text from task content. */
const LOCALE_CACHE = "spcode-mobile-locale-v1";
const LOCALE_URL = new URL("__spcode_locale__", self.registration.scope).href;
const scriptParams = new URL(self.location.href).searchParams;
const supportedLocales = (scriptParams.get("supportedLocales") || "zh-CN,en").split(",");
const initialLocale = scriptParams.get("locale") || scriptParams.get("defaultLocale");

function fallbackTitle(locale) {
  if (locale === "en") return "Spcod Remote Control";
  if (locale === "zh-CN") return "Spcod 远程控制";
  return "Spcod";
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data?.type !== "locale.changed" || !supportedLocales.includes(data.locale)) return;
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(LOCALE_CACHE);
      // A profile may customize the generic title; do not store any session information.
      const title = typeof data.title === "string" && data.title ? data.title : fallbackTitle(data.locale);
      await cache.put(LOCALE_URL, new Response(JSON.stringify({ locale: data.locale, title })));
    } catch {
      // Storage is optional, including in private browsing.
    }
  })());
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let title = fallbackTitle(initialLocale);
    let body = "";
    try {
      const cached = await (await caches.open(LOCALE_CACHE)).match(LOCALE_URL);
      const data = await cached?.json();
      if (supportedLocales.includes(data?.locale) && typeof data?.title === "string" && data.title) title = data.title;
    } catch {
      // The installation URL carries the resolved profile locale when caching is unavailable.
    }
    try {
      const data = event.data?.json();
      if (data && typeof data === "object") {
        if (typeof data.title === "string" && data.title) title = data.title;
        if (typeof data.body === "string") body = data.body;
      }
    } catch {
      // Do not expose arbitrary non-JSON payloads on the lock screen.
    }
    await self.registration.showNotification(title, { body });
  })());
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
