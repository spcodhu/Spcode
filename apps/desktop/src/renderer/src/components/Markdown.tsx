/**
 * 统一的 Markdown 渲染（Codex 简约风：无表格悬浮按钮/内滚动）。
 * 供消息区（MessageItem）与输入框 Markdown 预览（Composer）共用。
 *
 * 语法高亮插件（shiki）。模块级单例，避免每次渲染重建 highlighter。
 * 双主题都钉成 github-dark：Tailwind 不扫描 node_modules，streamdown 的 dark: 变体类全部失效，
 * 若保留默认 github-light 基色，暗色界面上代码会被刷成浅色主题的灰白。
 *
 * 评审 N3：SHIKI_THEME 是当前唯一的主题耦合点。将来支持浅色主题（CustomTheme.base: "light"）
 * 时，这里要随主题切换高亮方案（重建插件并触发重渲染），CustomTheme 类型处有互指注释。
 */
import { createCodePlugin } from "@streamdown/code";
import { Streamdown } from "streamdown";

const SHIKI_THEME: "github-dark" = "github-dark";
const codePlugin = createCodePlugin({ themes: [SHIKI_THEME, SHIKI_THEME] });

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md-body mb-2 text-sm leading-6">
      <Streamdown
        controls={{ table: false, mermaid: false, code: { copy: true, download: false } }}
        tableMaxHeight={0}
        shikiTheme={[SHIKI_THEME, SHIKI_THEME]}
        plugins={{ code: codePlugin }}
      >
        {text}
      </Streamdown>
    </div>
  );
}
