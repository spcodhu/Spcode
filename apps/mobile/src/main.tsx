import { i18n } from "@spcode/shared/i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import App from "./App";
import { initializeMobileLocale } from "./lib/i18n";
import { initializeMobileTheme } from "./lib/theme";
import "./index.css";

initializeMobileLocale();
initializeMobileTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  </StrictMode>,
);
