import { createInstance } from "i18next";
import { localeProfile, validateProfile } from "./profile.js";
import { resources } from "./resources.js";
import type { Locale, LocaleProfile, LocalizedText } from "./types.js";

export { localeProfile, validateProfile } from "./profile.js";

export type { Locale, LocaleProfile, LocalizedText } from "./types.js";
export type { TranslationKey } from "./typing.js";

export function resolveLocale(value: unknown, profile: LocaleProfile = localeProfile): Locale {
  if (profile.fixedLocale) return profile.fixedLocale;
  return profile.supportedLocales.includes(value as Locale) ? (value as Locale) : profile.defaultLocale;
}

export function createI18n(profile: LocaleProfile = localeProfile) {
  validateProfile(profile);
  const instance = createInstance();
  const bundled = Object.fromEntries(
    profile.supportedLocales.map((locale) => {
      const base = resources[locale];
      const overrides = profile.overrides?.[locale] ?? {};
      const catalog = Object.fromEntries(Object.entries(base).map(([ns, values]) => [ns, { ...values }]));
      for (const [ns, values] of Object.entries(overrides)) {
        if (!catalog[ns]) throw new Error(`Unknown translation namespace: ${ns}`);
        for (const [key, value] of Object.entries(values)) {
          const original = catalog[ns][key];
          if (typeof original !== "string" || typeof value !== "string")
            throw new Error(`Unknown translation: ${ns}:${key}`);
          if (interpolationNames(original) !== interpolationNames(value))
            throw new Error(`Translation parameters differ: ${ns}:${key}`);
          catalog[ns][key] = value;
        }
      }
      return [locale, catalog];
    }),
  );
  void instance.init({
    resources: bundled,
    lng: resolveLocale(profile.defaultLocale, profile),
    supportedLngs: [...profile.supportedLocales],
    fallbackLng: false,
    defaultNS: "common",
    keySeparator: false,
    initAsync: false,
    returnNull: false,
    interpolation: { escapeValue: false },
  });
  return instance;
}

export function interpolationNames(text: string): string {
  return [...new Set(Array.from(text.matchAll(/{{\s*([^},\s]+)(?:,[^}]*)?\s*}}/g), (match) => match[1]))]
    .sort()
    .join(",");
}

export const i18n = createI18n();

export function getLocale(): Locale {
  return resolveLocale(i18n.language);
}

export function setLocale(locale: unknown): void {
  void i18n.changeLanguage(resolveLocale(locale));
}

export function renderMessage(message: LocalizedText): string {
  const translate = i18n.t as (key: string, params?: Record<string, string | number>) => string;
  return translate(message.key, message.params);
}

interface SessionTitle {
  title: string;
  cwd: string;
  mode: "chat" | "project";
  titleKind?: "default" | "custom";
}

export function isDefaultSessionTitle(session: Pick<SessionTitle, "title" | "cwd" | "titleKind">): boolean {
  if (session.titleKind) return session.titleKind === "default";
  const basename =
    session.cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  return ["新聊天", "新项目", "New chat", "New project", basename].includes(session.title);
}

export function localizeDefaultTitle<T extends SessionTitle>(session: T): T {
  if (!isDefaultSessionTitle(session)) return session;
  const basename =
    session.cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  return {
    ...session,
    titleKind: "default",
    title:
      session.mode === "project" && basename ? basename : i18n.t(session.mode === "chat" ? "newChat" : "newProject"),
  };
}
