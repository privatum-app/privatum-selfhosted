// End-to-end: the client core (real vodozemac WASM) against a real relay.
//   docker run -d --name privatum-e2e -e PRIVATUM_HOST=localhost:18080 -p 127.0.0.1:18080:8080 privatum-relay:local
//   PRIVATUM_TEST_BASE=http://localhost:18080 node --test client/test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseInvite, parseRegistrationCode, inviteLink } from '../src/core/identity.ts';
import { Messenger, KeyMismatchError, contactName, type Deps, type Olm } from '../src/core/messenger.ts';
import type { Storage } from '../src/core/vault.ts';

const base = process.env.PRIVATUM_TEST_BASE;
const olm = createRequire(import.meta.url)('../../crypto-wasm/pkg/node/privatum_crypto.js') as Olm;

function memory(): Storage {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v), clear: async () => m.clear() };
}

function deps(storage = memory(), fetchFn?: typeof fetch): Deps {
  return { olm, storage, base: base!, host: new URL(base!).host, fetch: fetchFn };
}

async function waitFor(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const opts = { skip: base ? false : 'set PRIVATUM_TEST_BASE to a running relay' };

test('alice and bob talk; the relay only sees padded ciphertext', opts, async () => {
  const sent: string[] = [];
  const spy: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/v1/messages') && init?.body) sent.push(String(init.body));
    return fetch(url, init);
  };
  const alice = await Messenger.create('alice passphrase 123', deps(memory(), spy));
  const bob = await Messenger.create('bob passphrase 123', deps());
  try {
    await alice.addContact(bob.mailbox, 'Bob');
    await alice.send(bob.mailbox, 'segredo curto');
    await waitFor(() => bob.contact(alice.mailbox)?.messages.length === 1);
    const fromAlice = bob.contact(alice.mailbox)!;
    assert.equal(fromAlice.messages[0].text, 'segredo curto');
    assert.equal(fromAlice.addedByMe, false, 'bob did not add alice: must be flagged');

    await bob.send(alice.mailbox, 'resposta do bob');
    await waitFor(() => alice.contact(bob.mailbox)!.messages.length === 2);
    assert.equal(alice.contact(bob.mailbox)!.messages[1].text, 'resposta do bob');

    for (const t of ['um', 'dois', 'três']) await alice.send(bob.mailbox, t);
    const received = () => fromAlice.messages.filter((m) => !m.out).map((m) => m.text);
    await waitFor(() => received().length === 4);
    assert.deepEqual(received(), ['segredo curto', 'um', 'dois', 'três']);

    assert.ok(sent.every((b) => !b.includes('segredo')), 'plaintext must never reach the relay');
    const sizes = new Set(sent.slice(1).map((b) => JSON.parse(JSON.parse(b).envelope).ciphertext.length));
    assert.equal(sizes.size, 1, 'short messages pad to the same size');
  } finally {
    alice.close();
    bob.close();
  }
});

test('state survives a restart and needs the right passphrase', opts, async () => {
  const storage = memory();
  const alice = await Messenger.create('alice passphrase 456', deps(storage));
  const bob = await Messenger.create('bob passphrase 456', deps());
  await alice.addContact(bob.mailbox, 'Bob');
  await alice.send(bob.mailbox, 'antes');
  await alice.idle();
  alice.close();

  await assert.rejects(Messenger.unlock('senha errada!!', deps(storage)), { message: 'wrong_passphrase' });
  const again = await Messenger.unlock('alice passphrase 456', deps(storage));
  try {
    assert.equal(again.mailbox, alice.mailbox);
    await again.send(bob.mailbox, 'depois');
    await waitFor(() => bob.contact(alice.mailbox)?.messages.length === 2);
    assert.deepEqual(bob.contact(alice.mailbox)!.messages.map((m) => m.text), ['antes', 'depois']);
  } finally {
    again.close();
    bob.close();
  }
});

test('backup restores the identity on a fresh browser and the chat resumes', opts, async () => {
  const pass = 'alice backup passphrase';
  const alice = await Messenger.create(pass, deps());
  const bob = await Messenger.create('bob passphrase bkp', deps());
  const fromAlice = () => bob.contact(alice.mailbox)?.messages.filter((m) => !m.out).map((m) => m.text) ?? [];
  try {
    await alice.addContact(bob.mailbox, 'Bob');
    await alice.send(bob.mailbox, 'antes do backup');
    assert.equal(alice.unsaved, 1);
    const backup = await alice.exportBackup();
    assert.equal(alice.unsaved, 0);
    assert.ok(!backup.includes('antes do backup'), 'backup must be encrypted');

    // Sent after the export: the restored copy's ratchet will be behind.
    await alice.send(bob.mailbox, 'depois do backup');
    await waitFor(() => fromAlice().length === 2);
    alice.close();

    await assert.rejects(Messenger.importBackup('{"format":"other"}', pass, deps()), { message: 'bad_backup' });
    await assert.rejects(Messenger.importBackup(backup, 'senha errada!!', deps()), { message: 'wrong_passphrase' });

    const restored = await Messenger.importBackup(backup, pass, deps());
    try {
      assert.equal(restored.mailbox, alice.mailbox);
      assert.deepEqual(restored.contact(bob.mailbox)!.messages.map((m) => m.text), ['antes do backup']);

      await restored.send(bob.mailbox, 'voltei do backup');
      await waitFor(() => fromAlice().length === 3);
      assert.equal(fromAlice()[2], 'voltei do backup');

      await bob.send(alice.mailbox, 'bem-vinda de volta');
      await waitFor(() => restored.contact(bob.mailbox)!.messages.some((m) => !m.out && m.text === 'bem-vinda de volta'));
    } finally {
      restored.close();
    }
  } finally {
    bob.close();
  }
});

