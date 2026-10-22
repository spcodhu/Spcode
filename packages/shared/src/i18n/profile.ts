import { activeProfile } from "./active-profile.js";
import type { Locale, LocaleProfile } from "./types.js";

export const availableLocales: readonly Locale[] = ["zh-CN", "en"];
export const localeProfile: LocaleProfile = activeProfile;

export function validateProfile(input: LocaleProfile): LocaleProfile {
  if (!input || !Array.isArray(input.supportedLocales) || input.supportedLocales.length === 0) {
    throw new Error("A language profile must include at least one locale.");
  }
  if (input.supportedLocales.some((locale) => !availableLocales.includes(locale))) {
    throw new Error("The language profile contains an unsupported locale.");
  }
  if (!input.supportedLocales.includes(input.defaultLocale)) {
    throw new Error("The default locale must be included in the profile.");
  }
  if (input.fixedLocale && (input.supportedLocales.length !== 1 || input.supportedLocales[0] !== input.fixedLocale)) {
    throw new Error("A fixed-language profile must include only its fixed locale.");
  }
  return input;
}
