import { getLocale, i18n, setLocale } from "@spcode/shared/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import App from "./App";
import { useStore } from "./store";
import "./styles.css";

function syncDocumentLanguage() {
  document.documentElement.lang = getLocale();
  document.documentElement.dir = i18n.dir();
}
i18n.on("languageChanged", syncDocumentLanguage);

async function boot() {
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
