import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify, type KeyObject } from 'node:crypto';

/**
 * Access tokens: compact JWS (RFC 7515) signed with Ed25519, `alg: EdDSA` (RFC 8037), nothing else. The algorithm
 * is fixed here, never taken from the token: a token that says `none` or `HS256` is refused before any key is
 * looked at (the "algorithm confusion" attacks on JWT libraries).
 */
export const AUDIENCE = 'chalk-library';
/** How far another clock may be off, for `exp` and `iat`. */
export const CLOCK_SKEW_S = 30;

export type AccessClaims = { iss: string; aud: string; sub: string; name: string; roles: string[]; iat: number; exp: number; jti: string };
export type SigningKey = { kid: string; privateKey?: KeyObject; publicKey: KeyObject };
export type Jwk = { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; alg: 'EdDSA'; use: 'sig' };

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const json = (s: string): unknown => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } };

/** A new key pair, as PEM for the database. */
export function newKeyPair(): { kid: string; publicPem: string; privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    kid: randomBytes(12).toString('base64url'),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export const keyFromPem = (kid: string, publicPem: string, privatePem?: string): SigningKey => ({
  kid, publicKey: createPublicKey(publicPem), ...(privatePem ? { privateKey: createPrivateKey(privatePem) } : {}),
});

export function jwkOf(k: SigningKey): Jwk {
  const { x } = k.publicKey.export({ format: 'jwk' }) as { x: string };
  return { kty: 'OKP', crv: 'Ed25519', x, kid: k.kid, alg: 'EdDSA', use: 'sig' };
}

export function signAccessToken(key: SigningKey, c: Omit<AccessClaims, 'iat' | 'exp' | 'jti' | 'aud'>, ttlSeconds: number, now = Date.now()): string {
  if (!key.privateKey) throw new Error('this key cannot sign');
  const iat = Math.floor(now / 1000);
  const claims: AccessClaims = { iss: c.iss, aud: AUDIENCE, sub: c.sub, name: c.name, roles: c.roles, iat, exp: iat + ttlSeconds, jti: randomUUID() };
  const input = `${b64(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: key.kid }))}.${b64(JSON.stringify(claims))}`;
  return `${input}.${b64(sign(null, Buffer.from(input), key.privateKey))}`;
}

/** The token's `kid`, if it is shaped like one of ours (for looking the key up before verifying). */
export function kidOf(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const h = json(parts[0]!) as { alg?: unknown; kid?: unknown } | null;
  return h && h.alg === 'EdDSA' && typeof h.kid === 'string' ? h.kid : null;
}

/** The claims of a valid token, or null: signature by `key`, `alg`, `kid`, `iss`, `aud`, `exp` and `iat` all checked. */
export function verifyAccessToken(token: string, key: SigningKey, issuer: string, now = Date.now()): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = json(h) as { alg?: unknown; kid?: unknown; crit?: unknown } | null;
  if (!header || header.alg !== 'EdDSA' || header.kid !== key.kid || header.crit !== undefined) return null;
  const sig = Buffer.from(s, 'base64url');
  if (sig.length !== 64 || !verify(null, Buffer.from(`${h}.${p}`), key.publicKey, sig)) return null;
  const c = json(p) as Partial<AccessClaims> | null;
  if (!c || typeof c !== 'object') return null;
  const t = now / 1000;
  const audOk = c.aud === AUDIENCE || (Array.isArray(c.aud) && (c.aud as unknown[]).includes(AUDIENCE));
  if (c.iss !== issuer || !audOk) return null;
  if (typeof c.exp !== 'number' || c.exp + CLOCK_SKEW_S <= t) return null;
  if (typeof c.iat !== 'number' || c.iat - CLOCK_SKEW_S > t) return null;
  if (typeof c.sub !== 'string' || typeof c.name !== 'string' || !Array.isArray(c.roles) || !c.roles.every((r) => typeof r === 'string')) return null;
  return c as AccessClaims;
}
