import { describe, expect, it } from 'vitest';
import { assetKeyAndSha256 } from '@chalk-format/model';
import { createRegistryClient, RegistryError } from './registry.js';

const bytes = new TextEncoder().encode('a pendulum video');
const { key, sha256 } = await assetKeyAndSha256(bytes);
const record = (extra = {}) => ({ key, sha256, type: 'video/mp4', size: bytes.byteLength, status: 'available', createdAt: '2026-10-21T00:00:00Z', ...extra });

/** A fake registry and bucket, answering registry-api §3. */
function fakeRegistry(existing: boolean) {
  const calls: string[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url), m = init?.method ?? 'GET'; calls.push(`${m} ${u.replace('https://reg.example/', '')}`);
    const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('v1/uploads')) return existing ? json({ exists: true, asset: record({ title: 'old' }) }) : json({ upload: { url: 'https://bucket.example/c1/x', method: 'PUT', expiresAt: '2026-10-21T01:00:00Z' }, store: 'r2' });
    if (u === 'https://bucket.example/c1/x') return new Response(null, { status: 200 });
    if (u.endsWith('v1/assets') && m === 'POST') return json(record({ title: body.title }));
    if (u.endsWith('v1/assets/check')) return json({ present: [], missing: body.keys });
    if (u.includes('v1/search')) return json({ items: [record()], next: 'abc' });
    return json({ error: { code: 'not_found', message: 'no such thing' } }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('registry client (registry-api.md)', () => {
  it('adds a new asset: hash once, upload to the bucket, register', async () => {
    const f = fakeRegistry(false);
    const rec = await createRegistryClient('https://reg.example', { token: 't', fetch: f.fetch }).add(bytes, { type: 'video/mp4', title: 'দোলক' });
    expect(rec).toMatchObject({ key, sha256, title: 'দোলক' });
    expect(f.calls).toEqual(['POST v1/uploads', 'PUT https://bucket.example/c1/x', 'POST v1/assets']);
  });

  it('reuses an asset the registry already has, without uploading', async () => {
    const f = fakeRegistry(true);
    const rec = await createRegistryClient('https://reg.example/', { fetch: f.fetch }).add(bytes, { type: 'video/mp4' });
    expect(rec.title).toBe('old');
    expect(f.calls).toEqual(['POST v1/uploads']);
  });

  it('searches with filters, and reports errors with their code', async () => {
    const f = fakeRegistry(false), c = createRegistryClient('https://reg.example/', { fetch: f.fetch });
    const page = await c.search({ q: 'দোলক', type: ['video/*'], mine: true, limit: 10 });
    expect(page.next).toBe('abc');
    expect(f.calls[0]).toBe(`GET v1/search?q=${encodeURIComponent('দোলক')}&type=${encodeURIComponent('video/*')}&mine=1&limit=10`);
    await expect(c.get(key)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(c.get(key)).rejects.toBeInstanceOf(RegistryError);
  });
});
