/**
 * 技能设置页：内置工具技能的独立配置入口（与对话模型分开）。
 * 图像生成内置千问AI平台同步协议；自定义协议由完整 Body 模板 + 图片响应路径组成。
 * 保存后经 skills.setConfig 热下发生效。
 */

import type { ImageGenConfig, ImageGenProtocol, QwenImageGenBilling } from "@spcode/shared";
import { SECRET_MASK } from "@spcode/shared";
import {
  IMAGE_GEN_PRESETS,
  inferQwenImageGenBilling,
  isImageGenReady,
  isValidImageGenResponsePath,
  QWEN_IMAGE_GEN_ENDPOINTS,
  validateImageGenRequestBody,
} from "@spcode/shared/image-gen";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { ImageGenProgress } from "./ImageGenProgress";
import { Select } from "./ui/Select";

export function SkillsPage() {
  const { t } = useTranslation("settings");
  return (
    <div>
      <PageHeader title={t("nav.skills")} subtitle={t("skills.description")} />
      <ImageGenSkillCard />
      <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-3 text-[12px] text-text-tertiary">
        {t("skills.moreComing")}
      </div>
    </div>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-[22px] font-semibold text-text-primary">{title}</h1>
      <p className="mt-1 text-[13px] text-text-tertiary">{subtitle}</p>
    </div>
  );
}

const PROTOCOLS: ImageGenProtocol[] = ["qwen", "custom"];
const BILLING_OPTIONS: QwenImageGenBilling[] = ["payg", "token-plan"];

