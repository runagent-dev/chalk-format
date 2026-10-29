import { useRef, useState } from 'react';
import { ChalkReader, DEFAULT_CONFIG, useSavedLibraries, type BookSource, type ReaderConfig, type ReaderHandle, type SaveProgress } from '@chalk-format/reader';
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

/** The showcase: pick a sample or open your own .chalk file. */
export function App() {
  const [source, setSource] = useState<{ key: string; src: BookSource }>({ key: SAMPLES[0]!.id, src: SAMPLES[0]!.url });
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
  // the libraries connected in this browser (This device, folders, library servers), kept for next time;
  // a library server named in .env.local is connected for you (see .env.example)
  const [libraries, setLibraries] = useSavedLibraries({ preset: PRESET });
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
        <button type="button" className="app-btn" onClick={() => file.current?.click()}>Open a book</button>
        <button type="button" className="app-btn" aria-pressed={configuring} onClick={() => setConfiguring((c) => !c)}>Configure</button>
        <input ref={file} type="file" accept=".chalk,application/vnd.chalk+zip,application/zip" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) setSource({ key: f.name, src: f }); e.target.value = ''; }} />
      </header>
      <main className="app-main">
        <ChalkReader ref={reader} key={source.key} source={source.src} config={config} mode={mode} onModeChange={setMode} onDirtyChange={setDirty} {...(onSave ? { onSave } : {})} onSavingChange={(s) => { setSaving(s); if (s) (window as unknown as { __savePhases?: string[] }).__savePhases = []; else setPhase(null); if (s && callbacks === 'throw') throw new Error('host callback bug'); if (s && callbacks === 'resave') void reader.current?.save(); }} onSaveProgress={(p) => { setPhase(p); const w = window as unknown as { __savePhases?: string[] }; const log = (w.__savePhases ??= []); if (log.at(-1) !== p.phase) log.push(p.phase); }} libraries={libraries} onLibrariesChange={setLibraries} />
        {configuring && <Playground config={config} base={BASE} onChange={setConfig} onClose={() => setConfiguring(false)} />}
      </main>
    </div>
  );
}
