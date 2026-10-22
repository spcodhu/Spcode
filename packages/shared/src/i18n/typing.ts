import type * as agent from "./agent.js";
import type * as chat from "./chat.js";
import type * as common from "./common.js";
import type * as errors from "./errors.js";
import type * as feishu from "./feishu.js";
import type * as integration from "./integration.js";
import type * as main from "./main.js";
import type * as mobile from "./mobile.js";
import type * as questions from "./questions.js";
import type * as settings from "./settings.js";

export interface TranslationResources {
  common: typeof common.en;
  chat: typeof chat.en;
  settings: typeof settings.en;
  agent: typeof agent.en;
  questions: typeof questions.en;
  feishu: typeof feishu.en;
  main: typeof main.en;
  errors: typeof errors.en;
  mobile: typeof mobile.en;
  integration: typeof integration.en;
}

export type TranslationKey = {
  [N in keyof TranslationResources]: `${N}:${Extract<keyof TranslationResources[N], string>}`;
}[keyof TranslationResources];

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    keySeparator: false;
    returnNull: false;
    resources: TranslationResources;
  }
}
