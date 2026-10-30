import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAuthLibrary } from '../../../../tools/fake-auth-library.js';
import { createRegistryClient } from '../registry.js';
import { registryLibrary } from '../registry-library.js';
import { openLibraryBook } from '../library-book/load.js';
import { LibraryAuthError, libraryAuth, tokenClaims } from './library-auth.js';
import { memoryStorage, webStorage, type AuthStorage } from './storage.js';
import { fetchWithToken } from './token.js';

const BASE = 'https://lib.example/';
const USERS = { rahim: { password: 'correct horse battery', roles: ['reader'] }, karim: { password: 'another long one', roles: ['reader', 'author'] } };

let clock = 1_800_000_000_000;
const now = () => clock;
const server = (o: { now?: () => number } = {}) => fakeAuthLibrary({ base: BASE, users: USERS, now: o.now ?? now });

/** A Web Storage area (localStorage) in memory. */
function fakeArea() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, map: m };
}
const refreshGrants = (s: ReturnType<typeof server>) => s.grants.filter((g) => g.grant === 'refresh_token');

let logs: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { clock = 1_800_000_000_000; logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m)); });
afterEach(() => {
  // tokens are never logged: nothing here logs at all
  for (const l of logs) { expect(l).not.toHaveBeenCalled(); l.mockRestore(); }
});

describe('libraryAuth: signing in', () => {
  it('signs in with a username and password, and reads the user from the token', async () => {
    const s = server();
    const auth = libraryAuth({ library: BASE, fetch: s.fetch, now });
    const changes: unknown[] = [];
    auth.onChange((u) => changes.push(u));
    expect(auth.user()).toBeNull();
    expect(await auth.token()).toBeUndefined();
    const user = await auth.signIn('karim', 'another long one');
    expect(user).toEqual({ sub: 'u-karim', name: 'karim', roles: ['reader', 'author'] });
    expect(auth.user()).toEqual(user);
    expect(changes).toEqual([user]);
    const t = await auth.token();
    expect(tokenClaims(t!)).toMatchObject({ aud: 'chalk-library', name: 'karim', roles: ['reader', 'author'] });
    expect(s.grants).toEqual([{ grant: 'password', ok: true }]);
  });

  it('a wrong password is a LibraryAuthError (invalid_grant) that says nothing of the password, and changes nothing', async () => {
    const s = server();
    const auth = libraryAuth({ library: BASE, fetch: s.fetch, now });
    const changes: unknown[] = [];
    auth.onChange((u) => changes.push(u));
    const e = await auth.signIn('rahim', 'not the password').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LibraryAuthError);
    expect((e as LibraryAuthError).code).toBe('invalid_grant');
    expect((e as Error).message).not.toContain('not the password');
    expect(auth.user()).toBeNull();
    expect(changes).toEqual([]);
  });

  it('a rate limit is reported as such', async () => {
    const f = (async () => new Response('{"error":"slow_down"}', { status: 429 })) as unknown as typeof fetch;
    const e = await libraryAuth({ library: BASE, fetch: f }).signIn('a', 'b').catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'rate_limited', status: 429 });
  });
});

