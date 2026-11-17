/**
 * GenerateImage —— 用户在设置页「技能」配置了生图模型后可用的内置生图工具。
 *
 * 与 AdvancedSearch 的门控方式不同：工具始终注册，但是否进活跃工具集由
 * session-controller 按配置完整性决定（skills.setConfig 热插拔，活跃会话即时生效）。
 * 执行时再查一次配置兜底（配置可能在会话存活期间被清空）。
 *
 * 协议适配在 @spcode/shared/image-gen（主进程「测试生成」IPC 共用）。
 * 生成的图片落盘到会话 cwd 的 spcode-images/，路径经 details.images 上抛，
 * 渲染层据此在消息流里直接展示图片（工作区路径守卫内读取）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ImageGenConfig } from "@spcode/shared";
import { executeImageGen, isImageGenReady } from "@spcode/shared/image-gen";
import { type Static, Type } from "typebox";
import { STRICT_PREFER_TOOL_SAMPLING } from "./tool-schema.js";

const schema = Type.Object({
  prompt: Type.String({
    description:
      "Detailed, self-contained image description: subject, style, composition, lighting, colors. English usually works best.",
    minLength: 1,
  }),
  size: Type.Optional(
    Type.String({
      description:
        'Optional output size like "1024x1024", "1536x1024" (landscape) or "1024x1536" (portrait). Protocol-dependent; ignored when unsupported.',
    }),
  ),
});

type Params = Static<typeof schema>;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

export interface ImageGenToolOptions {
  /** 会话工作目录：图片保存到其下 spcode-images/（chat 会话为 scratch 目录） */
  cwd: string;
  /** 实时读取技能配置（主进程经 skills.setConfig 下发） */
  getConfig: () => ImageGenConfig | null;
}

export function createImageGenTool(opts: ImageGenToolOptions): ToolDefinition {
  return {
    name: "GenerateImage",
    label: "Generate Image",
    description:
      "Generate an image from a text prompt using the user's configured image model (Settings → Skills). The image is saved into the session workspace and automatically displayed to the user inline in the chat — do not embed or re-read it. Returns the saved file path(s). Use for photos, illustrations, artwork and visual concepts; for precise diagrams, charts or text-heavy graphics prefer code/SVG instead.",
    promptSnippet: "Generate images from text prompts via the user-configured image model (Settings → Skills)",
    parameters: schema,
    constrainedSampling: STRICT_PREFER_TOOL_SAMPLING,
    execute: async (_id, args: Params, signal) => {
      const prompt = (args.prompt ?? "").trim();
      if (!prompt) {
        return { content: [{ type: "text", text: "Missing prompt" }], details: undefined, isError: true };
      }
      const config = opts.getConfig();
      if (!isImageGenReady(config)) {
        return {
          content: [
            {
              type: "text",
              text: "GenerateImage is not configured. Ask the user to configure an image model in Settings → Skills → Image generation.",
            },
          ],
          details: undefined,
          isError: true,
        };
      }
      try {
        const outcome = await executeImageGen(config as ImageGenConfig, prompt, {
          size: typeof args.size === "string" ? args.size : undefined,
          signal,
        });
        const dir = join(opts.cwd, "spcode-images");
        mkdirSync(dir, { recursive: true });
        const saved: { path: string; mimeType: string }[] = [];
        for (const image of outcome.images) {
          const ext = EXT_BY_MIME[image.mimeType] ?? "png";
          const name = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
          const path = join(dir, name);
          writeFileSync(path, Buffer.from(image.data, "base64"));
          saved.push({ path, mimeType: image.mimeType });
        }
        const lines = [
          `Generated ${saved.length} image(s). Saved to:`,
          ...saved.map((s) => `- ${s.path}`),
          "",
          "The images are already displayed to the user inline in the chat. Do not embed them again with markdown or read them back; mention the file paths only if useful.",
        ];
        if (outcome.text) lines.push("", `Model note: ${outcome.text.slice(0, 500)}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { images: saved } };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `GenerateImage failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
    },
  };
}
