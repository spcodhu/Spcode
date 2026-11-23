import * as Lark from "@larksuiteoapi/node-sdk";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

export interface FeishuInboundMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  operatorOpenId: string;
  text: string;
  rootId?: string;
  threadId?: string;
  mentions: Array<{ openId: string; name: string; key: string }>;
  fromBot: boolean;
}

export interface FeishuCardAction {
  eventId: string;
  operatorOpenId: string;
  chatId: string;
  messageId: string;
  value: Record<string, unknown>;
}

export interface FeishuApi {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(callback: (message: FeishuInboundMessage) => Promise<void> | void): void;
  onCardAction(callback: (action: FeishuCardAction) => Promise<void> | void): void;
  sendText(chatId: string, text: string): Promise<string>;
  sendCard(chatId: string, card: Record<string, unknown>): Promise<string>;
  replyText(messageId: string, text: string): Promise<string>;
  updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
  sendPrivateText?(openId: string, text: string): Promise<string>;
  sendPrivateCard?(openId: string, card: Record<string, unknown>): Promise<string>;
}

export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly options: { retryable?: boolean; timeout?: boolean } = {},
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
}

export class LarkFeishuApi implements FeishuApi {
  private readonly client: InstanceType<typeof Lark.Client>;
  private readonly wsClient: InstanceType<typeof Lark.WSClient>;
  private messageCallback: ((message: FeishuInboundMessage) => Promise<void> | void) | null = null;
  private cardCallback: ((action: FeishuCardAction) => Promise<void> | void) | null = null;

  constructor(
    private readonly config: { appId: string; appSecret: string; botOpenId: string },
    proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy,
  ) {
    const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
    const httpInstance = agent ? axios.create({ httpAgent: agent, httpsAgent: agent, proxy: false }) : undefined;
    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      ...(httpInstance ? { httpInstance: httpInstance as unknown as Lark.HttpInstance } : {}),
    });
    this.wsClient = new Lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      ...(agent ? { agent } : {}),
    });
  }

  onMessage(callback: (message: FeishuInboundMessage) => void): void {
    this.messageCallback = callback;
  }

  onCardAction(callback: (action: FeishuCardAction) => void): void {
    this.cardCallback = callback;
  }

  async start(): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (raw: unknown) => {
        const data = raw as Record<string, any>;
        const message = data.message;
        const openId = data.sender?.sender_id?.open_id;
        if (!message?.message_id || !message.chat_id || !openId || message.message_type !== "text") return;
        let text = "";
        try {
          text = (JSON.parse(message.content) as { text?: string }).text ?? "";
        } catch {
          return;
        }
        const mentions = Array.isArray(message.mentions)
          ? message.mentions.map((mention: any) => ({
              openId: String(mention.id?.open_id ?? ""),
              name: String(mention.name ?? ""),
              key: String(mention.key ?? ""),
            }))
          : [];
        await this.messageCallback?.({
          eventId: String(data.header?.event_id ?? data.event_id ?? message.message_id),
          messageId: String(message.message_id),
          chatId: String(message.chat_id),
          chatType: message.chat_type === "group" ? "group" : "p2p",
          operatorOpenId: openId,
          text,
          ...(message.root_id ? { rootId: String(message.root_id) } : {}),
          ...(message.thread_id ? { threadId: String(message.thread_id) } : {}),
          mentions,
          fromBot: data.sender?.sender_type !== "user" || openId === this.config.botOpenId,
        });
      },
      "card.action.trigger": async (raw: unknown) => {
        const data = raw as Record<string, any>;
        const openId = data.operator?.open_id;
        const messageId = data.context?.open_message_id ?? data.open_message_id;
        const chatId = data.context?.open_chat_id ?? data.open_chat_id;
        if (!openId || !messageId || !chatId) return {};
        await this.cardCallback?.({
          eventId: String(
            data.header?.event_id ?? data.event_id ?? `${messageId}:${JSON.stringify(data.action?.value ?? {})}`,
          ),
          operatorOpenId: String(openId),
          chatId: String(chatId),
          messageId: String(messageId),
          value: data.action?.value ?? {},
        });
        return {};
      },
    } as Parameters<InstanceType<typeof Lark.EventDispatcher>["register"]>[0]);
    await this.wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    this.messageCallback = null;
    this.cardCallback = null;
    this.wsClient.close({ force: true });
  }

  async sendText(chatId: string, text: string): Promise<string> {
    return this.create(chatId, "text", { text });
  }

  async sendCard(chatId: string, card: Record<string, unknown>): Promise<string> {
    const response = (await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) },
    })) as { code?: number; msg?: string; data?: { message_id?: string } };
    this.assert(response);
    return response.data?.message_id ?? "";
  }

  async sendPrivateText(openId: string, text: string): Promise<string> {
    const response = (await this.client.im.message.create({
      params: { receive_id_type: "open_id" },
      data: { receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) },
    })) as { code?: number; msg?: string; data?: { message_id?: string } };
    this.assert(response);
    return response.data?.message_id ?? "";
  }

  async sendPrivateCard(openId: string, card: Record<string, unknown>): Promise<string> {
    const response = (await this.client.im.message.create({
      params: { receive_id_type: "open_id" },
      data: { receive_id: openId, msg_type: "interactive", content: JSON.stringify(card) },
    })) as { code?: number; msg?: string; data?: { message_id?: string } };
    this.assert(response);
    return response.data?.message_id ?? "";
  }

  async replyText(messageId: string, text: string): Promise<string> {
    const response = (await this.client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "text", content: JSON.stringify({ text }) },
    })) as { code?: number; msg?: string; data?: { message_id?: string } };
    this.assert(response);
    return response.data?.message_id ?? "";
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    const response = (await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    })) as { code?: number; msg?: string };
    this.assert(response);
  }

  private async create(chatId: string, msgType: "text", content: { text: string }): Promise<string> {
    const response = (await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) },
    })) as { code?: number; msg?: string; data?: { message_id?: string } };
    this.assert(response);
    return response.data?.message_id ?? "";
  }

  private assert(response: { code?: number; msg?: string }): void {
    if (response.code === 0) return;
    const retryable = response.code === 429 || (response.code !== undefined && response.code >= 500);
    throw new FeishuApiError(response.msg ?? `飞书 API code=${response.code}`, { retryable });
  }
}
