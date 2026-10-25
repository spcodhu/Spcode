/**
 * 配对页：摄像头扫码（qr-scanner）+ 手动粘贴 QR payload 兜底。
 * 配对错误按桌面语义展示（otp 错误/过期/锁定）；成功后记录落 IndexedDB 并建连。
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

export function PairPage() {
  const { t } = useTranslation("mobile");
  const [name, setName] = useState<string | null>(null);
  const device = guessDeviceName();
  const defaultName = device === "android" ? t("pair.androidPhone") : device === "phone" ? t("pair.phone") : device;
  const [payload, setPayload] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);

  const doPair = async (qrText: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const record = await pairWithQr(qrText, (name ?? defaultName).trim() || t("pair.phone"));
      await savePairing(record);
      attachPairedRecord(record);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  // 扫码生命周期
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在扫码开关变化时重建扫描器（doPair 读取最新 state 即可）
  useEffect(() => {
    if (!scanning) return;
    const video = videoRef.current;
    if (!video) return;
    const scanner = new QrScanner(
      video,
      (result) => {
        stopScan();
        void doPair(result.data);
      },
      { returnDetailedScanResult: true, highlightScanRegion: true },
    );
    scannerRef.current = scanner;
    scanner.start().catch(() => {
      setError(new MobileError("pair.cameraError"));
      setScanning(false);
    });
    return () => {
      scanner.destroy();
      scannerRef.current = null;
    };
  }, [scanning]);

  const stopScan = () => {
    scannerRef.current?.destroy();
    scannerRef.current = null;
    setScanning(false);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto px-5 pb-[max(2rem,env(safe-area-inset-bottom))] pt-6">
      <h1 className="text-xl font-bold text-slate-100">{t("pair.title")}</h1>
      <p className="mt-2 text-sm leading-6 text-slate-400">{t("pair.help")}</p>

      <label className="mt-6 block text-xs text-slate-400">
        {t("pair.deviceName")}
        <input
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
          disabled={busy}
          onClick={() => {
            setError(null);
            setScanning(true);
          }}
          className="mt-4 min-h-12 w-full rounded-xl bg-teal-700 px-4 py-3 text-sm font-medium text-white active:bg-teal-600 disabled:opacity-40"
        >
          {t("pair.scan")}
        </button>
      )}

      <div className="mt-6">
        <div className="text-xs text-slate-500">{t("pair.pasteHelp")}</div>
        <textarea
          value={payload}
          disabled={busy}
          onChange={(e) => setPayload(e.target.value)}
          rows={3}
          placeholder="spcode-remote://pair?v=2&hosts=…"
          className="mt-2 min-h-24 w-full rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 font-mono text-base leading-6 text-slate-200 outline-none focus:border-teal-500"
        />
        <button
          type="button"
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
