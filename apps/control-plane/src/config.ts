import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "@spcode/shared/node";
import {
  DEFAULT_SUPERAGENT_CONFIG,
  type SuperAgentConfig,
  type SuperAgentPublicConfig,
  sanitizeSuperAgentConfig,
} from "@spcode/shared/superagent";

function validateConfigFile(value: unknown): { version: 1; config: Partial<SuperAgentConfig> } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { version?: unknown; config?: unknown };
  if (record.version !== 1 || !record.config || typeof record.config !== "object" || Array.isArray(record.config))
    return null;
  return { version: 1, config: record.config as Partial<SuperAgentConfig> };
}

/** 非密钥业务配置；环境变量只作为缺省覆盖，不写入此文件。 */
function envList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** 非密钥业务配置；环境变量只作为缺省覆盖，不写入此文件。 */
export class ConfigStore {
  private readonly file: string;
  private current: SuperAgentConfig;

  constructor(baseDir: string, enabledOverride?: boolean) {
    this.file = join(baseDir, "config.json");
    const loaded = readJsonFile(this.file, validateConfigFile);
    this.current = sanitizeSuperAgentConfig({
      ...DEFAULT_SUPERAGENT_CONFIG,
      ...loaded?.config,
      ...(loaded?.config?.allowedChats === undefined
        ? { allowedChats: envList(process.env.SPCODE_SUPERAGENT_ALLOWED_CHATS) }
        : {}),
      ...(loaded?.config?.authorizedOperators === undefined
        ? { authorizedOperators: envList(process.env.SPCODE_SUPERAGENT_AUTHORIZED_OPERATORS) }
        : {}),
      ...(enabledOverride === undefined && process.env.SPCODE_SUPERAGENT_ENABLED !== undefined
        ? { enabled: process.env.SPCODE_SUPERAGENT_ENABLED === "1" }
        : {}),
      ...(enabledOverride === undefined ? {} : { enabled: enabledOverride }),
    });
  }

  get(): SuperAgentConfig {
    return structuredClone(this.current);
  }

  set(patch: Partial<SuperAgentConfig>): SuperAgentConfig {
    this.current = sanitizeSuperAgentConfig({ ...this.current, ...patch });
    writeJsonFileAtomic(this.file, { version: 1, config: this.current }, { mode: 0o600 });
    return this.get();
  }

  public(): SuperAgentPublicConfig {
    return {
      ...this.get(),
      credentials: {
        github: !!process.env.SPCODE_GITHUB_TOKEN?.trim(),
        feishu: !!(process.env.SPCODE_FEISHU_APP_ID?.trim() && process.env.SPCODE_FEISHU_APP_SECRET?.trim()),
        botIdentity: !!process.env.SPCODE_FEISHU_BOT_OPEN_ID?.trim(),
      },
      configFile: this.file,
    };
  }
}
