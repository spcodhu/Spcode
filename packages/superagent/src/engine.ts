import type { SuperAgentCommand, SuperAgentSnapshot } from "@spcode/shared/superagent";
import type { EventSink, SuperAgentStore } from "./ports.js";

/** 事务用例：Store 先提交事实，返回后才发布事件；事件永远只是唤醒提示。 */
export class SuperAgentEngine {
  constructor(
    private readonly store: SuperAgentStore,
    private readonly events: EventSink,
  ) {}

  execute(command: SuperAgentCommand, actorId: string): { eventId: number; workItemId?: string } {
    const result = this.store.execute(command, actorId);
    this.events.publish({ sequence: result.eventId, ...(result.workItemId ? { workItemId: result.workItemId } : {}) });
    return result;
  }

  snapshot(): Omit<SuperAgentSnapshot, "service" | "enabled"> {
    return this.store.snapshot();
  }
}
