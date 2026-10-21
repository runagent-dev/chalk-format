import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assetKey, assetKeyAndSha256, base32, c1FromSha256, isC1Key, isContentAddressedId, resolutionKey, verifyAssetBytes } from './keys.js';
import { lessonObjectSchema } from './schema.js';

// The normative vectors every implementation must reproduce (spec 1.2 §3.2).
type Vectors = { vectors: { name: string; base64: string; sha256: string; key: string }[]; fromSha256: { id: string; key: string }[]; valid: string[]; invalid: string[] };
const V = JSON.parse(readFileSync(new URL('../../../conformance/keys.json', import.meta.url), 'utf8')) as Vectors;
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));

describe('c1 keys (spec 1.2 §3)', () => {
  for (const v of V.vectors) {
    it(`reproduces the vector: ${v.name}`, async () => {
      expect(await assetKey(bytes(v.base64))).toBe(v.key);
      expect(await assetKeyAndSha256(bytes(v.base64))).toEqual({ key: v.key, sha256: v.sha256 });
    });
  }

  it('derives the key of a sha256 id without the bytes', () => {
    for (const f of V.fromSha256) { expect(c1FromSha256(f.id)).toBe(f.key); expect(resolutionKey(f.id)).toBe(f.key); }
  });

  it('accepts exactly the canonical form', () => {
    for (const k of V.valid) expect(isC1Key(k), k).toBe(true);
    for (const k of V.invalid) expect(isC1Key(k), k).toBe(false);
  });

  it('knows which ids are content-addressed', () => {
    expect(isContentAddressedId(V.valid[0]!)).toBe(true);
    expect(isContentAddressedId(V.fromSha256[0]!.id)).toBe(true);
    expect(isContentAddressedId('img-1')).toBe(false);
    expect(resolutionKey('img-1')).toBeNull();
  });

  it('verifies bytes against either form of id', async () => {
    const v = V.vectors[3]!, b = bytes(v.base64);
    expect(await verifyAssetBytes(v.key, b)).toBe(true);
    expect(await verifyAssetBytes(`sha256:${v.sha256}`, b)).toBe(true);
    expect(await verifyAssetBytes(v.key, new Uint8Array([1, 2, 3]))).toBe(false);
    expect(await verifyAssetBytes('img-1', b)).toBe(false);
  });

  it('encodes base32 as RFC 4648 (lower case, no padding)', () => {
    // RFC 4648 §10: "foobar" → MZXW6YTBOI======
    expect(base32(new TextEncoder().encode('foobar'))).toBe('mzxw6ytboi');
  });

  it('lets a lab entry be a c1 key (schema v9)', () => {
    const lab = { id: 'l', type: 'embed', embed: 'plugin', plugin: 'chalk.lab', x: 0, y: 0, width: 1, height: 1,
      lab: { id: 'org.example.lab', version: '1', title: 'Lab', entry: V.valid[0]!, assets: [V.valid[1]!, V.fromSha256[2]!.id] } };
    expect(lessonObjectSchema.safeParse(lab).success).toBe(true);
    expect(lessonObjectSchema.safeParse({ ...lab, lab: { ...lab.lab, entry: V.invalid[0]! } }).success).toBe(false);
  });
});
