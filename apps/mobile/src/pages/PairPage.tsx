/**
 * 配对页：摄像头扫码（qr-scanner）+ 手动粘贴 QR payload 兜底。
 * 配对错误按桌面语义展示（otp 错误/过期/锁定）；成功后记录落 IndexedDB 并建连。
 */

import QrScanner from "qr-scanner";
import { useEffect, useRef, useState } from "react";
import { PAIR_ERROR_TEXT, PairError, pairWithQr } from "../lib/client";
import { savePairing } from "../lib/db";
import { attachPairedRecord } from "../state/controller";

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android 手机";
  return "手机";
}

export function PairPage() {
  const [name, setName] = useState(guessDeviceName);
  const [payload, setPayload] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScanner | null>(null);

  const doPair = async (qrText: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const record = await pairWithQr(qrText, name.trim() || "手机");
      await savePairing(record);
      attachPairedRecord(record);
    } catch (err) {
      setError(
        err instanceof PairError
          ? (PAIR_ERROR_TEXT[err.code] ?? err.message)
          : err instanceof Error
            ? err.message
            : String(err),
      );
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
      setError("无法打开摄像头（需要授权，且在 http 局域网页面下浏览器可能禁止）——可改用下方手动粘贴");
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
    <div className="flex h-full flex-col overflow-y-auto px-5 py-8">
      <h1 className="text-xl font-bold text-slate-100">连接到桌面 Spcode</h1>
      <p className="mt-2 text-sm leading-6 text-slate-400">
        在桌面端「设置 → 远程控制」开启服务并展示配对二维码，然后用下方任一方式完成配对。 配对为端到端加密（X25519 +
        NaCl box），配对码 5 分钟内有效、仅可使用一次。
      </p>

      <label className="mt-6 block text-xs text-slate-400">
        本机设备名
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={30}
          className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
        />
      </label>

      {scanning ? (
        <div className="mt-4">
          <video ref={videoRef} className="w-full rounded-xl bg-black" muted playsInline />
          <button
            type="button"
            onClick={stopScan}
            className="mt-3 w-full rounded-lg border border-slate-700 py-2 text-sm text-slate-300"
          >
            取消扫码
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setScanning(true);
          }}
          className="mt-4 w-full rounded-xl bg-sky-600 py-3 text-sm font-medium text-white active:bg-sky-500"
        >
          扫码配对
        </button>
      )}

      <div className="mt-6">
        <div className="text-xs text-slate-500">摄像头不可用？粘贴配对码（spcode-remote://pair?…）</div>
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={3}
          placeholder="spcode-remote://pair?v=1&hosts=…"
          className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-slate-200 outline-none focus:border-sky-500"
        />
        <button
          type="button"
          disabled={busy || !payload.trim()}
          onClick={() => void doPair(payload)}
          className="mt-2 w-full rounded-lg border border-sky-700 py-2 text-sm text-sky-300 disabled:opacity-40"
        >
          {busy ? "配对中…" : "使用配对码连接"}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-sm leading-6 text-red-200">
          {error}
        </div>
      )}
    </div>
  );
}
