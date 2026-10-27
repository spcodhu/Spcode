import type {
  AdvancedSearchConfig,
  AdvancedSearchProtocol,
  PermissionMode,
  SandboxStatusReport,
  WebFetchConfig,
} from "@spcode/shared";
import { baseName } from "@spcode/shared";
import { inferMapping, isAdvancedSearchReady, PRESET_ENDPOINTS } from "@spcode/shared/advanced-search";
import { getLocale, localeProfile, resolveLocale } from "@spcode/shared/i18n";
import { DEEPSEEK_FETCH_ENDPOINT, isWebFetchReady } from "@spcode/shared/web-fetch";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { McpPage } from "./McpPage";
import { ModelsPage } from "./ModelsPage";
import { QuotaPage } from "./QuotaPage";
import { RemotePage } from "./RemotePage";
import { UsagePage } from "./UsagePage";
import { Modal } from "./ui/Modal";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";

type PageId = "general" | "appearance" | "models" | "usage" | "quota" | "remote" | "mcp" | "memory" | "about";

const NAV: { id: PageId; label: `nav.${PageId}`; icon: string }[] = [
  { id: "general", label: "nav.general", icon: "gear" },
  { id: "appearance", label: "nav.appearance", icon: "sun" },
  { id: "models", label: "nav.models", icon: "cpu" },
  { id: "usage", label: "nav.usage", icon: "chart" },
  { id: "quota", label: "nav.quota", icon: "gauge" },
  { id: "remote", label: "nav.remote", icon: "globe" },
  { id: "mcp", label: "nav.mcp", icon: "toolbox" },
  { id: "memory", label: "nav.memory", icon: "brain" },
  { id: "about", label: "nav.about", icon: "info" },
];

