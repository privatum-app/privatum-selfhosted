// Messaging logic, independent of React and of the browser (runs in Node tests).
// All cryptography is vodozemac's (via `olm`); this file only wires it up.
import { b64, concat, fromB64, fromUtf8, utf8 } from './encoding.ts';
import { isMailboxId, mailboxId } from './identity.ts';
import { Relay, type Delivered, type SignedKey } from './relay.ts';
import { deriveKeys, open, seal, type Keys, type Storage } from './vault.ts';

// Structural types of the wasm-bindgen module (pkg/web or pkg/node).
export interface OlmSession {
  encrypt(plaintext: Uint8Array): { messageType: number; ciphertext: string };
  decrypt(messageType: number, ciphertext: string): Uint8Array;
  pickle(key: Uint8Array): string;
}
export interface OlmAccount {
  readonly ed25519: string;
  readonly curve25519: string;
  sign(message: Uint8Array): string;
  generateOneTimeKeys(count: number): void;
  oneTimeKeys(): string;
  generateFallbackKey(): void;
  fallbackKey(): string;
  markKeysAsPublished(): void;
  createOutboundSession(identityKey: string, oneTimeKey: string): OlmSession;
  createInboundSession(theirIdentityKey: string, ciphertext: string): { plaintext: Uint8Array; takeSession(): OlmSession };
  pickle(key: Uint8Array): string;
}
export interface Olm {
  Account: { new (): OlmAccount; fromPickle(pickle: string, key: Uint8Array): OlmAccount };
  Session: { fromPickle(pickle: string, key: Uint8Array): OlmSession };
  verifyEd25519(key: string, message: Uint8Array, signature: string): boolean;
}

export interface Message {
  /** Random id carried inside the encrypted payload; lets the sender edit or delete it. */
  id?: string;
  out: boolean;
  text: string;
  at: number;
  failed?: boolean;
  edited?: boolean;
  deleted?: boolean;
}

/** Number of avatars in the client's gallery; contacts only ever send an index. */
export const AVATAR_COUNT = 20;
const isAvatar = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < AVATAR_COUNT;

/** Longest display name a contact may send; longer names are cut. */
export const MAX_NAME = 32;
// Control and format characters (bidi overrides included) are stripped so a name can't disguise itself.
const cleanName = (x: unknown) => (typeof x === 'string' ? x.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, MAX_NAME) || undefined : undefined);

/** Name given to a contact when nobody typed one. */
export const defaultName = (mailbox: string) => `Contato ${mailbox.slice(0, 6)}`;

/** The name we typed wins; otherwise the name the contact chose; otherwise the default. */
export const contactName = (c: Contact) => (c.nick && c.name === defaultName(c.mailbox) ? c.nick : c.name);

export interface Contact {
  mailbox: string;
  ed25519: string;
  curve25519: string;
  name: string;
  /** False when they wrote first: compare the safety code before trusting. */
  addedByMe: boolean;
  verified: boolean;
  messages: Message[];
  /** Avatar index the contact chose (sent to us encrypted); none means the sigil. */
  avatar?: number;
  /** Display name the contact chose (sent to us encrypted). */
  nick?: string;
}

interface Saved {
  v: 1;
  account: string;
  mailbox: string;
  contacts: Record<string, Contact>;
  sessions: Record<string, string[]>; // pickles, most recently used first
  /** Contacts whose sessions came from a backup: start a fresh session before sending. */
  resync?: string[];
  /** Messages sent or received since the last backup export. */
  unsaved?: number;
  /** Mailboxes whose messages are dropped unread. */
  blocked?: string[];
  /** Our own avatar index, shared with contacts inside encrypted messages. */
  avatar?: number;
  /** Our own display name, shared with contacts inside encrypted messages. */
  nick?: string;
}

const BACKUP_FORMAT = 'privatum-backup';
const saltBytes = (salt: string) => Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));

interface Envelope {
  v: 1;
  from_ed25519: string;
  from_curve25519: string;
  type: number;
  ciphertext: string;
}

export interface Deps {
  olm: Olm;
  storage: Storage;
  base: string;
  host: string;
  fetch?: typeof fetch;
}

export class KeyMismatchError extends Error {}

const MAX_TEXT = 4000;
const PAD = 256;
const OTK_BATCH = 20;

