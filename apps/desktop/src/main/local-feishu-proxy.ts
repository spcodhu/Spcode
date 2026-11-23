import type { LocalService } from "./local-service.js";
import type { FeishuApi, FeishuCardAction, FeishuInboundMessage } from "./remote/channel/feishu.js";

/** 桌面旧 FeishuChannel 的 subscriber API：不建立第二条长连接。 */
export class LocalFeishuProxy implements FeishuApi {
  private messageCallback: ((message: FeishuInboundMessage) => void) | null = null;
  private cardCallback: ((action: FeishuCardAction) => void) | null = null;

  constructor(private readonly service: LocalService) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.messageCallback = null;
    this.cardCallback = null;
  }
  onMessage(callback: (message: FeishuInboundMessage) => void): void {
    this.messageCallback = callback;
  }
  onCardAction(callback: (action: FeishuCardAction) => void): void {
    this.cardCallback = callback;
  }
  async sendText(openId: string, text: string): Promise<string> {
    return this.service.invokeControl<string>("feishu.sendPrivateText", [openId, text]);
  }
  async sendCard(openId: string, card: Record<string, unknown>): Promise<string> {
    return this.service.invokeControl<string>("feishu.sendPrivateCard", [openId, card]);
  }
  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.service.invokeControl("feishu.updateCard", [messageId, card]);
  }
  async dispatchMessage(message: { operatorOpenId: string; text: string; chatType: string }): Promise<void> {
    this.messageCallback?.({ openId: message.operatorOpenId, text: message.text, chatType: message.chatType });
  }
  async dispatchCard(action: {
    operatorOpenId: string;
    value: Record<string, unknown>;
    messageId: string;
  }): Promise<void> {
    this.cardCallback?.({
      operatorOpenId: action.operatorOpenId,
      value: action.value,
      messageId: action.messageId,
    });
  }
}
