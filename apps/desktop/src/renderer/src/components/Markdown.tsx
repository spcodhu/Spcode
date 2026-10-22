/**
 * 统一的 Markdown 渲染（Codex 简约风：无表格悬浮按钮/内滚动）。
 * 供消息区（MessageItem）与输入框 Markdown 预览（Composer）共用。
 *
 * 插件：
 * - code：shiki 语法高亮，模块级单例避免每次渲染重建 highlighter。
 *   双主题都钉成 github-dark：Tailwind 不扫描 node_modules，streamdown 的 dark: 变体类全部失效，
 *   若保留默认 github-light 基色，暗色界面上代码会被刷成浅色主题的灰白。
 * - math：KaTeX 公式（remark-math + rehype-katex），singleDollarTextMath 打开以支持 $x$ 行内公式。
 * - mermaid：流程图/时序图渲染，主题钉 dark（与代码高亮同理，界面是深色）。
 *
 * 体积策略：mermaid（~1.5MB）与 katex 走**动态 import + 内容按需**——
 * 首屏 bundle 不背这两个大依赖；只有内容里真的出现 ```mermaid / 公式语法时才拉 chunk，
 * 加载完成前对应语法短暂降级为普通代码块/原文，加载后自动重渲染成图/公式。
 *
 * 评审 N3：SHIKI_THEME 是当前唯一的主题耦合点。将来支持浅色主题（CustomTheme.base: "light"）
 * 时，这里要随主题切换高亮方案（重建插件并触发重渲染），CustomTheme 类型处有互指注释。
 */
import { createCodePlugin } from "@streamdown/code";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type PluginConfig, Streamdown, type StreamdownTranslations } from "streamdown";
import { hasMathSyntax, hasMermaidSyntax } from "../md-detect";

const SHIKI_THEME: "github-dark" = "github-dark";
const codePlugin = createCodePlugin({ themes: [SHIKI_THEME, SHIKI_THEME] });

/**
 * 插件动态加载的模块级单例：一次加载、所有 Markdown 实例共享。
 * 失败时清空 promise，下次内容变化可重试。
 */
let mathPluginPromise: Promise<PluginConfig["math"] | null> | null = null;
let mermaidPluginPromise: Promise<PluginConfig["mermaid"] | null> | null = null;

function loadMathPlugin(): Promise<PluginConfig["math"] | null> {
  mathPluginPromise ??= import("@streamdown/math")
    .then(({ createMathPlugin }) => createMathPlugin({ singleDollarTextMath: true }))
    .catch(() => {
      mathPluginPromise = null;
      return null;
    });
  return mathPluginPromise;
}

function loadMermaidPlugin(): Promise<PluginConfig["mermaid"] | null> {
  mermaidPluginPromise ??= import("@streamdown/mermaid")
    .then(({ createMermaidPlugin }) => createMermaidPlugin({ config: { theme: "dark" } }))
    .catch(() => {
      mermaidPluginPromise = null;
      return null;
    });
  return mermaidPluginPromise;
}

export function Markdown({ text }: { text: string }) {
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

  // 按需拉取公式插件（首次命中公式语法时）
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

  // 按需拉取 mermaid 插件（首次命中 ```mermaid 时）
  useEffect(() => {
    if (!needMermaid || mermaidPlugin) return;
    let alive = true;
    void loadMermaidPlugin().then((p) => {
      if (alive && p) setMermaidPlugin(p);
    });
    return () => {
      alive = false;
    };
  }, [needMermaid, mermaidPlugin]);

  const plugins = useMemo<PluginConfig>(
    () => ({
      code: codePlugin,
      ...(mathPlugin ? { math: mathPlugin } : {}),
      ...(mermaidPlugin ? { mermaid: mermaidPlugin } : {}),
    }),
    [mathPlugin, mermaidPlugin],
  );

  return (
    <div className="md-body mb-2 text-sm leading-6">
      <Streamdown
        translations={translations}
        controls={{
          table: false,
          mermaid: { download: false, copy: false, fullscreen: false, panZoom: false },
          code: { copy: true, download: false },
        }}
        tableMaxHeight={0}
        shikiTheme={[SHIKI_THEME, SHIKI_THEME]}
        plugins={plugins}
      >
        {text}
      </Streamdown>
    </div>
  );
}
