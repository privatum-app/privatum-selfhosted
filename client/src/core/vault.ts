// Local-only encryption of the client state with WebCrypto primitives.
// The passphrase never leaves the device (THREAT-MODEL R1, R10).
import { b64, fromB64, fromUtf8, utf8 } from './encoding.ts';

// Fixed in code, never read from the server (R10).
const ITERATIONS = 600_000;
const AAD = utf8('privatum-vault-v1');

export interface Keys {
  pickleKey: Uint8Array; // for vodozemac pickles
  aesKey: CryptoKey; // for the sealed app state
}

export interface Storage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  /** Removes everything this app stored (used by logout). */
  clear(): Promise<void>;
}

export async function deriveKeys(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<Keys> {
  const base = await crypto.subtle.importKey('raw', utf8(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, 512),
  );
  const aesKey = await crypto.subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const pickleKey = bits.slice(0, 32);
  bits.fill(0);
  return { pickleKey, aesKey };
}

export async function seal(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, utf8(JSON.stringify(value)));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

/** Throws `wrong_passphrase` when the data does not authenticate (wrong passphrase or tampered data). */
export async function open<T>(key: CryptoKey, sealed: string): Promise<T> {
  const [iv, ct] = sealed.split('.');
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv), additionalData: AAD }, key, fromB64(ct));
  } catch {
    // Only this step means "wrong passphrase"; any later failure must surface as itself.
    throw new Error('wrong_passphrase');
  }
  return JSON.parse(fromUtf8(new Uint8Array(pt))) as T;
}