function ImageGenSkillCard() {
  const { t } = useTranslation("settings");
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const saved = settings?.skills?.imageGen ?? null;

  const [protocol, setProtocol] = useState<ImageGenProtocol>(saved?.protocol ?? "qwen");
  const [billing, setBilling] = useState<QwenImageGenBilling>(
    saved?.billing ?? inferQwenImageGenBilling(saved?.baseUrl),
  );
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? IMAGE_GEN_PRESETS.qwen.baseUrl);
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? "");
  // 模型始终由用户填写，不随协议预设写死。
  const [model, setModel] = useState(saved?.model ?? "");
  const [requestBody, setRequestBody] = useState(saved?.requestBody ?? IMAGE_GEN_PRESETS.custom.requestBody);
  const [responsePath, setResponsePath] = useState(saved?.responsePath ?? IMAGE_GEN_PRESETS.custom.responsePath);
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState<{ mimeType: string; data: string } | null>(null);

  // settings 异步加载完成后回填一次表单（之后用户编辑为准，不再覆盖）
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !settings) return;
    hydrated.current = true;
    const s = settings.skills?.imageGen;
    if (!s) return;
    setProtocol(s.protocol);
    setBilling(s.billing ?? inferQwenImageGenBilling(s.baseUrl));
    setBaseUrl(s.baseUrl);
    setApiKey(s.apiKey);
    setModel(s.model);
    setRequestBody(s.requestBody ?? IMAGE_GEN_PRESETS.custom.requestBody);
    setResponsePath(s.responsePath ?? IMAGE_GEN_PRESETS.custom.responsePath);
  }, [settings]);

  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    [],
  );

  const clearHint = () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = null;
    setHint(null);
  };

  const flash = (ok: boolean, text: string) => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = null;
    setHint({ ok, text });
    // 成功反馈自动消失；错误必须等用户显式关闭或发起下一次操作，避免误点丢失。
    if (ok) {
      hintTimer.current = setTimeout(() => {
        hintTimer.current = null;
        setHint(null);
      }, 5000);
    }
  };

  const clearMaskedKey = () => {
    if (apiKey === SECRET_MASK) setApiKey("");
  };

  const switchProtocol = (next: ImageGenProtocol) => {
    if (next !== protocol) clearMaskedKey();
    setProtocol(next);
    if (next === "qwen") setBaseUrl(QWEN_IMAGE_GEN_ENDPOINTS[billing]);
    else if (Object.values(QWEN_IMAGE_GEN_ENDPOINTS).includes(baseUrl.trim())) setBaseUrl("");
  };

  const switchBilling = (next: QwenImageGenBilling) => {
    if (next !== billing) clearMaskedKey();
    setBilling(next);
    setBaseUrl(QWEN_IMAGE_GEN_ENDPOINTS[next]);
  };

  const bodyError = protocol === "custom" ? validateImageGenRequestBody(requestBody) : null;
  const responsePathValid = isValidImageGenResponsePath(responsePath);

  const buildConfig = (): ImageGenConfig | null => {
    const url = baseUrl.trim();
    const key = apiKey.trim();
    const m = model.trim();
    if (!url || !key || !m) {
      flash(false, t("skills.imageGen.missingFields"));
      return null;
    }
    if (protocol === "qwen") {
      return { protocol, billing, baseUrl: QWEN_IMAGE_GEN_ENDPOINTS[billing], apiKey: key, model: m };
    }
    if (bodyError) {
      flash(false, t(`skills.imageGen.bodyError.${bodyError}`));
      return null;
    }
    if (!responsePathValid) {
      flash(false, t("skills.imageGen.invalidResponsePath"));
      return null;
    }
    return {
      protocol,
      baseUrl: url,
      apiKey: key,
      model: m,
      requestBody,
      responsePath: responsePath.trim(),
    };
  };

  const save = async () => {
    const config = buildConfig();
    if (!config) return;
    await saveSettings({ skills: { imageGen: config } });
    flash(true, t("skills.imageGen.saved"));
  };

  const disable = async () => {
    await saveSettings({ skills: { imageGen: null } });
    setPreview(null);
    flash(true, t("skills.imageGen.disabled"));
  };

  const test = async () => {
    const config = buildConfig();
    if (!config || testing) return;
    clearHint();
    setTesting(true);
    setPreview(null);
    try {
      const result = await window.spcode.imageGenTest(config);
      if (result.ok) {
        setPreview(result.image);
        flash(true, t("skills.imageGen.testSuccess"));
      } else {
        flash(false, t("skills.imageGen.testFailure", { error: result.error }));
      }
    } finally {
      setTesting(false);
    }
  };

  const inputCls = "form-control w-full bg-bg-main";
  const ready = isImageGenReady(saved);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-elevated" data-testid="skills-image-gen-card">
      {/* 卡片头：技能图标 + 名称 + 工具名 chip + 配置状态 */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Icon name="image" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-text-primary">{t("skills.imageGen.title")}</span>
            <span className="mono rounded-md border border-border bg-bg-main px-1.5 py-0.5 text-[10.5px] text-text-tertiary">
              GenerateImage
            </span>
          </div>
          <div className="mt-0.5 truncate text-[12px] text-text-tertiary">{t("skills.imageGen.description")}</div>
        </div>
        <span className={`shrink-0 text-[12px] ${ready ? "text-accent" : "text-text-tertiary"}`}>
          {ready ? t("skills.imageGen.configured") : t("skills.imageGen.notConfigured")}
        </span>
      </div>

      <div className="px-4 py-3">
        <div
          className="mb-4 flex items-start gap-2.5 rounded-lg border border-accent/20 bg-accent-soft/30 px-3 py-2.5 text-[12px] leading-5 text-text-secondary"
          data-testid="skills-image-gen-sync-note"
        >
          <Icon name="info" size={15} className="mt-0.5 shrink-0 text-accent" />
          <p>{t("skills.imageGen.syncParallel")}</p>
        </div>

        <div className="grid grid-cols-[140px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5">
          <div className="text-[13px] text-text-secondary">{t("skills.imageGen.protocol")}</div>
          <div>
            <Select
              value={protocol}
              options={PROTOCOLS.map((p) => ({ value: p, label: t(`skills.imageGen.protocol.${p}`) }))}
              onChange={(v) => switchProtocol(v as ImageGenProtocol)}
              testId="skills-image-gen-protocol"
            />
            <p className="mt-1 text-[11.5px] leading-4 text-text-tertiary">
              {t(`skills.imageGen.protocolHint.${protocol}`)}
            </p>
            {protocol === "qwen" && (
              <a
                href={
                  billing === "token-plan"
                    ? "https://platform.qianwenai.com/docs/token-plan/best-practices/image-generation"
                    : "https://platform.qianwenai.com/docs/api-reference/image-generation/qwen-text-to-image"
                }
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
              >
                {t("skills.imageGen.qwenDocs")}
                <Icon name="link" size={11} />
              </a>
            )}
          </div>

          {protocol === "qwen" && (
            <>
              <div className="text-[13px] text-text-secondary">{t("skills.imageGen.billing")}</div>
              <div>
                <Select
                  value={billing}
                  options={BILLING_OPTIONS.map((value) => ({
                    value,
                    label: t(`skills.imageGen.billing.${value}`),
                  }))}
                  onChange={(value) => switchBilling(value as QwenImageGenBilling)}
                  testId="skills-image-gen-billing"
                />
                <p className="mt-1 text-[11.5px] leading-4 text-text-tertiary">
                  {t(`skills.imageGen.billingHint.${billing}`)}
                </p>
              </div>
            </>
          )}

          <div className="text-[13px] text-text-secondary">{t("skills.imageGen.baseUrl")}</div>
          <input
            value={baseUrl}
            onChange={(e) => {
              if (e.target.value !== baseUrl) clearMaskedKey();
              setBaseUrl(e.target.value);
            }}
            readOnly={protocol === "qwen"}
            placeholder={t("skills.imageGen.urlPlaceholder")}
            data-testid="skills-image-gen-baseurl"
            className={inputCls}
          />

          <div className="text-[13px] text-text-secondary">{t("skills.imageGen.apiKey")}</div>
          <div>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("skills.imageGen.keyPlaceholder")}
              data-testid="skills-image-gen-apikey"
              className={inputCls}
            />
            {protocol === "custom" && (
              <p className="mt-1 text-[11.5px] leading-4 text-text-tertiary">{t("skills.imageGen.authHint")}</p>
            )}
          </div>

          <div className="text-[13px] text-text-secondary">{t("skills.imageGen.model")}</div>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={t("skills.imageGen.modelPlaceholder")}
            data-testid="skills-image-gen-model"
            className={`${inputCls} mono`}
          />
        </div>

        {protocol === "custom" && (
          <div className="mt-4 border-t border-border pt-3" data-testid="skills-image-gen-custom">
            <label className="block text-[13px] text-text-secondary" htmlFor="skills-image-gen-body">
              {t("skills.imageGen.requestBody")}
            </label>
            <textarea
              id="skills-image-gen-body"
              value={requestBody}
              onChange={(e) => setRequestBody(e.target.value)}
              spellCheck={false}
              rows={9}
              data-testid="skills-image-gen-body"
              className={`${inputCls} mono mt-1.5 resize-y whitespace-pre text-[12px] leading-5`}
            />
            <p className="mt-1 text-[11.5px] leading-4 text-text-tertiary">{t("skills.imageGen.requestBodyHint")}</p>
            {bodyError && (
              <p className="mt-1 text-[12px] text-danger" data-testid="skills-image-gen-body-error">
                {t(`skills.imageGen.bodyError.${bodyError}`)}
              </p>
            )}

            <label className="mt-3 block text-[13px] text-text-secondary" htmlFor="skills-image-gen-response-path">
              {t("skills.imageGen.responsePath")}
            </label>
            <input
              id="skills-image-gen-response-path"
              value={responsePath}
              onChange={(e) => setResponsePath(e.target.value)}
              placeholder={t("skills.imageGen.responsePathPlaceholder")}
              spellCheck={false}
              data-testid="skills-image-gen-response-path"
              className={`${inputCls} mono mt-1.5`}
            />
            <p className="mt-1 text-[11.5px] leading-4 text-text-tertiary">{t("skills.imageGen.responsePathHint")}</p>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            data-testid="skills-image-gen-save"
            className="rounded-lg bg-accent px-4 py-1.5 text-[13px] text-on-accent transition-colors hover:bg-accent-dim"
          >
            {t("save")}
          </button>
          <button
            type="button"
            onClick={() => void test()}
            disabled={testing}
            data-testid="skills-image-gen-test"
            title={t("skills.imageGen.testHint")}
            className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-1.5 text-[13px] text-text-secondary transition-colors hover:bg-bg-hover disabled:opacity-40"
          >
            {testing && <Icon name="refresh" size={13} className="animate-spin" />}
            {testing ? t("skills.imageGen.testing") : t("skills.imageGen.test")}
          </button>
          {saved && (
            <button
              type="button"
              onClick={() => void disable()}
              data-testid="skills-image-gen-disable"
              className="rounded-lg px-3 py-1.5 text-[13px] text-text-tertiary transition-colors hover:text-danger"
            >
              {t("skills.imageGen.disable")}
            </button>
          )}
        </div>
        {hint && (
          <div
            role={hint.ok ? "status" : "alert"}
            className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-5 ${
              hint.ok ? "border-accent/20 bg-accent-soft/20 text-accent" : "border-danger/25 bg-danger/5 text-danger"
            }`}
            data-testid="skills-image-gen-hint"
          >
            <span className="min-w-0 flex-1 break-words">{hint.text}</span>
            {!hint.ok && (
              <button
                type="button"
                onClick={clearHint}
                title={t("skills.imageGen.dismissError")}
                aria-label={t("skills.imageGen.dismissError")}
                data-testid="skills-image-gen-hint-dismiss"
                className="flex size-6 shrink-0 items-center justify-center rounded-md border border-danger/20 transition-colors hover:bg-danger/10"
              >
                <Icon name="x" size={13} />
              </button>
            )}
          </div>
        )}
        <p className="mt-1.5 text-[11.5px] text-text-tertiary">{t("skills.imageGen.testHint")}</p>

        {testing && (
          <ImageGenProgress
            title={t("skills.imageGen.testing")}
            description={t("skills.imageGen.progressHint")}
            testId="skills-image-gen-progress"
          />
        )}
        {preview && (
          <img
            src={`data:${preview.mimeType};base64,${preview.data}`}
            alt={t("skills.imageGen.previewAlt")}
            data-testid="skills-image-gen-preview"
            className="mt-3 max-h-44 rounded-lg border border-border object-contain"
          />
        )}
      </div>
    </div>
  );
}
