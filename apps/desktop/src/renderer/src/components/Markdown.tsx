/**
 * 统一的 Markdown 渲染（Codex 简约风：无表格悬浮按钮/内滚动）。
 * 供消息区（MessageItem）与输入框 Markdown 预览（Composer）共用。
 *
 * 插件：
 * - code：shiki 语法高亮，按 CustomTheme.base 缓存 dark/light 两套插件。
 *   Tailwind 不扫描 node_modules，streamdown 的 dark: 变体类全部失效，
 *   所以必须显式给当前主题，而不能依赖 CSS dark: 选择器。
 * - math：KaTeX 公式（remark-math + rehype-katex），singleDollarTextMath 打开以支持 $x$ 行内公式。
 * - mermaid：流程图/时序图渲染，dark 使用 dark、light 使用 default。
 *
 * 体积策略：mermaid（~1.5MB）与 katex 走**动态 import + 内容按需**——
 * 首屏 bundle 不背这两个大依赖；只有内容里真的出现 ```mermaid / 公式语法时才拉 chunk，
 * 加载完成前对应语法短暂降级为普通代码块/原文，加载后自动重渲染成图/公式。
 *
 * 主题策略：CustomTheme.base 同时驱动 Shiki、Mermaid 与 document.colorScheme；
 * 两套插件按 base 缓存，切主题只替换对应插件，不重复加载数学插件。
 */
import { createCodePlugin } from "@streamdown/code";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type PluginConfig, Streamdown, type StreamdownTranslations } from "streamdown";
import { hasMathSyntax, hasMermaidSyntax } from "../md-detect";
import { useStore } from "../store";

type ThemeBase = "dark" | "light";
const SHIKI_THEMES = { dark: "github-dark", light: "github-light" } as const;
const codePlugins: Partial<Record<ThemeBase, PluginConfig["code"]>> = {};
function getCodePlugin(base: ThemeBase): PluginConfig["code"] {
  const theme = SHIKI_THEMES[base];
  codePlugins[base] ??= createCodePlugin({ themes: [theme, theme] });
  return codePlugins[base];
}

/**
 * 插件动态加载的模块级单例：一次加载、所有 Markdown 实例共享。
 * 失败时清空 promise，下次内容变化可重试。
 */
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

export function Markdown({ text }: { text: string }) {
  const { t } = useTranslation("chat");
  const themeBase = useStore((s) => s.settings?.customTheme?.base ?? "dark");
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

  // 按需拉取与当前主题匹配的 mermaid 插件；切换主题时重新获取对应缓存。
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
        shikiTheme={[SHIKI_THEMES[themeBase], SHIKI_THEMES[themeBase]]}
        plugins={plugins}
      >
        {text}
      </Streamdown>
    </div>
  );
}
