/**
 * Markdown 编辑器工具栏（博客编辑器风格）：
 * 左侧字形/标题/块/代码/插入/历史 动作，右端「编辑 · 分屏 · 预览」三态切换 + 退出长文本输入。
 *
 * 纯展示组件：动作经 onAction 回传给 MdEditor.applyAction；图片走 Composer 的附件通道。
 */
import { Icon } from "./Icon";
import type { MdAction } from "./MdEditor";

/** Markdown 输入区的呈现模式 */
export type MdView = "edit" | "split" | "preview";

/** 三态切换的分段控件（编辑/分屏/预览）。工具栏内控件：用 bg-main 底、不浮阴影 */
export function MdViewSwitch({ view, onChange }: { view: MdView; onChange: (v: MdView) => void }) {
  return (
    <div className="flex shrink-0 items-center rounded-full bg-bg-main p-0.5 text-[11px] font-medium">
      {VIEWS.map((v) => (
        <button
          key={v.value}
          type="button"
          data-testid={`md-view-${v.value}`}
          onClick={() => onChange(v.value)}
          className={`rounded-full px-2 py-[2px] transition-colors ${
            view === v.value ? "bg-accent-soft text-accent" : "text-text-tertiary hover:text-text-secondary"
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

interface ToolItem {
  /** 唯一 key（用于 React key 与 testid） */
  key: string;
  /** 编辑器动作（缺省 = 图片通道） */
  action?: MdAction;
  /** 走 Composer 的图片附件通道（内嵌到光标处） */
  pickImage?: boolean;
  icon?: string;
  /** 文字按钮（A+ / A- / Σ / 1.） */
  text?: string;
  title: string;
}

/** 分组按钮表：组间渲染竖线分隔（对齐常见博客编辑器的心智） */
const GROUPS: ToolItem[][] = [
  [
    { key: "bold", action: "bold", icon: "bold", title: "加粗 **text**" },
    { key: "italic", action: "italic", icon: "italic", title: "斜体 *text*" },
    { key: "underline", action: "underline", icon: "underline", title: "下划线 <u>text</u>" },
    { key: "strike", action: "strike", icon: "strike", title: "删除线 ~~text~~" },
  ],
  [
    { key: "heading", action: "heading", icon: "heading", title: "标题（循环 H2→H3→H4→取消）" },
    { key: "heading-up", action: "heading-up", text: "A⁺", title: "标题升级" },
    { key: "heading-down", action: "heading-down", text: "A⁻", title: "标题降级" },
  ],
  [
    { key: "quote", action: "quote", icon: "quote", title: "引用 > " },
    { key: "ol", action: "ol", text: "1.", title: "有序列表 1. " },
    { key: "ul", action: "ul", icon: "list", title: "无序列表 - " },
  ],
  [
    { key: "code", action: "code", icon: "code", title: "行内代码 `code`" },
    { key: "code-block", action: "code-block", icon: "codeBlock", title: "代码块 ```" },
  ],
  [
    { key: "link", action: "link", icon: "link", title: "链接 [文字](url)" },
    { key: "image", pickImage: true, icon: "image", title: "图片（内嵌到光标处）" },
    { key: "table", action: "table", icon: "table", title: "表格" },
    { key: "mermaid", action: "mermaid", icon: "diagram", title: "流程图（Mermaid）" },
    { key: "math", action: "math", text: "Σ", title: "公式：选中=行内 $x$；无选中=公式块 $$…$$" },
  ],
  [
    { key: "undo", action: "undo", icon: "undo", title: "撤销" },
    { key: "redo", action: "redo", icon: "redo", title: "重做" },
  ],
];

const VIEWS: { value: MdView; label: string }[] = [
  { value: "edit", label: "编辑" },
  { value: "split", label: "分屏" },
  { value: "preview", label: "预览" },
];

export function MdToolbar({
  view,
  onViewChange,
  onExit,
  onAction,
  onPickImages,
}: {
  view: MdView;
  onViewChange: (v: MdView) => void;
  /** 退出长文本输入（回普通输入框） */
  onExit: () => void;
  onAction: (a: MdAction) => void;
  /** 图片按钮：走 Composer 的附件通道（内嵌到光标处） */
  onPickImages: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
      {/* 动作区：窄窗口下横向滚动（隐藏滚动条），右侧视图控制始终固定不挤 */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {GROUPS.map((group, gi) => (
          <div key={group[0]?.key ?? gi} className="flex shrink-0 items-center gap-0.5">
            {gi > 0 && <span className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />}
            {group.map((item) => (
              <button
                key={item.key}
                type="button"
                title={item.title}
                data-testid={`md-tool-${item.key}`}
                // mousedown 阻止默认：点工具栏不夺走编辑器选区/焦点
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => (item.pickImage ? onPickImages() : item.action && onAction(item.action))}
                className="flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                {item.icon ? (
                  <Icon name={item.icon} size={13} />
                ) : (
                  <span className="text-[11.5px] font-medium leading-none">{item.text}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* 右端：三态切换 + 退出长文本输入 */}
      <span className="h-3.5 w-px shrink-0 bg-border" />
      <MdViewSwitch view={view} onChange={onViewChange} />
      <button
        type="button"
        data-testid="md-mode-toggle"
        onClick={onExit}
        title="退出长文本输入（回到普通输入框）"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}
