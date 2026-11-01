/** 图片预览灯箱：多图切换、缩放/拖动、原生右键菜单；浮层行为复用统一 Modal。 */

import type { ImageAttachment } from "@spcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openImageContextMenu } from "../image-actions";
import { Icon } from "./Icon";
import { Modal } from "./ui/Modal";

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

function clampScale(value: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
}

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
  const { t } = useTranslation("chat");
  const current = images[index];
  const total = images.length;
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | null>(null);

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    dragRef.current = null;
    setDragging(false);
  }, []);
  const zoomBy = useCallback((factor: number) => {
    setScale((currentScale) => {
      const next = clampScale(currentScale * factor);
      if (next === 1) setOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  // 切图后从适应窗口重新开始，不把上一张的缩放与位移带过去。
  useEffect(() => {
    if (current) resetView();
  }, [current, resetView]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab" || event.isComposing) return;
      if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        event.stopPropagation();
        onNavigate(index - 1);
      } else if (event.key === "ArrowRight" && index < total - 1) {
        event.preventDefault();
        event.stopPropagation();
        onNavigate(index + 1);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        event.stopPropagation();
        zoomBy(1.25);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        event.stopPropagation();
        zoomBy(1 / 1.25);
      } else if (event.key === "0") {
        event.preventDefault();
        event.stopPropagation();
        resetView();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, total, onNavigate, resetView, zoomBy]);

  if (!current) return null;

  return (
    <Modal
      title={current.name}
      onClose={onClose}
      testId="image-lightbox"
      layerClassName="items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      panelClassName="relative flex h-[92vh] w-[96vw] items-center justify-center outline-none"
    >
      {/* 点击图像外的预览空白关闭；控制按钮和图片自身不会触发 */}
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("image.close")}
        className="absolute inset-0 cursor-default"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      />

      <button
        type="button"
        onClick={onClose}
        title={t("image.close")}
        aria-label={t("image.close")}
        data-testid="image-preview-close"
        data-modal-initial-focus
        className="absolute right-4 top-4 z-20 rounded-lg bg-black/35 p-2 text-white/75 transition-colors hover:bg-white/10 hover:text-white"
      >
        <Icon name="x" size={18} />
      </button>

      <button
        type="button"
        disabled={index === 0}
        onClick={() => onNavigate(index - 1)}
        title={t("image.previous")}
        aria-label={t("image.previous")}
        data-testid="image-preview-prev"
        className="absolute left-4 top-1/2 z-20 -translate-y-1/2 rounded-full bg-black/35 p-2.5 text-white/75 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-25"
      >
        <Icon name="chevronRight" size={20} style={{ transform: "rotate(180deg)" }} />
      </button>
      <button
        type="button"
        disabled={index >= total - 1}
        onClick={() => onNavigate(index + 1)}
        title={t("image.next")}
        aria-label={t("image.next")}
        data-testid="image-preview-next"
        className="absolute right-4 top-1/2 z-20 -translate-y-1/2 rounded-full bg-black/35 p-2.5 text-white/75 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-25"
      >
        <Icon name="chevronRight" size={20} />
      </button>

      <img
        src={`data:${current.mimeType};base64,${current.data}`}
        alt={current.name}
        data-testid="image-preview-image"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void openImageContextMenu(current);
        }}
        onWheel={(event) => {
          event.preventDefault();
          zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
        }}
        onPointerDown={(event) => {
          if (scale === 1) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            originX: offset.x,
            originY: offset.y,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setOffset({ x: drag.originX + event.clientX - drag.x, y: drag.originY + event.clientY - drag.y });
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
            setDragging(false);
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDragging(false);
        }}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transition: dragging ? "none" : "transform 120ms ease-out",
        }}
        className={`relative z-10 max-h-[82vh] max-w-[88vw] rounded-xl object-contain shadow-2xl ${
          scale > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"
        }`}
      />

      <div className="absolute bottom-20 left-1/2 z-20 max-w-[80vw] -translate-x-1/2 truncate rounded-full bg-black/50 px-3.5 py-1.5 text-[12px] text-white/80">
        {total > 1 ? t("image.caption", { name: current.name, index: index + 1, total }) : current.name}
      </div>

      <div className="absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-black/55 p-1 text-white/80 shadow-lg">
        <button
          type="button"
          onClick={() => zoomBy(1 / 1.25)}
          disabled={scale <= MIN_SCALE}
          title={t("image.zoomOut")}
          aria-label={t("image.zoomOut")}
          data-testid="image-preview-zoom-out"
          className="rounded-full p-2 transition-colors hover:bg-white/10 disabled:opacity-30"
        >
          <Icon name="minus" size={16} />
        </button>
        <button
          type="button"
          onClick={resetView}
          title={t("image.resetZoom")}
          aria-label={t("image.resetZoom")}
          data-testid="image-preview-zoom-reset"
          className="mono min-w-14 rounded-full px-2 py-1 text-[11px] tabular-nums transition-colors hover:bg-white/10"
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          onClick={() => zoomBy(1.25)}
          disabled={scale >= MAX_SCALE}
          title={t("image.zoomIn")}
          aria-label={t("image.zoomIn")}
          data-testid="image-preview-zoom-in"
          className="rounded-full p-2 transition-colors hover:bg-white/10 disabled:opacity-30"
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
    </Modal>
  );
}
