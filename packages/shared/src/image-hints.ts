/**
 * 图片附件发送前，pi 引擎可能自动缩放/转换图片，并把坐标映射提示追加到用户文本中。
 * 这些提示属于模型上下文，不应作为用户正文展示；模型上下文仍保留原文，这里只做 UI/远程展示剥离。
 */

const IMAGE_PROCESSING_HINT_LINE =
  /^\[(?:Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+(?:\.\d+)? to map to original image\.|Image converted from .+ to .+\.)\]$/;

/** 去掉引擎追加的图片缩放/格式转换提示；其他内容保持原样。 */
export function stripImageProcessingHints(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !IMAGE_PROCESSING_HINT_LINE.test(line.trim()))
    .join("\n")
    .trim();
}
