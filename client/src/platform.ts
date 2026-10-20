// Browser-only adapters: WASM loading and IndexedDB storage.
import init, * as wasm from '../../crypto-wasm/pkg/web/privatum_crypto.js';
import wasmUrl from '../../crypto-wasm/pkg/web/privatum_crypto_bg.wasm?url';
import type { Olm } from './core/messenger.ts';
import type { Storage } from './core/vault.ts';

export async function loadOlm(): Promise<Olm> {
  await init({ module_or_path: wasmUrl });
  return wasm as unknown as Olm;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('privatum', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return idb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = run(db.transaction('kv', mode).objectStore('kv'));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Everything stored here is already sealed with the passphrase-derived key. */
export const storage: Storage = {
  get: (key) => request<string | undefined>('readonly', (s) => s.get(key)),
  set: (key, value) => request<void>('readwrite', (s) => s.put(value, key)),
};
