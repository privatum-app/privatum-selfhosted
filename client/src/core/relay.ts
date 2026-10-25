// HTTP/WebSocket client for the relay API (docs/PROTOCOL.md §3–4).
import { concat, fromB64, utf8 } from './encoding.ts';

export interface SignedKey {
  key_id: string;
  key: string;
  signature: string;
}

export interface KeyBundle {
  mailbox_id: string;
  ed25519: string;
  curve25519: string;
  one_time_key: SignedKey | null;
  fallback_key: SignedKey | null;
}

export interface Delivered {
  id: number;
  from: string;
  envelope: string;
  created_at: number;
}

export class RelayError extends Error {
  status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

export interface RelayOptions {
  base: string; // e.g. http://xyz.onion
  host: string; // the onion hostname signatures are bound to (location.host)
  mailbox: string;
  sign: (message: Uint8Array) => string;
  fetch?: typeof fetch;
}

export class Relay {
  opts: RelayOptions;
  token: string | null = null;

  constructor(opts: RelayOptions) {
    this.opts = opts;
  }

  private async raw(method: string, path: string, body?: unknown, token?: string | null): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await (this.opts.fetch ?? fetch)(this.opts.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new RelayError(res.status, (json as { error?: string }).error ?? 'error');
    return json;
  }

  /** `invite` is needed only for a new mailbox on an invite-only instance. */
  async register(ed25519: string, curve25519: string, invite?: string): Promise<string> {
    const signature = this.opts.sign(concat(utf8('privatum-register-v1'), fromB64(ed25519), fromB64(curve25519)));
    const r = (await this.raw('POST', '/v1/register', { ed25519, curve25519, signature, invite })) as { mailbox_id: string };
    return r.mailbox_id;
  }

  /** Who may join this instance: "open", "invite" or "closed". */
  async registration(): Promise<string> {
    return ((await this.raw('GET', '/v1/instance')) as { registration: string }).registration;
  }

  /** Single-use code (one week) to put in our invite link on an invite-only instance. */
  async mintInvite(): Promise<string> {
    return ((await this.call('POST', '/v1/invites', {})) as { code: string }).code;
  }

  async auth(): Promise<string> {
    const { nonce } = (await this.raw('POST', '/v1/auth/challenge', { mailbox_id: this.opts.mailbox })) as { nonce: string };
    const signature = this.opts.sign(concat(utf8('privatum-auth-v1'), utf8(this.opts.host), fromB64(nonce)));
    const r = (await this.raw('POST', '/v1/auth/verify', { mailbox_id: this.opts.mailbox, nonce, signature })) as { token: string };
    this.token = r.token;
    return r.token;
  }

  /** Authenticated call; re-authenticates once when the token has expired. */
  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.token) await this.auth();
    try {
      return await this.raw(method, path, body, this.token);
    } catch (e) {
      if (!(e instanceof RelayError) || e.status !== 401) throw e;
      await this.auth();
      return this.raw(method, path, body, this.token);
    }
  }

  putKeys(one_time_keys: SignedKey[], fallback_key: SignedKey | null) {
    return this.call('PUT', '/v1/keys', { one_time_keys, fallback_key });
  }

  async getKeys(mailbox: string): Promise<KeyBundle> {
    return (await this.call('GET', `/v1/keys/${mailbox}`)) as KeyBundle;
  }

  send(to: string, envelope: string) {
    return this.call('POST', '/v1/messages', { to, envelope });
  }

  ack(id: number) {
    return this.call('DELETE', `/v1/messages/${id}`);
  }

  /** Opens the inbox; the token goes in the first frame, never in the URL. */
  async openInbox(onMessage: (d: Delivered) => void, onClose: () => void): Promise<WebSocket> {
    const token = await this.auth();
    const ws = new WebSocket(this.opts.base.replace(/^http/, 'ws') + '/v1/inbox');
    ws.onopen = () => ws.send(JSON.stringify({ token }));
    ws.onmessage = (e) => onMessage(JSON.parse(String(e.data)) as Delivered);
    ws.onclose = onClose;
    return ws;
  }
}
