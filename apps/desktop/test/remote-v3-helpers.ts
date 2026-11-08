/**
 * 测试辅助：协议 v3 的手机侧握手原语（pair 帧构造、加密 ack 解析、auth 挑战应答）。
 * 各 RemoteServer 集成测试共用，避免每个文件自己拼帧格式。
 */
import type { AuthAckInner, HelloErrorInner, PairAckInner } from "@spcode/shared";
import {
  type BoxKeyPairB64,
  boxEncrypt,
  generateBoxKeyPair,
  openAuthAck,
  openHelloError,
  pairOpen,
  sealPairHello,
} from "@spcode/shared/crypto";

export type PhoneKeys = BoxKeyPairB64;

export function newPhone(): PhoneKeys {
  return generateBoxKeyPair();
}

/** 协议 v3 pair 帧：{t:"pair", v:3, pk, c} */
export function pairFrame(phone: PhoneKeys, desktopPk: string, otp: string, name = "测试机") {
  return {
    t: "pair" as const,
    v: 3 as const,
    pk: phone.publicKey,
    c: sealPairHello({ otp, name }, desktopPk, phone.secretKey),
  };
}

export type PairAckResult = { ok: true; inner: PairAckInner } | { ok: false; error: string };

/** 解开 pair_ack（成败均为密文）；解不开抛错（测试里视为协议违约） */
export function openPairAck(frame: unknown, phone: PhoneKeys, desktopPk: string): PairAckResult {
  const f = frame as { t?: string; ok?: boolean; c?: string };
  if (f.t !== "pair_ack" || typeof f.c !== "string") throw new Error(`not a pair_ack: ${JSON.stringify(frame)}`);
  if (f.ok) {
    const inner = pairOpen(f.c, desktopPk, phone.secretKey);
    if (!inner) throw new Error("pair_ack ok:true 但密文解不开");
    return { ok: true, inner };
  }
  const err: HelloErrorInner | null = openHelloError(f.c, desktopPk, phone.secretKey);
  if (!err) throw new Error("pair_ack ok:false 但密文解不开");
  return { ok: false, error: err.error };
}

export type AuthAckResult = { ok: true; inner: AuthAckInner } | { ok: false; error: string };

export function openAuthAckFrame(frame: unknown, phone: PhoneKeys, desktopPk: string): AuthAckResult {
  const f = frame as { t?: string; ok?: boolean; c?: string };
  if (f.t !== "auth_ack" || typeof f.c !== "string") throw new Error(`not an auth_ack: ${JSON.stringify(frame)}`);
  if (f.ok) {
    const inner = openAuthAck(f.c, desktopPk, phone.secretKey);
    if (!inner) throw new Error("auth_ack ok:true 但密文解不开");
    return { ok: true, inner };
  }
  const err = openHelloError(f.c, desktopPk, phone.secretKey);
  if (!err) throw new Error("auth_ack ok:false 但密文解不开");
  return { ok: false, error: err.error };
}

/** auth_proof 帧（挑战 nonce 的 box 密封） */
export function proofFrame(nonce: string, phone: PhoneKeys, desktopPk: string, deviceId?: string) {
  return {
    t: "auth_proof" as const,
    c: boxEncrypt(nonce, desktopPk, phone.secretKey),
    ...(deviceId ? { deviceId } : {}),
  };
}
