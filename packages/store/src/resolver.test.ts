import { describe, expect, it, vi } from 'vitest';
import { assetKey, type StoreDescriptor } from '@chalk-format/model';
import { createResolver, type AssetCache } from './resolver.js';
import { derivedUrl, matchesType, shardOf, standardPath } from './urls.js';

const enc = (s: string) => new TextEncoder().encode(s);
const PNG = enc('pretend png bytes'), MP4 = enc('pretend mp4 bytes'), LAB = enc('<!doctype html><p>lab</p>');
const K = { png: await assetKey(PNG), mp4: await assetKey(MP4), lab: await assetKey(LAB) };

/** A fake network: url → bytes (or a status); records every request. */
function net(files: Record<string, Uint8Array | number | object>) {
  const calls: string[] = [];
  const fake = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url); calls.push(`${init?.method ?? 'GET'} ${u}`);
    const f = files[u];
    if (f === undefined) return new Response(null, { status: 404 });
    if (typeof f === 'number') return new Response(null, { status: f });
    if (f instanceof Uint8Array) return new Response(f as unknown as BodyInit, { status: 200 });
    return new Response(JSON.stringify(f), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fake, calls };
}
const cdn: StoreDescriptor = { id: 'cdn', kind: 'derived', template: 'https://cdn.example/c1/{h0}/{h1}/{h}' };
const at = (s: StoreDescriptor, k: string) => derivedUrl(s, k);

describe('keys to URLs (spec 1.2 §5)', () => {
  it('uses the standard layout', () => {
    expect(standardPath('c1:jf3zbfd5izthmdhdr46ab2csy4')).toBe('c1/jf/3z/jf3zbfd5izthmdhdr46ab2csy4');
    expect(shardOf('c1:jf3zbfd5izthmdhdr46ab2csy4')).toBe('jf');
  });
  it('matches media type patterns', () => {
    expect(matchesType(['video/*'], 'video/mp4')).toBe(true);
    expect(matchesType(['video/*'], 'image/png')).toBe(false);
    expect(matchesType(undefined, 'image/png')).toBe(true);
    expect(matchesType(['*/*'], 'model/gltf-binary')).toBe(true);
  });
});

