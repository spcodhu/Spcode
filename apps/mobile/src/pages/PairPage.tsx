/**
 * 配对页：摄像头扫码（qr-scanner）+ 手动粘贴 QR payload 兜底。
 * 扫码与手动提交共享互斥锁；扫描器和配对请求均有代次保护，迟到结果不会覆盖新状态。
 */

import QrScanner from "qr-scanner";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { pairWithQr } from "../lib/client";
import { savePairing } from "../lib/db";
import { errorText, MobileError } from "../lib/i18n";
import { attachPairedRecord } from "../state/controller";

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "android";
  return "phone";
}

function cameraStartError(error: unknown): MobileError {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return new MobileError("pair.cameraPermissionDenied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new MobileError("pair.cameraNotFound");
  return new MobileError("pair.cameraError");
}

export function PairPage() {
  const { t } = useTranslation("mobile");
  const [name, setName] = useState<string | null>(null);
  const device = guessDeviceName();
  const defaultName = device === "android" ? t("pair.androidPhone") : device === "phone" ? t("pair.phone") : device;
  const [payload, setPayload] = useState("");
  const [scanning, setScanning] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const payloadRef = useRef<HTMLTextAreaElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const cameraStartingRef = useRef(false);
  const scanGenerationRef = useRef(0);
  const pairGenerationRef = useRef(0);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const deviceNameRef = useRef("");
  deviceNameRef.current = (name ?? defaultName).trim() || t("pair.phone");

  const stopScan = () => {
    scanGenerationRef.current++;
    cameraStartingRef.current = false;
    setCameraStarting(false);
    scannerRef.current?.destroy();
    scannerRef.current = null;
    setScanning(false);
  };

  const startScan = async () => {
    if (busyRef.current || cameraStartingRef.current) return;
    const generation = ++scanGenerationRef.current;
    setError(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(new MobileError("pair.cameraInsecure"));
      payloadRef.current?.focus();
      return;
    }
    cameraStartingRef.current = true;
    setCameraStarting(true);
    try {
      // 必须在安全上下文中由用户点击显式请求，浏览器才会展示正常的权限确认窗口。
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "environment" },
      });
      for (const track of stream.getTracks()) track.stop();
      if (generation !== scanGenerationRef.current || !mountedRef.current) return;
      setScanning(true);
    } catch (error) {
      if (generation !== scanGenerationRef.current || !mountedRef.current) return;
      setError(cameraStartError(error));
      setScanning(false);
    } finally {
      cameraStartingRef.current = false;
      if (mountedRef.current) setCameraStarting(false);
    }
  };

  const doPair = async (qrText: string) => {
    if (busyRef.current || !mountedRef.current) return;
    // 手动配对与扫码互斥；扫描回调也走这里，先使旧 scanner 的后续回调失效。
    stopScan();
    busyRef.current = true;
    const generation = ++pairGenerationRef.current;
    const deviceName = deviceNameRef.current;
    setBusy(true);
    setError(null);
    try {
      const record = await pairWithQr(qrText, deviceName);
      if (generation !== pairGenerationRef.current || !mountedRef.current) return;
      await savePairing(record);
      if (generation !== pairGenerationRef.current || !mountedRef.current) return;
      attachPairedRecord(record);
    } catch (err) {
      if (generation !== pairGenerationRef.current || !mountedRef.current) return;
      setError(err);
      busyRef.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pairGenerationRef.current++;
      scanGenerationRef.current++;
      scannerRef.current?.destroy();
      scannerRef.current = null;
    };
  }, []);

  // 扫码生命周期。设备名通过 ref 在识别成功时读取，避免 scanner 闭包冻结旧值。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在扫码开关变化时重建扫描器，配对函数统一走 ref/代次保护
  useEffect(() => {
    if (!scanning) return;
    const video = videoRef.current;
    if (!video) return;
    const generation = scanGenerationRef.current;
    const scanner = new QrScanner(
      video,
      (result) => {
        if (generation !== scanGenerationRef.current || busyRef.current || !mountedRef.current) return;
        void doPair(result.data);
      },
      { returnDetailedScanResult: true, highlightScanRegion: true },
    );
    scannerRef.current = scanner;
    scanner.start().catch(() => {
      if (generation !== scanGenerationRef.current || !mountedRef.current) return;
      setError(new MobileError("pair.cameraError"));
      setScanning(false);
    });
    return () => {
      if (scanGenerationRef.current === generation) scanGenerationRef.current++;
      scanner.destroy();
      if (scannerRef.current === scanner) scannerRef.current = null;
    };
  }, [scanning]);

  return (
    <div className="flex h-full flex-col overflow-y-auto px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-6">
      <h1 className="text-xl font-bold text-slate-100">{t("pair.title")}</h1>
      <p className="mt-2 text-sm leading-6 text-slate-400">{t("pair.help")}</p>

      <label className="mt-6 block text-xs text-slate-400">
        {t("pair.deviceName")}
        <input
          data-testid="pair-device-name"
          value={name ?? defaultName}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          maxLength={30}
          className="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-base text-slate-100 outline-none focus:border-teal-500"
        />
      </label>

      {scanning ? (
        <div className="mt-4">
          <video ref={videoRef} className="aspect-[4/3] w-full rounded-xl bg-black object-cover" muted playsInline />
          <button
            type="button"
            onClick={stopScan}
            className="mt-3 min-h-11 w-full rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-200"
          >
            {t("pair.cancelScan")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="pair-scan"
          disabled={busy || cameraStarting}
          onClick={() => void startScan()}
          className="mt-4 min-h-12 w-full rounded-xl bg-teal-700 px-4 py-3 text-sm font-medium text-white active:bg-teal-600 disabled:opacity-40"
        >
          {cameraStarting ? t("pair.cameraStarting") : t("pair.scan")}
        </button>
      )}

      <div className="mt-6">
        <div className="text-xs text-slate-500">{t("pair.pasteHelp")}</div>
        <textarea
          ref={payloadRef}
          data-testid="pair-payload"
          value={payload}
          disabled={busy}
          onChange={(e) => setPayload(e.target.value)}
          rows={3}
          placeholder="spcode-remote://pair?v=2&hosts=…"
          className="mt-2 min-h-24 w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 font-mono text-base leading-6 text-slate-200 outline-none focus:border-teal-500"
        />
        <button
          type="button"
          data-testid="pair-connect"
          disabled={busy || !payload.trim()}
          onClick={() => void doPair(payload)}
          className="mt-2 min-h-12 w-full rounded-xl border border-teal-700 px-4 py-3 text-sm text-teal-200 disabled:opacity-40"
        >
          {busy ? t("pair.pairing") : t("pair.connect")}
        </button>
      </div>

      {error != null && (
        <div
          role="alert"
          className="safe-break mt-4 rounded-xl border border-red-800 bg-red-950/60 px-3 py-2.5 text-sm leading-6 text-red-200"
        >
          {errorText(error)}
        </div>
      )}
    </div>
  );
}
