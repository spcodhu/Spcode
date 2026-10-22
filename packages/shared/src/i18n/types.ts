export type Locale = "zh-CN" | "en";

export interface LocalizedText {
  key: string;
  params?: Record<string, string | number>;
}

export interface LocaleProfile {
  supportedLocales: readonly Locale[];
  defaultLocale: Locale;
  fixedLocale?: Locale;
  overrides?: Partial<Record<Locale, Record<string, Record<string, string>>>>;
}
