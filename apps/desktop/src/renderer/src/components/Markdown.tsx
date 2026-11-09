/** 桌面 Markdown 适配：共享渲染器 + 本机计划/工作区文件动作。 */
import { Markdown as SharedMarkdown } from "@spcode/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { resolveThemeBase } from "../theme";
import { Icon } from "./Icon";
import { WorkspaceFileLink } from "./WorkspaceFileLink";

export function Markdown({ text, workspaceDocumentPath }: { text: string; workspaceDocumentPath?: string }) {
  const themeBase = useStore((s) => resolveThemeBase(s.settings));
  return (
    <SharedMarkdown
      text={text}
      themeBase={themeBase}
      renderPlanLink={({ key, path, label }) => <WorkspaceFileLink key={key} path={path} label={label} kind="plan" />}
      renderFileLink={({ key, path, label }) => <WorkspaceFileLink key={key} path={path} label={label} kind="file" />}
      renderImage={
        workspaceDocumentPath
          ? ({ key, path, label }) => (
              <WorkspaceMarkdownImage key={key} path={path} label={label} documentPath={workspaceDocumentPath} />
            )
          : undefined
      }
    />
  );
}

/** 工作区 Markdown 的本地图片：不开放 file://，由主进程校验后只把位图数据交给 img。 */
function WorkspaceMarkdownImage({ path, label, documentPath }: { path: string; label: string; documentPath: string }) {
  const { t } = useTranslation("chat");
  const sessionId = useStore((s) => s.activeSessionId);
  const [image, setImage] = useState<{ mimeType: string; data: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setImage(null);
    setFailed(false);
    if (!sessionId) return () => {};
    void window.spcode
      .readWorkspaceImage(path, sessionId, documentPath)
      .then((result) => {
        if (alive) setImage(result);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [path, sessionId, documentPath]);

  if (failed) {
    return (
      <span
        data-testid="workspace-image-error"
        title={path}
        className="my-3 flex items-center gap-2 rounded-xl border border-border bg-bg-elevated px-3 py-2 text-[12px] text-text-tertiary"
      >
        <Icon name="image" size={14} className="shrink-0" />
        <span>
          {t("markdown.imageNotAvailable")}
          {label ? `：${label}` : ""}
        </span>
      </span>
    );
  }
  if (!image) {
    return (
      <span
        data-testid="workspace-image-loading"
        role="status"
        aria-label={label || t("markdown.imageNotAvailable")}
        className="my-3 flex h-24 items-center justify-center rounded-xl border border-border bg-bg-elevated text-text-tertiary"
      >
        <Icon name="image" size={20} className="animate-pulse" />
      </span>
    );
  }
  return (
    <img
      data-testid="workspace-markdown-image"
      src={`data:${image.mimeType};base64,${image.data}`}
      alt={label}
      title={path}
      loading="lazy"
      className="my-3 block max-h-[520px] max-w-full rounded-xl border border-border object-contain"
    />
  );
}
