import { describe, expect, it } from "vitest";
import { decodeImageAttachment, safeImageFileName } from "../src/main/image-file.js";

const signatures = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/gif": [...Buffer.from("GIF89a", "ascii")],
  "image/webp": [...Buffer.from("RIFF0000WEBP", "ascii")],
  "image/bmp": [...Buffer.from("BM00", "ascii")],
} as const;

function attachment(mimeType: keyof typeof signatures, bytes: readonly number[]) {
  return { name: "test", mimeType, data: Buffer.from(bytes).toString("base64") };
}

describe("safeImageFileName", () => {
  it("清理路径和非法字符，并按真实 MIME 补扩展名", () => {
    expect(safeImageFileName("..\\bad:name*.png", "image/png")).toBe("bad_name_.png");
    expect(safeImageFileName("photo.exe", "image/png")).toBe("photo.png");
    expect(safeImageFileName("photo.jpeg", "image/jpeg")).toBe("photo.jpeg");
    expect(safeImageFileName("CON", "image/png")).toBe("_CON.png");
    expect(safeImageFileName("", "image/png")).toBe("image.png");
  });
});

describe("decodeImageAttachment", () => {
  it("接受应用支持的五种位图签名并保留原始字节", () => {
    for (const [mime, signature] of Object.entries(signatures)) {
      const decoded = decodeImageAttachment(attachment(mime as keyof typeof signatures, signature));
      expect(decoded.mimeType).toBe(mime);
      expect(decoded.bytes).toEqual(Buffer.from(signature));
      expect(decoded.name).toBe(`test.${mime === "image/jpeg" ? "jpg" : mime.split("/")[1]}`);
    }
  });

  it("拒绝伪造 MIME、非法 base64、空数据和签名不匹配", () => {
    expect(() => decodeImageAttachment({ name: "x", mimeType: "image/svg+xml", data: "AAAA" })).toThrow();
    expect(() => decodeImageAttachment({ name: "x", mimeType: "image/png", data: "not base64!" })).toThrow();
    expect(() => decodeImageAttachment({ name: "x", mimeType: "image/png", data: "" })).toThrow();
    expect(() => decodeImageAttachment(attachment("image/png", signatures["image/jpeg"]))).toThrow(
      "Image signature does not match MIME type",
    );
  });
});
