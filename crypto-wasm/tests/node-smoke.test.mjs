// Exercises the real WASM build (pkg/node), including the JS randomness source.
// Build first: docker build -f deploy/relay.Dockerfile --target wasm-out --output crypto-wasm/pkg .
// then: node --test crypto-wasm/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { Account, Session, verifyEd25519 } = createRequire(import.meta.url)('../pkg/node/privatum_crypto.js');
const enc = new TextEncoder();
const dec = new TextDecoder();

test('two accounts get different keys (RNG is wired in WASM)', () => {
  assert.notEqual(new Account().curve25519, new Account().curve25519);
});

test('alice and bob exchange messages through the ratchet', () => {
  const alice = new Account();
  const bob = new Account();
  bob.generateOneTimeKeys(1);
  const [otk] = Object.values(JSON.parse(bob.oneTimeKeys()));
  bob.markKeysAsPublished();

  const toBob = alice.createOutboundSession(bob.curve25519, otk);
  const first = toBob.encrypt(enc.encode('olá bob'));
  assert.equal(first.messageType, 0);

  const inbound = bob.createInboundSession(alice.curve25519, first.ciphertext);
  assert.equal(dec.decode(inbound.plaintext), 'olá bob');
  const toAlice = inbound.takeSession();

  const reply = toAlice.encrypt(enc.encode('oi alice'));
  assert.equal(reply.messageType, 1);
  assert.equal(dec.decode(toBob.decrypt(1, reply.ciphertext)), 'oi alice');
  assert.throws(() => toBob.decrypt(1, reply.ciphertext), 'replay must fail');
});

test('pickles need the right 32-byte key', () => {
  const a = new Account();
  const key = crypto.getRandomValues(new Uint8Array(32));
  assert.equal(Account.fromPickle(a.pickle(key), key).ed25519, a.ed25519);
  assert.throws(() => Account.fromPickle(a.pickle(key), new Uint8Array(32)));
  assert.throws(() => a.pickle(new Uint8Array(16)));
  assert.equal(typeof Session.fromPickle, 'function');
});

test('signatures', () => {
  const a = new Account();
  const sig = a.sign(enc.encode('m'));
  assert.equal(verifyEd25519(a.ed25519, enc.encode('m'), sig), true);
  assert.equal(verifyEd25519(a.ed25519, enc.encode('x'), sig), false);
});
