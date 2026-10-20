// End-to-end: the client core (real vodozemac WASM) against a real relay.
//   docker run -d --name privatum-e2e -e PRIVATUM_HOST=localhost:18080 -p 127.0.0.1:18080:8080 privatum-relay:local
//   PRIVATUM_TEST_BASE=http://localhost:18080 node --test client/test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Messenger, KeyMismatchError, type Deps, type Olm } from '../src/core/messenger.ts';
import type { Storage } from '../src/core/vault.ts';

const base = process.env.PRIVATUM_TEST_BASE;
const olm = createRequire(import.meta.url)('../../crypto-wasm/pkg/node/privatum_crypto.js') as Olm;

function memory(): Storage {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v) };
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

  await assert.rejects(Messenger.unlock('senha errada!!', deps(storage)));
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
