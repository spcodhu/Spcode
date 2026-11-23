import type { SuperAgentCommand, SuperAgentSnapshot } from "@spcode/shared/superagent";

export interface SuperAgentStore {
  snapshot(): Omit<SuperAgentSnapshot, "service" | "enabled">;
  execute(command: SuperAgentCommand, actorId: string): { eventId: number; workItemId?: string };
}

export interface EventSink {
  publish(event: { sequence: number; workItemId?: string }): void;
}