test('blocking drops a contact and its messages; adding the invite again unblocks', opts, async () => {
  const alice = await Messenger.create('alice passphrase blk', deps());
  const bob = await Messenger.create('bob passphrase blk', deps());
  const incoming = () => bob.contact(alice.mailbox)?.messages.filter((m) => !m.out).map((m) => m.text) ?? [];
  try {
    await alice.addContact(bob.mailbox, 'Bob');
    await alice.send(bob.mailbox, 'primeira');
    await waitFor(() => incoming().length === 1);

    await bob.blockContact(alice.mailbox);
    assert.equal(bob.contact(alice.mailbox), undefined);
    await alice.send(bob.mailbox, 'enquanto bloqueada');
    await new Promise((r) => setTimeout(r, 500));
    await bob.idle();
    assert.equal(bob.contact(alice.mailbox), undefined, 'blocked sender must not reappear');

    await bob.addContact(alice.mailbox, 'Alice');
    await bob.send(alice.mailbox, 'desbloqueei');
    await waitFor(() => alice.contact(bob.mailbox)!.messages.some((m) => !m.out && m.text === 'desbloqueei'));
    await alice.send(bob.mailbox, 'de novo');
    await waitFor(() => incoming().includes('de novo'));
    assert.ok(!incoming().includes('enquanto bloqueada'));

    // Deleting is not blocking: a new message brings the conversation back, unverified.
    await alice.deleteContact(bob.mailbox);
    assert.equal(alice.contacts.length, 0);
    await bob.send(alice.mailbox, 'depois de apagar');
    await waitFor(() => alice.contact(bob.mailbox)?.messages.some((m) => m.text === 'depois de apagar') === true);
    assert.equal(alice.contact(bob.mailbox)!.addedByMe, false);
    assert.equal(alice.contact(bob.mailbox)!.messages.length, 1, 'old history stays deleted');
  } finally {
    alice.close();
    bob.close();
  }
});

test('logout erases the identity from this browser', opts, async () => {
  const storage = memory();
  const m = await Messenger.create('logout passphrase', deps(storage));
  assert.equal(await Messenger.exists(storage), true);
  await m.logout();
  assert.equal(await Messenger.exists(storage), false);
  await assert.rejects(Messenger.unlock('logout passphrase', deps(storage)), { message: 'no_identity' });
});

test('edit, delete for everyone, avatars, names and new-message events', opts, async () => {
  const alice = await Messenger.create('alice passphrase edt', deps());
  const bob = await Messenger.create('bob passphrase edt', deps());
  const heard: string[] = [];
  bob.onIncoming((mb) => heard.push(mb));
  const fromAlice = () => bob.contact(alice.mailbox)?.messages ?? [];
  try {
    await alice.setAvatar(7);
    await alice.addContact(bob.mailbox, 'Bob');
    await alice.send(bob.mailbox, 'texto original');
    await alice.send(bob.mailbox, 'vai sumir');
    await waitFor(() => fromAlice().length === 2);
    assert.equal(bob.contact(alice.mailbox)!.avatar, 7, 'avatar travels inside the message');
    assert.deepEqual(heard, [alice.mailbox, alice.mailbox]);

    const [first, second] = alice.contact(bob.mailbox)!.messages;
    await alice.editMessage(bob.mailbox, first.id!, 'texto corrigido');
    await alice.deleteMessage(bob.mailbox, second, true);
    await waitFor(() => fromAlice()[1].deleted === true);
    assert.equal(fromAlice()[0].text, 'texto corrigido');
    assert.equal(fromAlice()[0].edited, true);
    assert.equal(fromAlice()[1].text, '');
    assert.equal(heard.length, 2, 'edits and deletions do not count as new messages');

    // Bob tries to edit a message Alice wrote to him: Alice must ignore it.
    await bob.send(alice.mailbox, 'oi');
    await waitFor(() => alice.contact(bob.mailbox)!.messages.some((m) => !m.out && m.text === 'oi'));
    const forged = { k: 'edit', id: first.id, b: 'falsificado' };
    await (bob as unknown as { deliver(mb: string, p: object): Promise<void> }).deliver(alice.mailbox, forged);
    await bob.send(alice.mailbox, 'depois');
    await waitFor(() => alice.contact(bob.mailbox)!.messages.some((m) => m.text === 'depois'));
    assert.equal(alice.contact(bob.mailbox)!.messages[0].text, 'texto corrigido');

    await alice.setAvatar(null);
    await waitFor(() => bob.contact(alice.mailbox)!.avatar === undefined);
    await assert.rejects(alice.setAvatar(99), { message: 'bad_avatar' });

    // Display names: shown only where nobody typed a name, cleaned of control/bidi characters.
    await alice.setNick('  Ana\u202e\u0007 ');
    await bob.setNick('Banco Oficial');
    await waitFor(() => bob.contact(alice.mailbox)!.nick === 'Ana');
    assert.equal(contactName(bob.contact(alice.mailbox)!), 'Ana', 'alice wrote first: her name shows');
    await waitFor(() => alice.contact(bob.mailbox)!.nick === 'Banco Oficial');
    assert.equal(contactName(alice.contact(bob.mailbox)!), 'Bob', 'the name alice typed wins');
    await alice.setNick('');
    await waitFor(() => bob.contact(alice.mailbox)!.nick === undefined);
    assert.equal(contactName(bob.contact(alice.mailbox)!), `Contato ${alice.mailbox.slice(0, 6)}`);

    // "Delete for me" only removes it here.
    const mine = bob.contact(alice.mailbox)!.messages[0];
    await bob.deleteMessage(alice.mailbox, mine, false);
    assert.ok(!bob.contact(alice.mailbox)!.messages.includes(mine));
  } finally {
    alice.close();
    bob.close();
  }
});

