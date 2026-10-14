import { useEffect, useRef, useState } from "react";
import type { AdvancedSearchConfig, AdvancedSearchProtocol } from "@spcode/shared";
import { inferMapping, isAdvancedSearchReady, PRESET_ENDPOINTS } from "@spcode/shared/advanced-search";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { ModelsPage } from "./ModelsPage";
import { QuotaPage } from "./QuotaPage";
import { RemotePage } from "./RemotePage";
import { UsagePage } from "./UsagePage";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";

type PageId = "general" | "appearance" | "models" | "usage" | "quota" | "remote" | "memory" | "about";

const NAV: { id: PageId; label: string; icon: string }[] = [
  { id: "general", label: "通用", icon: "gear" },
  { id: "appearance", label: "外观", icon: "sun" },
  { id: "models", label: "模型", icon: "cpu" },
  { id: "usage", label: "用量", icon: "chart" },
  { id: "quota", label: "配额", icon: "gauge" },
  { id: "remote", label: "远程控制", icon: "globe" },
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
            {page === "remote" && <RemotePage />}
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
  // 当前版本号：推导更新通道开关的默认值（beta 版默认收 beta，稳定版默认只收稳定）
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    window.spcode
      .getAppVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);
  const betaUpdatesOn = settings?.betaUpdates ?? appVersion.includes("-");

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

      <SectionTitle>沙盒</SectionTitle>
      <SandboxSection />

      <SectionTitle>高级搜索</SectionTitle>
      <AdvancedSearchSection />

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
      <div className="mt-2 flex items-center justify-between rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">接收测试版更新</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">
            开启后包含 beta 预发布版；关闭则只跟踪稳定版{settings?.betaUpdates === undefined ? "（当前跟随版本形态自动判断）" : ""}
          </div>
        </div>
        <Switch
          on={betaUpdatesOn}
          onChange={(v) => void saveSettings({ betaUpdates: v })}
          label="接收测试版更新"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 高级搜索（通用页子区块）
// ---------------------------------------------------------------------------

const PROTOCOL_OPTIONS: { value: AdvancedSearchProtocol; label: string }[] = [
  { value: "tavily", label: "Tavily" },
  { value: "bocha", label: "博查 Bocha" },
  { value: "custom", label: "自定义（粘贴响应示例）" },
];

