/**
 * Asset keys (spec 1.2 §3): `c1:` + base32 (RFC 4648, lower case, no padding) of the first 128 bits of the
 * SHA-256 of the bytes. 29 characters, computed once when an asset is added; readers only look keys up.
 * 1.0 `sha256:` ids stay valid, and each has a c1 key computed from the id alone (its resolution key).
 */

/** A canonical c1 key: 25 base32 characters, then one carrying 3 bits and two zero bits. */
export const C1_KEY_PATTERN = /^c1:[a-z2-7]{25}[aeimquy4]$/;
const SHA256_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export const isC1Key = (id: string): boolean => C1_KEY_PATTERN.test(id);
/** Content-addressed: a c1 key or a sha256 id. Only these may live outside a book (spec 1.0 §3.5, 1.2 §4.5). */
export const isContentAddressedId = (id: string): boolean => C1_KEY_PATTERN.test(id) || SHA256_ID_PATTERN.test(id);

/** base32 (RFC 4648 alphabet, lower case), no padding. */
export function base32(bytes: Uint8Array): string {
  let out = '', bits = 0, value = 0;
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

const keyOfDigest = (digest: Uint8Array) => 'c1:' + base32(digest.subarray(0, 16));

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer));
}

/** The c1 key of some bytes. For authoring tools and registries; readers never need it to find assets. */
export async function assetKey(bytes: Uint8Array): Promise<string> {
  return keyOfDigest(await sha256(bytes));
}

/** The c1 key and full SHA-256 (hex) at once: what a registry upload needs (registry-api §3). */
export async function assetKeyAndSha256(bytes: Uint8Array): Promise<{ key: string; sha256: string }> {
  const d = await sha256(bytes);
  return { key: keyOfDigest(d), sha256: [...d].map((b) => b.toString(16).padStart(2, '0')).join('') };
}

/** The c1 key a sha256 id resolves through, from the id alone (spec 1.2 §3.3). */
export function c1FromSha256(id: string): string {
  if (!SHA256_ID_PATTERN.test(id)) throw new Error(`not a sha256 id: ${id}`);
  const hex = id.slice(7, 39), bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return 'c1:' + base32(bytes);
}

/** The key stores know an asset by: itself for a c1 key, derived for a sha256 id, null for anything else. */
export function resolutionKey(id: string): string | null {
  if (C1_KEY_PATTERN.test(id)) return id;
  if (SHA256_ID_PATTERN.test(id)) return c1FromSha256(id);
  return null;
}

/** Are these the bytes the id names? (spec 1.2 §6.4). False for ids that are not content-addressed. */
export async function verifyAssetBytes(id: string, bytes: Uint8Array): Promise<boolean> {
  if (!isContentAddressedId(id)) return false;
  const d = await sha256(bytes);
  if (C1_KEY_PATTERN.test(id)) return keyOfDigest(d) === id;
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('') === id.slice(7);
}