test('keys swapped by the relay are refused', opts, async () => {
  const bob = await Messenger.create('bob passphrase 789', deps());
  const mallory = await Messenger.create('mallory passphrase', deps());
  // A malicious relay answers the request for Bob's keys with Mallory's.
  const swap: typeof fetch = (url, init) =>
    fetch(String(url).replace(`/v1/keys/${bob.mailbox}`, `/v1/keys/${mallory.mailbox}`), init);
  const alice = await Messenger.create('alice passphrase 789', deps(memory(), swap));
  try {
    await assert.rejects(alice.addContact(bob.mailbox, 'Bob'), KeyMismatchError);
    assert.equal(alice.contacts.length, 0);
  } finally {
    for (const m of [alice, bob, mallory]) m.close();
  }
});

test('one-time key with a forged signature is refused', opts, async () => {
  const bob = await Messenger.create('bob passphrase 000', deps());
  const forge: typeof fetch = async (url, init) => {
    const res = await fetch(url, init);
    if (!String(url).includes(`/v1/keys/${bob.mailbox}`)) return res;
    const body = await res.json();
    for (const k of [body.one_time_key, body.fallback_key]) if (k) k.signature = 'A'.repeat(86);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const alice = await Messenger.create('alice passphrase 000', deps(memory(), forge));
  try {
    await assert.rejects(alice.addContact(bob.mailbox, 'Bob'), { message: 'bad_key_signature' });
  } finally {
    alice.close();
    bob.close();
  }
});

// Needs the relay's internal admin API too: PRIVATUM_TEST_ADMIN=http://localhost:18081 and
// PRIVATUM_TEST_ADMIN_TOKEN=<token>.
const adminBase = process.env.PRIVATUM_TEST_ADMIN;
const setMode = (mode: string) =>
  fetch(`${adminBase}/admin/registration`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PRIVATUM_TEST_ADMIN_TOKEN}` },
    body: JSON.stringify({ mode }),
  });

test('invite-only instance: joining needs the code from a member invite', { skip: base && adminBase ? false : 'set PRIVATUM_TEST_ADMIN' }, async () => {
  const alice = await Messenger.create('alice passphrase inv', deps());
  try {
    assert.equal((await setMode('invite')).status, 200);
    assert.equal(await alice.relay.registration(), 'invite');

    const refused = memory();
    await assert.rejects(Messenger.create('bob passphrase inv', deps(refused)), { message: 'invite_required' });
    assert.equal(await Messenger.exists(refused), false, 'a refused registration leaves nothing saved');

    const link = inviteLink('http://x.onion', alice.mailbox, await alice.relay.mintInvite());
    assert.equal(parseInvite(link), alice.mailbox, 'the contact part still parses');
    const code = parseRegistrationCode(link)!;
    const bob = await Messenger.create('bob passphrase inv', deps(), code);
    await assert.rejects(Messenger.create('carol passphrase inv', deps(), code), { message: 'invalid_invite' });

    await bob.addContact(alice.mailbox, 'Alice');
    await bob.send(alice.mailbox, 'entrei pelo convite');
    await waitFor(() => alice.contact(bob.mailbox)?.messages.length === 1);
    bob.close();
  } finally {
    await setMode('open');
    alice.close();
  }
});
