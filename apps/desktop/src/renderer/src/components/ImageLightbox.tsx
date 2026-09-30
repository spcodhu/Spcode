/** 图片预览灯箱：点击缩略图放大查看，支持多图左右切换、Esc/点击外部关闭 */

import type { ImageAttachment } from "@spcode/shared";
import { useEffect } from "react";
import { Icon } from "./Icon";

export function ImageLightbox({
  images,
  index,
  onClose,
  onNavigate,
}: {
  images: ImageAttachment[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const current = images[index];
  const total = images.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onNavigate(index - 1);
      else if (e.key === "ArrowRight" && index < total - 1) onNavigate(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, total, onClose, onNavigate]);

  if (!current) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      {/* 点击背板关闭：用真 button 承载（a11y），视觉上是全屏透明层，内容元素在其后声明、自然盖在上层 */}
      <button type="button" aria-label="关闭预览" className="absolute inset-0 cursor-default" onClick={onClose} />
      {/* 关闭 */}
      <button
        type="button"
        onClick={onClose}
        title="关闭预览"
        className="absolute right-4 top-4 rounded-lg p-2 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      >
        <Icon name="x" size={18} />
      </button>

      {/* 左右切换（多图时） */}
      {index > 0 && (
        <button
          type="button"
          onClick={() => onNavigate(index - 1)}
          title="上一张"
          className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full p-2.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <Icon name="chevronRight" size={20} style={{ transform: "rotate(180deg)" }} />
        </button>
      )}
      {index < total - 1 && (
        <button
          type="button"
          onClick={() => onNavigate(index + 1)}
          title="下一张"
          className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-2.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <Icon name="chevronRight" size={20} />
        </button>
      )}

      <img
        src={`data:${current.mimeType};base64,${current.data}`}
        alt={current.name}
        className="relative max-h-[86vh] max-w-[92vw] rounded-xl object-contain shadow-2xl"
      />

      {/* 底部文件名 + 序号 */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3.5 py-1.5 text-[12px] text-white/80">
        {current.name}
        {total > 1 ? `（${index + 1}/${total}）` : ""}
      </div>
    </div>
  );
}
