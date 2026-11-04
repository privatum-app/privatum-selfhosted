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
  /** At least one recipient did not get it (for a group: someone may still have). */
  failed?: boolean;
  edited?: boolean;
  deleted?: boolean;
  /** Sender of an incoming group message. */
  from?: string;
  /** Disappearing message: removed from this device at this time (ms). */
  exp?: number;
  /** The message this one answers: its id and its author's mailbox. Only the reference travels. */
  reply?: { id: string; by: string };
  /** Reaction per person (mailbox -> one of REACTIONS). */
  reactions?: Record<string, string>;
  /** A notice instead of a text: someone changed the disappearing timer. */
  info?: { timer: number; by: string };
}

/** Reactions are a fixed set, so nobody can send arbitrary text as one. */
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
/** Disappearing-message timers offered (seconds; 0 = off). */
export const TIMERS = [0, 3600, 86_400, 7 * 86_400];

/** What contacts and groups have in common: a history and an optional timer. */
interface Thread {
  messages: Message[];
  /** Disappearing-message timer in seconds. */
  timer?: number;
}

/**
 * A group is only a convention between clients: each message is encrypted separately
 * for every member over the usual pairwise sessions, so the relay sees ordinary
 * one-to-one messages. Only the creator (owner) changes the member list.
 */
export interface Group extends Thread {
  id: string;
  name: string;
  owner: string;
  /** Every member, us and the owner included. */
  members: string[];
  messages: Message[];
  /** We left or were removed: history stays, nothing more is sent or accepted. */
  left?: boolean;
  /** Its owner ended it for everyone (also sets `left`). */
  ended?: boolean;
}

/** Thread keys: a contact's mailbox, or this prefix plus a group id. */
export const GROUP_PREFIX = 'g:';
/** Members per group, us included: every message is encrypted once per member. */
export const MAX_GROUP = 20;
export const MAX_GROUP_NAME = 48;

/** Number of avatars in the client's gallery; contacts only ever send an index. */
export const AVATAR_COUNT = 20;
const isAvatar = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < AVATAR_COUNT;

/** Longest display name a contact may send; longer names are cut. */
export const MAX_NAME = 32;
// Control and format characters (bidi overrides included) are stripped so a name can't disguise itself.
const cleanName = (x: unknown, max = MAX_NAME) =>
  typeof x === 'string' ? x.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, max) || undefined : undefined;

/** Name given to a contact when nobody typed one. */
export const defaultName = (mailbox: string) => `Contato ${mailbox.slice(0, 6)}`;

/** The name we typed wins; otherwise the name the contact chose; otherwise the default. */
export const contactName = (c: Contact) => (c.nick && c.name === defaultName(c.mailbox) ? c.nick : c.name);

/** Compares names the way people read them: case, accents and spacing don't count. */
export const sameText = (s: string) =>
  s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

export interface Contact extends Thread {
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
  /** Known only as a member of a group we are in: kept for its keys and name, not listed. */
  hidden?: boolean;
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
  groups?: Record<string, Group>;
}

const BACKUP_FORMAT = 'privatum-backup';

/** Decrypted payload; every field is untrusted until checked. */
interface Payload {
  k?: unknown;
  b?: unknown;
  id?: unknown;
  a?: unknown;
  n?: unknown;
  /** Group id: the message belongs to that group. */
  g?: unknown;
  /** ginfo: group name and member list. */
  name?: unknown;
  m?: unknown;
  /** text: disappearing timer of the sender (seconds). timer: the new timer. */
  x?: unknown;
  s?: unknown;
  /** text: quoted message reference. react: author of the target message. */
  q?: unknown;
  by?: unknown;
  /** react: the reaction, or null to remove ours. */
  e?: unknown;
}

