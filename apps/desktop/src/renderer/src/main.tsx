import { getLocale, i18n, setLocale } from "@spcode/shared/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import App from "./App";
import { createBrowserSpcodeApi } from "./browser-api";
import { initializeControlTransport } from "./control";
import { useStore } from "./store";
import "./styles.css";

function syncDocumentLanguage() {
  document.documentElement.lang = getLocale();
  document.documentElement.dir = i18n.dir();
}
i18n.on("languageChanged", syncDocumentLanguage);

async function boot() {
  try {
    const control = await initializeControlTransport();
    if (!window.spcode && control) window.spcode = createBrowserSpcodeApi(control);
  } catch {
    // 控制面认证失败由 SuperAgent 页面给出恢复入口，不阻塞共享工作台启动。
  }
  try {
    const settings = await window.spcode.getSettings();
    setLocale(settings.locale);
    useStore.setState({ settings });
  } catch {
    // App.init retains the settings error and offers recovery without blocking startup.
  }
  syncDocumentLanguage();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </StrictMode>,
  );
}
void boot();
