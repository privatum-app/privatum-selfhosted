// Encodings shared with the relay: unpadded standard base64 and lowercase,
// unpadded RFC 4648 base32 (same output as the relay's data-encoding crate).

export const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '');
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function b32(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1; // keep only unconsumed bits so `value` never overflows
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
