import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const SECRET_PREFIX = 'v1';

export function buildAppConnectorSecretKey(rawSecret: string): Buffer {
  const normalized = String(rawSecret || '').trim();
  if (!normalized) {
    throw new Error('PLATFORM_SECRETS_KEY or JWT_SECRET_KEY is required');
  }
  return createHash('sha256').update(normalized).digest();
}

export function encryptAppConnectorSecretJson(value: Record<string, unknown>, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(value || {});
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    SECRET_PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function decryptAppConnectorSecretJson(value: string | null | undefined, key: Buffer): Record<string, unknown> {
  const raw = String(value || '').trim();
  if (!raw) {
    return {};
  }
  const [version, ivRaw, tagRaw, encryptedRaw] = raw.split(':');
  if (version !== SECRET_PREFIX || !ivRaw || !tagRaw || !encryptedRaw) {
    return {};
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  const parsed = JSON.parse(plaintext);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}
