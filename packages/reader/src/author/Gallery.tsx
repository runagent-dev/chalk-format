import { useEffect, useRef, useState } from 'react';
import { CubeIcon, FilmStripIcon, FlaskIcon, ImageIcon, MagnifyingGlassIcon, MusicNotesIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import type { Library, LibraryItem } from '@chalk-format/store';
import { KIND_TYPES, type MediaKind } from './insert.js';
import type { AuthorStrings } from './i18n.js';

const KIND_ICON: Record<MediaKind, (s: number) => React.ReactNode> = {
  image: (s) => <ImageIcon size={s} />, video: (s) => <FilmStripIcon size={s} />, audio: (s) => <MusicNotesIcon size={s} />,
  model3d: (s) => <CubeIcon size={s} />, lab: (s) => <FlaskIcon size={s} />,
};
const size = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const duration = (s?: number) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

/**
 * The media of one kind across the connected libraries (author mode, spec 1.2 libraries): search, pick, place.
 * "Upload new" adds a file to a library first (the one chosen), so it can be found and reused afterwards.
 */
export function Gallery({ kind, libraries, onPick, onUpload, t }: {
  kind: MediaKind; libraries: readonly Library[];
  onPick: (item: LibraryItem, library: Library) => void;
  onUpload: (files: File[], library: Library) => void;
  t: AuthorStrings;
}) {
  const [libId, setLibId] = useState<string>('all');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<{ item: LibraryItem; lib: Library }[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const writable = libraries.filter((l) => l.writable);
  const [target, setTarget] = useState<string>(writable[0]?.id ?? '');
  const file = useRef<HTMLInputElement>(null);

  // search the chosen libraries (all of them by default), a moment after typing stops
  useEffect(() => {
    let live = true;
    const id = setTimeout(async () => {
      const from = libId === 'all' ? libraries : libraries.filter((l) => l.id === libId);
      const pages = await Promise.all(from.map(async (lib) => {
        try { return (await lib.search({ q, types: KIND_TYPES[kind], limit: 48 })).items.map((item) => ({ item, lib })); }
        catch { return [] as { item: LibraryItem; lib: Library }[]; }
      }));
      // one tile per item, from the first library (in their order) that has it
      const seen = new Set<string>(), out: { item: LibraryItem; lib: Library }[] = [];
      for (const r of pages.flat()) if (!seen.has(r.item.key)) { seen.add(r.item.key); out.push(r); }
      if (live) { setRows(out); setProblem(null); }
    }, 220);
    return () => { live = false; clearTimeout(id); };
  }, [kind, q, libId, libraries]);

  return (
    <div className="chalk-gallery">
      <div className="chalk-gallery-bar">
        <label className="chalk-gallery-search">
          <MagnifyingGlassIcon size={16} />
          <input type="search" value={q} placeholder={t.searchMedia} aria-label={t.searchMedia} onChange={(e) => setQ(e.target.value)} />
        </label>
        <select value={libId} aria-label={t.libraries} onChange={(e) => setLibId(e.target.value)}>
          <option value="all">{t.allLibraries}</option>
          {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>

      {rows === null ? <p className="chalk-side-note">…</p> : rows.length === 0 ? <p className="chalk-side-note">{q ? t.noMatches : t.libraryEmpty}</p> : (
        <ul className="chalk-gallery-grid">
          {rows.map(({ item, lib }) => (
            <li key={item.key}>
              <button type="button" className="chalk-tile" onClick={() => onPick(item, lib)} title={item.title ?? item.filename ?? item.key}>
                <Thumb item={item} lib={lib} kind={kind} />
                <span className="chalk-tile-name">{item.title ?? item.filename ?? t[kind]}</span>
                <span className="chalk-tile-meta">{[duration(item.meta?.duration), size(item.size), libraries.length > 1 ? lib.name : ''].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="chalk-side-note">{problem}</p>}

      {kind !== 'lab' && writable.length > 0 && (
        <div className="chalk-gallery-upload">
          <button type="button" className="chalk-side-btn is-primary" onClick={() => file.current?.click()}><UploadSimpleIcon size={16} /> {t.uploadNew}</button>
          {writable.length > 1 && (
            <select value={target} aria-label={t.uploadTo} onChange={(e) => setTarget(e.target.value)}>
              {writable.map((l) => <option key={l.id} value={l.id}>{t.uploadTo} {l.name}</option>)}
            </select>
          )}
          <input ref={file} type="file" hidden multiple accept={KIND_TYPES[kind].join(',').replace('model/gltf-binary', '.glb,model/gltf-binary')}
            onChange={(e) => { const fs = [...(e.target.files ?? [])]; const lib = writable.find((l) => l.id === target) ?? writable[0]; if (fs.length && lib) onUpload(fs, lib); e.target.value = ''; }} />
        </div>
      )}
    </div>
  );
}

/** A picture of an item: the image itself, a poster, or the kind's icon. */
function Thumb({ item, lib, kind }: { item: LibraryItem; lib: Library; kind: MediaKind }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const key = item.type.startsWith('image/') ? item.key : item.poster;
    if (key) void lib.url(key).then((u) => { if (live) setSrc(u); }).catch(() => {});
    return () => { live = false; };
  }, [item, lib]);
  return <span className="chalk-tile-thumb">{src ? <img src={src} alt="" loading="lazy" draggable={false} /> : KIND_ICON[kind](28)}</span>;
}
