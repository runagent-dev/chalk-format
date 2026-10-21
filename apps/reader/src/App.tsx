import { useRef, useState } from 'react';
import { ChalkReader, DEFAULT_CONFIG, type BookSource, type ReaderConfig } from '@chalk-format/reader';
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
];

/** The showcase: pick a sample or open your own .chalk file. */
export function App() {
  const [source, setSource] = useState<{ key: string; src: BookSource }>({ key: SAMPLES[0]!.id, src: SAMPLES[0]!.url });
  const file = useRef<HTMLInputElement>(null);
  const [config, setConfig] = useState<ReaderConfig>(BASE);
  const [configuring, setConfiguring] = useState(false);
  const [mode, setMode] = useState<'read' | 'author'>('read');
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
        <button type="button" className="app-btn" onClick={() => file.current?.click()}>Open a book</button>
        <button type="button" className="app-btn" aria-pressed={configuring} onClick={() => setConfiguring((c) => !c)}>Configure</button>
        <input ref={file} type="file" accept=".chalk,application/vnd.chalk+zip,application/zip" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) setSource({ key: f.name, src: f }); e.target.value = ''; }} />
      </header>
      <main className="app-main">
        <ChalkReader key={source.key} source={source.src} config={config} mode={mode} onModeChange={setMode} />
        {configuring && <Playground config={config} base={BASE} onChange={setConfig} onClose={() => setConfiguring(false)} />}
      </main>
    </div>
  );
}
