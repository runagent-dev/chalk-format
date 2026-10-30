/**
 * Where a sign-in is kept between visits. One string value per library (JSON: the refresh token, the current access token and when it
 * expires). Each method may be synchronous or return a promise, so a platform's own secure storage plugs in as it is:
 *
 *   // React Native, expo-secure-store
 *   const storage: AuthStorage = {
 *     get: (k) => SecureStore.getItemAsync(k),
 *     set: (k, v) => SecureStore.setItemAsync(k, v),
 *     remove: (k) => SecureStore.deleteItemAsync(k),
 *   };
 *   // iOS Keychain / Android Keystore through any wrapper with the same three calls works the same way.
 *   // SecureStore keys may only hold [A-Za-z0-9._-]: wrap the key (e.g. `k.replace(/[^\w.-]/g, '_')`) if the wrapper is strict.
 *
 * The value is a credential: an app should keep it where other apps and scripts cannot read it. `webStorage(localStorage)` is the simple
 * choice for a web reader (readable by any script on the page's origin); `memoryStorage()` (the default) forgets the sign-in on reload.
 */
export type AuthStorage = {
  get(key: string): string | null | undefined | Promise<string | null | undefined>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
};

/** Kept in memory only: signed out again when the page or process ends. */
export function memoryStorage(): AuthStorage {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); }, remove: (k) => { m.delete(k); } };
}

/** A Web Storage area (`localStorage`, `sessionStorage`). A storage that throws (private mode, blocked site data) acts as empty. */
export function webStorage(area: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): AuthStorage {
  return {
    get: (k) => { try { return area.getItem(k); } catch { return null; } },
    set: (k, v) => { try { area.setItem(k, v); } catch { /* not kept: signed in for this page only */ } },
    remove: (k) => { try { area.removeItem(k); } catch { /* nothing to remove */ } },
  };
}
