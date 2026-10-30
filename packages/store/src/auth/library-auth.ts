import { memoryStorage, type AuthStorage } from './storage.js';
import type { TokenRequest } from './token.js';

/**
 * Signing in to a library server (the library is its own identity provider: `POST /v1/auth/token`, OAuth 2.0 shaped). A user signs in with
 * a username and password once; after that `token()` always gives an access token that is good for at least another minute, refreshing it
 * (and storing the rotated refresh token) when needed. Hand `auth.token` to any library client of this package as its `token`.
 *
 *   const auth = libraryAuth({ library: 'https://library.example', storage: webStorage(localStorage) });
 *   await auth.signIn('rahim', '…');
 *   const book = await openLibraryBook({ library: auth.library, slug: 'physics-9-10-bn', token: auth.token });
 *
 * Tokens are never logged and never put in an error message.
 */

/** Who is signed in, read from the access token's claims (not checked here: the library checks every token it is sent). */
export type LibraryUser = { sub: string; name: string; roles: string[] };

export type LibraryAuth = {
  /** The library server, as given. */
  readonly library: string;
  /** Settles once a sign-in kept in `storage` has been read (every method waits for it too). */
  readonly ready: Promise<void>;
  /** Signs in with a username and password. Throws a `LibraryAuthError` (`invalid_grant`: wrong username or password; `rate_limited`). */
  signIn(username: string, password: string): Promise<LibraryUser>;
  /** Forgets the sign-in here and asks the library to revoke its refresh token (that call may fail: the sign-in is gone here either way). */
  signOut(): Promise<void>;
  /**
   * A valid access token, or undefined when signed out. Refreshed when less than a minute is left; concurrent callers share one refresh.
   * With `{ rejected }` (the library just refused that token), a fresh one is fetched if `rejected` is still the current one. A refresh the
   * library refuses (`invalid_grant`: expired, revoked, reused) signs out. A bound function: pass `auth.token` itself as a client's token.
   */
  token: (request?: TokenRequest) => Promise<string | undefined>;
  /** Who is signed in, or null. */
  user(): LibraryUser | null;
  /** Called after every sign-in, sign-out (including one caused by a refused refresh), and change of user or roles. Returns an unsubscribe. */
  onChange(listener: (user: LibraryUser | null) => void): () => void;
};

export type LibraryAuthOptions = {
  /** The library server's base URL (the one `/v1/...` hangs off). */
  library: string;
  fetch?: typeof fetch;
  /** Where the sign-in is kept between visits (default: memory only). See `AuthStorage` for a mobile app's secure storage. */
  storage?: AuthStorage;
  /** The clock, in milliseconds (tests). */
  now?: () => number;
  /** The storage key (default `chalk-library-auth:<library>`). */
  storageKey?: string;
  /**
   * Runs a refresh so that no other tab or instance sharing the storage refreshes at the same time (a refresh token is single use; using it
   * twice would end the sign-in everywhere). Default: the Web Locks API where there is one; otherwise none.
   */
  lock?: <T>(name: string, run: () => Promise<T>) => Promise<T>;
};

export class LibraryAuthError extends Error {
  /** `code`: the library's OAuth error (`invalid_grant`, `invalid_request`, `unsupported_grant_type`), `rate_limited` (429), `cancelled` (signed out while signing in) or `failed`. */
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = 'LibraryAuthError'; }
}

/** Refresh when less than this is left. */
const REFRESH_MARGIN_MS = 60_000;

type Session = { access: string; refresh: string; expiresAt: number };

const isSession = (v: unknown): v is Session => {
  const s = v as Partial<Session> | null;
  return !!s && typeof s === 'object' && typeof s.access === 'string' && !!s.access && typeof s.refresh === 'string' && !!s.refresh && typeof s.expiresAt === 'number';
};

