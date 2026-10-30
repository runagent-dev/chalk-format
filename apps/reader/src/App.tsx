import { useEffect, useRef, useState } from 'react';
import { ChalkReader, DEFAULT_CONFIG, LibrarySignIn, libraryAuth, useLibraryAuth, useSavedLibraries, webStorage, type BookSource, type LibrarySource, type LibraryBookLinks, type ReaderConfig, type ReaderHandle, type SaveProgress, type BookPatch, type MergeReport, type PatchResult } from '@chalk-format/reader';
import { Playground } from './Playground.js';
// pdf.js's worker, for books whose PDF pages carry no rendered image (config.pdfWorkerSrc)
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// the showcase lets you author too: the switch in the bar (or the pencil in the dock) changes the mode
const BASE: ReaderConfig = { ...DEFAULT_CONFIG, pdfWorkerSrc, authoring: { ...DEFAULT_CONFIG.authoring, enabled: true } };

const SAMPLES = [
  { id: 'showcase', label: 'পদার্থবিজ্ঞান · Physics sample', url: '/samples/showcase.chalk' },
  { id: 'pdf-only', label: 'Pages drawn from the PDF', url: '/samples/pdf-only.chalk' },
  { id: 'all-features', label: 'Every object type', url: '/samples/all-features.chalk' },
  { id: 'lab', label: 'A lab', url: '/samples/lab.chalk' },
  // streamed books (spec 1.4): the index first, then only the pages around the one being read
  { id: 'streamed', label: 'Streamed: the physics sample', url: '/samples/showcase/' },
  { id: 'long', label: 'Streamed: a 60-page book', url: '/samples/long/' },
  { id: 'long-chalk', label: 'The 60-page book as one .chalk', url: '/samples/long.chalk' },
];

const env = import.meta.env as Record<string, string | undefined>;
const PRESET = env.VITE_CHALK_LIBRARY_URL
  ? [{ url: env.VITE_CHALK_LIBRARY_URL, ...(env.VITE_CHALK_LIBRARY_NAME ? { name: env.VITE_CHALK_LIBRARY_NAME } : {}), ...(env.VITE_CHALK_LIBRARY_TOKEN ? { token: env.VITE_CHALK_LIBRARY_TOKEN } : {}) }]
  : [];

// a book in a library (spec 1.8): `?library=<server>&book=<slug>[&token=<token>]` opens the current revision of that book from the library
const query = new URLSearchParams(location.search);
const FROM_LIBRARY: LibrarySource | null = query.get('library') && query.get('book')
  ? { library: query.get('library')!, slug: query.get('book')!, ...(query.get('token') ? { token: query.get('token')! } : {}) }
  : null;
// without `&token=`, the reader can sign in to that library (username and password; kept in this browser until signing out): the form comes
// first when the library keeps its books private, and from "Sign in" in the bar when anyone may read it
const AUTH = FROM_LIBRARY && !FROM_LIBRARY.token ? libraryAuth({ library: FROM_LIBRARY.library, storage: webStorage(localStorage) }) : null;
// what the reader hands a host about a library book's questions, kept where a test (or the console) can see it
const onBookLinks = (links: LibraryBookLinks | null) => { (window as unknown as { __bookLinks?: LibraryBookLinks | null }).__bookLinks = links; };

