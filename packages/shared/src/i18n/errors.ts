export const zhCN = {
  "run.quota.title": "模型额度不足，任务已中断",
  "run.quota.hint": "到「设置 → 配额」查看剩余额度，或切换到其他模型后重新发送。本轮已完成的输出已保留。",
  "run.auth.title": "模型凭证无效，任务已中断",
  "run.auth.hint": "到「设置 → 模型」检查该供应商的 API Key 是否有效、是否已过期，然后重新发送。",
  "run.rateLimit.title": "模型限流，任务已中断",
  "run.rateLimit.hint": "等一会儿再重试，或在「设置 → 模型」切换到其他模型；已完成的输出已保留。",
  "run.overflow.title": "上下文超长，任务已中断",
  "run.overflow.hint": "先用输入框旁的用量环手动压缩上下文，或新建会话继续；已完成的输出已保留。",
  "run.network.title": "网络异常，任务已中断",
  "run.network.hint": "检查网络或代理后重试；已完成的输出已保留。",
  "run.other.title": "任务因错误中断",
  "run.other.hint": "原始错误见下方；必要时切换模型或稍后重试。",
} as const;

export const en = {
  "run.quota.title": "Task interrupted: model quota exhausted",
  "run.quota.hint":
    "Check your remaining quota in Settings → Quota, or switch models and send again. Output already completed in this turn has been preserved.",
  "run.auth.title": "Task interrupted: invalid model credentials",
  "run.auth.hint":
    "In Settings → Models, check that this provider's API Key is valid and has not expired, then send again.",
  "run.rateLimit.title": "Task interrupted: model rate limit reached",
  "run.rateLimit.hint":
    "Wait a moment and retry, or switch models in Settings → Models. Completed output has been preserved.",
  "run.overflow.title": "Task interrupted: context too long",
  "run.overflow.hint":
    "Use the usage ring beside the input to compact the context, or continue in a new session. Completed output has been preserved.",
  "run.network.title": "Task interrupted: network error",
  "run.network.hint": "Check your network or proxy and retry. Completed output has been preserved.",
  "run.other.title": "Task interrupted by an error",
  "run.other.hint": "See the original error below. If needed, switch models or try again later.",
} as const satisfies Record<keyof typeof zhCN, string>;
