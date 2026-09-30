import { useEffect, useState } from "react";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { ModelsPage } from "./ModelsPage";
import { QuotaPage } from "./QuotaPage";
import { UsagePage } from "./UsagePage";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";

type PageId = "general" | "appearance" | "models" | "usage" | "quota" | "memory" | "about";

const NAV: { id: PageId; label: string; icon: string }[] = [
  { id: "general", label: "通用", icon: "gear" },
  { id: "appearance", label: "外观", icon: "sun" },
  { id: "models", label: "模型", icon: "cpu" },
  { id: "usage", label: "用量", icon: "chart" },
  { id: "quota", label: "配额", icon: "gauge" },
  { id: "memory", label: "记忆", icon: "brain" },
  { id: "about", label: "关于", icon: "info" },
];

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState<PageId>("usage");

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        // 点击面板外部任意位置关闭
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-[720px] max-h-[86vh] w-[1100px] max-w-[92vw] overflow-hidden rounded-2xl border border-border-strong bg-bg-main shadow-2xl">
        {/* 左侧导航 */}
        <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-bg-sidebar">
          <div className="titlebar-drag flex h-12 items-center justify-center border-b border-border">
            <span className="text-[14px] font-semibold text-text-primary">设置</span>
          </div>
          <div className="flex-1 overflow-y-auto px-2 py-3">
            {NAV.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => setPage(item.id)}
                className={`mb-0.5 flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors ${
                  page === item.id ? "bg-accent text-white" : "text-text-secondary hover:bg-bg-hover"
                }`}
              >
                <Icon name={item.icon} size={15} />
                {item.label}
              </button>
            ))}
          </div>
          <div className="border-t border-border px-3 py-2 text-[11px] text-text-tertiary">Esc 或点击外部关闭</div>
        </nav>

        {/* 内容区 */}
        <div className="relative min-w-0 flex-1 overflow-y-auto">
          <button
            type="button"
            onClick={onClose}
            title="关闭设置"
            className="absolute right-4 top-3.5 rounded-lg p-1.5 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary"
          >
            <Icon name="x" size={16} />
          </button>
          <div className="mx-auto max-w-[760px] px-8 py-6">
            {page === "general" && <GeneralPage />}
            {page === "appearance" && <AppearancePage />}
            {page === "models" && <ModelsPage />}
            {page === "usage" && <UsagePage />}
            {page === "quota" && <QuotaPage />}
            {page === "memory" && <MemoryPage />}
            {page === "about" && <AboutPage />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

function GeneralPage() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);

  return (
    <div>
      <PageHeader title="通用" subtitle="权限模式、默认行为与更新" />
      <SectionTitle>权限模式</SectionTitle>
      <div className="flex gap-2">
        {(
          [
            { id: "ask", label: "询问模式", desc: "写操作与 Shell 每次确认" },
            { id: "act", label: "行动模式", desc: "仅危险命令确认" },
          ] as const
        ).map((m) => (
          <button
            type="button"
            key={m.id}
            onClick={() => void saveSettings({ permissionMode: m.id })}
            className={`flex-1 rounded-xl border px-4 py-3 text-left ${
              settings?.permissionMode === m.id ? "border-accent/50 bg-accent-soft" : "border-border hover:bg-bg-hover"
            }`}
          >
            <div
              className={`text-[14px] font-medium ${settings?.permissionMode === m.id ? "text-accent" : "text-text-primary"}`}
            >
              {m.label}
            </div>
            <div className="mt-0.5 text-[12px] text-text-tertiary">{m.desc}</div>
          </button>
        ))}
      </div>

      <SectionTitle>默认思考强度</SectionTitle>
      <Select
        value={settings?.defaultThinkingLevel ?? "medium"}
        options={["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((v) => ({ value: v }))}
        onChange={(v) => void saveSettings({ defaultThinkingLevel: v })}
        className="w-56"
      />

      <SectionTitle>记忆</SectionTitle>
      <div className="flex items-center justify-between rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">自动记忆蒸馏</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">
            每轮对话结束后自动整理长期记忆（会消耗少量 token）
          </div>
        </div>
        <Switch
          on={settings?.memoryDistill ?? true}
          onChange={(v) => void saveSettings({ memoryDistill: v })}
          label="自动记忆蒸馏"
        />
      </div>

      <SectionTitle>自动更新</SectionTitle>
      <div className="flex items-center justify-between rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">启动时检查更新</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">需要先在 updater.ts 配置 GitHub 更新源</div>
        </div>
        <Switch
          on={settings?.autoUpdate ?? true}
          onChange={(v) => void saveSettings({ autoUpdate: v })}
          label="自动更新"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 外观
// ---------------------------------------------------------------------------

function AppearancePage() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const [themeDesc, setThemeDesc] = useState("");
  const [generating, setGenerating] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const flash = (text: string) => {
    setHint(text);
    setTimeout(() => setHint(null), 3000);
  };

  const importTheme = async () => {
    const text = await window.spcode.pickThemeFile();
    if (!text) return;
    try {
      const { normalizeTheme } = await import("../theme.js");
      const theme = normalizeTheme(JSON.parse(text));
      if (!theme) return flash("主题文件格式不正确");
      await saveSettings({ customTheme: theme });
      flash(`已应用主题「${theme.name}」`);
    } catch {
      flash("主题文件不是有效 JSON");
    }
  };

  const generateTheme = async () => {
    const desc = themeDesc.trim();
    if (!desc || generating) return;
    setGenerating(true);
    try {
      // 评审 P2-5：显式带上默认模型，避免宿主误用可用列表首个（可能是最贵模型）
      const raw = await window.spcode.command({
        type: "theme.generate",
        payload: { description: desc, model: settings?.defaultModel ?? undefined },
      });
      const { normalizeTheme } = await import("../theme.js");
      const theme = normalizeTheme(raw);
      if (!theme) return flash("AI 返回的主题不完整，换个描述再试");
      await saveSettings({ customTheme: theme });
      flash(`已生成并应用「${theme.name}」`);
      setThemeDesc("");
    } catch (e) {
      flash(e instanceof Error ? e.message : "生成失败");
    } finally {
      setGenerating(false);
    }
  };

  const importFont = async (kind: "ui" | "mono") => {
    const picked = await window.spcode.pickFontFile();
    if (!picked) return;
    await saveSettings(
      kind === "ui"
        ? { uiFontFamily: picked.family, uiFontFile: picked.file }
        : { monoFontFamily: picked.family, monoFontFile: picked.file },
    );
    flash(`已导入字体 ${picked.family}`);
  };

  return (
    <div>
      <PageHeader title="外观" subtitle="主题与字体。支持导入主题 JSON、AI 生成主题、导入本地字体" />
      {hint && <div className="mb-3 rounded-lg bg-accent-soft px-3 py-2 text-[12px] text-accent">{hint}</div>}

      <SectionTitle>主题</SectionTitle>
      <div className="mb-3 flex items-center justify-between rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div className="text-[14px] text-text-primary">
          {settings?.customTheme ? `「${settings.customTheme.name}」（自定义）` : "雀羽 · 墨（默认暗色）"}
        </div>
        <div className="flex gap-2">
          {settings?.customTheme && (
            <button
              type="button"
              onClick={() => void saveSettings({ customTheme: null })}
              className="text-[12px] text-text-tertiary hover:text-danger"
            >
              恢复默认
            </button>
          )}
          <button type="button" onClick={() => void importTheme()} className="text-[12px] text-accent hover:underline">
            导入主题 JSON
          </button>
        </div>
      </div>
      <div className="flex gap-2">
        <input
          value={themeDesc}
          onChange={(e) => setThemeDesc(e.target.value)}
          placeholder="描述你想要的主题，如：深林墨绿、低对比护眼"
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] outline-none focus:border-accent/50"
          onKeyDown={(e) => {
            if (e.key === "Enter") void generateTheme();
          }}
        />
        <button
          type="button"
          onClick={() => void generateTheme()}
          disabled={!themeDesc.trim() || generating}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-[13px] text-white hover:bg-accent-dim disabled:opacity-40"
        >
          {generating ? "生成中…" : "AI 生成"}
        </button>
      </div>

      <SectionTitle>字体</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        {[
          { kind: "ui" as const, label: "界面字体", family: settings?.uiFontFamily },
          { kind: "mono" as const, label: "等宽字体（代码）", family: settings?.monoFontFamily },
        ].map((f) => (
          <div key={f.kind} className="rounded-xl border border-border bg-bg-elevated px-4 py-3">
            <div className="text-[12px] text-text-tertiary">{f.label}</div>
            <div className="my-1.5 truncate text-[13px] text-text-primary">{f.family || "系统默认"}</div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => void importFont(f.kind)}
                className="text-[12px] text-accent hover:underline"
              >
                导入字体
              </button>
              {f.family && (
                <button
                  type="button"
                  onClick={() =>
                    void saveSettings(
                      f.kind === "ui" ? { uiFontFamily: "", uiFontFile: "" } : { monoFontFamily: "", monoFontFile: "" },
                    )
                  }
                  className="text-[12px] text-text-tertiary hover:text-danger"
                >
                  重置
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 记忆
// ---------------------------------------------------------------------------

function MemoryPage() {
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void window.spcode
      .command<Record<string, string>>({ type: "memory.read" })
      .then((f) => setFiles(f ?? {}))
      .catch(() => setFiles({}));
  }, []);

  const names = Object.keys(files ?? {});

  return (
    <div>
      <PageHeader
        title="记忆"
        subtitle="分层记忆在会话创建时注入系统提示，结束后蒸馏写回。文件位于 ~/.spcode/，可直接编辑"
      />
      {names.length === 0 ? (
        <div className="text-[13px] text-text-tertiary">读取中…</div>
      ) : (
        <div className="space-y-1.5">
          {names.map((name) => (
            <div key={name} className="rounded-xl border border-border bg-bg-elevated">
              <button
                type="button"
                onClick={() => setOpen(open === name ? null : name)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] text-text-secondary"
              >
                <Icon name={open === name ? "chevronDown" : "chevronRight"} size={13} />
                <span className="mono">{name}</span>
              </button>
              {open === name && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border px-4 py-3 text-[12px] leading-5 text-text-tertiary">
                  {files?.[name]?.trim() || "（空）"}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 关于
// ---------------------------------------------------------------------------

function AboutPage() {
  return (
    <div>
      <PageHeader title="关于" subtitle="版本与引擎信息" />
      <div className="rounded-xl border border-border bg-bg-elevated px-5 py-4 text-[13px] leading-7 text-text-secondary">
        <div className="text-[16px] font-semibold text-text-primary">Spcode</div>
        <div>版本 0.1.0</div>
        <div>
          引擎：<span className="mono">@earendil-works/pi-coding-agent</span> v0.87.1（MIT）
        </div>
        <div className="mt-2 text-text-tertiary">以 Pi 为引擎的 Agentic Code 工作台。</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 共用
// ---------------------------------------------------------------------------

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-[22px] font-semibold text-text-primary">{title}</h1>
      <p className="mt-1 text-[13px] text-text-tertiary">{subtitle}</p>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 mt-6 text-[13px] font-semibold text-text-secondary first:mt-0">{children}</h2>;
}
