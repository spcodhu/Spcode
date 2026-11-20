import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

export type SpcodeResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type SpcodeSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

const DISABLED_BUILTIN_EXTENSIONS = ["mcp", "codemode", "tool-search"];

export function createSpcodeSettingsManager(settings: SpcodeSettings = {}): SettingsManager {
  return SettingsManager.inMemory({ ...settings, cacheWarming: "off" });
}

export function createSpcodeResourceLoader(options: SpcodeResourceLoaderOptions): DefaultResourceLoader {
  return new DefaultResourceLoader({
    ...options,
    disabledBuiltinExtensions: [
      ...new Set([...(options.disabledBuiltinExtensions ?? []), ...DISABLED_BUILTIN_EXTENSIONS]),
    ],
  });
}