describe('libraryAuth: refreshing', () => {
  it('gives the same token while more than a minute is left, and refreshes when less is', async () => {
    const s = server();
    const auth = libraryAuth({ library: BASE, fetch: s.fetch, now });
    await auth.signIn('rahim', 'correct horse battery');
    const first = await auth.token();
    clock += (900 - 61) * 1000;     // 61 s left
    expect(await auth.token()).toBe(first);
    expect(refreshGrants(s)).toHaveLength(0);
    clock += 2000;                  // 59 s left
    const second = await auth.token();
    expect(second).not.toBe(first);
    expect(refreshGrants(s)).toEqual([{ grant: 'refresh_token', ok: true }]);
    // the new one is good for another 15 minutes
    clock += 800 * 1000;
    expect(await auth.token()).toBe(second);
    expect(refreshGrants(s)).toHaveLength(1);
  });

  it('concurrent callers share one refresh', async () => {
    const s = server();
    const auth = libraryAuth({ library: BASE, fetch: s.fetch, now });
    await auth.signIn('rahim', 'correct horse battery');
    clock += 890 * 1000;
    const tokens = await Promise.all(Array.from({ length: 8 }, () => auth.token()));
    expect(new Set(tokens).size).toBe(1);
    expect(refreshGrants(s)).toHaveLength(1);
  });

  it('stores the rotated refresh token, so the next refresh (here or in a new instance) does not reuse the old one', async () => {
    const s = server();
    const area = fakeArea();
    const auth = libraryAuth({ library: BASE, fetch: s.fetch, now, storage: webStorage(area) });
    await auth.signIn('rahim', 'correct horse battery');
    const key = `chalk-library-auth:${BASE}`;
    const before = JSON.parse(area.map.get(key)!) as { refresh: string };
    clock += 890 * 1000;
    await auth.token();
    const after = JSON.parse(area.map.get(key)!) as { refresh: string; access: string };
    expect(after.refresh).not.toBe(before.refresh);
    expect(s.liveRefreshTokens()).toEqual([after.refresh]);
    // a new instance (the page reloaded) picks up the rotated one and can refresh with it
    const again = libraryAuth({ library: BASE, fetch: s.fetch, now, storage: webStorage(area) });
    await again.ready;
    clock += 890 * 1000;
    expect(await again.token()).toBeTruthy();
    expect(refreshGrants(s).every((g) => g.ok)).toBe(true);
    expect(again.user()?.name).toBe('rahim');
  });

  it('a second instance on the same storage takes the other one\'s refresh instead of reusing a rotated token', async () => {
    const s = server();
    const area = fakeArea();
    const a = libraryAuth({ library: BASE, fetch: s.fetch, now, storage: webStorage(area) });
    await a.signIn('rahim', 'correct horse battery');
    const b = libraryAuth({ library: BASE, fetch: s.fetch, now, storage: webStorage(area) });
    await b.ready;
    clock += 890 * 1000;
    const ta = await a.token();      // a refreshes and rotates
    const tb = await b.token();      // b sees the rotated session in storage and takes it
    expect(tb).toBe(ta);
    expect(refreshGrants(s)).toEqual([{ grant: 'refresh_token', ok: true }]);
    expect(b.user()?.name).toBe('rahim');
  });

  it('a refresh the library refuses (invalid_grant) signs out and says so', async () => {
    const s = server();
    const area = fakeArea();
    const auth = libraryAuth({ library: BASE, fetch: s.fetch, now, storage: webStorage(area) });
    await auth.signIn('rahim', 'correct horse battery');
    const changes: unknown[] = [];
    auth.onChange((u) => changes.push(u));
    s.revokeAll();                    // e.g. an admin disabled the user
    clock += 890 * 1000;
    expect(await auth.token()).toBeUndefined();
    expect(auth.user()).toBeNull();
    expect(changes).toEqual([null]);
    expect(area.map.size).toBe(0);
  });

  it('a refresh that fails for another reason keeps the sign-in and the token while it is still valid', async () => {
    const s = server();
    let offline = false;
    const f = (async (i: string | URL | Request, init?: RequestInit) => { if (offline) throw new TypeError('fetch failed'); return s.fetch(i, init); }) as typeof fetch;
    const auth = libraryAuth({ library: BASE, fetch: f, now });
    await auth.signIn('rahim', 'correct horse battery');
    const t = await auth.token();
    offline = true;
    clock += 890 * 1000;              // 10 s left: tries to refresh, cannot, the old one is still good
    expect(await auth.token()).toBe(t);
    clock += 20 * 1000;               // expired: now it is an error, but still signed in
    await expect(auth.token()).rejects.toThrow('fetch failed');
    expect(auth.user()?.name).toBe('rahim');
    offline = false;
    expect(await auth.token()).not.toBe(t);
  });

  it('signing out while a refresh is on its way: the refresh is not applied, and its new refresh token is revoked', async () => {
    const s = server();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = (async (i: string | URL | Request, init?: RequestInit) => {
      if (String(init?.body ?? '').includes('"refresh_token","refresh_token"') || String(init?.body ?? '').includes('"grant_type":"refresh_token"')) await gate;
      return s.fetch(i, init);
    }) as typeof fetch;
    const auth = libraryAuth({ library: BASE, fetch: f, now });
    await auth.signIn('rahim', 'correct horse battery');
    clock += 890 * 1000;
    const pending = auth.token();
    await new Promise((r) => setTimeout(r, 0));
    await auth.signOut();
    release();
    await pending;
    await new Promise((r) => setTimeout(r, 0));
    expect(auth.user()).toBeNull();
    expect(await auth.token()).toBeUndefined();
    expect(s.liveRefreshTokens()).toEqual([]);
  });
});