export function SettingsPage({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("settings");
  const [page, setPage] = useState<PageId>("general");

  return (
    <Modal
      title={t("title")}
      onClose={onClose}
      layerClassName="items-center justify-center"
      panelClassName="flex h-[720px] max-h-[86vh] w-[1100px] max-w-[92vw] overflow-hidden rounded-2xl border border-border-strong bg-bg-main shadow-2xl"
    >
      {/* 左侧导航 */}
      <nav className="flex w-52 shrink-0 flex-col border-r border-border bg-bg-sidebar">
        <div className="titlebar-drag flex h-12 items-center justify-center border-b border-border">
          <span className="text-[14px] font-semibold text-text-primary">{t("title")}</span>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-3">
          {NAV.map((item) => (
            <button
              type="button"
              key={item.id}
              data-testid={`settings-nav-${item.id}`}
              onClick={() => setPage(item.id)}
              className={`mb-0.5 flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors ${
                page === item.id ? "bg-accent text-on-accent" : "text-text-secondary hover:bg-bg-hover"
              }`}
            >
              <Icon name={item.icon} size={15} />
              {t(item.label)}
            </button>
          ))}
        </div>
        <div className="border-t border-border px-3 py-2 text-[11px] text-text-tertiary">{t("closeHint")}</div>
      </nav>

      {/* 内容区 */}
      <div className="relative min-w-0 flex-1 overflow-y-auto">
        <button
          type="button"
          onClick={onClose}
          title={t("closeSettings")}
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
          {page === "mcp" && <McpPage />}
          {page === "about" && <AboutPage />}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

function GeneralPage() {
  const { t } = useTranslation("settings");
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
      <PageHeader title={t("nav.general")} subtitle={t("general.description")} />
      {!localeProfile.fixedLocale && (
        <div className="mb-6" data-testid="settings-language">
          <SectionTitle>{t("general.language")}</SectionTitle>
          <p className="mb-2 text-[12px] text-text-tertiary">{t("general.languageDescription")}</p>
          <Select
            value={settings?.locale ?? getLocale()}
            options={localeProfile.supportedLocales.map((locale) => ({
              value: locale,
              label: t(`general.language.${locale}`),
            }))}
            onChange={(value) => void saveSettings({ locale: resolveLocale(value) })}
            className="w-64 max-w-full"
          />
        </div>
      )}
      <SectionTitle>{t("general.permissionMode")}</SectionTitle>
      <div className="flex gap-2" data-testid="settings-permission-mode">
        {(
          [
            { id: "ask", label: t("general.modeAsk"), desc: t("general.modeAskDescription") },
            { id: "auto", label: t("general.modeAuto"), desc: t("general.modeAutoDescription") },
            { id: "never", label: t("general.modeNever"), desc: t("general.modeNeverDescription") },
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
      <div className="text-[12px] text-text-tertiary">{t("general.permissionModeHint")}</div>

      <PermissionRulesSection />
      <ProjectPermissionRulesSection />

      <SectionTitle>{t("general.thinking")}</SectionTitle>
      <Select
        value={settings?.defaultThinkingLevel ?? "medium"}
        options={(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((v) => ({
          value: v,
          label: t(`thinking.${v}`),
        }))}
        onChange={(v) => void saveSettings({ defaultThinkingLevel: v })}
        className="w-56"
      />

      <SectionTitle>{t("nav.memory")}</SectionTitle>
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">{t("general.memoryDistill")}</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">{t("general.memoryDistillDescription")}</div>
        </div>
        <Switch
          on={settings?.memoryDistill ?? true}
          onChange={(v) => void saveSettings({ memoryDistill: v })}
          label={t("general.memoryDistill")}
        />
      </div>

      {/* 评审 R3-F4 */}
      <div className="mt-2 flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">{t("general.notifications")}</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">{t("general.notificationsDescription")}</div>
        </div>
        <Switch
          on={settings?.desktopNotifications ?? true}
          onChange={(v) => void saveSettings({ desktopNotifications: v })}
          label={t("general.notifications")}
        />
      </div>

      <SectionTitle>{t("general.compaction")}</SectionTitle>
      <CompactionSection />

      <SectionTitle>{t("general.sandbox")}</SectionTitle>
      <SandboxSection />

      <SectionTitle>{t("general.search")}</SectionTitle>
      <AdvancedSearchSection />

      <SectionTitle>{t("general.webFetch")}</SectionTitle>
      <WebFetchSection />

      <SectionTitle>{t("general.autoUpdate")}</SectionTitle>
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">{t("general.checkUpdates")}</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">{t("general.checkUpdatesDescription")}</div>
        </div>
        <Switch
          on={settings?.autoUpdate ?? true}
          onChange={(v) => void saveSettings({ autoUpdate: v })}
          label={t("general.autoUpdate")}
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">{t("general.betaUpdates")}</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">
            {t("general.betaUpdatesDescription")}
            {settings?.betaUpdates === undefined ? t("general.betaAutomatic") : ""}
          </div>
        </div>
        <Switch
          on={betaUpdatesOn}
          onChange={(v) => void saveSettings({ betaUpdates: v })}
          label={t("general.betaUpdates")}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 高级搜索（通用页子区块）
// ---------------------------------------------------------------------------

function AdvancedSearchSection() {
  const { t } = useTranslation("settings");
  const PROTOCOL_OPTIONS: { value: AdvancedSearchProtocol; label: string }[] = [
    { value: "tavily", label: "Tavily" },
    { value: "bocha", label: t("search.bocha") },
    { value: "deepseek", label: "DeepSeek" },
    { value: "custom", label: t("search.custom") },
  ];

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
      onError(t("search.missingCredentials"));
      return null;
    }
    const config: AdvancedSearchConfig = { protocol, baseUrl: url, apiKey: key };
    if (protocol === "custom") {
      if (!inferred) {
        onError(sample.trim() ? t("search.unrecognizedSample") : t("search.missingSample"));
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
    flash(true, t("search.saved"));
  };

  const disable = async () => {
    await saveSettings({ advancedSearch: null });
    flash(true, t("search.disabled"));
  };

  const test = async () => {
    const config = buildConfig((msg) => flash(false, msg));
    if (!config || testing) return;
    setTesting(true);
    try {
      const result = await window.spcode.searchTest(config);
      flash(
        result.ok,
        result.ok ? t("search.success", { count: result.count }) : t("search.failure", { error: result.error }),
      );
    } finally {
      setTesting(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-border bg-bg-main px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent/50";

  return (
    <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-text-tertiary">{t("search.description")}</div>
        <div className={`shrink-0 text-[12px] ${isAdvancedSearchReady(saved) ? "text-accent" : "text-text-tertiary"}`}>
          {isAdvancedSearchReady(saved) ? t("search.configured") : t("search.notConfigured")}
        </div>
      </div>

      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
        <div className="text-[13px] text-text-secondary">{t("search.protocol")}</div>
        <Select
          value={protocol}
          options={PROTOCOL_OPTIONS}
          onChange={(v) => switchProtocol(v as AdvancedSearchProtocol)}
        />

        <div className="text-[13px] text-text-secondary">{t("search.baseUrl")}</div>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={t("search.urlPlaceholder")}
          className={inputCls}
        />

        <div className="text-[13px] text-text-secondary">{t("search.apiKey")}</div>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t("search.keyPlaceholder")}
          className={inputCls}
        />
      </div>

      {protocol === "custom" && (
        <div className="mt-2.5">
          <textarea
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            placeholder={t("search.samplePlaceholder", {
              example: '{"data":{"results":[{"title":"…","url":"https://…","snippet":"…"}]}}',
            })}
            rows={5}
            className={`${inputCls} resize-y font-mono text-[12px] leading-relaxed`}
          />
          {sample.trim() && (
            <div className={`mt-1.5 text-[12px] ${inferred ? "text-accent" : "text-danger"}`}>
              {inferred
                ? t("search.mapping", {
                    results: inferred.resultsPath || t("search.topLevel"),
                    title: inferred.titleField || t("none"),
                    url: inferred.urlField,
                    snippet: inferred.snippetField || t("none"),
                  })
                : t("search.invalidMapping")}
            </div>
          )}
          <div className="mt-1 text-[12px] text-text-tertiary">
            {t("search.customDescription", { body: "{query, count}" })}
          </div>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          className="rounded-lg bg-accent px-4 py-1.5 text-[13px] text-on-accent hover:bg-accent-dim"
        >
          {t("save")}
        </button>
        <button
          type="button"
          onClick={() => void test()}
          disabled={testing}
          className="rounded-lg border border-border px-4 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
        >
          {testing ? t("search.testing") : t("search.test")}
        </button>
        {saved && (
          <button
            type="button"
            onClick={() => void disable()}
            className="rounded-lg px-3 py-1.5 text-[13px] text-text-tertiary hover:text-danger"
          >
            {t("search.disable")}
          </button>
        )}
        {hint && <span className={`text-[12px] ${hint.ok ? "text-accent" : "text-danger"}`}>{hint.text}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 网页抓取后端（通用页子区块）
// ---------------------------------------------------------------------------

function WebFetchSection() {
  const { t } = useTranslation("settings");
  const PROVIDER_OPTIONS = [
    { value: "builtin", label: t("fetch.builtin") },
    { value: "deepseek", label: "DeepSeek" },
  ];

  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const saved = settings?.webFetch ?? null;

  const [provider, setProvider] = useState<"builtin" | "deepseek">(saved?.provider ?? "builtin");
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? DEEPSEEK_FETCH_ENDPOINT);
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? "");
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // settings 异步加载完成后回填一次表单（之后用户编辑为准，不再覆盖）
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !settings) return;
    hydrated.current = true;
    const s = settings.webFetch;
    if (!s) return;
    setProvider(s.provider);
    setBaseUrl(s.baseUrl);
    setApiKey(s.apiKey);
  }, [settings]);

  const flash = (ok: boolean, text: string) => {
    setHint({ ok, text });
    setTimeout(() => setHint(null), 4000);
  };

  const switchProvider = (p: string) => {
    const next = p === "deepseek" ? "deepseek" : "builtin";
    setProvider(next);
    // 切到 DeepSeek 且端点为空时自动填默认端点
    if (next === "deepseek" && !baseUrl.trim()) setBaseUrl(DEEPSEEK_FETCH_ENDPOINT);
  };

  const buildConfig = (onError: (msg: string) => void): WebFetchConfig | null => {
    const url = baseUrl.trim();
    const key = apiKey.trim();
    if (!url || !key) {
      onError(t("search.missingCredentials"));
      return null;
    }
    return { provider: "deepseek", baseUrl: url, apiKey: key };
  };

  const save = async () => {
    // 选内置 = 清空配置（工具始终注册，逐次调用实时读取，即时生效）
    if (provider === "builtin") {
      await saveSettings({ webFetch: null });
      flash(true, t("fetch.disabled"));
      return;
    }
    const config = buildConfig((msg) => flash(false, msg));
    if (!config) return;
    await saveSettings({ webFetch: config });
    flash(true, t("fetch.saved"));
  };

  const test = async () => {
    const config = buildConfig((msg) => flash(false, msg));
    if (!config || testing) return;
    setTesting(true);
    try {
      const result = await window.spcode.webFetchTest(config);
      flash(
        result.ok,
        result.ok ? t("fetch.success", { length: result.length }) : t("search.failure", { error: result.error }),
      );
    } finally {
      setTesting(false);
    }
  };

  const inputCls =
    "w-full rounded-lg border border-border bg-bg-main px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent/50";

  return (
    <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12px] text-text-tertiary">{t("fetch.description")}</div>
        <div className={`shrink-0 text-[12px] ${isWebFetchReady(saved) ? "text-accent" : "text-text-tertiary"}`}>
          {isWebFetchReady(saved) ? t("fetch.configured") : t("search.notConfigured")}
        </div>
      </div>

      <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
        <div className="text-[13px] text-text-secondary">{t("fetch.provider")}</div>
        <Select value={provider} options={PROVIDER_OPTIONS} onChange={switchProvider} />

        {provider === "deepseek" && (
          <>
            <div className="text-[13px] text-text-secondary">{t("search.baseUrl")}</div>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("fetch.urlPlaceholder")}
              className={inputCls}
            />

            <div className="text-[13px] text-text-secondary">{t("search.apiKey")}</div>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("search.keyPlaceholder")}
              className={inputCls}
            />
          </>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          className="rounded-lg bg-accent px-4 py-1.5 text-[13px] text-on-accent hover:bg-accent-dim"
        >
          {t("save")}
        </button>
        {provider === "deepseek" && (
          <button
            type="button"
            onClick={() => void test()}
            disabled={testing}
            className="rounded-lg border border-border px-4 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover disabled:opacity-40"
          >
            {testing ? t("search.testing") : t("search.test")}
          </button>
        )}
        {hint && <span className={`text-[12px] ${hint.ok ? "text-accent" : "text-danger"}`}>{hint.text}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 外观
// ---------------------------------------------------------------------------

function AppearancePage() {
  const { t } = useTranslation("settings");
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const [themeDesc, setThemeDesc] = useState("");
  const [generating, setGenerating] = useState(false);
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);

  const flash = (ok: boolean, text: string) => {
    setHint({ ok, text });
    setTimeout(() => setHint(null), 3000);
  };

  const importTheme = async () => {
    const text = await window.spcode.pickThemeFile();
    if (!text) return;
    try {
      const { normalizeTheme } = await import("../theme.js");
      const theme = normalizeTheme(JSON.parse(text));
      if (!theme) return flash(false, t("appearance.invalidTheme"));
      await saveSettings({ customTheme: theme });
      flash(true, t("appearance.applied", { name: theme.name }));
    } catch {
      flash(false, t("appearance.invalidJson"));
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
      if (!theme) return flash(false, t("appearance.incompleteTheme"));
      await saveSettings({ customTheme: theme });
      flash(true, t("appearance.generated", { name: theme.name }));
      setThemeDesc("");
    } catch (e) {
      flash(false, e instanceof Error ? e.message : t("appearance.generateFailed"));
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
    flash(true, t("appearance.fontImported", { name: picked.family }));
  };

  return (
    <div>
      <PageHeader title={t("nav.appearance")} subtitle={t("appearance.description")} />
      {hint && (
        <div
          className={`mb-3 rounded-lg px-3 py-2 text-[12px] ${
            hint.ok ? "bg-accent-soft text-accent" : "bg-danger/10 text-danger"
          }`}
        >
          {hint.text}
        </div>
      )}

      <SectionTitle>{t("appearance.theme")}</SectionTitle>
      <div className="mb-3 flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div className="text-[14px] text-text-primary">
          {settings?.customTheme
            ? t("appearance.customTheme", { name: settings.customTheme.name })
            : t("appearance.defaultTheme")}
        </div>
        <div className="flex gap-2">
          {settings?.customTheme && (
            <button
              type="button"
              onClick={() => void saveSettings({ customTheme: null })}
              className="text-[12px] text-text-tertiary hover:text-danger"
            >
              {t("appearance.restore")}
            </button>
          )}
          <button type="button" onClick={() => void importTheme()} className="text-[12px] text-accent hover:underline">
            {t("appearance.importTheme")}
          </button>
        </div>
      </div>
      <div className="flex gap-2">
        <input
          value={themeDesc}
          onChange={(e) => setThemeDesc(e.target.value)}
          placeholder={t("appearance.themePlaceholder")}
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-[13px] outline-none focus:border-accent/50"
          onKeyDown={(e) => {
            if (e.key === "Enter") void generateTheme();
          }}
        />
        <button
          type="button"
          onClick={() => void generateTheme()}
          disabled={!themeDesc.trim() || generating}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-[13px] text-on-accent hover:bg-accent-dim disabled:opacity-40"
        >
          {generating ? t("appearance.generating") : t("appearance.generate")}
        </button>
      </div>

      <SectionTitle>{t("appearance.fonts")}</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        {[
          { kind: "ui" as const, label: t("appearance.uiFont"), family: settings?.uiFontFamily },
          { kind: "mono" as const, label: t("appearance.monoFont"), family: settings?.monoFontFamily },
        ].map((f) => (
          <div key={f.kind} className="rounded-xl border border-border bg-bg-elevated px-4 py-3">
            <div className="text-[12px] text-text-tertiary">{f.label}</div>
            <div className="my-1.5 truncate text-[13px] text-text-primary">
              {f.family || t("appearance.systemFont")}
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => void importFont(f.kind)}
                className="text-[12px] text-accent hover:underline"
              >
                {t("appearance.importFont")}
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
                  {t("reset")}
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
  const { t } = useTranslation("settings");
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await window.spcode.command<Record<string, string>>({ type: "memory.read" });
      setFiles(result ?? {});
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const names = Object.keys(files ?? {});

  return (
    <div>
      <PageHeader title={t("nav.memory")} subtitle={t("memory.description")} />
      {loading ? (
        <div role="status" data-testid="memory-loading" className="text-[13px] text-text-tertiary">
          {t("loading")}
        </div>
      ) : loadError ? (
        <div
          role="alert"
          data-testid="memory-load-error"
          className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-[13px] text-danger"
        >
          <div>{t("memory.loadFailed", { error: loadError })}</div>
          <button
            type="button"
            data-testid="memory-retry"
            onClick={() => void load()}
            className="mt-2 rounded-lg border border-danger/40 px-3 py-1.5 text-[12px] hover:bg-danger/10"
          >
            {t("retry")}
          </button>
        </div>
      ) : names.length === 0 ? (
        <div data-testid="memory-empty" className="text-[13px] text-text-tertiary">
          {t("memory.empty")}
        </div>
      ) : (
        <div className="space-y-1.5">
          {names.map((name) => (
            <div key={name} className="rounded-xl border border-border bg-bg-elevated">
              <button
                type="button"
                data-testid={`memory-file-${name}`}
                onClick={() => setOpen(open === name ? null : name)}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] text-text-secondary"
              >
                <Icon name={open === name ? "chevronDown" : "chevronRight"} size={13} />
                <span className="mono">{name}</span>
              </button>
              {open === name && (
                <pre
                  data-testid="memory-content"
                  className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border px-4 py-3 text-[12px] leading-5 text-text-tertiary"
                >
                  {files?.[name]?.trim() || t("empty")}
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
  const { t } = useTranslation("settings");
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
      <PageHeader title={t("nav.about")} subtitle={t("about.description")} />
      <div className="rounded-xl border border-border bg-bg-elevated px-5 py-4 text-[13px] leading-7 text-text-secondary">
        <div className="text-[16px] font-semibold text-text-primary">Spcod</div>
        <div>{t("about.version", { version: version || "…" })}</div>
        <div>
          {t("about.engine")}
          <span className="mono">@earendil-works/pi-coding-agent</span> v0.87.1 (MIT)
        </div>
        <div className="mt-2 text-text-tertiary">{t("about.tagline")}</div>
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
 * 上下文压缩设置：自动开关 + 触发预留 + 保留窗口。
 * 即时生效（引擎每轮压缩判断实时读取）；手动压缩入口在输入框左侧上下文环的悬浮卡。
 */
function CompactionSection() {
  const { t } = useTranslation("settings");
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const compaction = settings?.compaction;
  if (!compaction) return null;

  const patch = (p: Partial<typeof compaction>) => void saveSettings({ compaction: { ...compaction, ...p } });

  return (
    <div className="space-y-3" data-testid="compaction-settings">
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">{t("compaction.auto")}</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">{t("compaction.description")}</div>
        </div>
        <Switch on={compaction.enabled} onChange={(v) => patch({ enabled: v })} label={t("compaction.auto")} />
      </div>
      <div className="rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <TokenField
          label={t("compaction.reserve")}
          desc={t("compaction.reserveDescription")}
          value={compaction.reserveTokens}
          min={1024}
          onCommit={(v) => patch({ reserveTokens: v })}
        />
        <div className="my-3 h-px bg-border" />
        <TokenField
          label={t("compaction.keep")}
          desc={t("compaction.keepDescription")}
          value={compaction.keepRecentTokens}
          min={1000}
          onCommit={(v) => patch({ keepRecentTokens: v })}
        />
      </div>
    </div>
  );
}

/** token 数字输入：本地编辑态 + 失焦/回车校验提交（非法值回退并提示） */
function TokenField({
  label,
  desc,
  value,
  min,
  onCommit,
}: {
  label: string;
  desc: string;
  value: number;
  min: number;
  onCommit: (v: number) => void;
}) {
  const { t } = useTranslation("settings");
  const [text, setText] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  // 外部值变化（另一区块修改/重载设置）时同步本地编辑态
  useEffect(() => {
    setText(String(value));
    setInvalid(false);
  }, [value]);

  const commit = () => {
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < min) {
      setInvalid(true);
      setText(String(value));
      return;
    }
    setInvalid(false);
    if (n !== value) onCommit(n);
  };

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-[14px] text-text-primary">{label}</div>
        <div className="mt-0.5 text-[12px] text-text-tertiary">{desc}</div>
        {invalid && <div className="mt-1 text-[12px] text-danger">{t("compaction.invalid", { min })}</div>}
      </div>
      <input
        type="number"
        min={min}
        step={1024}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={`mono w-32 shrink-0 rounded-lg border bg-bg-main px-2.5 py-1.5 text-right text-[13px] text-text-primary outline-none transition-colors ${
          invalid ? "border-danger" : "border-border focus:border-accent"
        }`}
      />
    </div>
  );
}

/**
 * 旧版全局免审批规则管理：保留兼容；新的「总允许」写入下方项目级规则。
 * 命中规则的 bash/powershell 命令（write/outward 级）不再弹窗；danger 级永远不免。
 */
function PermissionRulesSection() {
  const { t } = useTranslation("settings");
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const rules = settings?.permissionRules ?? [];
  if (!settings) return null;
  return (
    <div className="mt-3 rounded-xl border border-border bg-bg-elevated px-4 py-3" data-testid="permission-rules">
      <div className="text-[14px] text-text-primary">{t("permissions.rules")}</div>
      <div className="mt-0.5 text-[12px] text-text-tertiary">{t("permissions.description")}</div>
      {rules.length === 0 ? (
        <div className="mt-2 text-[12px] text-text-tertiary">{t("permissions.empty")}</div>
      ) : (
        <div className="mt-2 space-y-1">
          {rules.map((rule) => (
            <div key={rule} className="flex items-center justify-between rounded-lg bg-bg-main px-3 py-1.5">
              <code className="mono text-[12px] text-text-secondary">{rule} …</code>
              <button
                type="button"
                onClick={() => void saveSettings({ permissionRules: rules.filter((r) => r !== rule) })}
                className="text-[12px] text-text-tertiary hover:text-danger"
              >
                {t("remove")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 项目级免审批规则：按 cwd 分组，只影响对应项目的当前与后续会话。 */
function ProjectPermissionRulesSection() {
  const { t } = useTranslation("settings");
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const projects = settings?.projectPermissionRules ?? {};
  const entries = Object.entries(projects);
  if (!settings) return null;
  return (
    <div
      className="mt-3 rounded-xl border border-border bg-bg-elevated px-4 py-3"
      data-testid="project-permission-rules"
    >
      <div className="text-[14px] text-text-primary">{t("permissions.projectRules")}</div>
      <div className="mt-0.5 text-[12px] text-text-tertiary">{t("permissions.projectDescription")}</div>
      {entries.length === 0 ? (
        <div className="mt-2 text-[12px] text-text-tertiary">{t("permissions.emptyProject")}</div>
      ) : (
        <div className="mt-3 space-y-3">
          {entries.map(([cwd, rules]) => (
            <section key={cwd} aria-label={cwd}>
              <div className="mb-1 text-[12px] font-medium text-text-secondary" title={cwd}>
                {baseName(cwd) || cwd}
              </div>
              <div className="space-y-1">
                {rules.map((rule) => (
                  <div
                    key={`${rule.match}:${rule.command}`}
                    className="flex items-center gap-3 rounded-lg bg-bg-main px-3 py-1.5"
                  >
                    <code className="mono min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] text-text-secondary">
                      {rule.command}
                      {rule.match === "prefix" ? " …" : ""}
                    </code>
                    <span className="shrink-0 text-[11px] text-text-tertiary">
                      {t(rule.match === "exact" ? "permissions.exact" : "permissions.prefix")}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        const nextRules = rules.filter((r) => r !== rule);
                        const next = { ...projects };
                        if (nextRules.length) next[cwd] = nextRules;
                        else delete next[cwd];
                        void saveSettings({ projectPermissionRules: next });
                      }}
                      className="shrink-0 text-[12px] text-text-tertiary hover:text-danger"
                    >
                      {t("remove")}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 沙盒设置：真实运行状态 + 总开关/自动放行/逃生舱/本地端口/网络白名单/沙盒外白名单/额外路径。
 * 列表用「每行一条」的 textarea 编辑，失焦保存（空行与 # 注释行忽略）。
 *
 * 「启用命令沙盒」不是单纯的偏好开关：它决定会话创建时是否用沙盒版 bash 覆盖内置 bash，
 * 从而用内核边界（macOS Seatbelt / Linux bubblewrap）换取沙盒内写类命令免审批。
 * 工具集在会话创建时固定，所以开关只对新会话生效——这点必须在 UI 上写清，
 * 否则用户会以为“开了但没用”。
 */
function SandboxSection() {
  const { t } = useTranslation("settings");
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const sandbox = settings?.sandbox;
  /** 宿主侧真实状态（null = 还没查回来） */
  const [status, setStatus] = useState<SandboxStatusReport | null>(null);
  const [checking, setChecking] = useState(false);

  const refreshStatus = useCallback(() => {
    setChecking(true);
    void window.spcode
      .sandboxStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setChecking(false));
  }, []);

  // 进入分区（设置加载完）查一次；任何 sandbox 字段变更后也会重查（初始化是惰性的）
  useEffect(() => {
    if (!sandbox) return;
    refreshStatus();
  }, [sandbox, refreshStatus]);

  if (!sandbox) return null;
  const platformSupported = window.navigator.userAgent.includes("Mac") || window.navigator.userAgent.includes("Linux");

  const patch = (p: Partial<typeof sandbox>) => {
    void saveSettings({ sandbox: { ...sandbox, ...p } });
  };

  return (
    <div className="space-y-3" data-testid="sandbox-settings">
      <SandboxStatusLine status={status} checking={checking} onRefresh={refreshStatus} />
      <div className="rounded-xl border border-border bg-bg-elevated px-4 py-2.5 text-[12px] leading-5 text-text-tertiary">
        <span className="text-text-secondary">{t("sandbox.newSessions")}</span>
        {t("sandbox.newSessionsDescription")}
      </div>

      {!platformSupported && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-[12px] text-warning">
          {t("sandbox.unsupported")}
        </div>
      )}
      {!sandbox.enabled && (
        <div
          data-testid="sandbox-disabled-warning"
          className="rounded-xl border border-danger/50 bg-danger/10 px-4 py-3"
        >
          <div className="text-[13px] font-semibold text-danger">{t("sandbox.disabledWarning")}</div>
          <div className="mt-1 text-[12px] leading-5 text-danger/80">{t("sandbox.disabledDescription")}</div>
          {settings?.permissionMode !== "ask" && (
            <div data-testid="sandbox-disabled-mode-warning" className="mt-1 text-[12px] leading-5 text-danger">
              {t("sandbox.disabledPlusModeWarning", {
                mode: settings?.permissionMode === "auto" ? t("general.modeAuto") : t("general.modeNever"),
              })}
            </div>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">{t("sandbox.enable")}</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">{t("sandbox.enableDescription")}</div>
        </div>
        <Switch on={sandbox.enabled} onChange={(v) => patch({ enabled: v })} label={t("sandbox.enable")} />
      </div>

      <SandboxBehaviorTable enabled={sandbox.enabled} permissionMode={settings?.permissionMode ?? "ask"} />

      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">{t("sandbox.escape")}</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">{t("sandbox.escapeDescription")}</div>
        </div>
        <Switch
          on={sandbox.allowUnsandboxedCommands}
          onChange={(v) => patch({ allowUnsandboxedCommands: v })}
          label={t("sandbox.escapeLabel")}
        />
      </div>

      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-elevated px-4 py-3">
        <div>
          <div className="text-[14px] text-text-primary">{t("sandbox.localPorts")}</div>
          <div className="mt-0.5 text-[12px] text-text-tertiary">{t("sandbox.localPortsDescription")}</div>
        </div>
        <Switch
          on={sandbox.network.allowLocalBinding}
          onChange={(v) => patch({ network: { ...sandbox.network, allowLocalBinding: v } })}
          label={t("sandbox.localPorts")}
        />
      </div>

      <SandboxListEditor
        title={t("sandbox.domains")}
        hint={t("sandbox.domainsDescription")}
        testId="sandbox-allowed-domains"
        values={sandbox.network.allowedDomains}
        onSave={(list) => patch({ network: { ...sandbox.network, allowedDomains: list } })}
      />
      <SandboxListEditor
        title={t("sandbox.excluded")}
        hint={t("sandbox.excludedDescription")}
        testId="sandbox-excluded-commands"
        values={sandbox.excludedCommands}
        onSave={(list) => patch({ excludedCommands: list })}
      />
      <SandboxListEditor
        title={t("sandbox.denyRead")}
        hint={t("sandbox.denyReadDescription")}
        testId="sandbox-extra-deny-read"
        values={sandbox.filesystem.extraDenyRead}
        onSave={(list) => patch({ filesystem: { ...sandbox.filesystem, extraDenyRead: list } })}
      />
      <SandboxListEditor
        title={t("sandbox.allowWrite")}
        hint={t("sandbox.allowWriteDescription")}
        testId="sandbox-extra-allow-write"
        values={sandbox.filesystem.extraAllowWrite}
        onSave={(list) => patch({ filesystem: { ...sandbox.filesystem, extraAllowWrite: list } })}
      />
    </div>
  );
}

function SandboxStatusLine({
  status,
  checking,
  onRefresh,
}: {
  status: SandboxStatusReport | null;
  checking: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation("settings");
  const platform = status?.platform ?? "";
  const mechanism =
    platform === "darwin" ? "macOS Seatbelt (sandbox-exec)" : platform === "linux" ? "Linux bubblewrap" : platform;
  const view = !status
    ? { dot: "bg-text-tertiary", title: t("sandbox.loading"), tone: "text-text-tertiary" }
    : status.state === "active"
      ? {
          dot: "bg-accent",
          title: t("sandbox.active", { mechanism }),
          tone: "text-accent",
        }
      : status.state === "disabled"
        ? { dot: "bg-warning", title: t("sandbox.disabled"), tone: "text-warning" }
        : { dot: "bg-danger", title: t("sandbox.unavailable"), tone: "text-danger" };
  return (
    <div
      className="flex items-start justify-between gap-3 rounded-xl border border-border bg-bg-elevated px-4 py-3"
      data-testid="sandbox-status"
      data-state={status?.state ?? "unknown"}
    >
      <div className="min-w-0">
        <div className={`flex items-center gap-2 text-[13px] font-medium ${view.tone}`}>
          <span aria-hidden className={`h-[7px] w-[7px] shrink-0 rounded-full ${view.dot}`} />
          <span className="truncate">{view.title}</span>
        </div>
        {status?.state === "unavailable" && status.reason && (
          <div className="mt-1 break-words text-[12px] leading-5 text-text-tertiary">
            {t("sandbox.reason", { reason: status.reason })}
          </div>
        )}
        {status?.state === "active" && (
          <div className="mt-1 text-[12px] text-text-tertiary">{t("sandbox.approvalsByMode")}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={checking}
        className="mt-0.5 flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary disabled:opacity-50"
      >
        <Icon name="refresh" size={12} className={checking ? "animate-spin" : ""} />
        {checking ? t("sandbox.checking") : t("sandbox.recheck")}
      </button>
    </div>
  );
}

/** 开启/关闭两套行为速查：让「沙盒开关到底管什么」在界面上可自证。
 *  写类命令的弹窗策略已从 autoAllow 开关改为新会话默认权限模式驱动，这里同步展示。 */
function SandboxBehaviorTable({ enabled, permissionMode }: { enabled: boolean; permissionMode: PermissionMode }) {
  const { t } = useTranslation("settings");
  const modeLabel =
    permissionMode === "ask"
      ? t("general.modeAsk")
      : permissionMode === "auto"
        ? t("general.modeAuto")
        : t("general.modeNever");
  const rows = [
    {
      label: t("sandbox.execution"),
      active: t("sandbox.executionActive"),
      off: t("sandbox.executionOff"),
    },
    {
      label: t("sandbox.writeApprovals"),
      active: t("sandbox.writeByMode", { mode: modeLabel }),
      off: t("sandbox.writeByMode", { mode: modeLabel }),
    },
    { label: t("sandbox.dangerous"), active: t("sandbox.dangerousActive"), off: t("sandbox.dangerousOff") },
    { label: t("sandbox.domains"), active: t("sandbox.domainsActive"), off: t("sandbox.domainsOff") },
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-border" data-testid="sandbox-behavior-table">
      <div className="grid grid-cols-[110px_1fr] gap-x-3 border-b border-border bg-bg-hover/40 px-4 py-2 text-[11.5px] text-text-tertiary">
        <span />
        <span>{enabled ? t("sandbox.currentOn") : t("sandbox.currentOff")}</span>
      </div>
      {rows.map((r, i) => (
        <div
          key={r.label}
          className={`grid grid-cols-[110px_1fr] gap-x-3 px-4 py-2 text-[12px] ${i > 0 ? "border-t border-border/60" : ""}`}
        >
          <span className="text-text-tertiary">{r.label}</span>
          <span className="text-text-secondary">{enabled ? r.active : r.off}</span>
        </div>
      ))}
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
