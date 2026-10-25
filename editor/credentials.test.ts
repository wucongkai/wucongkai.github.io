import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialKey, decryptToken, encryptToken } from './credentials.ts';

// Deliberately fake credentials: these tests never call GitHub.
const token = 'test-only-not-a-github-token';
const password = '这是一句用于测试的设备密码';
const repository = 'example/wiki/main';

test('remembered credentials survive serialization without persisting token or password', async () => {
  const record = await encryptToken(` ${token} `, password, repository);
  const storage = new Map([[credentialKey(repository), record]]);
  assert.ok(!record.includes(token));
  assert.ok(!record.includes(password));
  assert.deepEqual(Object.keys(JSON.parse(record)).sort(), [
    'ciphertext',
    'iv',
    'salt',
    'version',
  ]);
  assert.equal(
    await decryptToken(
      storage.get(credentialKey(repository))!,
      password,
      repository,
    ),
    token,
  );
  assert.notEqual(
    credentialKey(repository),
    credentialKey('example/other/main'),
  );
});

test('each save generates fresh salt and IV even for the same credentials', async () => {
  const first = JSON.parse(await encryptToken(token, password, repository));
  const second = JSON.parse(await encryptToken(token, password, repository));
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test('wrong passwords, tampered ciphertext and cross-repository copies cannot unlock', async () => {
  const record = await encryptToken(token, password, repository);
  await assert.rejects(
    decryptToken(record, 'another-password', repository),
    /密码不正确/,
  );
  await assert.rejects(
    decryptToken(record, password, 'example/other/main'),
    /密码不正确/,
  );
  const modified = JSON.parse(record);
  const bytes = Buffer.from(modified.ciphertext, 'base64');
  bytes[0] ^= 1;
  modified.ciphertext = bytes.toString('base64');
  await assert.rejects(
    decryptToken(JSON.stringify(modified), password, repository),
    /密码不正确/,
  );
  // Failed attempts must not mutate or destroy the saved record.
  assert.equal(await decryptToken(record, password, repository), token);
});

test('unsupported, malformed and oversized records are rejected before decryption', async () => {
  for (const record of [
    'null',
    '{}',
    '{',
    'x'.repeat(8001),
    JSON.stringify({ version: 2 }),
    JSON.stringify({ version: 1, salt: '!', iv: 'aaaa', ciphertext: 'aaaa' }),
    JSON.stringify({
      version: 1,
      salt: 'a'.repeat(24),
      iv: 'aaaa',
      ciphertext: 'aaaa',
    }),
  ]) {
    await assert.rejects(
      decryptToken(record, password, repository),
      /保存的凭据无法读取/,
    );
  }
});

test('empty tokens and weak or excessive passwords are not saved', async () => {
  await assert.rejects(
    encryptToken('', password, repository),
    /有效的 GitHub 令牌/,
  );
  await assert.rejects(
    encryptToken('x'.repeat(4097), password, repository),
    /有效的 GitHub 令牌/,
  );
  await assert.rejects(encryptToken(token, 'short', repository), /10–256/);
  await assert.rejects(
    encryptToken(token, 'x'.repeat(257), repository),
    /10–256/,
  );
});