/** Plaintext JSON padded with spaces to a multiple of 256 bytes (R5). */
function pad(obj: unknown): Uint8Array {
  const raw = utf8(JSON.stringify(obj));
  const out = new Uint8Array(Math.ceil((raw.length + 1) / PAD) * PAD).fill(0x20);
  out.set(raw);
  return out;
}

export class Messenger {
  private deps: Deps;
  private keys: Keys;
  private account: OlmAccount;
  private state: Saved;
  private sessions = new Map<string, OlmSession[]>();
  // Two chains: receives run one at a time, and so do saves. A receive awaits a
  // save, so they must not share a chain (it would wait on itself).
  private inbox: Promise<unknown> = Promise.resolve();
  private saving: Promise<unknown> = Promise.resolve();
  private socket: WebSocket | null = null;
  private stopped = false;
  private listeners = new Set<() => void>();
  private incoming = new Set<(mailbox: string) => void>();
  readonly relay: Relay;

  private constructor(deps: Deps, keys: Keys, account: OlmAccount, state: Saved) {
    this.deps = deps;
    this.keys = keys;
    this.account = account;
    this.state = state;
    this.relay = new Relay({
      base: deps.base,
      host: deps.host,
      mailbox: state.mailbox,
      sign: (m) => account.sign(m),
      fetch: deps.fetch,
    });
    for (const [mailbox, pickles] of Object.entries(state.sessions)) {
      this.sessions.set(mailbox, pickles.map((p) => deps.olm.Session.fromPickle(p, keys.pickleKey)));
    }
  }

  static async exists(storage: Storage): Promise<boolean> {
    return (await storage.get('state')) !== undefined;
  }

