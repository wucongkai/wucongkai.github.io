// Version 1: PBKDF2-SHA256 + AES-256-GCM. Only this encrypted envelope is persisted.
const iterations = 600_000;
const encoder = new TextEncoder();
const invalidRecord =
  '保存的凭据无法读取，请忘记此设备后重新输入 GitHub 令牌。';

export function credentialKey(repository: string) {
  return `wiki-studio-credential:${repository}`;
}

function webCrypto() {
  if (!globalThis.crypto?.subtle)
    throw new Error(
      '当前浏览器无法加密凭据，请通过 HTTPS 打开写作台，或取消记住此设备。',
    );
  return globalThis.crypto;
}

function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function decode(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 6000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error(invalidRecord);
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>) {
  const crypto = webCrypto();
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptToken(
  token: string,
  password: string,
  repository: string,
) {
  if (password.length < 10 || password.length > 256)
    throw new Error('设备密码需要 10–256 个字符，建议使用容易记住的长句。');
  token = token.trim();
  if (!token || encoder.encode(token).length > 4096)
    throw new Error('请填写有效的 GitHub 令牌。');
  const crypto = webCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode(`v1:${credentialKey(repository)}`),
      tagLength: 128,
    },
    key,
    encoder.encode(token),
  );
  return JSON.stringify({
    version: 1,
    salt: encode(salt),
    iv: encode(iv),
    ciphertext: encode(new Uint8Array(ciphertext)),
  });
}

export async function decryptToken(
  record: string,
  password: string,
  repository: string,
) {
  webCrypto();
  let salt: Uint8Array<ArrayBuffer>;
  let iv: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    if (record.length > 8000) throw new Error(invalidRecord);
    const value = JSON.parse(record);
    if (value.version !== 1) throw new Error(invalidRecord);
    salt = decode(value.salt);
    iv = decode(value.iv);
    ciphertext = decode(value.ciphertext);
    if (
      salt.length !== 16 ||
      iv.length !== 12 ||
      ciphertext.length < 17 ||
      ciphertext.length > 4112
    )
      throw new Error(invalidRecord);
  } catch {
    throw new Error(invalidRecord);
  }
  if (!password || password.length > 256) throw new Error('请输入设备密码。');
  try {
    const key = await derive(password, salt);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: encoder.encode(`v1:${credentialKey(repository)}`),
        tagLength: 128,
      },
      key,
      ciphertext,
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    throw new Error(
      '密码不正确，或保存的凭据已损坏。请重试，或忘记此设备后重新输入令牌。',
    );
  }
}
