// Encrypted backup of the onion service key, made and opened in the browser with the
// same WebCrypto primitives as the identity vault (PBKDF2 + AES-GCM). No React here, so
// tests can run it in Node.
import { b64, fromB64 } from '../core/encoding.ts';
import { deriveKeys, open, seal } from '../core/vault.ts';

export const MIN_BACKUP_PASSPHRASE = 12;
const FORMAT = 'privatum-onion-backup';

/** tor's key files, base64, as the panel's /api/onion/export returns them. */
export interface KeyFiles {
  hostname: string;
  secret_key: string;
  public_key: string;
}

export async function encryptBackup(files: KeyFiles, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { aesKey } = await deriveKeys(passphrase, salt);
  return JSON.stringify({ format: FORMAT, v: 1, salt: b64(salt), data: await seal(aesKey, files) });
}

/** Throws `bad_backup` for another kind of file and `wrong_passphrase` when it does not decrypt. */
export async function decryptBackup(text: string, passphrase: string): Promise<KeyFiles> {
  let parsed: { format?: string; v?: number; salt?: string; data?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('bad_backup');
  }
  if (parsed.format !== FORMAT || parsed.v !== 1 || !parsed.salt || !parsed.data) throw new Error('bad_backup');
  const { aesKey } = await deriveKeys(passphrase, fromB64(parsed.salt));
  return open<KeyFiles>(aesKey, parsed.data);
}
