export const zhCN = {
  "plan.title": "计划已就绪，是否开始执行？",
  "plan.header": "计划确认",
  "plan.approve": "开始执行",
  "plan.approveDescription": "关闭计划模式，按计划开始实施",
  "plan.revise": "继续调整",
  "plan.reviseDescription": "保持计划模式，继续完善计划",
  "plan.notActive": "当前不在计划模式，无需调用此工具。",
  "plan.approved":
    "用户已批准计划。计划模式已关闭，全部工具已恢复。\n现在开始执行：第一步必须调用 TodoWrite，把计划拆成任务清单（每步一项，带 activeForm）；\n之后每完成一个阶段目标，立即更新一次 TodoWrite 状态，不要攒到最后批量更新。",
  "plan.feedback":
    "用户暂未批准，仍在计划模式。用户的回复：「{{answer}}」。请按此继续完善计划，完成后再次调用 WritePlan 更新计划文件并重新展示，然后再调用 ExitPlanMode。",
  "plan.dismissed": "用户跳过了确认，仍在计划模式。等待用户进一步指示；若用户表达了执行意愿，再次调用 ExitPlanMode。",
  "ask.dismissed": "用户取消了提问，未作答。",
  "card.title": "Agent 在提问",
  "card.session": "会话：{{title}}",
  "card.queued": "还有 {{count}} 组提问",
  "card.previous": "上一题",
  "card.next": "下一题",
  "card.multiSelect": "可多选",
  "card.otherAnswer": "其他回答…",
  "card.typeInstead": "或直接输入…",
  "card.typeAnswer": "输入回答…",
  "card.cancel": "取消",
  "card.submit": "提交回答",
} as const;

export const en = {
  "plan.title": "The plan is ready. Start executing?",
  "plan.header": "Plan approval",
  "plan.approve": "Start executing",
  "plan.approveDescription": "Exit plan mode and start implementing the plan",
  "plan.revise": "Keep refining",
  "plan.reviseDescription": "Stay in plan mode and continue refining the plan",
  "plan.notActive": "Plan mode is not active. This tool is not needed.",
  "plan.approved":
    "The user approved the plan. Plan mode is disabled and all tools are restored.\nStart executing now: first call TodoWrite to split the plan into a task list (one item per step, with activeForm).\nAfter each milestone, immediately update TodoWrite status; do not batch updates at the end.",
  "plan.feedback":
    'The user has not approved the plan. Remain in plan mode. User reply: "{{answer}}". Refine the plan accordingly, call WritePlan again to update and display the plan, then call ExitPlanMode again.',
  "plan.dismissed":
    "The user dismissed the confirmation. Remain in plan mode and wait for further instructions. If the user asks to execute, call ExitPlanMode again.",
  "ask.dismissed": "User dismissed the question without answering.",
  "card.title": "Agent is asking",
  "card.session": "Session: {{title}}",
  "card.queued": "{{count}} more question sets",
  "card.previous": "Previous question",
  "card.next": "Next question",
  "card.multiSelect": "Select multiple",
  "card.otherAnswer": "Other answer…",
  "card.typeInstead": "Or type an answer…",
  "card.typeAnswer": "Type an answer…",
  "card.cancel": "Cancel",
  "card.submit": "Submit answer",
} as const satisfies Record<keyof typeof zhCN, string>;
