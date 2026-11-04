import { b32, concat, fromB64, utf8 } from './encoding.ts';

const sha256 = async (data: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));

/** Self-certifying address: base32(SHA-256("privatum-id-v1" || ed25519 || curve25519)). */
export async function mailboxId(ed25519: string, curve25519: string): Promise<string> {
  return b32(await sha256(concat(utf8('privatum-id-v1'), fromB64(ed25519), fromB64(curve25519))));
}

export const isMailboxId = (s: string) => /^[a-z2-7]{52}$/.test(s);

/** 30 digits in 6 groups of 5, identical on both sides; compare by voice or in person. */
export async function safetyCode(a: string, b: string): Promise<string> {
  const h = await sha256(utf8([a, b].sort().join(':')));
  const groups: string[] = [];
  for (let g = 0; g < 6; g++) {
    let n = 0;
    for (let i = 0; i < 5; i++) n = n * 256 + h[g * 5 + i];
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

export const inviteLink = (origin: string, mailbox: string) => `${origin}/#c=${mailbox}`;

/** Accepts a full invite link or a bare mailbox id. */
export function parseInvite(text: string): string | null {
  const t = text.trim();
  const m = t.match(/#c=([a-z2-7]{52})(?:&|$)/) ?? t.match(/^([a-z2-7]{52})$/);
  return m ? m[1] : null;
}
