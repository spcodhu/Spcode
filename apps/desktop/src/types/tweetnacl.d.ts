/**
 * tweetnacl 无官方类型包（@types/tweetnacl 不存在于 npm registry），
 * 这里只声明 remote/ 模块用到的 API 子集。
 */
declare module "tweetnacl" {
  export interface BoxKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  export interface BoxAPI {
    (msg: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
    open(box: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null;
    keyPair(): BoxKeyPair;
    nonceLength: number;
    publicKeyLength: number;
    secretKeyLength: number;
  }

  export interface SecretBoxAPI {
    (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
    open(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
    nonceLength: number;
    keyLength: number;
  }

  export const box: BoxAPI;
  export const secretbox: SecretBoxAPI;
  export function randomBytes(n: number): Uint8Array;

  const nacl: {
    box: BoxAPI;
    secretbox: SecretBoxAPI;
    randomBytes: (n: number) => Uint8Array;
  };
  export default nacl;
}