const parseSession = (raw: string | null | undefined): Session | null => {
  if (!raw) return null;
  try { const v: unknown = JSON.parse(raw); return isSession(v) ? { access: v.access, refresh: v.refresh, expiresAt: v.expiresAt } : null; } catch { return null; }
};

/** The claims of a JWT, without checking its signature (the library does that); null if it is not one. */
export function tokenClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const bin = atob(b64);
    const v: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

const userOf = (access: string): LibraryUser => {
  const c = tokenClaims(access) ?? {};
  return {
    sub: typeof c.sub === 'string' ? c.sub : '',
    name: typeof c.name === 'string' ? c.name : '',
    roles: Array.isArray(c.roles) ? c.roles.filter((r): r is string => typeof r === 'string') : [],
  };
};
const sameUser = (a: LibraryUser | null, b: LibraryUser | null) =>
  a === b || (!!a && !!b && a.sub === b.sub && a.name === b.name && a.roles.join('\n') === b.roles.join('\n'));

type Locks = { request<T>(name: string, cb: () => Promise<T>): Promise<T> };
const webLocks = (): LibraryAuthOptions['lock'] => {
  const locks = (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;
  return locks && typeof locks.request === 'function' ? (name, run) => locks.request(name, run) : undefined;
};

export function libraryAuth(o: LibraryAuthOptions): LibraryAuth {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const storage = o.storage ?? memoryStorage();
  const now = o.now ?? Date.now;
  const root = o.library.endsWith('/') ? o.library : `${o.library}/`;
  const key = o.storageKey ?? `chalk-library-auth:${root}`;
  const lock = o.lock ?? webLocks();

  let session: Session | null = null;
  let current: LibraryUser | null = null;
  /** Bumped by every sign-in and sign-out: a refresh that started before one is not applied after it. */
  let generation = 0;
  let refreshing: Promise<string | undefined> | null = null;
  const listeners = new Set<(u: LibraryUser | null) => void>();

  /** Storage writes, one after another in the order the session changed (an async storage could finish them out of order). */
  let writes: Promise<void> = Promise.resolve();
  /** The session changes here at once (and listeners hear of it); the write to storage is queued behind the ones before it. */
  const set = (s: Session | null): Promise<void> => {
    session = s;
    const value = s ? JSON.stringify(s) : null;
    writes = writes.then(async () => {
      try { if (value) await storage.set(key, value); else await storage.remove(key); } catch { /* kept in memory only */ }
    });
    const u = s ? userOf(s.access) : null;
    if (!sameUser(u, current)) {
      current = u;
      for (const l of [...listeners]) { try { l(u); } catch { /* a listener's failure is its own */ } }
    }
    return writes;
  };

  /** What storage holds once the writes queued so far have landed. */
  const read = async () => { await writes; try { return parseSession(await storage.get(key)); } catch { return null; } };

  const ready = (async () => {
    const s = await read();
    if (s && generation === 0) { session = s; current = userOf(s.access); for (const l of [...listeners]) { try { l(current); } catch { /* ignore */ } } }
  })();

  const post = (path: string, body: unknown) => f(root + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });

  /** `POST /v1/auth/token`: a new session, or a LibraryAuthError (the response body is not echoed: it could hold a token). */
  const grant = async (body: Record<string, string>): Promise<Session> => {
    const r = await post('v1/auth/token', body);
    const v = (await r.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown } | null;
    if (!r.ok) {
      const code = r.status === 429 ? 'rate_limited' : typeof v?.error === 'string' ? v.error : 'failed';
      throw new LibraryAuthError(code, r.status, code === 'invalid_grant'
        ? (body.grant_type === 'password' ? 'wrong username or password' : 'the sign-in has ended; sign in again')
        : code === 'rate_limited' ? 'too many attempts; wait a minute and try again' : `the library refused the sign-in (${code}, HTTP ${r.status})`);
    }
    if (typeof v?.access_token !== 'string' || !v.access_token || typeof v.refresh_token !== 'string' || !v.refresh_token) {
      throw new LibraryAuthError('failed', r.status, 'the library sent no tokens');
    }
    const seconds = typeof v.expires_in === 'number' && v.expires_in > 0 ? v.expires_in : 900;
    // timed by this clock from expires_in, not by the token's exp: a device clock that is off does not matter
    return { access: v.access_token, refresh: v.refresh_token, expiresAt: now() + seconds * 1000 };
  };

  const revoke = (refresh: string) => post('v1/auth/revoke', { refresh_token: refresh }).then((r) => { void r.body?.cancel().catch(() => {}); }, () => {});

  /** Refresh tokens this instance has used (they are spent: using one again would end the sign-in everywhere). */
  const spent = new Set<string>();

  const refresh = (force: boolean): Promise<string | undefined> => {
    if (refreshing) return refreshing;
    const gen = generation;
    const run = async (): Promise<string | undefined> => {
      // another tab or instance on the same storage may have refreshed (its refresh token replaced ours) or signed in again: take that
      const stored = await read();
      if (gen !== generation) return session?.access;
      // (never one this instance already spent: storage still holding it means our write of the rotated one did not land)
      if (stored && session && stored.refresh !== session.refresh && !spent.has(stored.refresh)) {
        await set(stored);
        // a different grant, so not the token that was rejected
        if (stored.expiresAt - now() > REFRESH_MARGIN_MS) return stored.access;
      }
      const old = session;
      if (!old) return undefined;
      let next: Session;
      try {
        spent.add(old.refresh);
        next = await grant({ grant_type: 'refresh_token', refresh_token: old.refresh });
      } catch (e) {
        if (gen !== generation) return session?.access;
        if (e instanceof LibraryAuthError && e.code === 'invalid_grant') { generation++; await set(null); return undefined; }
        // offline, rate-limited, the server failing: the token we have is still good if it has not expired
        if (!force && old.expiresAt > now()) return old.access;
        throw e;
      }
      // signed out or in again while this was on its way: the new refresh token belongs to nobody
      if (gen !== generation) { void revoke(next.refresh); return session?.access; }
      // another tab signed out while this was on its way (what it had stored is gone): its sign-out holds here too
      if (stored && !(await read())) {
        if (gen === generation) { generation++; void set(null); }
        void revoke(next.refresh);
        return undefined;
      }
      if (gen !== generation) { void revoke(next.refresh); return session?.access; }
      await set(next);
      return next.access;
    };
    const p = (lock ? lock(key, run) : run()).finally(() => { if (refreshing === p) refreshing = null; });
    refreshing = p;
    return p;
  };

  const auth: LibraryAuth = {
    library: o.library,
    ready,
    async signIn(username, password) {
      await ready;
      const gen = generation;
      const s = await grant({ grant_type: 'password', username, password });
      // signed out (or in again) while this was on its way: that came later and wins; this sign-in's refresh token belongs to nobody
      if (gen !== generation) { void revoke(s.refresh); throw new LibraryAuthError('cancelled', 0, 'the sign-in was cancelled'); }
      const old = session;
      generation++;
      refreshing = null;
      await set(s);
      if (old && old.refresh !== s.refresh) void revoke(old.refresh);
      return userOf(s.access);
    },
    async signOut() {
      await ready;
      const old = session;
      generation++;
      refreshing = null;
      const cleared = set(null);
      // under the refresh lock too: a refresh another tab has on its way writes its session before this removes it, not after
      await (lock ? lock(key, async () => { await cleared; try { await storage.remove(key); } catch { /* nothing to remove */ } }) : cleared);
      if (old) await revoke(old.refresh);
    },
    token: async (request) => {
      await ready;
      const s = session;
      if (!s) return undefined;
      const rejected = request?.rejected;
      if (rejected && rejected === s.access) return refresh(true);
      if (s.expiresAt - now() > REFRESH_MARGIN_MS) return s.access;
      return refresh(false);
    },
    user: () => current,
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return auth;
}