/** The showcase: pick a sample or open your own .chalk file. */
export function App() {
  const [source, setSource] = useState<{ key: string; src: BookSource | LibrarySource }>(FROM_LIBRARY ? { key: `library: ${FROM_LIBRARY.slug}`, src: FROM_LIBRARY } : { key: SAMPLES[0]!.id, src: SAMPLES[0]!.url });
  const file = useRef<HTMLInputElement>(null);
  const [config, setConfig] = useState<ReaderConfig>(BASE);
  const [configuring, setConfiguring] = useState(false);
  const [mode, setMode] = useState<'read' | 'author'>('read');
  // the host's own Save: the reader says when the book has unsaved changes (onDirtyChange) and saves when asked (handle.save)
  const reader = useRef<ReaderHandle>(null);
  const [dirty, setDirty] = useState(false);
  // what a host can do with a save in progress (onSavingChange, onSaveProgress); `?save=slow` or `?save=fail` makes the showcase's own save take a
  // moment, or refuse, so this (and the tests) can be tried: without it the book is downloaded as before
  const [saving, setSaving] = useState(false);
  const [phase, setPhase] = useState<SaveProgress | null>(null);
  const demoSave = new URLSearchParams(location.search).get('save');
  const callbacks = new URLSearchParams(location.search).get('callbacks'); // `throw`: a host callback with a bug; `resave`: one that calls save() at once
  const onSave = demoSave ? async () => { (window as unknown as { __saveCalls?: number }).__saveCalls = ((window as unknown as { __saveCalls?: number }).__saveCalls ?? 0) + 1; await new Promise((r) => setTimeout(r, 1500)); if (demoSave === 'fail') throw new Error('The host refused the save'); } : undefined;
  // a host that takes patches (`?save=patch`; `patchfail` refuses them; `patchmerge` answers as if someone else's work was merged into the first page):
  // each patch is recorded in `window.__patches` (its size, the pages and media in it) and answered the way a host would
  const onSavePatch = demoSave?.startsWith('patch') ? async (patch: BookPatch, media: Map<string, { type: string; bytes: Uint8Array }>): Promise<PatchResult> => {
    const w = window as unknown as { __patches?: unknown[]; __patchCounter?: number };
    const enc = new TextEncoder();
    (w.__patches ??= []).push({
      bytes: enc.encode(JSON.stringify(patch)).length, pages: Object.keys(patch.mine.pages), base: Object.keys(patch.base.pages), deleted: patch.mine.deleted,
      version: patch.base.version, baseObjects: Object.values(patch.base.pages).map((b) => b.page.objects.length), mineObjects: Object.values(patch.mine.pages).map((q) => q.objects.length), mineTitles: Object.values(patch.mine.pages).map((q) => q.title), baseTitles: Object.fromEntries(Object.entries(patch.base.pages).map(([id, b]) => [id, b.page.title])), media: [...media.keys()], mediaBytes: [...media.values()].reduce((n, m) => n + m.bytes.length, 0), order: patch.mine.order.length,
    });
    await new Promise((r) => setTimeout(r, demoSave === 'patchmerge' ? 1500 : 400)); // the merging host is slow, so the editor can be used while it works
    if (demoSave === 'patchfail') throw new Error('the host did not keep the patch');
    const hex8 = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer))].slice(0, 4).map((x) => x.toString(16).padStart(2, '0')).join('');
    const pages: PatchResult['pages'] = {};
    for (const [id, pg] of Object.entries(patch.mine.pages)) { const hash = await hex8(enc.encode(JSON.stringify(pg))); pages[id] = { file: `pages/${(w.__patchCounter = (w.__patchCounter ?? 1000) + 1)}-${hash}.json`, hash }; }
    const notes: MergeReport['notes'] = [];
    const first = Object.keys(pages)[0];
    if (demoSave === 'patchmerge' && first) {
      const merged = { ...patch.mine.pages[first]!, title: `${patch.mine.pages[first]!.title} (merged)` };
      pages[first] = { ...pages[first]!, hash: await hex8(enc.encode(JSON.stringify(merged))), page: merged };
      notes.push({ page: first, rule: 'same-property-last-saver', by: 'mine', property: 'title', loser: 'someone else' });
    }
    return { version: `sha256:${await hex8(enc.encode(JSON.stringify(patch)))}${'0'.repeat(56)}`, pages, report: { notes } };
  } : undefined;
  // the libraries connected in this browser (This device, folders, library servers), kept for next time;
  // a library server named in .env.local is connected for you (see .env.example)
  const [libraries, setLibraries] = useSavedLibraries({ preset: PRESET });
  // the library book: the sign-in form first (or "continue without", for a library anyone may read), then the book with the sign-in's token
  const { user, ready } = useLibraryAuth(AUTH);
  // whether to show the form while signed out: null until the library has said whether it lets anyone read
  const [form, setForm] = useState<boolean | null>(null);
  useEffect(() => {
    if (!AUTH) return;
    const root = AUTH.library.endsWith('/') ? AUTH.library : `${AUTH.library}/`;
    fetch(`${root}v1/search?limit=1`).then((r) => { void r.body?.cancel(); setForm((f) => f ?? (r.status === 401 || r.status === 403)); }, () => setForm((f) => f ?? true));
  }, []);
  const fromLibrary = AUTH !== null && source.src === FROM_LIBRARY;
  const gate = fromLibrary && (!ready || (!user && form !== false));
  const src = fromLibrary && user ? { ...FROM_LIBRARY, token: AUTH.token } : source.src;
  return (
    <div className="app">
      <header className="app-bar">
        <span className="app-mark">Chalk <span>Reader</span></span>
        <label className="app-field">
          <span className="app-visually-hidden">Book</span>
          <select value={source.key} onChange={(e) => { const s = SAMPLES.find((x) => x.id === e.target.value); if (s) { setSource({ key: s.id, src: s.url }); setMode('read'); } }}>
            {SAMPLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            {!SAMPLES.some((s) => s.id === source.key) && <option value={source.key}>{source.key}</option>}
          </select>
        </label>
        {config.authoring.enabled && (
          <div className="app-mode" role="radiogroup" aria-label="Mode">
            {(['read', 'author'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>{m === 'read' ? 'Read' : 'Author'}</button>
            ))}
          </div>
        )}
        {config.authoring.enabled && mode === 'author' && (
          <button type="button" className="app-btn app-save" data-dirty={dirty} data-saving={saving} data-phase={phase ? `${phase.phase}${phase.total ? ` ${phase.done}/${phase.total}` : ''}` : ''} disabled={!dirty || saving} onClick={() => void reader.current?.save()}>
            {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
        )}
        {fromLibrary && user && <button type="button" className="app-btn app-signout" title={`Signed in as ${user.name}`} onClick={() => { setForm(true); void AUTH.signOut(); }}>Sign out {user.name}</button>}
        {fromLibrary && ready && !user && form === false && <button type="button" className="app-btn app-signin" onClick={() => setForm(true)}>Sign in</button>}
        <button type="button" className="app-btn" onClick={() => file.current?.click()}>Open a book</button>
        <button type="button" className="app-btn" aria-pressed={configuring} onClick={() => setConfiguring((c) => !c)}>Configure</button>
        <input ref={file} type="file" accept=".chalk,application/vnd.chalk+zip,application/zip" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) setSource({ key: f.name, src: f }); e.target.value = ''; }} />
      </header>
      <main className="app-main">
        {gate ? (ready && form && <LibrarySignIn auth={AUTH} config={config} onSkip={() => setForm(false)} />) : <ChalkReader ref={reader} key={`${source.key}${fromLibrary && user ? ` ${user.sub}` : ''}`} source={src} config={config} mode={mode} onModeChange={setMode} onDirtyChange={setDirty} {...(onSave ? { onSave } : {})} {...(onSavePatch ? { onSavePatch } : {})} onSavingChange={(s) => { setSaving(s); if (s) (window as unknown as { __savePhases?: string[] }).__savePhases = []; else setPhase(null); if (s && callbacks === 'throw') throw new Error('host callback bug'); if (s && callbacks === 'resave') void reader.current?.save(); }} onSaveProgress={(p) => { setPhase(p); const w = window as unknown as { __savePhases?: string[] }; const log = (w.__savePhases ??= []); if (log.at(-1) !== p.phase) log.push(p.phase); }} libraries={libraries} onLibrariesChange={setLibraries} onBookLinks={onBookLinks} />}
        {configuring && <Playground config={config} base={BASE} onChange={setConfig} onClose={() => setConfiguring(false)} />}
      </main>
    </div>
  );
}
