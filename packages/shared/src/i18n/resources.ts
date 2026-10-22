import * as agent from "./agent.js";
import * as chat from "./chat.js";
import * as common from "./common.js";
import * as errors from "./errors.js";
import * as feishu from "./feishu.js";
import * as integration from "./integration.js";
import * as main from "./main.js";
import * as mobile from "./mobile.js";
import * as questions from "./questions.js";
import * as settings from "./settings.js";

const namespaces = { common, chat, settings, agent, questions, feishu, main, errors, mobile, integration };
export const resources = {
  "zh-CN": Object.fromEntries(Object.entries(namespaces).map(([name, catalog]) => [name, catalog.zhCN])),
  en: Object.fromEntries(Object.entries(namespaces).map(([name, catalog]) => [name, catalog.en])),
};
