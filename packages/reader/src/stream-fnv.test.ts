import { describe, expect, it } from 'vitest';
import { fnv1a } from './stream';

describe('fnv1a (the index version where crypto.subtle is missing)', () => {
  it('matches the published 64-bit FNV-1a vectors', () => {
    expect(fnv1a(new Uint8Array())).toBe('cbf29ce484222325');
    expect(fnv1a(new TextEncoder().encode('a'))).toBe('af63dc4c8601ec8c');
    expect(fnv1a(new TextEncoder().encode('foobar'))).toBe('85944171f73967e8');
  });
});
