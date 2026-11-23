import type { FeishuApi, FeishuCardAction, FeishuInboundMessage } from "./api.js";

/** 可控 Fake：只替代飞书网络，不替代 Gate、Outbox、Worker 或 Git。 */
export class FakeFeishu implements FeishuApi {
  readonly messages: Array<{ kind: string; target: string; content: unknown; messageId: string }> = [];
  error: Error | null = null;
  hang = false;
  private messageCallback: ((message: FeishuInboundMessage) => Promise<void> | void) | null = null;
  private cardCallback: ((action: FeishuCardAction) => Promise<void> | void) | null = null;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(callback: (message: FeishuInboundMessage) => Promise<void> | void): void {
    this.messageCallback = callback;
  }
  onCardAction(callback: (action: FeishuCardAction) => Promise<void> | void): void {
    this.cardCallback = callback;
  }
  async emitMessage(message: FeishuInboundMessage): Promise<void> {
    await this.messageCallback?.(message);
  }
  async emitCard(action: FeishuCardAction): Promise<void> {
    await this.cardCallback?.(action);
  }
  async sendText(chatId: string, text: string): Promise<string> {
    return this.record("text", chatId, text);
  }
  async sendCard(chatId: string, card: Record<string, unknown>): Promise<string> {
    return this.record("card", chatId, card);
  }
  async replyText(messageId: string, text: string): Promise<string> {
    return this.record("reply", messageId, text);
  }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    this.messages.push({ kind: "update", target: messageId, content: card, messageId });
  }

  private async record(kind: string, target: string, content: unknown): Promise<string> {
    if (this.error) throw this.error;
    if (this.hang) return new Promise(() => {});
    const messageId = `om_${this.messages.length + 1}`;
    this.messages.push({ kind, target, content, messageId });
    return messageId;
  }
}
