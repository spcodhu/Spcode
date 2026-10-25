import type { ImageAttachment } from "@spcode/shared";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;
const MIME_EXTENSIONS: Record<string, string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/bmp": ["bmp"],
};

export interface DecodedImage {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

/** 附件名只取最后一段，并按真实 MIME 选择扩展名；同时处理 Windows 保留字符。 */
export function safeImageFileName(rawName: unknown, mimeType: string): string {
  const tail = (typeof rawName === "string" ? rawName : "").split(/[\\/]/).pop() ?? "";
  const cleaned = Array.from(tail, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 || '<>:"/\\|?*'.includes(char) ? "_" : char;
  })
    .join("")
    .trim()
    .replace(/[. ]+$/g, "");
  const parts = cleaned.split(".");
  const currentExt = parts.length > 1 ? (parts.pop()?.toLowerCase() ?? "") : "";
  const allowed = MIME_EXTENSIONS[mimeType] ?? ["png"];
  const extension = allowed.includes(currentExt) ? currentExt : allowed[0]!;
  let stem = parts
    .join(".")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 96);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
  return `${stem || "image"}.${extension}`;
}

function hasExpectedSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= 8 && signature.every((value, index) => bytes[index] === value);
  }
  if (mimeType === "image/jpeg")
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/gif")
    return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6));
  if (mimeType === "image/webp") {
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  }
  if (mimeType === "image/bmp") return bytes.length >= 2 && bytes.toString("ascii", 0, 2) === "BM";
  return false;
}

/** 只接受应用本就能选取的位图格式；拒绝伪造 MIME、异常 base64 和超限数据。 */
export function decodeImageAttachment(raw: ImageAttachment): DecodedImage {
  const mimeType = typeof raw?.mimeType === "string" ? raw.mimeType.trim().toLowerCase() : "";
  if (!(mimeType in MIME_EXTENSIONS)) throw new Error("Unsupported image MIME type");
  if (typeof raw?.data !== "string" || raw.data.length === 0 || raw.data.length > MAX_BASE64_CHARS) {
    throw new Error("Invalid image data length");
  }
  if (raw.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data)) {
    throw new Error("Invalid image base64 data");
  }
  const bytes = Buffer.from(raw.data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds size limit");
  if (!hasExpectedSignature(bytes, mimeType)) throw new Error("Image signature does not match MIME type");
  return {
    name: safeImageFileName(raw.name, mimeType),
    mimeType,
    bytes,
  };
}