describe('libraryAuth: signing out and storage', () => {
  it('signs out: revokes the refresh token at the library, forgets it here, and says so', async () => {
    const s = server();
    const area = fakeArea();
    const auth = libraryAuth({ library: BASE, fetch: s.fetch, now, storage: webStorage(area) });
    await auth.signIn('rahim', 'correct horse battery');
    const changes: unknown[] = [];
    auth.onChange((u) => changes.push(u));
    await auth.signOut();
    expect(s.log.some((l) => l.path === '/v1/auth/revoke')).toBe(true);
    expect(s.liveRefreshTokens()).toEqual([]);
    expect(auth.user()).toBeNull();
    expect(await auth.token()).toBeUndefined();
    expect(area.map.size).toBe(0);
    expect(changes).toEqual([null]);
  });

  it('signs out here even when the library cannot be reached', async () => {
    const s = server();
    let offline = false;
    const f = (async (i: string | URL | Request, init?: RequestInit) => { if (offline) throw new TypeError('fetch failed'); return s.fetch(i, init); }) as typeof fetch;
    const auth = libraryAuth({ library: BASE, fetch: f, now });
    await auth.signIn('rahim', 'correct horse battery');
    offline = true;
    await auth.signOut();
    expect(auth.user()).toBeNull();
  });

  it('a sign-in kept in storage is there after a reload (and announced once read)', async () => {
    const s = server();
    const area = fakeArea();
    await libraryAuth({ library: BASE, fetch: s.fetch, now, storage: webStorage(area) }).signIn('karim', 'another long one');
    const auth = libraryAuth({ library: BASE, fetch: s.fetch, now, storage: webStorage(area) });
    const changes: unknown[] = [];
    auth.onChange((u) => changes.push(u));
    await auth.ready;
    expect(auth.user()?.name).toBe('karim');
    expect(changes).toHaveLength(1);
    expect(await auth.token()).toBeTruthy();
    expect(s.grants.filter((g) => g.grant === 'password')).toHaveLength(1);
  });

  it('memory storage (the default) forgets on reload; an async storage (a phone\'s secure storage) works the same as a sync one', async () => {
    const s = server();
    await libraryAuth({ library: BASE, fetch: s.fetch, now }).signIn('rahim', 'correct horse battery');
    const fresh = libraryAuth({ library: BASE, fetch: s.fetch, now });
    await fresh.ready;
    expect(fresh.user()).toBeNull();

    const m = memoryStorage();
    const secure: AuthStorage = { get: async (k) => m.get(k), set: async (k, v) => m.set(k, v), remove: async (k) => m.remove(k) };
    await libraryAuth({ library: BASE, fetch: s.fetch, now, storage: secure }).signIn('rahim', 'correct horse battery');
    const app = libraryAuth({ library: BASE, fetch: s.fetch, now, storage: secure });
    expect(await app.token()).toBeTruthy();    // waits for the storage read itself
    expect(app.user()?.name).toBe('rahim');
  });

  it('broken or blocked storage reads as signed out and does not throw', async () => {
    const s = server();
    const area = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    const auth = libraryAuth({ library: BASE, fetch: s.fetch, now, storage: webStorage(area) });
    await auth.ready;
    await auth.signIn('rahim', 'correct horse battery');
    expect(await auth.token()).toBeTruthy();
    const junk = fakeArea(); junk.setItem(`chalk-library-auth:${BASE}`, '{not json');
    const other = libraryAuth({ library: BASE, fetch: s.fetch, now, storage: webStorage(junk) });
    await other.ready;
    expect(other.user()).toBeNull();
  });
});

