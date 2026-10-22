/**
 * IndexedDB 极简 KV 封装：持久化配对记录（手机密钥对、桌面公钥、hosts、deviceId）。
 * 密钥对生成后只进不出（无导出接口），与桌面端 ~/.spcode/remote/device.key 同职责。
 */

import { MobileError } from "./i18n";

const DB_NAME = "spcode-remote";
const STORE = "kv";

export interface PairingRecord {
  version: 1;
  /** 桌面 X25519 公钥（base64） */
  desktopPk: string;
  /** 桌面分配的设备 id */
  deviceId: string;
  /** 桌面 harness base url 列表（http://ip:port） */
  hosts: string[];
  /** 本机设备名（配对时上报） */
  deviceName: string;
  /** 手机端 X25519 密钥对（base64） */
  keyPair: { publicKey: string; secretKey: string };
  pairedAt: number;
  /** 协议 v2：下一个出站 seq（跨连接单调；节流落盘） */
  lastOutSeq?: number;
}

const PAIRING_KEY = "pairing";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new MobileError("error.dbOpen"));
  });
}

async function kvGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new MobileError("error.dbRead"));
    });
  } finally {
    db.close();
  }
}

async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new MobileError("error.dbWrite"));
    });
  } finally {
    db.close();
  }
}

async function kvDel(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new MobileError("error.dbDelete"));
    });
  } finally {
    db.close();
  }
}

export function loadPairing(): Promise<PairingRecord | null> {
  return kvGet<PairingRecord>(PAIRING_KEY);
}

export function savePairing(record: PairingRecord): Promise<void> {
  return kvSet(PAIRING_KEY, record);
}

export function clearPairing(): Promise<void> {
  return kvDel(PAIRING_KEY);
}
