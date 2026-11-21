/**
 * 生图画廊：GenerateImage 工具落盘的图片在消息流里直接展示（不藏在折叠的工具步骤里）。
 * 位图经 readWorkspaceImage 读取（主进程工作区路径守卫，与 Markdown 本地图同边界）；
 * 点击进灯箱放大，右键走统一原生图片菜单（复制/另存为/打开）。
 */

import type { ImageAttachment } from "@spcode/shared";
import { baseName } from "@spcode/shared";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openImageContextMenu } from "../image-actions";
import { type GeneratedImageRef, useStore } from "../store";
import { Icon } from "./Icon";
import { ImageGenProgress } from "./ImageGenProgress";
import { ImageLightbox } from "./ImageLightbox";

export interface PendingGeneratedImage {
  id: string;
}

export function GeneratedImageGallery({
  images,
  pending = [],
}: {
  images: GeneratedImageRef[];
  /** 正在执行的 GenerateImage 调用；并行调用各自展示一张等待卡片 */
  pending?: PendingGeneratedImage[];
}) {
  const sessionId = useStore((s) => s.activeSessionId);
  const { t } = useTranslation("chat");
  const [loaded, setLoaded] = useState<Record<string, ImageAttachment>>({});
  const [failed, setFailed] = useState<Record<string, true>>({});
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);

  const onLoad = useCallback((path: string, image: ImageAttachment) => {
    setLoaded((m) => ({ ...m, [path]: image }));
  }, []);
  const onFail = useCallback((path: string) => {
    setFailed((m) => ({ ...m, [path]: true }));
  }, []);

  // 灯箱序列 = 已成功加载的图（按原顺序）；点击卡片时按“前面有几张已加载”换算下标
  const lightboxImages = images.flatMap((ref) => {
    const img = loaded[ref.path];
    return img ? [img] : [];
  });
  const openPreview = (path: string) => {
    if (!loaded[path]) return;
    let idx = 0;
    for (const ref of images) {
      if (ref.path === path) break;
      if (loaded[ref.path]) idx++;
    }
    setPreviewIdx(idx);
  };

  if (images.length === 0 && pending.length === 0) return null;
  return (
    <div className="my-3 flex flex-wrap gap-2.5" data-testid="generated-images">
      {pending.map((call) => (
        <ImageGenProgress
          key={call.id}
          title={t("imageGen.generating")}
          testId="generated-image-progress"
          variant="card"
        />
      ))}
      {images.map((ref) => (
        <GeneratedImageCard
          key={ref.path}
          refImage={ref}
          sessionId={sessionId}
          image={loaded[ref.path]}
          failed={!!failed[ref.path]}
          onLoad={onLoad}
          onFail={onFail}
          onPreview={openPreview}
        />
      ))}
      {previewIdx !== null && lightboxImages.length > 0 && (
        <ImageLightbox
          images={lightboxImages}
          index={Math.min(previewIdx, lightboxImages.length - 1)}
          onClose={() => setPreviewIdx(null)}
          onNavigate={setPreviewIdx}
        />
      )}
    </div>
  );
}

function GeneratedImageCard({
  refImage,
  sessionId,
  image,
  failed,
  onLoad,
  onFail,
  onPreview,
}: {
  refImage: GeneratedImageRef;
  sessionId: string | null;
  image?: ImageAttachment;
  failed: boolean;
  onLoad: (path: string, image: ImageAttachment) => void;
  onFail: (path: string) => void;
  onPreview: (path: string) => void;
}) {
  const { t } = useTranslation("chat");
  const name = baseName(refImage.path);

  useEffect(() => {
    if (image || failed || !sessionId) return;
    let alive = true;
    void window.spcode
      .readWorkspaceImage(refImage.path, sessionId)
      .then((result) => {
        if (alive) onLoad(refImage.path, { name, mimeType: result.mimeType, data: result.data });
      })
      .catch(() => {
        if (alive) onFail(refImage.path);
      });
    return () => {
      alive = false;
    };
  }, [refImage.path, sessionId, image, failed, name, onLoad, onFail]);

  if (failed) {
    return (
      <span
        data-testid="generated-image-error"
        title={refImage.path}
        className="flex items-center gap-2 rounded-xl border border-border bg-bg-elevated px-3 py-2 text-[12px] text-text-tertiary"
      >
        <Icon name="alert" size={14} className="shrink-0 text-danger/70" />
        <span>
          {t("imageGen.loadFailed")}：{name}
        </span>
      </span>
    );
  }

  if (!image) {
    return (
      <span
        data-testid="generated-image-loading"
        role="status"
        aria-label={t("imageGen.loading")}
        className="flex h-44 w-52 items-center justify-center rounded-xl border border-border bg-bg-elevated text-text-tertiary"
      >
        <Icon name="image" size={22} className="animate-pulse" />
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid="generated-image"
      data-path={refImage.path}
      title={t("imageGen.viewLarge")}
      onClick={() => onPreview(refImage.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void openImageContextMenu(image);
      }}
      className="group overflow-hidden rounded-xl border border-border bg-bg-elevated p-1.5 text-left transition-all hover:border-accent/40 hover:shadow-md"
    >
      <img
        src={`data:${image.mimeType};base64,${image.data}`}
        alt={name}
        className="h-44 w-auto max-w-[300px] rounded-lg object-cover"
      />
      <span className="mt-1 flex items-center gap-1 px-0.5 text-[11px] text-text-tertiary">
        <Icon name="image" size={11} className="shrink-0" />
        <span className="max-w-52 truncate">{name}</span>
      </span>
    </button>
  );
}