function AdvancedSearchSection() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const saved = settings?.advancedSearch ?? null;

  const [protocol, setProtocol] = useState<AdvancedSearchProtocol>(saved?.protocol ?? "tavily");
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? PRESET_ENDPOINTS.tavily);
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? "");
  const [sample, setSample] = useState(saved?.responseSample ?? "");
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // settings 异步加载完成后回填一次表单（之后用户编辑为准，不再覆盖）
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !settings) return;
    hydrated.current = true;
    const s = settings.advancedSearch;
    if (!s) return;
    setProtocol(s.protocol);
    setBaseUrl(s.baseUrl);
    setApiKey(s.apiKey);
    setSample(s.responseSample ?? "");
  }, [settings]);

  const flash = (ok: boolean, text: string) => {
    setHint({ ok, text });
    setTimeout(() => setHint(null), 4000);
  };

  // 自定义协议：实时从示例推断映射（输入即校验）
  const inferred = protocol === "custom" && sample.trim() ? inferMapping(sample) : null;

  const switchProtocol = (p: AdvancedSearchProtocol) => {
    setProtocol(p);
    // 切预设时若 baseUrl 为空或仍是另一个预设的默认值，跟着换成当前预设默认端点
    const presets = Object.values(PRESET_ENDPOINTS) as string[];
    if (p !== "custom" && (!baseUrl.trim() || presets.includes(baseUrl.trim()))) {
      setBaseUrl(PRESET_ENDPOINTS[p]);
    }
  };

  /** 表单 → 配置对象；不完整/推断失败返回 null 并通过 onError 报告原因 */
  const buildConfig = (onError: (msg: string) => void): AdvancedSearchConfig | null => {
    const url = baseUrl.trim();
    const key = apiKey.trim();
    if (!url || !key) {
      onError("请填写 Base URL 和 API Key");
      return null;
    }
    const config: AdvancedSearchConfig = { protocol, baseUrl: url, apiKey: key };
    if (protocol === "custom") {
      if (!inferred) {
        onError(sample.trim() ? "无法从示例中识别结果列表（需包含带 http 链接的字段）" : "请粘贴该 API 的响应示例 JSON");
        return null;
      }
      config.responseSample = sample;
      config.mapping = inferred;
    }
    return config;
  };

  const save = async () => {
    const config = buildConfig((msg) => flash(false, msg));
    if (!config) return;
    await saveSettings({ advancedSearch: config });
    flash(true, "已保存，新会话生效");
  };

  const disable = async () => {
    await saveSettings({ advancedSearch: null });
    flash(true, "已停用，恢复默认 Bing 搜索");
  };

  const test = async () => {
    const config = buildConfig((msg) => flash(false, msg));
    if (!config || testing) return;
    setTesting(true);
    try {
      const result = await window.spcode.searchTest(config);
      flash(result.ok, result.ok ? `连接成功，返回 ${result.count} 条结果` : `测试失败：${result.error}`);
    } finally {
      setTesting(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-border bg-bg-main px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent/50";

  return (
    <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[12px] text-text-tertiary">
          配置搜索 API 后，模型在需要多信息源或高精度查询时会优先使用；未配置时使用内置 Bing 搜索
        </div>
        <div className={`shrink-0 text-[12px] ${isAdvancedSearchReady(saved) ? "text-accent" : "text-text-tertiary"}`}>
          {isAdvancedSearchReady(saved) ? "● 已配置（新会话生效）" : "○ 未配置"}
        </div>
      </div>

      <div className="grid grid-cols-[140px_1fr] items-center gap-x-3 gap-y-2.5">
        <div className="text-[13px] text-text-secondary">协议</div>
        <Select value={protocol} options={PROTOCOL_OPTIONS} onChange={(v) => switchProtocol(v as AdvancedSearchProtocol)} />

        <div className="text-[13px] text-text-secondary">Base URL</div>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="搜索 API 端点，如 https://api.tavily.com/search"
          className={inputCls}
        />

        <div className="text-[13px] text-text-secondary">API Key</div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="API 密钥（保存在本地 settings.json）"
          className={inputCls}
        />
      </div>

      {protocol === "custom" && (
        <div className="mt-2.5">
          <textarea
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            placeholder='粘贴该 API 的真实响应 JSON 示例，如 {"data":{"results":[{"title":"…","url":"https://…","snippet":"…"}]}}'
            rows={5}
            className={`${inputCls} resize-y font-mono text-[12px] leading-relaxed`}
          />
          {sample.trim() && (
            <div className={`mt-1.5 text-[12px] ${inferred ? "text-accent" : "text-danger"}`}>
              {inferred
                ? `已识别：结果数组 ${inferred.resultsPath || "(顶层)"}，标题 ${inferred.titleField || "无"}，链接 ${inferred.urlField}，摘要 ${inferred.snippetField || "无"}`
                : "无法从示例中识别结果列表（需要包含带 http 链接字段的对象数组）"}
            </div>
          )}
          <div className="mt-1 text-[12px] text-text-tertiary">
            自定义协议约定：POST JSON {"{query, count}"} + Bearer 鉴权；响应格式由上面的示例推断
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          className="rounded-lg bg-accent px-4 py-1.5 text-[13px] text-white hover:bg-accent-dim"
        >
          保存
        </button>
        <button
          type="button"
          onClick={() => void test()}
          disabled={testing}
          className="rounded-lg border border-border px-4 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
        >
          {testing ? "测试中…" : "测试连接"}
        </button>
        {saved && (
          <button
            type="button"
            onClick={() => void disable()}
            className="rounded-lg px-3 py-1.5 text-[13px] text-text-tertiary hover:text-danger"
          >
            停用
          </button>
        )}
        {hint && (
          <span className={`text-[12px] ${hint.ok ? "text-accent" : "text-danger"}`}>{hint.text}</span>
        )}
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
  // 真实版本号从主进程读（package.json），别在这里硬编码
  const [version, setVersion] = useState("");
  useEffect(() => {
    window.spcode
      .getAppVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);
  return (
    <div>
      <PageHeader title="关于" subtitle="版本与引擎信息" />
      <div className="rounded-xl border border-border bg-bg-elevated px-5 py-4 text-[13px] leading-7 text-text-secondary">
        <div className="text-[16px] font-semibold text-text-primary">Spcod</div>
        <div>版本 {version || "…"}</div>
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

/**
 * 沙盒设置：总开关/自动放行/网络白名单/额外路径。
 * 列表用「每行一条」的 textarea 编辑，失焦保存（空行与 # 注释行忽略）。
 */
function SandboxSection() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const sandbox = settings?.sandbox;
  if (!sandbox) return null;
  const platformSupported = window.navigator.userAgent.includes("Mac") || window.navigator.userAgent.includes("Linux");

  const patch = (p: Partial<typeof sandbox>) => void saveSettings({ sandbox: { ...sandbox, ...p } });

  return (
    <div className="space-y-3" data-testid="sandbox-settings">
      {!platformSupported && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-[12px] text-warning">
          当前平台暂不支持沙盒（Windows 支持规划中），命令仅靠审批网关约束。
        </div>
      )}
      {!sandbox.enabled && (
        <div
          data-testid="sandbox-disabled-warning"
          className="rounded-xl border border-danger/50 bg-danger/10 px-4 py-3"
        >
          <div className="text-[13px] font-semibold text-danger">⚠ 沙盒已关闭：命令将以你的完整权限直接执行</div>
          <div className="mt-1 text-[12px] leading-5 text-danger/80">
            关闭后，AI 执行的命令不再受内核级边界约束：可以读写本机任意文件（包括 ~/.ssh 密钥、
            ~/.spcode 记忆与配置）、可自由访问网络。届时唯一防线只剩审批弹窗——而黑名单可被绕过、
            逐条审批容易疲劳误点。除非你明确知道在做什么，否则不建议关闭。
          </div>
        </div>
      )}
      <div className="flex items-center justify-between rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">启用命令沙盒</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">
            bash 命令在 OS 级边界内执行：写入限工作目录与缓存，~/.ssh 等敏感路径禁读，网络按白名单放行。对新会话生效
          </div>
        </div>
        <Switch on={sandbox.enabled} onChange={(v) => patch({ enabled: v })} label="启用命令沙盒" />
      </div>

      <div className="flex items-center justify-between rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">沙盒内安全命令免审批</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">
            内核边界已兜底时可跳过弹窗；危险命令与对外动作（git push、发布等）仍然会询问
          </div>
        </div>
        <Switch on={sandbox.autoAllow} onChange={(v) => patch({ autoAllow: v })} label="沙盒内安全命令免审批" />
      </div>

      <SandboxListEditor
        title="网络白名单"
        hint="沙盒内命令可访问的域名，每行一条；支持 *.example.com 与 example.com:443。未列入的域名首次访问会弹窗询问"
        testId="sandbox-allowed-domains"
        values={sandbox.network.allowedDomains}
        onSave={(list) => patch({ network: { ...sandbox.network, allowedDomains: list } })}
      />
      <SandboxListEditor
        title="额外禁读路径"
        hint="在默认敏感清单（~/.ssh、~/.aws、应用密钥等）之上追加，每行一个绝对路径"
        testId="sandbox-extra-deny-read"
        values={sandbox.filesystem.extraDenyRead}
        onSave={(list) => patch({ filesystem: { ...sandbox.filesystem, extraDenyRead: list } })}
      />
      <SandboxListEditor
        title="额外允许写路径"
        hint="工作目录/临时目录/开发缓存之外的写权限，每行一个绝对路径。请谨慎：放开 bin 目录等于开逃逸通道"
        testId="sandbox-extra-allow-write"
        values={sandbox.filesystem.extraAllowWrite}
        onSave={(list) => patch({ filesystem: { ...sandbox.filesystem, extraAllowWrite: list } })}
      />
    </div>
  );
}

function SandboxListEditor({
  title,
  hint,
  values,
  testId,
  onSave,
}: {
  title: string;
  hint: string;
  values: string[];
  testId: string;
  onSave: (list: string[]) => void;
}) {
  const [text, setText] = useState(values.join("\n"));
  // 外部值变化（远端同步等）时同步本地编辑态
  useEffect(() => setText(values.join("\n")), [values]);
  return (
    <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3">
      <div className="text-[14px] text-text-primary">{title}</div>
      <div className="mt-0.5 text-[12px] text-text-tertiary">{hint}</div>
      <textarea
        data-testid={testId}
        className="mono mt-2 h-24 w-full resize-y rounded-lg border border-border bg-bg-root px-3 py-2 text-[12px] text-text-primary outline-none focus:border-accent/50"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const list = text
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"));
          onSave(list);
        }}
        spellCheck={false}
      />
    </div>
  );
}