  static async create(passphrase: string, deps: Deps): Promise<Messenger> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keys = await deriveKeys(passphrase, salt);
    const account = new deps.olm.Account();
    account.generateFallbackKey();
    const mailbox = await mailboxId(account.ed25519, account.curve25519);
    const state: Saved = { v: 1, account: '', mailbox, contacts: {}, sessions: {} };
    const m = new Messenger(deps, keys, account, state);
    await deps.storage.set('salt', btoa(String.fromCharCode(...salt)));
    await m.save();
    await m.connect();
    return m;
  }

  /** Throws if the passphrase is wrong (the sealed state fails to authenticate). */
  static async unlock(passphrase: string, deps: Deps): Promise<Messenger> {
    const [salt, sealed] = [await deps.storage.get('salt'), await deps.storage.get('state')];
    if (!salt || !sealed) throw new Error('no_identity');
    const keys = await deriveKeys(passphrase, saltBytes(salt));
    const state = await open<Saved>(keys.aesKey, sealed);
    const account = deps.olm.Account.fromPickle(state.account, keys.pickleKey);
    const m = new Messenger(deps, keys, account, state);
    await m.connect();
    return m;
  }

  /**
   * Restores an identity from an exported backup. Throws `bad_backup` for a
   * malformed file and `wrong_passphrase` for a wrong passphrase.
   */
  static async importBackup(text: string, passphrase: string, deps: Deps): Promise<Messenger> {
    let file: { format?: unknown; v?: unknown; salt?: unknown; state?: unknown };
    try {
      file = JSON.parse(text);
    } catch {
      throw new Error('bad_backup');
    }
    if (file.format !== BACKUP_FORMAT || file.v !== 1 || typeof file.salt !== 'string' || typeof file.state !== 'string') {
      throw new Error('bad_backup');
    }
    const keys = await deriveKeys(passphrase, saltBytes(file.salt));
    const state = await open<Saved>(keys.aesKey, file.state);
    // Never encrypt with restored sessions: if the backup is older than the live
    // ratchet, encrypting would reuse message keys. They stay usable for decrypting.
    state.resync = Object.keys(state.contacts);
    state.unsaved = 0;
    const account = deps.olm.Account.fromPickle(state.account, keys.pickleKey);
    const m = new Messenger(deps, keys, account, state);
    await deps.storage.set('salt', file.salt);
    await m.save();
    await m.connect();
    return m;
  }

  /** The sealed state plus its salt; protected only by the local passphrase. */
  async exportBackup(): Promise<string> {
    this.state.unsaved = 0;
    await this.save();
    this.changed();
    const [salt, state] = [await this.deps.storage.get('salt'), await this.deps.storage.get('state')];
    return JSON.stringify({ format: BACKUP_FORMAT, v: 1, salt, state });
  }

  get unsaved(): number {
    return this.state.unsaved ?? 0;
  }

  get mailbox() {
    return this.state.mailbox;
  }

  get contacts(): Contact[] {
    return Object.values(this.state.contacts);
  }

  contact(mailbox: string): Contact | undefined {
    return this.state.contacts[mailbox];
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /** Serialized so concurrent saves never interleave. */
  private save(): Promise<void> {
    const run = async () => {
      this.state.account = this.account.pickle(this.keys.pickleKey);
      this.state.sessions = Object.fromEntries(
        [...this.sessions].map(([mb, list]) => [mb, list.map((s) => s.pickle(this.keys.pickleKey))]),
      );
      await this.deps.storage.set('state', await seal(this.keys.aesKey, this.state));
    };
    const next = this.saving.then(run, run);
    this.saving = next.catch(() => {});
    return next;
  }

  /** Registers (idempotent), tops up one-time keys and opens the inbox. */
  private async connect() {
    await this.relay.register(this.account.ed25519, this.account.curve25519);
    await this.publishKeys();
    await this.openInbox();
  }

  private async publishKeys() {
    this.account.generateOneTimeKeys(OTK_BATCH);
    const sign = (key_id: string, key: string): SignedKey => ({
      key_id,
      key,
      signature: this.account.sign(concat(utf8('privatum-otk-v1'), fromB64(key))),
    });
    const otks = Object.entries(JSON.parse(this.account.oneTimeKeys()) as Record<string, string>).map(([i, k]) => sign(i, k));
    const fb = Object.entries(JSON.parse(this.account.fallbackKey()) as Record<string, string>).map(([i, k]) => sign(i, k));
    // The relay replaces our previous batch, so it never hands out keys we no longer hold.
    await this.relay.putKeys(otks, fb[0] ?? null);
    this.account.markKeysAsPublished();
    await this.save();
  }

  private async openInbox() {
    if (this.stopped) return;
    this.socket = await this.relay.openInbox(
      (d) => {
        this.inbox = this.inbox.then(() => this.receive(d)).catch(() => {});
      },
      () => {
        this.socket = null;
        // Tokens expire after 15 min and the relay closes the socket: reconnect.
        if (!this.stopped) setTimeout(() => this.openInbox().catch(() => {}), 2000);
      },
    );
  }

  close() {
    this.stopped = true;
    this.socket?.close();
  }

  /** Logs out: closes the connection and erases the identity from this browser. */
  async logout(): Promise<void> {
    this.close();
    await this.saving.catch(() => {});
    await this.deps.storage.clear();
  }

  /** Waits until every queued receive/save has finished (used by tests). */
  async idle(): Promise<void> {
    await this.inbox;
    await this.saving;
  }

  /**
   * Fetches the peer's keys and starts a session. Refuses keys that do not
   * hash to the mailbox id from the invite (R2/R3), or an unsigned one-time key.
   */
  private async startSession(mailbox: string): Promise<{ session: OlmSession; ed25519: string; curve25519: string }> {
    const k = await this.relay.getKeys(mailbox);
    if ((await mailboxId(k.ed25519, k.curve25519)) !== mailbox) throw new KeyMismatchError('identity_mismatch');
    const known = this.state.contacts[mailbox];
    if (known && (known.ed25519 !== k.ed25519 || known.curve25519 !== k.curve25519)) throw new KeyMismatchError('identity_mismatch');
    const otk = k.one_time_key ?? k.fallback_key;
    if (!otk) throw new Error('no_keys');
    const signed = concat(utf8('privatum-otk-v1'), fromB64(otk.key));
    if (!this.deps.olm.verifyEd25519(k.ed25519, signed, otk.signature)) throw new KeyMismatchError('bad_key_signature');
    return { session: this.account.createOutboundSession(k.curve25519, otk.key), ed25519: k.ed25519, curve25519: k.curve25519 };
  }

  /**
   * Forgets the contact and its history on this device. The sessions are kept,
   * so if the person writes again the conversation reappears (as unverified).
   */
  async deleteContact(mailbox: string): Promise<void> {
    delete this.state.contacts[mailbox];
    await this.save();
    this.changed();
  }

  /** Deletes the contact and its sessions and drops anything it sends from now on. Adding its invite again unblocks. */
  async blockContact(mailbox: string): Promise<void> {
    this.state.blocked = [...new Set([...(this.state.blocked ?? []), mailbox])];
    this.sessions.delete(mailbox);
    this.state.resync = (this.state.resync ?? []).filter((m) => m !== mailbox);
    await this.deleteContact(mailbox);
  }

  async addContact(mailbox: string, name: string): Promise<Contact> {
    if (!isMailboxId(mailbox) || mailbox === this.mailbox) throw new Error('bad_invite');
    this.state.blocked = (this.state.blocked ?? []).filter((m) => m !== mailbox);
    const existing = this.state.contacts[mailbox];
    if (existing) return existing;
    const { session, ed25519, curve25519 } = await this.startSession(mailbox);
    const c: Contact = { mailbox, ed25519, curve25519, name, addedByMe: true, verified: false, messages: [] };
    this.state.contacts[mailbox] = c;
    this.sessions.set(mailbox, [session]);
    await this.save();
    this.changed();
    return c;
  }

  async send(mailbox: string, text: string): Promise<void> {
    const c = this.state.contacts[mailbox];
    const body = text.trim();
    if (!c || !body || body.length > MAX_TEXT) throw new Error('bad_message');
    const at = Date.now();
    const id = b64(crypto.getRandomValues(new Uint8Array(9)));
    const msg: Message = { id, out: true, text: body, at };
    c.messages.push(msg);
    await this.deliver(mailbox, { k: 'text', id, b: body, t: at, ...this.profile() }, () => {
      msg.failed = true;
    });
  }

  /** Edits one of our own messages here and on the contact's device. */
  async editMessage(mailbox: string, id: string, text: string): Promise<void> {
    const c = this.state.contacts[mailbox];
    const msg = c?.messages.find((m) => m.out && m.id === id && !m.deleted);
    const body = text.trim();
    if (!c || !msg || !body || body.length > MAX_TEXT) throw new Error('bad_message');
    msg.text = body;
    msg.edited = true;
    await this.deliver(mailbox, { k: 'edit', id, b: body });
  }

  /**
   * Deletes a message. "For everyone" only applies to our own messages and is a
   * request: a modified client, a screenshot or an older backup can still keep it.
   */
  async deleteMessage(mailbox: string, msg: Message, forEveryone: boolean): Promise<void> {
    const c = this.state.contacts[mailbox];
    if (!c || !c.messages.includes(msg)) return;
    if (!forEveryone) {
      c.messages.splice(c.messages.indexOf(msg), 1);
      await this.save();
      this.changed();
      return;
    }
    if (!msg.out || !msg.id) throw new Error('bad_message');
    msg.deleted = true;
    msg.text = '';
    await this.deliver(mailbox, { k: 'del', id: msg.id });
  }

  get avatar(): number | undefined {
    return this.state.avatar;
  }

  get nick(): string | undefined {
    return this.state.nick;
  }

  /** Chooses an avatar (null = back to the sigil) and tells every contact, best effort. */
  async setAvatar(avatar: number | null): Promise<void> {
    if (avatar !== null && !isAvatar(avatar)) throw new Error('bad_avatar');
    this.state.avatar = avatar ?? undefined;
    await this.shareProfile();
  }

  /** Chooses the name contacts see (empty = none) and tells every contact, best effort. */
  async setNick(nick: string): Promise<void> {
    this.state.nick = cleanName(nick);
    await this.shareProfile();
  }

  private profile() {
    return { a: this.state.avatar ?? null, n: this.state.nick ?? null };
  }

  private async shareProfile() {
    await this.save();
    this.changed();
    for (const mailbox of Object.keys(this.state.contacts)) {
      await this.deliver(mailbox, { k: 'profile', ...this.profile() }).catch(() => {});
    }
  }

  /** Called with the contact's mailbox whenever a new text message arrives. */
  onIncoming(fn: (mailbox: string) => void): () => void {
    this.incoming.add(fn);
    return () => this.incoming.delete(fn);
  }

  /** Encrypts a payload for a contact and hands it to the relay. */
  private async deliver(mailbox: string, payload: object, onFail?: () => void): Promise<void> {
    const list = this.sessions.get(mailbox) ?? [];
    const resync = this.state.resync ?? [];
    if (list.length === 0 || resync.includes(mailbox)) {
      list.unshift((await this.startSession(mailbox)).session);
      this.sessions.set(mailbox, list);
      this.state.resync = resync.filter((m) => m !== mailbox);
    }
    const enc = list[0].encrypt(pad(payload));
    this.state.unsaved = this.unsaved + 1;
    await this.save(); // persist the advanced ratchet before the message leaves
    this.changed();
    const env: Envelope = {
      v: 1,
      from_ed25519: this.account.ed25519,
      from_curve25519: this.account.curve25519,
      type: enc.messageType,
      ciphertext: enc.ciphertext,
    };
    try {
      await this.relay.send(mailbox, JSON.stringify(env));
    } catch (e) {
      onFail?.();
      await this.save();
      this.changed();
      throw e;
    }
  }

  setVerified(mailbox: string, verified: boolean) {
    const c = this.state.contacts[mailbox];
    if (!c) return;
    c.verified = verified;
    this.save().then(() => this.changed());
  }

  private async receive(d: Delivered) {
    // Blocked senders are not even decrypted, so they can't open a new session either.
    const plain = this.state.blocked?.includes(d.from) ? null : await this.decryptDelivered(d).catch(() => null);
    const c = this.state.contacts[d.from];
    let isNewText = false;
    if (plain && c) {
      try {
        const p = JSON.parse(fromUtf8(plain)) as { k?: unknown; b?: unknown; id?: unknown; a?: unknown; n?: unknown };
        const id = typeof p.id === 'string' && p.id.length <= 32 ? p.id : undefined;
        const text = typeof p.b === 'string' ? p.b.slice(0, MAX_TEXT) : undefined;
        if ('a' in p && (p.a === null || isAvatar(p.a))) c.avatar = p.a ?? undefined;
        if ('n' in p && (p.n === null || typeof p.n === 'string')) c.nick = cleanName(p.n);
        // Edits and deletions may only touch messages this same contact sent us.
        const theirs = id ? c.messages.find((m) => !m.out && m.id === id && !m.deleted) : undefined;
        if (p.k === 'text' && text) {
          c.messages.push({ id, out: false, text, at: Date.now() });
          this.state.unsaved = this.unsaved + 1;
          isNewText = true;
        } else if (p.k === 'edit' && theirs && text) {
          theirs.text = text;
          theirs.edited = true;
        } else if (p.k === 'del' && theirs) {
          theirs.deleted = true;
          theirs.text = '';
        }
      } catch {
        // authenticated but malformed: drop it
      }
    }
    // Persist before acknowledging, so a crash can't lose an acknowledged message.
    await this.save();
    await this.relay.ack(d.id).catch(() => {});
    this.changed();
    if (isNewText) for (const fn of this.incoming) fn(d.from);
  }

  private async decryptDelivered(d: Delivered): Promise<Uint8Array | null> {
    const env = JSON.parse(d.envelope) as Envelope;
    if (env.v !== 1 || typeof env.from_ed25519 !== 'string' || typeof env.from_curve25519 !== 'string') return null;
    // The relay-reported sender must match the keys in the envelope; the Olm
    // session then proves the sender holds that Curve25519 key.
    if (d.from === this.mailbox || (await mailboxId(env.from_ed25519, env.from_curve25519)) !== d.from) return null;

    const list = this.sessions.get(d.from) ?? [];
    for (let i = 0; i < list.length; i++) {
      try {
        const plain = list[i].decrypt(env.type, env.ciphertext);
        list.unshift(...list.splice(i, 1));
        this.ensureContact(d.from, env);
        return plain;
      } catch {
        // try the next session
      }
    }
    if (env.type !== 0) return null;
    const inbound = this.account.createInboundSession(env.from_curve25519, env.ciphertext);
    list.unshift(inbound.takeSession());
    this.sessions.set(d.from, list);
    this.ensureContact(d.from, env);
    return inbound.plaintext;
  }

  /** A sender we have no contact for (new, or deleted earlier) shows up as unverified. */
  private ensureContact(mailbox: string, env: Envelope) {
    this.state.contacts[mailbox] ??= {
      mailbox,
      ed25519: env.from_ed25519,
      curve25519: env.from_curve25519,
      name: defaultName(mailbox),
      addedByMe: false,
      verified: false,
      messages: [],
    };
  }
}