const isTimer = (x: unknown): x is number => TIMERS.includes(x as number);
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
  private sweeper: ReturnType<typeof setInterval> | undefined;
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
    // Register before saving: a refused registration (instance full) leaves nothing behind.
    await m.relay.register(account.ed25519, account.curve25519);
    await deps.storage.set('salt', btoa(String.fromCharCode(...salt)));
    await m.save();
    await m.connect(true);
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
    // Refuse before replacing local data if the instance won't take the mailbox.
    await m.relay.register(account.ed25519, account.curve25519);
    await deps.storage.set('salt', file.salt);
    await m.save();
    await m.connect(true);
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

  /** Contacts to list: people known only through a group are left out. */
  get contacts(): Contact[] {
    return Object.values(this.state.contacts).filter((c) => !c.hidden);
  }

  get groups(): Group[] {
    return Object.values(this.state.groups ?? {});
  }

  group(id: string): Group | undefined {
    return this.state.groups?.[id];
  }

  /**
   * An unverified contact whose chosen name matches another contact's name: either
   * someone posing as that person, or that person with a new identity. Keys can't change
   * under a contact (the mailbox id is their hash), so this is how a swap shows up.
   */
  lookalike(mailbox: string): Contact | undefined {
    const c = this.state.contacts[mailbox];
    if (!c?.nick || c.verified) return undefined;
    const nick = sameText(c.nick);
    return this.contacts.find((o) => o.mailbox !== mailbox && (sameText(contactName(o)) === nick || (o.nick && sameText(o.nick) === nick)));
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

  /** Registers (idempotent; skipped when the caller just did it), tops up one-time keys and opens the inbox. */
  private async connect(registered = false) {
    // Messages that expired while the app was closed go before anything is shown.
    if (this.sweep()) await this.save();
    this.sweeper ??= setInterval(() => {
      if (this.sweep()) this.save().then(() => this.changed());
    }, 15_000);
    if (!registered) await this.relay.register(this.account.ed25519, this.account.curve25519);
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
    clearInterval(this.sweeper);
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
    if (existing) {
      // Someone we knew only from a group becomes a contact of ours.
      if (existing.hidden) {
        existing.hidden = false;
        existing.name = name;
        existing.addedByMe = true;
        await this.save();
        this.changed();
      }
      return existing;
    }
    const { session, ed25519, curve25519 } = await this.startSession(mailbox);
    const c: Contact = { mailbox, ed25519, curve25519, name, addedByMe: true, verified: false, messages: [] };
    this.state.contacts[mailbox] = c;
    this.sessions.set(mailbox, [session]);
    await this.save();
    this.changed();
    return c;
  }

  /** A contact's mailbox or GROUP_PREFIX + group id: its messages and who receives them. */
  private thread(key: string): { messages: Message[]; to: string[]; g?: string; obj: Contact | Group } | undefined {
    if (key.startsWith(GROUP_PREFIX)) {
      const g = this.state.groups?.[key.slice(GROUP_PREFIX.length)];
      return g && { messages: g.messages, to: g.left ? [] : this.othersIn(g), g: g.id, obj: g };
    }
    const c = this.state.contacts[key];
    return c && { messages: c.messages, to: [key], obj: c };
  }

  /** Who wrote `msg` in the thread `key`: us, the group member, or the contact. */
  private author(key: string, msg: Message): string {
    return msg.out ? this.mailbox : (msg.from ?? key);
  }

  /** Finds a message by id and author, as a reply or reaction names it. */
  private findBy(messages: Message[], id: string, by: string, contact?: string): Message | undefined {
    return messages.find(
      (m) => m.id === id && !m.info && (by === this.mailbox ? m.out : !m.out && (m.from ?? contact) === by),
    );
  }

  /** The message a reply points to, if it is still on this device. */
  quoted(key: string, msg: Message): Message | undefined {
    const t = this.thread(key);
    return t && msg.reply ? this.findBy(t.messages, msg.reply.id, msg.reply.by, key) : undefined;
  }

  private othersIn(g: Group): string[] {
    return g.members.filter((mb) => mb !== this.mailbox && !this.state.blocked?.includes(mb));
  }

  /**
   * One-to-one: delivers or throws. Group: tries every member and only reports, through
   * onFail, that someone missed it; the others still get it.
   */
  private async fanout(t: { to: string[]; g?: string }, payload: object, onFail?: () => void): Promise<void> {
    if (t.g === undefined) return this.deliver(t.to[0], payload, onFail);
    for (const mailbox of t.to) {
      await this.deliver(mailbox, { ...payload, g: t.g }).catch(() => onFail?.());
    }
    await this.save();
    this.changed();
  }

  async send(key: string, text: string, replyTo?: Message): Promise<void> {
    const t = this.thread(key);
    const body = text.trim();
    if (!t || (t.g !== undefined && this.group(t.g)?.left) || !body || body.length > MAX_TEXT) throw new Error('bad_message');
    const at = Date.now();
    const id = b64(crypto.getRandomValues(new Uint8Array(9)));
    const timer = t.obj.timer ?? 0;
    const reply = replyTo?.id && t.messages.includes(replyTo) ? { id: replyTo.id, by: this.author(key, replyTo) } : undefined;
    const msg: Message = { id, out: true, text: body, at, reply, exp: timer ? at + timer * 1000 : undefined };
    t.messages.push(msg);
    await this.fanout(t, { k: 'text', id, b: body, t: at, x: timer || undefined, q: reply, ...this.profile() }, () => {
      msg.failed = true;
    });
  }

  /** Sets (or with null removes) our reaction to a message, here and for the others. */
  async react(key: string, msg: Message, emoji: string | null): Promise<void> {
    const t = this.thread(key);
    if (!t || !msg.id || msg.deleted || msg.info || !t.messages.includes(msg)) return;
    if (emoji !== null && !REACTIONS.includes(emoji)) throw new Error('bad_reaction');
    const reactions = (msg.reactions ??= {});
    if (emoji === null) delete reactions[this.mailbox];
    else reactions[this.mailbox] = emoji;
    await this.fanout(t, { k: 'react', id: msg.id, by: this.author(key, msg), e: emoji });
  }

  /** Disappearing messages for this conversation; in a group, only its owner sets it. */
  async setTimer(key: string, seconds: number): Promise<void> {
    const t = this.thread(key);
    if (!t || !isTimer(seconds)) throw new Error('bad_timer');
    if (t.g !== undefined && (this.group(t.g)!.owner !== this.mailbox || this.group(t.g)!.left)) throw new Error('not_owner');
    t.obj.timer = seconds || undefined;
    t.messages.push({ out: true, text: '', at: Date.now(), info: { timer: seconds, by: this.mailbox } });
    await this.fanout(t, { k: 'timer', s: seconds });
  }

  /** Removes disappearing messages whose time has come; returns true if any went. */
  private sweep(): boolean {
    const now = Date.now();
    let removed = false;
    for (const t of [...Object.values(this.state.contacts), ...this.groups]) {
      const kept = t.messages.filter((m) => !m.exp || m.exp > now);
      if (kept.length !== t.messages.length) {
        t.messages = kept;
        removed = true;
      }
    }
    return removed;
  }

  /** Edits one of our own messages here and on the other devices. */
  async editMessage(key: string, id: string, text: string): Promise<void> {
    const t = this.thread(key);
    const msg = t?.messages.find((m) => m.out && m.id === id && !m.deleted);
    const body = text.trim();
    if (!t || !msg || !body || body.length > MAX_TEXT) throw new Error('bad_message');
    msg.text = body;
    msg.edited = true;
    await this.fanout(t, { k: 'edit', id, b: body });
  }

  /**
   * Deletes a message. "For everyone" only applies to our own messages and is a
   * request: a modified client, a screenshot or an older backup can still keep it.
   */
  async deleteMessage(key: string, msg: Message, forEveryone: boolean): Promise<void> {
    const t = this.thread(key);
    if (!t || !t.messages.includes(msg)) return;
    if (!forEveryone) {
      t.messages.splice(t.messages.indexOf(msg), 1);
      await this.save();
      this.changed();
      return;
    }
    if (!msg.out || !msg.id) throw new Error('bad_message');
    msg.deleted = true;
    msg.text = '';
    await this.fanout(t, { k: 'del', id: msg.id });
  }

  /** Creates a group of ours with some of our contacts and tells them, best effort. */
  async createGroup(name: string, members: string[]): Promise<Group> {
    const clean = cleanName(name, MAX_GROUP_NAME);
    const others = [...new Set(members)].filter((mb) => mb !== this.mailbox && this.contacts.some((c) => c.mailbox === mb));
    if (!clean) throw new Error('bad_group_name');
    if (others.length === 0 || others.length + 1 > MAX_GROUP) throw new Error('bad_group_members');
    const id = b64(crypto.getRandomValues(new Uint8Array(12)));
    const g: Group = { id, name: clean, owner: this.mailbox, members: [this.mailbox, ...others], messages: [] };
    (this.state.groups ??= {})[id] = g;
    await this.save();
    this.changed();
    await this.announce(g, others);
    return g;
  }

  /** Owner only: new member list (our contacts, or people already in it). Removed people are told too. */
  async setGroupMembers(id: string, members: string[]): Promise<void> {
    const g = this.group(id);
    if (!g || g.left || g.owner !== this.mailbox) throw new Error('not_owner');
    const allowed = (mb: string) => g.members.includes(mb) || this.contacts.some((c) => c.mailbox === mb);
    const others = [...new Set(members)].filter((mb) => mb !== this.mailbox && allowed(mb));
    if (others.length === 0 || others.length + 1 > MAX_GROUP) throw new Error('bad_group_members');
    const removed = g.members.filter((mb) => mb !== this.mailbox && !others.includes(mb));
    g.members = [this.mailbox, ...others];
    await this.save();
    this.changed();
    await this.announce(g, [...others, ...removed]);
  }

  private async announce(g: Group, to: string[]) {
    const payload = { k: 'ginfo', name: g.name, m: g.members };
    await this.fanout({ to: to.filter((mb) => !this.state.blocked?.includes(mb)), g: g.id }, payload);
  }

  /** Leaves for good: members are told, the history stays here (read-only). */
  /**
   * A member leaves for good: the others are told, the history stays here (read-only).
   * The owner leaving ends the group for everyone, since nobody else could manage it.
   */
  async leaveGroup(id: string): Promise<void> {
    const g = this.group(id);
    if (!g || g.left) return;
    const to = this.othersIn(g);
    g.left = true;
    if (g.owner === this.mailbox) {
      g.ended = true;
      await this.fanout({ to, g: id }, { k: 'gend' });
      return;
    }
    g.members = g.members.filter((mb) => mb !== this.mailbox);
    await this.fanout({ to, g: id }, { k: 'gleave' });
  }

  /** Leaves (if still in it) and forgets the group on this device. */
  async deleteGroup(id: string): Promise<void> {
    await this.leaveGroup(id);
    delete this.state.groups?.[id];
    await this.save();
    this.changed();
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
    const wasKnown = d.from in this.state.contacts;
    // Blocked senders are not even decrypted, so they can't open a new session either.
    const plain = this.state.blocked?.includes(d.from) ? null : await this.decryptDelivered(d).catch(() => null);
    const c = this.state.contacts[d.from];
    let newIn: string | null = null;
    if (plain && c) {
      try {
        const p = JSON.parse(fromUtf8(plain)) as Payload;
        const id = typeof p.id === 'string' && p.id.length <= 32 ? p.id : undefined;
        const text = typeof p.b === 'string' ? p.b.slice(0, MAX_TEXT) : undefined;
        if ('a' in p && (p.a === null || isAvatar(p.a))) c.avatar = p.a ?? undefined;
        if ('n' in p && (p.n === null || typeof p.n === 'string')) c.nick = cleanName(p.n);
        if (typeof p.g === 'string' && p.g.length <= 32) {
          // Someone who reaches us only through a group is not listed as a contact.
          if (!wasKnown) c.hidden = true;
          if (this.receiveGroup(d.from, p.g, p, id, text)) newIn = GROUP_PREFIX + p.g;
        } else {
          if (p.k === 'text' && text) c.hidden = false;
          if (this.applyMessage(c, d.from, p, id, text, { contact: d.from, mayTime: true })) newIn = d.from;
        }
      } catch {
        // authenticated but malformed: drop it
      }
    }
    // Persist before acknowledging, so a crash can't lose an acknowledged message.
    await this.save();
    await this.relay.ack(d.id).catch(() => {});
    this.changed();
    if (newIn) for (const fn of this.incoming) fn(newIn);
  }

  /** Applies a group payload from `from`; returns true for a new text message. */
  private receiveGroup(from: string, gid: string, p: Payload, id: string | undefined, text: string | undefined): boolean {
    const groups = (this.state.groups ??= {});
    const g = groups[gid];
    if (p.k === 'ginfo') {
      const members = Array.isArray(p.m) ? [...new Set(p.m.filter((x): x is string => typeof x === 'string' && isMailboxId(x)))] : [];
      if (members.length > MAX_GROUP || !members.includes(from)) return false;
      const name = cleanName(p.name, MAX_GROUP_NAME) ?? 'Grupo';
      if (!g) {
        // A new group: whoever announces it first is its owner.
        if (members.includes(this.mailbox)) groups[gid] = { id: gid, name, owner: from, members, messages: [] };
      } else if (from === g.owner) {
        // Only the owner changes the list; being left out of it means we were removed.
        g.name = name;
        g.members = members;
        g.left = members.includes(this.mailbox) ? undefined : true;
        if (!g.left) g.ended = undefined;
      }
      return false;
    }
    if (!g || g.left || !g.members.includes(from)) return false;
    // Only the owner ends a group; from anyone else this is ignored.
    if (p.k === 'gend') {
      if (from === g.owner) {
        g.left = true;
        g.ended = true;
      }
      return false;
    }
    if (p.k === 'gleave') {
      g.members = g.members.filter((mb) => mb !== from);
      return false;
    }
    return this.applyMessage(g, from, p, id, text, { mayTime: from === g.owner });
  }

  /**
   * Applies a text, edit, deletion, reaction or timer change from `from` to a thread.
   * `contact` is set for one-to-one threads (incoming messages there carry no `from`).
   * Returns true for a new text message.
   */
  private applyMessage(
    t: Thread,
    from: string,
    p: Payload,
    id: string | undefined,
    text: string | undefined,
    opts: { contact?: string; mayTime: boolean },
  ): boolean {
    const now = Date.now();
    // Edits and deletions may only touch messages this same person sent us.
    const theirs = id ? t.messages.find((m) => !m.out && (m.from ?? opts.contact) === from && m.id === id && !m.deleted) : undefined;
    if (p.k === 'text' && text) {
      const q = p.q as { id?: unknown; by?: unknown } | undefined;
      const reply = q && typeof q.id === 'string' && q.id.length <= 32 && typeof q.by === 'string' && isMailboxId(q.by) ? { id: q.id, by: q.by } : undefined;
      // The sender's timer decides; anything outside the offered values is ignored.
      const exp = isTimer(p.x) && p.x > 0 ? now + p.x * 1000 : undefined;
      t.messages.push({ id, out: false, from: opts.contact ? undefined : from, text, at: now, reply, exp });
      this.state.unsaved = this.unsaved + 1;
      return true;
    }
    if (p.k === 'edit' && theirs && text) {
      theirs.text = text;
      theirs.edited = true;
    } else if (p.k === 'del' && theirs) {
      theirs.deleted = true;
      theirs.text = '';
    } else if (p.k === 'react' && id && typeof p.by === 'string' && (p.e === null || REACTIONS.includes(p.e as string))) {
      const target = this.findBy(t.messages, id, p.by, opts.contact);
      if (target && !target.deleted) {
        const reactions = (target.reactions ??= {});
        if (p.e === null) delete reactions[from];
        else reactions[from] = p.e as string;
      }
    } else if (p.k === 'timer' && opts.mayTime && isTimer(p.s)) {
      t.timer = p.s || undefined;
      t.messages.push({ out: false, from: opts.contact ? undefined : from, text: '', at: now, info: { timer: p.s, by: from } });
    }
    return false;
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
