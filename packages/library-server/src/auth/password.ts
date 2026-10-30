import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Passwords: scrypt with a random salt per user, compared in constant time. The parameters are stored with the
 * hash (`scrypt$N$r$p$salt$hash`), so they can be raised later without breaking the passwords already set.
 */
export const MIN_PASSWORD = 10;
/** Longer passwords are refused before hashing: hashing megabytes is a way to tie up the server. */
export const MAX_PASSWORD = 1024;
const N = 2 ** 15, R = 8, P = 1, LEN = 32;

const scrypt = (pw: string, salt: Buffer, n: number, r: number, p: number) => new Promise<Buffer>((ok, fail) =>
  scryptCb(pw.normalize('NFC'), salt, LEN, { N: n, r, p, maxmem: 256 * n * r } satisfies ScryptOptions, (e, k) => (e ? fail(e) : ok(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${(await scrypt(pw, salt, N, R, P)).toString('base64url')}`;
}

/** A hash of no password: unknown users are checked against it, so they take as long as known ones. */
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword(randomBytes(16).toString('hex')));

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  const parts = (stored ?? (await dummyHash())).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const want = Buffer.from(hash, 'base64url');
  const got = await scrypt(pw, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return stored !== null && got.length === want.length && timingSafeEqual(got, want);
}

export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string') return 'password is required';
  if ([...pw].length < MIN_PASSWORD) return `a password has at least ${MIN_PASSWORD} characters`;
  if (pw.length > MAX_PASSWORD) return `a password has at most ${MAX_PASSWORD} characters`;
  return null;
}
