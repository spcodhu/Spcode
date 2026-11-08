// 首屏主题预设（同步执行，防闪烁）；外置为独立文件以满足 relay 的严格 CSP（script-src 'self'）。
try {
  var base = localStorage.getItem("spcod-mobile-theme") === "dark" ? "dark" : "light";
  document.documentElement.dataset.themeBase = base;
  document.documentElement.style.colorScheme = base;
} catch (e) {
  document.documentElement.dataset.themeBase = "light";
  document.documentElement.style.colorScheme = "light";
}
