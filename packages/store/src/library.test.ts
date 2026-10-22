import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { assetKey, indexShardSchema } from '@chalk-format/model';
import { deviceLibrary, folderLibrary, memoryDir, libraryResolver, registryLibrary, searchItems, type Library } from './index.js';

const enc = (s: string) => new TextEncoder().encode(s);
const VIDEO = enc('a pendulum video'), GLB = enc('a screw gauge model');

describe('search (shared by device and folder libraries)', () => {
  const items = [
    { key: 'c1:a', type: 'video/mp4', size: 1, title: 'সরল দোলক · Simple pendulum', tags: ['oscillation'], createdAt: '2026-01-02' },
    { key: 'c1:b', type: 'model/gltf-binary', size: 1, title: 'স্ক্রু গজ', filename: 'screw-gauge.glb', createdAt: '2026-01-03' },
    { key: 'c1:c', type: 'video/webm', size: 1, title: 'Tuning fork ৪৪০ Hz', createdAt: '2026-01-01' },
  ];
  it('finds by any word, any script, any case; filters by type; newest first', () => {
    expect(searchItems(items, { q: 'দোলক' }).items.map((i) => i.key)).toEqual(['c1:a']);
    expect(searchItems(items, { q: 'PENDULUM oscillation' }).items.map((i) => i.key)).toEqual(['c1:a']);
    expect(searchItems(items, { q: '440' }).items.map((i) => i.key)).toEqual(['c1:c']);   // Bengali digits match ASCII
    expect(searchItems(items, { types: ['video/*'] }).items.map((i) => i.key)).toEqual(['c1:a', 'c1:c']);
    expect(searchItems(items, { q: 'gauge' }).items.map((i) => i.key)).toEqual(['c1:b']);
  });
  it('pages', () => {
    const p1 = searchItems(items, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(searchItems(items, { limit: 2, cursor: p1.next! }).items).toHaveLength(1);
  });
});

describe('this device (IndexedDB)', () => {
  it('keeps what is added, once per content, and gives it back', async () => {
    const idb = new IDBFactory();
    const lib = deviceLibrary({ indexedDB: idb, database: 't1' });
    const a = await lib.put!({ bytes: VIDEO, type: 'video/mp4', title: 'সরল দোলক' });
    const again = await lib.put!({ bytes: VIDEO, type: 'video/mp4', title: 'a copy' });
    expect(again.key).toBe(a.key);
    expect(a.key).toBe(await assetKey(VIDEO));
    expect((await lib.search({ q: 'দোলক' })).items).toHaveLength(1);
    expect((await lib.get(a.key))?.bytes).toEqual(VIDEO);
    expect(await lib.has([a.key, 'c1:' + 'z'.repeat(25) + 'a'])).toEqual(new Set([a.key]));
    // survives a new connection (a reload)
    lib.dispose!();
    const reopened = deviceLibrary({ indexedDB: idb, database: 't1' });
    expect((await reopened.get(a.key))?.bytes).toEqual(VIDEO);
  });
});

describe('a folder', () => {
  it('stores what is added in the standard layout, with its index shard', async () => {
    const dir = memoryDir('school');
    const lib = folderLibrary(dir);
    const it = await lib.put!({ bytes: GLB, type: 'model/gltf-binary', title: 'স্ক্রু গজ' });
    const h = it.key.slice(3);
    expect(dir.files.get(`c1/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`)).toEqual(GLB);
    const shard = indexShardSchema.parse(JSON.parse(new TextDecoder().decode(dir.files.get(`index/${h.slice(0, 2)}.json`)!)));
    expect(shard.entries[h]).toMatchObject({ p: `c1/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`, t: 'model/gltf-binary' });
    // a second library over the same folder (another device, the same USB drive) sees it
    expect((await folderLibrary(dir).search({ q: 'গজ' })).items.map((i) => i.key)).toEqual([it.key]);
  });

  it('scans media already in the folder: keys once, titles from file names, nothing else touched', async () => {
    const dir = memoryDir('usb', { 'class9/pendulum-video.mp4': VIDEO, 'class9/notes.txt': enc('not media'), 'gauge.glb': GLB });
    const lib = folderLibrary(dir);
    const seen: number[] = [];
    expect(await lib.scan((d) => seen.push(d))).toBe(2);
    expect(seen).toEqual([1, 2]);
    expect((await lib.search({ q: 'pendulum video' })).items[0]).toMatchObject({ key: await assetKey(VIDEO), filename: 'pendulum-video.mp4', type: 'video/mp4' });
    expect(await lib.get(await assetKey(GLB))).toMatchObject({ bytes: GLB });
    expect(await lib.scan()).toBe(0);   // nothing new the second time
    expect(dir.files.get('class9/pendulum-video.mp4')).toEqual(VIDEO);
  });

  it('served over HTTP it is a store readers can use', async () => {
    const lib = folderLibrary(memoryDir('srv'), { publicUrl: 'http://192.168.1.10/chalk' });
    const it = await lib.put!({ bytes: VIDEO, type: 'video/mp4' });
    expect(await lib.delivery!()).toMatchObject({ kind: 'indexed', base: 'http://192.168.1.10/chalk/' });
    expect(await lib.url(it.key)).toMatch(/^http:\/\/192\.168\.1\.10\/chalk\/c1\//);
  });
});

describe('a library server (registry API)', () => {
  const key = 'c1:' + 'q'.repeat(25) + 'a';
  const server = (status = 200) => (async (url: string, init?: RequestInit) => {
    const u = String(url), json = (o: unknown, s = status) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('v1/stores')) return status === 200 ? json({ items: [{ id: 'cdn', kind: 'derived', template: 'https://media.example.org/c1/{h0}/{h1}/{h}' }] }) : json({ error: { code: 'unauthorized', message: 'sign in' } }, status);
    if (u.includes('v1/search')) return json({ items: [{ key, sha256: 'a'.repeat(64), type: 'video/mp4', size: 9, title: 'দোলক', status: 'available', createdAt: '2026-10-22T00:00:00Z' }] });
    if (u.endsWith('v1/assets/check')) return json({ present: [key], missing: JSON.parse(String(init!.body)).keys.filter((k: string) => k !== key) });
    return json({ error: { code: 'not_found', message: '' } }, 404);
  }) as unknown as typeof fetch;
  it('searches through the API and reads from its delivery store', async () => {
    const lib = registryLibrary({ url: 'https://library.example.org', fetch: server(), token: () => 'tok' });
    expect((await lib.search({ q: 'দোলক', types: ['video/*'] })).items[0]).toMatchObject({ key, title: 'দোলক' });
    expect(await lib.url(key)).toBe(`https://media.example.org/c1/qq/qq/${key.slice(3)}`);
    expect(await lib.has([key, 'c1:' + 'r'.repeat(25) + 'a'])).toEqual(new Set([key]));
    expect(await lib.item('c1:' + 'r'.repeat(25) + 'a')).toBeNull();
    expect(lib.writable).toBe(true);
  });
  it('says when it needs a sign-in', async () => {
    expect(await registryLibrary({ url: 'https://library.example.org', fetch: server(401) }).status!()).toBe('sign-in');
  });
});

describe('reading through libraries, in order', () => {
  const fake = (id: string, have: Record<string, string>, fail = false): Library => ({
    id, name: id, kind: 'test', writable: false,
    search: async () => ({ items: [] }), item: async () => null, has: async () => new Set(),
    get: async () => null,
    url: async (k) => { if (fail) throw new Error('offline'); return have[k] ?? null; },
  });
  it('takes the first that has an item, passes over one that is unreachable, and says not found otherwise', async () => {
    const r = libraryResolver(() => [fake('down', {}, true), fake('a', { k1: 'https://a/k1' }), fake('b', { k1: 'https://b/k1', k2: 'https://b/k2' })]);
    expect(await r('k1')).toBe('https://a/k1');
    expect(await r('k2')).toBe('https://b/k2');
    expect(await r('k3')).toBeNull();
  });
});
