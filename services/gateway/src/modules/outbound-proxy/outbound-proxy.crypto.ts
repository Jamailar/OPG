import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ENCRYPTION_PREFIX = 'v1';

export function buildOutboundProxySecretKey(rawSecret: string): Buffer {
  const normalized = String(rawSecret || '').trim();
  if (!normalized) {
    throw new Error('OUTBOUND_PROXY_ENCRYPTION_KEY or JWT_SECRET_KEY is required');
  }
  return createHash('sha256').update(normalized).digest();
}

export function encryptOutboundProxyPassword(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function decryptOutboundProxyPassword(value: string | null | undefined, key: Buffer): string {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  const [version, ivRaw, tagRaw, encryptedRaw] = raw.split(':');
  if (version !== ENCRYPTION_PREFIX || !ivRaw || !tagRaw || !encryptedRaw) {
    return '';
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
