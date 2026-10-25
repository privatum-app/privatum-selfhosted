// The panel's onion key backup: round trip, wrong passphrase, other files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptBackup, encryptBackup } from '../src/admin/backup.ts';

const files = { hostname: 'a'.repeat(56) + '.onion', secret_key: 'c2VjcmV0', public_key: 'cHVibGlj' };

test('onion key backup decrypts only with its passphrase', async () => {
  const text = await encryptBackup(files, 'frase longa de teste');
  assert.ok(!text.includes('c2VjcmV0') && !text.includes(files.hostname), 'nothing in the clear');
  assert.deepEqual(await decryptBackup(text, 'frase longa de teste'), files);
  await assert.rejects(decryptBackup(text, 'outra frase longa'), { message: 'wrong_passphrase' });
  await assert.rejects(decryptBackup('{"format":"privatum-backup"}', 'x'), { message: 'bad_backup' });
  await assert.rejects(decryptBackup('não é json', 'x'), { message: 'bad_backup' });
});
