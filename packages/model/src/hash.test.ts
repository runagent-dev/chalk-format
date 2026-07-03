import { describe, expect, it } from 'vitest';
import { hashBytes, isSha256AssetId } from './hash.js';

describe('hashBytes', () => {
  it('produces the well-known SHA-256 for an empty input', async () => {
    const id = await hashBytes(new Uint8Array());
    expect(id).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('produces the well-known SHA-256 for "abc"', async () => {
    const id = await hashBytes(new TextEncoder().encode('abc'));
    expect(id).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is deterministic — same bytes always yield the same id', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const a = await hashBytes(bytes);
    const b = await hashBytes(bytes);
    expect(a).toBe(b);
  });

  it('is sensitive to a single byte change', async () => {
    const a = await hashBytes(new Uint8Array([1, 2, 3]));
    const b = await hashBytes(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });
});

describe('isSha256AssetId', () => {
  it('accepts a valid id', () => {
    expect(
      isSha256AssetId(
        'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ),
    ).toBe(true);
  });
  it('rejects wrong prefix, wrong length, upper case', () => {
    expect(isSha256AssetId('md5:e3b0c442')).toBe(false);
    expect(isSha256AssetId('sha256:short')).toBe(false);
    expect(
      isSha256AssetId(
        'sha256:E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855',
      ),
    ).toBe(false);
  });
});
