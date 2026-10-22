import { useEffect, useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, FolderPlusIcon, PlugsConnectedIcon, XIcon } from '@phosphor-icons/react';
import { browserDir, folderLibrary, registryLibrary, type Library, type LibraryStatus } from '@chalk-format/store';
import type { AuthorStrings } from './i18n.js';

type Scannable = Library & { scan?: (p?: (d: number, n: number) => void) => Promise<number> };

/**
 * The connected libraries (author mode): their order (the first that has an item wins), whether each is reachable,
 * and adding one: a folder on this computer (scanned for media already in it) or a library server (its address,
 * and a token if it asks for one). Changes go to the host through `onChange`, which keeps them for next time.
 */
export function LibrariesPanel({ libraries, onChange, t }: { libraries: Library[]; onChange?: ((l: Library[]) => void) | undefined; t: AuthorStrings }) {
  const [status, setStatus] = useState<Record<string, LibraryStatus>>({});
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState(''), [token, setToken] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const canFolder = typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

  useEffect(() => {
    let live = true;
    for (const l of libraries) void (l.status?.() ?? Promise.resolve<LibraryStatus>('ok')).then((s) => { if (live) setStatus((m) => ({ ...m, [l.id]: s })); }).catch(() => { if (live) setStatus((m) => ({ ...m, [l.id]: 'offline' })); });
    return () => { live = false; };
  }, [libraries]);

  const move = (i: number, by: number) => { const next = [...libraries]; const [x] = next.splice(i, 1); next.splice(i + by, 0, x!); onChange?.(next); };
  const add = (l: Library) => { if (!libraries.some((x) => x.id === l.id)) onChange?.([...libraries, l]); };

  const connectFolder = async () => {
    try {
      const handle = await (globalThis as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite' });
      const lib = folderLibrary(browserDir(handle));
      add(lib);
      setNote(t.scanning);
      const n = await lib.scan((d, total) => setNote(`${t.scanning} ${d}/${total}`));
      setNote(t.scanned.replace('{n}', String(n)));
    } catch (e) {
      // the picker was closed: nothing to say
      if ((e as { name?: string }).name !== 'AbortError') setNote(e instanceof Error ? e.message : String(e));
    }
  };
  const connectServer = async () => {
    try {
      const lib = registryLibrary({ url: url.trim(), ...(token.trim() ? { token: token.trim() } : {}) });
      const s = await (lib.status?.() ?? Promise.resolve('ok'));
      if (s !== 'ok') { setNote(s === 'sign-in' ? t.needsToken : t.unreachable); return; }
      add(lib); setAdding(false); setUrl(''); setToken(''); setNote(null);
    } catch { setNote(t.unreachable); }
  };

  return (
    <div className="chalk-libs">
      <ol className="chalk-libs-list">
        {libraries.map((l, i) => (
          <li key={l.id}>
            <span className={`chalk-libs-dot is-${status[l.id] ?? 'checking'}`} title={status[l.id] ? t[`status_${status[l.id]}` as keyof AuthorStrings] : ''} />
            <span className="chalk-libs-name">{l.name}{(() => { const k = t[`kind_${l.kind}` as keyof AuthorStrings] ?? l.kind, extra = [k !== l.name ? k : '', l.writable ? '' : t.readOnly].filter(Boolean).join(' · '); return extra ? <small>{extra}</small> : null; })()}</span>
            {/* a folder after a reload: the browser wants a click before it gives access again */}
            {status[l.id] === 'no-permission' && l.connect && (
              <button type="button" className="chalk-side-btn" onClick={async () => { await l.connect!(); onChange?.([...libraries]); }}>{t.allow}</button>
            )}
            {onChange && (
              <span className="chalk-libs-actions">
                {(l as Scannable).scan && <button type="button" className="chalk-icon-btn" title={t.scan} aria-label={t.scan} onClick={async () => { setNote(t.scanning); const n = await (l as Scannable).scan!((d, total) => setNote(`${t.scanning} ${d}/${total}`)); setNote(t.scanned.replace('{n}', String(n))); }}>↻</button>}
                <button type="button" className="chalk-icon-btn" disabled={i === 0} aria-label={t.moveUp} title={t.moveUp} onClick={() => move(i, -1)}><ArrowUpIcon size={14} /></button>
                <button type="button" className="chalk-icon-btn" disabled={i === libraries.length - 1} aria-label={t.moveDown} title={t.moveDown} onClick={() => move(i, 1)}><ArrowDownIcon size={14} /></button>
                {l.kind !== 'device' && <button type="button" className="chalk-icon-btn" aria-label={t.disconnect} title={t.disconnect} onClick={() => onChange(libraries.filter((x) => x !== l))}><XIcon size={14} /></button>}
              </span>
            )}
          </li>
        ))}
      </ol>
      {onChange && (
        <div className="chalk-side-row">
          {canFolder && <button type="button" className="chalk-side-btn" onClick={() => void connectFolder()}><FolderPlusIcon size={16} /> {t.connectFolder}</button>}
          <button type="button" className="chalk-side-btn" aria-expanded={adding} onClick={() => setAdding((a) => !a)}><PlugsConnectedIcon size={16} /> {t.connectServer}</button>
        </div>
      )}
      {adding && (
        <form className="chalk-libs-form" onSubmit={(e) => { e.preventDefault(); void connectServer(); }}>
          <input type="url" required placeholder="https://library.example.org" aria-label={t.serverAddress} value={url} onChange={(e) => setUrl(e.target.value)} />
          <input type="password" placeholder={t.tokenOptional} aria-label={t.tokenOptional} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          <button type="submit" className="chalk-side-btn is-primary">{t.connect}</button>
        </form>
      )}
      {note && <p className="chalk-side-note" role="status">{note}</p>}
    </div>
  );
}
