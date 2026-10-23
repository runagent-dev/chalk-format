import { useCallback, useEffect, useState } from 'react';
import { browserDir, deviceLibrary, folderLibrary, registryLibrary, type Library, type LibraryConnection } from '@chalk-format/store';

/**
 * The libraries this browser has connected, kept for next time: "This device" always first, then what the person
 * connected, in their order. Library servers are kept by address (and a token typed into the panel); folders by
 * the browser's handle, in IndexedDB (a handle cannot go into localStorage), and the browser asks again for access
 * after a reload (the panel offers "Allow"). For hosts whose people connect libraries themselves:
 *
 *   const [libraries, setLibraries] = useSavedLibraries();
 *   <ChalkReader libraries={libraries} onLibrariesChange={setLibraries} … />
 *
 * `preset`: library servers the host connects for its people (a school's own library). Each is connected once, in
 * front of This device, so uploads go there by default; after that the person's order wins, and one they
 * disconnect stays disconnected.
 */

type Preset = { url: string; name?: string; token?: string };
type Saved = ({ kind: 'registry'; url: string; name?: string; token?: string } | { kind: 'folder'; slot: string } | { kind: 'device' })[];
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

const HANDLES_DB = 'chalk-library-handles';
function handles(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(HANDLES_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
  });
}
async function handleOp<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await handles();
  return new Promise((ok, fail) => {
    const t = db.transaction('handles', mode), r = fn(t.objectStore('handles'));
    t.oncomplete = () => { ok(r ? r.result : undefined); db.close(); };
    t.onerror = () => fail(t.error);
  });
}

function fromConnection(c: LibraryConnection): Library {
  if (c.kind === 'registry') return registryLibrary({ url: c.url, ...(c.name ? { name: c.name } : {}), ...(c.token ? { token: c.token } : {}) });
  if (c.kind === 'folder') return folderLibrary(browserDir(c.handle));
  return deviceLibrary();
}

export function useSavedLibraries(o: { key?: string; device?: boolean; preset?: readonly Preset[] } = {}): [Library[], (l: Library[]) => void, boolean] {
  const key = o.key ?? 'chalk:libraries';
  const presetKey = JSON.stringify(o.preset ?? []);
  const [libs, setLibs] = useState<Library[]>(() => (o.device === false ? [] : [deviceLibrary()]));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      let saved: Saved = [], offered: string[] = [];
      try { saved = JSON.parse(localStorage.getItem(key) ?? '[]') as Saved; } catch { saved = []; }
      try { offered = JSON.parse(localStorage.getItem(`${key}:offered`) ?? '[]') as string[]; } catch { offered = []; }
      const preset = JSON.parse(presetKey) as Preset[];
      // a preset not offered before goes in front; one already there takes the host's token if it has none
      const fresh = preset.filter((p) => !offered.some((u) => sameUrl(u, p.url)) && !saved.some((s) => s.kind === 'registry' && sameUrl(s.url, p.url)));
      saved = [...fresh.map((p) => ({ kind: 'registry' as const, ...p })), ...saved].map((s) => {
        const p = s.kind === 'registry' ? preset.find((x) => sameUrl(x.url, s.url)) : undefined;
        return s.kind === 'registry' && p?.token && !s.token ? { ...s, token: p.token } : s;
      });
      // This device stays where the person put it (first when they never moved it)
      if (o.device !== false && !saved.some((s) => s.kind === 'device')) saved.splice(fresh.length, 0, { kind: 'device' });
      // the new list and "offered" are written together, so a second run (StrictMode, a remount) finds it connected
      if (fresh.length) {
        try {
          localStorage.setItem(key, JSON.stringify(saved));
          localStorage.setItem(`${key}:offered`, JSON.stringify([...offered, ...fresh.map((p) => p.url)]));
        } catch { /* private mode: the list lasts for this visit */ }
      }
      const out: Library[] = [];
      for (const s of saved) {
        try {
          if (s.kind === 'device') { if (o.device !== false) out.push(deviceLibrary()); }
          else if (s.kind === 'registry') out.push(fromConnection(s));
          else {
            const h = await handleOp<FileSystemDirectoryHandle>('readonly', (st) => st.get(s.slot) as IDBRequest<FileSystemDirectoryHandle>);
            if (h) out.push(fromConnection({ kind: 'folder', handle: h }));
          }
        } catch { /* a connection that cannot be made again is dropped */ }
      }
      if (live) { setLibs(out); setReady(true); }
    })();
    return () => { live = false; };
  }, [key, o.device, presetKey]);

  const save = useCallback((next: Library[]) => {
    setLibs(next);
    void (async () => {
      const saved: Saved = [];
      await handleOp('readwrite', (st) => { st.clear(); });
      for (const [i, l] of next.entries()) {
        const c = l.connection;
        if (!c) continue;
        if (c.kind === 'device') { saved.push({ kind: 'device' }); continue; }
        if (c.kind === 'registry') saved.push({ kind: 'registry', url: c.url, ...(c.name ? { name: c.name } : {}), ...(c.token ? { token: c.token } : {}) });
        else { const slot = `f${i}`; await handleOp('readwrite', (st) => st.put(c.handle, slot)); saved.push({ kind: 'folder', slot }); }
      }
      try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* private mode: the list lasts for this visit */ }
    })();
  }, [key]);

  return [libs, save, ready];
}
