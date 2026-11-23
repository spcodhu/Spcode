/**
 * 会话用量的产生时计价：用户覆盖价优先，其次模型目录价；自定义模型未知的 0 不等于免费。
 * 独立成模块以便用真实 ModelRuntime 做宿主级回归，避免只验证 settings 写入。
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelPriceRates, ModelPricingOverrides, UsageRecord } from "@spcode/shared";
import { hasNonzeroPrice, resolveUsageRecordPricing } from "@spcode/shared";
import { type ModelOverlayStore, sourceOfModel } from "./model-overlay.js";

export function catalogPricing(
  modelOverlay: ModelOverlayStore,
  model: { provider: string; id: string; cost?: ModelPriceRates },
): { cost: ModelPriceRates; priceKnown: boolean } {
  const cost: ModelPriceRates = {
    input: model.cost?.input ?? 0,
    output: model.cost?.output ?? 0,
    cacheRead: model.cost?.cacheRead ?? 0,
    cacheWrite: model.cost?.cacheWrite ?? 0,
  };
  return {
    cost,
    priceKnown: hasNonzeroPrice(cost) || sourceOfModel(modelOverlay, model.provider, model.id) === "builtin",
  };
}

export function priceUsageRecord(
  record: UsageRecord,
  runtime: ModelRuntime,
  modelOverlay: ModelOverlayStore,
  overrides: ModelPricingOverrides,
): UsageRecord {
  const key = `${record.model.provider}/${record.model.modelId}`;
  const model = runtime.getModel(record.model.provider, record.model.modelId);
  const pricing = model ? catalogPricing(modelOverlay, model) : undefined;
  return resolveUsageRecordPricing(record, {
    override: overrides[key],
    defaultRates: pricing?.cost,
    defaultKnown: pricing?.priceKnown ?? false,
  });
}