describe('the resolver (spec 1.2 §6)', () => {
  it('takes the first store that has it: host before book, then priority', async () => {
    const school: StoreDescriptor = { id: 'school', kind: 'derived', template: 'http://lan/{h}', priority: 0 };
    const pub: StoreDescriptor = { id: 'publisher', kind: 'derived', template: 'https://pub/{h}', priority: -100 };
    const n = net({ [at(cdn, K.png)]: PNG, [at(school, K.png)]: PNG, [at(pub, K.png)]: PNG });
    const r = createResolver({ hostStores: [cdn, school], bookStores: [pub], fetch: n.fetch });
    expect(r.plan('image/png')).toEqual(['school', 'cdn', 'publisher']);   // a book's priority never beats the host's stores
    expect((await r.resolve(K.png, 'image/png'))?.from).toBe('school');
    expect(n.calls).toHaveLength(1);
  });

  it('serves each store only its media types', async () => {
    const video: StoreDescriptor = { id: 'video', kind: 'derived', template: 'https://v/{h}', media: ['video/*'] };
    const n = net({ [at(video, K.mp4)]: MP4, [at(cdn, K.png)]: PNG });
    const r = createResolver({ hostStores: [video, cdn], fetch: n.fetch });
    expect(r.plan('image/png')).toEqual(['cdn']);
    expect((await r.resolve(K.mp4, 'video/mp4'))?.from).toBe('video');
  });

  it('moves on after 404 and 410, and skips a failing store for a while', async () => {
    let t = 0;
    const down: StoreDescriptor = { id: 'down', kind: 'derived', template: 'https://down/{h}', priority: 1 };
    const gone: StoreDescriptor = { id: 'gone', kind: 'derived', template: 'https://gone/{h}', priority: 2 };
    const n = net({ [at(down, K.png)]: 503, [at(down, K.mp4)]: 503, [at(gone, K.png)]: 410, [at(cdn, K.png)]: PNG, [at(cdn, K.mp4)]: MP4 });
    const r = createResolver({ hostStores: [down, gone, cdn], fetch: n.fetch, now: () => t });
    expect((await r.resolve(K.png, 'image/png'))?.from).toBe('cdn');
    expect((await r.resolve(K.mp4, 'video/mp4'))?.from).toBe('cdn');
    expect(n.calls.filter((c) => c.includes('//down/'))).toHaveLength(1);   // skipped the second time
    // after the skip window it is asked again
    t = 61_000; n.calls.length = 0;
    await r.resolve(K.png, 'image/png');
    expect(n.calls[0]).toContain('//down/');
  });

  it('checks bytes against the key, and tries the next store when they do not match', async () => {
    const liar: StoreDescriptor = { id: 'liar', kind: 'derived', template: 'https://liar/{h}', priority: 0 };
    const n = net({ [at(liar, K.png)]: enc('something else'), [at(cdn, K.png)]: PNG });
    const r = createResolver({ hostStores: [liar, cdn], fetch: n.fetch });
    const got = await r.resolve(K.png, 'image/png');
    expect(got?.from).toBe('cdn');
    expect(new Uint8Array(got!.bytes)).toEqual(PNG);
  });

  it('always verifies a lab entry, even from a trusted store', async () => {
    const trusted: StoreDescriptor = { ...cdn, id: 'trusted', verify: 'none' };
    const n = net({ [at(trusted, K.lab)]: enc('<!doctype html><script>evil()</script>') });
    expect(await createResolver({ hostStores: [trusted], fetch: n.fetch }).resolve(K.lab, 'text/html')).toBeNull();
    const n2 = net({ [at(trusted, K.png)]: enc('unchecked') });
    expect((await createResolver({ hostStores: [trusted], fetch: n2.fetch }).resolve(K.png, 'image/png'))?.from).toBe('trusted');
  });

  it('answers from the cache without any request, and caches what it fetched', async () => {
    const store = new Map<string, { bytes: ArrayBuffer; type: string }>();
    const cache: AssetCache = { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); } };
    const n = net({ [at(cdn, K.png)]: PNG });
    const r = createResolver({ hostStores: [cdn], cache, fetch: n.fetch });
    await r.resolve(K.png, 'image/png');
    const again = await createResolver({ hostStores: [cdn], cache, fetch: n.fetch }).resolve(K.png, 'image/png');
    expect(again?.from).toBe('cache');
    expect(n.calls).toHaveLength(1);
  });

  it('resolves a sha256 id through the same c1 stores', async () => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', PNG));
    const id = 'sha256:' + [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
    const n = net({ [at(cdn, K.png)]: PNG });
    expect((await createResolver({ hostStores: [cdn], fetch: n.fetch }).resolve(id, 'image/png'))?.from).toBe('cdn');
  });

  it('fetches an index shard once, for every key in it', async () => {
    const lan: StoreDescriptor = { id: 'lan', kind: 'indexed', base: 'http://lan/chalk/' };
    const k2 = K.png.slice(0, 5) + 'a'.repeat(21) + 'q';   // same shard, not present
    const n = net({
      [`http://lan/chalk/index/${shardOf(K.png)}.json`]: { v: 1, entries: { [K.png.slice(3)]: { p: 'physics/gauge.png' } } },
      'http://lan/chalk/physics/gauge.png': PNG,
    });
    const r = createResolver({ hostStores: [lan], fetch: n.fetch });
    expect((await r.resolve(K.png, 'image/png'))?.from).toBe('lan');
    expect(await r.resolve(k2, 'image/png')).toBeNull();
    expect(n.calls.filter((c) => c.includes('/index/'))).toHaveLength(1);
  });

  it('asks only one store at a time, and once per key while a request is open', async () => {
    const n = net({ [at(cdn, K.png)]: PNG });
    const r = createResolver({ hostStores: [cdn], fetch: n.fetch });
    const [a, b] = await Promise.all([r.resolve(K.png, 'image/png'), r.resolve(K.png, 'image/png')]);
    expect(a?.from).toBe('cdn'); expect(b?.from).toBe('cdn');
    expect(n.calls).toHaveLength(1);
  });

  it('finds a URL to stream from with HEAD, without downloading', async () => {
    const api: StoreDescriptor = { id: 'api', kind: 'api', base: 'https://store.example/', auth: 'bearer' };
    const n = net({ [`https://store.example/v1/a/${encodeURIComponent(K.mp4)}`]: MP4 });
    const r = createResolver({ hostStores: [api], fetch: n.fetch, token: () => 'tok' });
    expect(await r.locate(K.mp4, 'video/mp4')).toEqual({ url: `https://store.example/v1/a/${encodeURIComponent(K.mp4)}`, from: 'api', headers: { Authorization: 'Bearer tok' } });
    expect(n.calls[0]!.startsWith('HEAD ')).toBe(true);
    expect(await r.locate(K.lab, 'text/html')).toBeNull();   // labs are never streamed unverified
  });

  it("never sends a book's stores a token, and skips kinds it does not know", async () => {
    const n = net({});
    const seen: (string | null)[] = [];
    const fetch = (async (u: string, init?: RequestInit) => { seen.push(new Headers(init?.headers).get('authorization')); return n.fetch(u, init); }) as typeof globalThis.fetch;
    const r = createResolver({ bookStores: [{ id: 'pub', kind: 'api', base: 'https://pub/', auth: 'bearer' }, { id: 'p2p', kind: 'torrent' }], token: () => 'secret', fetch });
    expect(r.plan('image/png')).toEqual(['pub']);
    await r.resolve(K.png, 'image/png');
    expect(seen).toEqual([null]);
  });
});