describe('library clients with a sign-in', () => {
  /** The library's clock runs ahead of the device's: the device thinks its token is good, the library has let it expire. */
  async function skewed() {
    let serverClock = clock;
    const s = fakeAuthLibrary({ base: BASE, users: USERS, now: () => serverClock });
    const auth = libraryAuth({ library: BASE, fetch: s.fetch, now });
    await auth.signIn('rahim', 'correct horse battery');
    serverClock += 901 * 1000;
    return { s, auth };
  }

  it('createRegistryClient: a 401 with a token function is retried once with a fresh token', async () => {
    const { s, auth } = await skewed();
    const c = createRegistryClient(BASE, { token: auth.token, fetch: s.fetch });
    expect((await c.stores()).items[0]).toMatchObject({ auth: 'bearer' });
    expect(s.log.filter((l) => l.path === '/v1/stores').map((l) => l.status)).toEqual([401, 200]);
    expect(refreshGrants(s)).toHaveLength(1);
  });

  it('createRegistryClient: a fixed token is not retried; a 401 that a fresh token does not cure is not retried twice', async () => {
    const { s, auth } = await skewed();
    const fixed = await auth.token();
    await expect(createRegistryClient(BASE, { token: fixed!, fetch: s.fetch }).stores()).rejects.toMatchObject({ status: 401 });
    expect(s.log.filter((l) => l.path === '/v1/stores')).toHaveLength(1);
    // a plain function that always gives the same token: nothing to retry with
    const same = createRegistryClient(BASE, { token: () => fixed, fetch: s.fetch });
    await expect(same.stores()).rejects.toMatchObject({ status: 401 });
    expect(s.log.filter((l) => l.path === '/v1/stores')).toHaveLength(2);
  });

  it('fetchWithToken: a signed-out function sends no header', async () => {
    const seen: (string | undefined)[] = [];
    const f = (async (_: string, init?: RequestInit) => { seen.push((init?.headers as Record<string, string> | undefined)?.Authorization); return new Response(null, { status: 401 }); }) as unknown as typeof fetch;
    const r = await fetchWithToken(f, async () => undefined, 'https://x.example/');
    expect(r.status).toBe(401);
    expect(seen).toEqual([undefined]);
  });

  it('registryLibrary: searches and reads bytes from a library that needs a token (bearer store), retrying after a 401', async () => {
    const { s, auth } = await skewed();
    const item = await s.add(new TextEncoder().encode('hello'), 'text/plain', ['kind:note']);
    const lib = registryLibrary({ url: BASE, token: auth.token, fetch: s.fetch });
    expect(await lib.status!()).toBe('ok');
    expect(await lib.url(item.key)).toBeNull();          // no public URL: an <img> could not fetch it
    const got = await lib.get(item.key);
    expect(new TextDecoder().decode(got!.bytes)).toBe('hello');
    expect(s.log.find((l) => l.path.startsWith('/v1/files/'))?.token).toBe(true);
    // signed out: the library asks for a sign-in
    await auth.signOut();
    const signedOut = registryLibrary({ url: BASE, token: auth.token, fetch: s.fetch });
    expect(await signedOut.status!()).toBe('sign-in');
  });

  it('openLibraryBook: opens a book from a library that needs a token, with a sign-in, refreshing on the way', async () => {
    let serverClock = clock;
    const s = fakeAuthLibrary({ base: BASE, users: USERS, now: () => serverClock });
    const enc = new TextEncoder();
    const picture = await s.add(new Uint8Array([0x52, 0x49, 0x46, 0x46, 9, 9]), 'image/webp');
    const page = await s.add(enc.encode(JSON.stringify({ id: 'p1', title: 'One', width: 800, height: 600, background: { type: 'image', assetId: picture.key }, objects: [] })), 'application/vnd.chalk.page+json', ['kind:page']);
    await s.add(enc.encode(JSON.stringify({
      format: 'chalk.streamed', streamVersion: 1, formatVersion: 11, id: 'demo', title: 'Demo', locale: 'bn', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
      pages: [{ id: 'p1', key: page.key, title: 'One', width: 800, height: 600, bytes: page.bytes.byteLength, assets: [picture.key] }],
      assets: [{ id: picture.key, type: 'image/webp', size: picture.bytes.byteLength }],
    })), 'application/vnd.chalk.book+json', ['book:demo', 'kind:book', 'state:current']);

    const auth = libraryAuth({ library: BASE, fetch: s.fetch, now });
    await expect(openLibraryBook({ library: BASE, slug: 'demo', token: auth.token, fetch: s.fetch })).rejects.toThrow();   // signed out
    await auth.signIn('rahim', 'correct horse battery');
    const book = await openLibraryBook({ library: BASE, slug: 'demo', token: auth.token, fetch: s.fetch });
    expect(book.index.title).toBe('Demo');
    expect(await book.headersFor('image/webp')).toEqual({ Authorization: `Bearer ${await auth.token()}` });
    serverClock += 901 * 1000;        // the library lets the token expire before the device thinks it has
    const bytes = await book.read(book.index.pages[0]!.file);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({ id: 'p1' });
    expect(await book.fetchItem(picture.key)).toEqual(picture.bytes);
    expect(refreshGrants(s)).toHaveLength(1);
    expect(s.log.filter((l) => l.path.startsWith('/v1/files/')).every((l) => l.token)).toBe(true);
  });
});
