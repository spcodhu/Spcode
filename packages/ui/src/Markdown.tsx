/**
 * 双端统一的 Markdown 渲染：Streamdown + Shiki + KaTeX + Mermaid。
 * 数学与 Mermaid 按需加载；Plan 文件等桌面专有动作通过 renderPlanLink 适配。
 */

import type { ThemeBase } from "@spcode/shared/theme";
import { createCodePlugin } from "@streamdown/code";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type PluginConfig, Streamdown, type StreamdownTranslations } from "streamdown";
import { hasMathSyntax, hasMermaidSyntax } from "./md-detect";
import { splitPlanLinks } from "./plan-links";

const SHIKI_THEMES = { dark: "github-dark", light: "github-light" } as const;
const codePlugins: Partial<Record<ThemeBase, PluginConfig["code"]>> = {};
function getCodePlugin(base: ThemeBase): PluginConfig["code"] {
  const theme = SHIKI_THEMES[base];
  codePlugins[base] ??= createCodePlugin({ themes: [theme, theme] });
  return codePlugins[base];
}

let mathPluginPromise: Promise<PluginConfig["math"] | null> | null = null;
const mermaidPluginPromises: Partial<Record<ThemeBase, Promise<PluginConfig["mermaid"] | null> | null>> = {};

function loadMathPlugin(): Promise<PluginConfig["math"] | null> {
  mathPluginPromise ??= import("@streamdown/math")
    .then(({ createMathPlugin }) => createMathPlugin({ singleDollarTextMath: true }))
    .catch(() => {
      mathPluginPromise = null;
      return null;
    });
  return mathPluginPromise;
}

function loadMermaidPlugin(base: ThemeBase): Promise<PluginConfig["mermaid"] | null> {
  mermaidPluginPromises[base] ??= import("@streamdown/mermaid")
    .then(({ createMermaidPlugin }) =>
      createMermaidPlugin({ config: { theme: base === "light" ? "default" : "dark" } }),
    )
    .catch(() => {
      mermaidPluginPromises[base] = null;
      return null;
    });
  return mermaidPluginPromises[base]!;
}

export interface MarkdownPlanLink {
  key: string;
  path: string;
  label: string;
}

export interface MarkdownProps {
  text: string;
  themeBase?: ThemeBase;
  /** 桌面可注入本机 Plan 文件打开卡；缺省仅展示同样式文本，不伪造文件动作。 */
  renderPlanLink?: (link: MarkdownPlanLink) => ReactNode;
}

export function Markdown({ text, themeBase = "light", renderPlanLink }: MarkdownProps) {
  const { t } = useTranslation("chat");
  const translations = useMemo(
    () =>
      ({
        close: t("markdown.close"),
        copied: t("markdown.copied"),
        copyCode: t("markdown.copyCode"),
        copyLink: t("markdown.copyLink"),
        copyTable: t("markdown.copyTable"),
        copyTableAsCsv: t("markdown.copyTableAsCsv"),
        copyTableAsMarkdown: t("markdown.copyTableAsMarkdown"),
        copyTableAsTsv: t("markdown.copyTableAsTsv"),
        downloadDiagram: t("markdown.downloadDiagram"),
        downloadDiagramAsMmd: t("markdown.downloadDiagramAsMmd"),
        downloadDiagramAsPng: t("markdown.downloadDiagramAsPng"),
        downloadDiagramAsSvg: t("markdown.downloadDiagramAsSvg"),
        downloadFile: t("markdown.downloadFile"),
        downloadImage: t("markdown.downloadImage"),
        downloadTable: t("markdown.downloadTable"),
        downloadTableAsCsv: t("markdown.downloadTableAsCsv"),
        downloadTableAsMarkdown: t("markdown.downloadTableAsMarkdown"),
        exitFullscreen: t("markdown.exitFullscreen"),
        externalLinkWarning: t("markdown.externalLinkWarning"),
        imageNotAvailable: t("markdown.imageNotAvailable"),
        mermaidFormatMmd: t("markdown.mermaidFormatMmd"),
        mermaidFormatPng: t("markdown.mermaidFormatPng"),
        mermaidFormatSvg: t("markdown.mermaidFormatSvg"),
        openExternalLink: t("markdown.openExternalLink"),
        openLink: t("markdown.openLink"),
        resetView: t("markdown.resetView"),
        tableFormatCsv: t("markdown.tableFormatCsv"),
        tableFormatMarkdown: t("markdown.tableFormatMarkdown"),
        tableFormatTsv: t("markdown.tableFormatTsv"),
        viewFullscreen: t("markdown.viewFullscreen"),
        zoomIn: t("markdown.zoomIn"),
        zoomOut: t("markdown.zoomOut"),
      }) satisfies StreamdownTranslations,
    [t],
  );
  const [mathPlugin, setMathPlugin] = useState<PluginConfig["math"] | undefined>(undefined);
  const [mermaidPlugin, setMermaidPlugin] = useState<PluginConfig["mermaid"] | undefined>(undefined);
  const needMath = hasMathSyntax(text);
  const needMermaid = hasMermaidSyntax(text);

  useEffect(() => {
    if (!needMath || mathPlugin) return;
    let alive = true;
    void loadMathPlugin().then((p) => {
      if (alive && p) setMathPlugin(p);
    });
    return () => {
      alive = false;
    };
  }, [needMath, mathPlugin]);

  useEffect(() => {
    if (!needMermaid) return;
    let alive = true;
    void loadMermaidPlugin(themeBase).then((p) => {
      if (alive && p) setMermaidPlugin(p);
    });
    return () => {
      alive = false;
    };
  }, [needMermaid, themeBase]);

  const plugins = useMemo<PluginConfig>(
    () => ({
      code: getCodePlugin(themeBase),
      ...(mathPlugin ? { math: mathPlugin } : {}),
      ...(mermaidPlugin ? { mermaid: mermaidPlugin } : {}),
    }),
    [mathPlugin, mermaidPlugin, themeBase],
  );

  const contentParts = useMemo(() => splitPlanLinks(text), [text]);

  return (
    <div className="md-body mb-2 text-sm leading-6" data-testid="markdown-body">
      {contentParts.map((part) =>
        part.kind === "plan" ? (
          renderPlanLink ? (
            renderPlanLink(part)
          ) : (
            <span key={part.key} className="md-plan-link" title={part.path}>
              {part.label}
            </span>
          )
        ) : (
          <Streamdown
            key={part.key}
            translations={translations}
            controls={{
              table: false,
              mermaid: { download: false, copy: false, fullscreen: false, panZoom: false },
              code: { copy: true, download: false },
            }}
            tableMaxHeight={0}
            shikiTheme={[SHIKI_THEMES[themeBase], SHIKI_THEMES[themeBase]]}
            plugins={plugins}
          >
            {part.text}
          </Streamdown>
        ),
      )}
    </div>
  );
}
