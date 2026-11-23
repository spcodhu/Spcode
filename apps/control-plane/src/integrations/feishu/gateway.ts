import { createHash } from "node:crypto";
import { isAuthorizedSource } from "@spcode/superagent";
import type { SourceStore } from "../../source-store.js";
import type { FeishuApi, FeishuCardAction, FeishuInboundMessage } from "./api.js";

export interface FeishuGateConfig {
  enabled: boolean;
  allowedChats: string[];
  authorizedOperators: string[];
  defaultRepo: string;
  botOpenId: string;
  repoForChat?: (chatId: string) => string | undefined;
}

export class FeishuGateway {
  constructor(
    readonly store: SourceStore,
    private readonly api: FeishuApi,
    private readonly config: () => FeishuGateConfig,
    private readonly approvePlan: (input: {
      workItemId: string;
      planId: string;
      planHash: string;
      actorId: string;
    }) => void,
    private readonly privateMessage?: (message: FeishuInboundMessage) => Promise<void>,
    private readonly privateCard?: (action: FeishuCardAction) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    this.api.onMessage(async (message) => {
      await this.handleMessage(message);
    });
    this.api.onCardAction(async (action) => {
      await this.handleCard(action);
    });
    await this.api.start();
  }

  async stop(): Promise<void> {
    await this.api.stop();
  }

  async handleMessage(message: FeishuInboundMessage): Promise<{ workItemId?: string; created: boolean }> {
    if (message.chatType === "p2p") {
      await this.privateMessage?.(message);
      return { created: false };
    }
    const config = this.config();
    const mentionedBot = message.mentions.some((mention) => mention.openId === config.botOpenId);
    if (
      !isAuthorizedSource({
        enabled: config.enabled,
        chatId: message.chatId,
        operatorId: message.operatorOpenId,
        allowedChats: config.allowedChats,
        authorizedOperators: config.authorizedOperators,
        mentionedBot,
        fromBot: message.fromBot,
      })
    ) {
      return { created: false };
    }
    const text = message.text
      .replace(/@_user_\d+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return { created: false };
    const explicitRepo = text.match(/(?:^|\s)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\s|$)/)?.[1];
    const repo = explicitRepo ?? config.repoForChat?.(message.chatId) ?? config.defaultRepo;
    return this.store.enqueueGroupAcceptance({
      eventId: message.eventId,
      messageId: message.messageId,
      chatId: message.chatId,
      operatorId: message.operatorOpenId,
      text,
      repo,
      ...(message.rootId ? { rootId: message.rootId } : {}),
      ...(message.threadId ? { threadId: message.threadId } : {}),
      mentions: message.mentions,
    });
  }

  async handleCard(action: FeishuCardAction): Promise<{ workItemId?: string; created: boolean }> {
    const value = action.value;
    if (value.action === "permission" || value.action === "question") {
      await this.privateCard?.(action);
      return { created: false };
    }
    const config = this.config();
    if (
      !config.enabled ||
      !config.allowedChats.includes(action.chatId) ||
      !config.authorizedOperators.includes(action.operatorOpenId)
    ) {
      return { created: false };
    }
    if (value.action === "digest.trigger" || value.action === "digest.ignore") {
      const card = this.store.card(action.messageId);
      if (
        !card ||
        card.digestId !== value.digestId ||
        typeof value.digestId !== "string" ||
        typeof value.itemId !== "string" ||
        typeof value.digestHash !== "string"
      ) {
        return { created: false };
      }
      return this.store.resolveDigestItem({
        digestId: value.digestId,
        itemId: value.itemId,
        digestHash: value.digestHash,
        action: value.action === "digest.trigger" ? "approve" : "ignore",
        actorId: action.operatorOpenId,
        chatId: action.chatId,
      });
    }
    if (value.action === "plan.approve") {
      const card = this.store.card(action.messageId);
      if (
        !card?.workItemId ||
        card.workItemId !== value.workItemId ||
        typeof value.workItemId !== "string" ||
        typeof value.planId !== "string" ||
        typeof value.planHash !== "string"
      ) {
        return { created: false };
      }
      this.approvePlan({
        workItemId: value.workItemId,
        planId: value.planId,
        planHash: value.planHash,
        actorId: action.operatorOpenId,
      });
      return { workItemId: value.workItemId, created: true };
    }
    return { created: false };
  }
}

export function feishuPayloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
