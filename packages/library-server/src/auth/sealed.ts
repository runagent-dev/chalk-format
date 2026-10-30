import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for the two secrets the auth tables hold that are not hashes:
 *
 * - the private signing keys (table auth_keys), sealed with a key derived from the operator's AUTH_KEY_SECRET, so a
 *   copy of the database alone cannot sign tokens;
 * - a rotated refresh token's successor (auth_refresh_tokens.successor), sealed with a key derived from the rotated
 *   token itself, so only whoever presents that token can get the successor back (the grace window).
 *
 * Stored as `enc:v1:` + base64url(iv ‖ ciphertext ‖ tag); `aad` binds the value to its row (a kid, a token id).
 */
const PREFIX = 'enc:v1:';
/** The shortest AUTH_KEY_SECRET accepted (`openssl rand -base64 32` gives 44 characters). */
export const MIN_KEY_SECRET = 32;

const derive = (ikm: string, info: string) => Buffer.from(hkdfSync('sha256', Buffer.from(ikm, 'utf8'), Buffer.from('chalk-library'), Buffer.from(info), 32));

export const isSealed = (stored: string) => stored.startsWith(PREFIX);

function seal(key: Buffer, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, body, c.getAuthTag()]).toString('base64url');
}

/** The plain text, or null when the key or the row is not the one it was sealed with (or it was altered). */
function open(key: Buffer, stored: string, aad: string): string | null {
  if (!isSealed(stored)) return null;
  const all = Buffer.from(stored.slice(PREFIX.length), 'base64url');
  if (all.length < 12 + 16) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, all.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(all.subarray(all.length - 16));
    return Buffer.concat([d.update(all.subarray(12, all.length - 16)), d.final()]).toString('utf8');
  } catch { return null; }
}

export type KeySealer = { seal(kid: string, pem: string): string; open(kid: string, stored: string): string | null };

/** The sealer for signing keys, from AUTH_KEY_SECRET. Throws when the secret is too short to be a key. */
export function keySealer(secret: string): KeySealer {
  if (secret.length < MIN_KEY_SECRET) throw new Error(`AUTH_KEY_SECRET must have at least ${MIN_KEY_SECRET} characters (e.g. openssl rand -base64 32)`);
  const key = derive(secret, 'auth_keys v1');
  return { seal: (kid, pem) => seal(key, pem, `auth_keys:${kid}`), open: (kid, stored) => open(key, stored, `auth_keys:${kid}`) };
}

/** A refresh token's successor, readable only with the token it replaced. */
export const sealSuccessor = (token: string, rowId: string, successor: string) => seal(derive(token, 'refresh successor v1'), successor, `refresh:${rowId}`);
export const openSuccessor = (token: string, rowId: string, stored: string) => open(derive(token, 'refresh successor v1'), stored, `refresh:${rowId}`);
