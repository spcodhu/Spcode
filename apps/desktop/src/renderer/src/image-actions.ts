import type { ImageAttachment } from "@spcode/shared";
import { i18n } from "@spcode/shared/i18n";
import { useStore } from "./store";

/** 统一处理原生图片菜单结果：取消保持安静，成功轻提示，失败展示真实原因。 */
export async function openImageContextMenu(image: ImageAttachment): Promise<void> {
  try {
    const result = await window.spcode.showImageContextMenu(image);
    if (result.type === "cancelled") return;
    const key = result.type === "copied" ? "image.copied" : result.type === "saved" ? "image.saved" : "image.opened";
    useStore.setState({ notice: { text: i18n.t(`chat:${key}`), tone: "success" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useStore.setState({ lastError: i18n.t("chat:image.failed", { message }) });
  }
}
