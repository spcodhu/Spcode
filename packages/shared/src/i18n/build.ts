import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locale, LocaleProfile } from "./types.js";

const directory = dirname(fileURLToPath(import.meta.url));
const namespaces = [
  "common",
  "chat",
  "settings",
  "agent",
  "questions",
  "feishu",
  "main",
  "errors",
  "mobile",
  "integration",
];
const supportedLocales: Locale[] = ["zh-CN", "en"];

const defaultProfile: LocaleProfile = { supportedLocales, defaultLocale: "zh-CN" };

export function validateBuildProfile(input: LocaleProfile): LocaleProfile {
  if (!input || !Array.isArray(input.supportedLocales) || input.supportedLocales.length === 0) {
    throw new Error("A language profile must include at least one locale.");
  }
  if (input.supportedLocales.some((locale) => !supportedLocales.includes(locale))) {
    throw new Error("The language profile contains an unsupported locale.");
  }
  if (!input.supportedLocales.includes(input.defaultLocale)) {
    throw new Error("The default locale must be included in the profile.");
  }
  if (input.fixedLocale && (input.supportedLocales.length !== 1 || input.supportedLocales[0] !== input.fixedLocale)) {
    throw new Error("A fixed-language profile must include only its fixed locale.");
  }
  const overrides = input.overrides ?? {};
  for (const [locale, catalogs] of Object.entries(overrides)) {
    if (!input.supportedLocales.includes(locale as Locale)) {
      throw new Error(`Overrides reference a locale outside the profile: ${locale}`);
    }
    for (const namespace of Object.keys(catalogs ?? {})) {
      if (!namespaces.includes(namespace)) throw new Error(`Unknown translation namespace: ${namespace}`);
    }
  }
  return input;
}

export function readBuildProfile(env: Record<string, string | undefined> = process.env): LocaleProfile {
  const file = env.SPCODE_I18N_PROFILE;
  return validateBuildProfile(file ? JSON.parse(readFileSync(resolve(file), "utf8")) : defaultProfile);
}

export function languageBuildPlugin() {
  const profile = readBuildProfile();
  const profileId = "\0spcode-language-profile";
  const resourcesId = "\0spcode-language-resources";
  return {
    name: "spcode-language-profile",
    enforce: "pre" as const,
    resolveId(source: string, importer?: string) {
      if (!importer?.replaceAll("\\", "/").includes("/shared/src/i18n/")) return null;
      if (source === "./active-profile.js") return profileId;
      if (source === "./resources.js") return resourcesId;
      return null;
    },
    load(id: string) {
      if (id === profileId) return `export const activeProfile = ${JSON.stringify(profile)};`;
      if (id !== resourcesId) return null;
      const lines: string[] = [];
      const catalogs: string[] = [];
      for (const [index, locale] of profile.supportedLocales.entries()) {
        const field = locale === "zh-CN" ? "zhCN" : "en";
        for (const ns of namespaces) {
          lines.push(`import { ${field} as ${ns}_${index} } from ${JSON.stringify(resolve(directory, `${ns}.ts`))};`);
        }
        catalogs.push(`${JSON.stringify(locale)}:{${namespaces.map((ns) => `${ns}:${ns}_${index}`).join(",")}}`);
      }
      lines.push(`export const resources = {${catalogs.join(",")}};`);
      return lines.join("\n");
    },
  };
}
