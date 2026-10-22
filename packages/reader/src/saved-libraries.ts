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
 */

type Saved = ({ kind: 'registry'; url: string; name?: string; token?: string } | { kind: 'folder'; slot: string })[];

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

export function useSavedLibraries(o: { key?: string; device?: boolean } = {}): [Library[], (l: Library[]) => void, boolean] {
  const key = o.key ?? 'chalk:libraries';
  const [libs, setLibs] = useState<Library[]>(() => (o.device === false ? [] : [deviceLibrary()]));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      let saved: Saved = [];
      try { saved = JSON.parse(localStorage.getItem(key) ?? '[]') as Saved; } catch { saved = []; }
      const out: Library[] = o.device === false ? [] : [deviceLibrary()];
      for (const s of saved) {
        try {
          if (s.kind === 'registry') out.push(fromConnection(s));
          else {
            const h = await handleOp<FileSystemDirectoryHandle>('readonly', (st) => st.get(s.slot) as IDBRequest<FileSystemDirectoryHandle>);
            if (h) out.push(fromConnection({ kind: 'folder', handle: h }));
          }
        } catch { /* a connection that cannot be made again is dropped */ }
      }
      if (live) { setLibs(out); setReady(true); }
    })();
    return () => { live = false; };
  }, [key, o.device]);

  const save = useCallback((next: Library[]) => {
    setLibs(next);
    void (async () => {
      const saved: Saved = [];
      await handleOp('readwrite', (st) => { st.clear(); });
      for (const [i, l] of next.entries()) {
        const c = l.connection;
        if (!c || c.kind === 'device') continue;
        if (c.kind === 'registry') saved.push({ kind: 'registry', url: c.url, ...(c.name ? { name: c.name } : {}), ...(c.token ? { token: c.token } : {}) });
        else { const slot = `f${i}`; await handleOp('readwrite', (st) => st.put(c.handle, slot)); saved.push({ kind: 'folder', slot }); }
      }
      try { localStorage.setItem(key, JSON.stringify(saved)); } catch { /* private mode: the list lasts for this visit */ }
    })();
  }, [key]);

  return [libs, save, ready];
}
