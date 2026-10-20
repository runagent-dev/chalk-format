import { useRef, useState } from 'react';
import { ChalkReader, type BookSource } from '@chalk-format/reader';

const SAMPLES = [
  { id: 'all-features', label: 'Every object type', url: '/samples/all-features.chalk' },
  { id: 'lab', label: 'A lab', url: '/samples/lab.chalk' },
];

/** The showcase: pick a sample or open your own .chalk file. */
export function App() {
  const [source, setSource] = useState<{ key: string; src: BookSource }>({ key: SAMPLES[0]!.id, src: SAMPLES[0]!.url });
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="app">
      <header className="app-bar">
        <span className="app-mark">Chalk <span>Reader</span></span>
        <label className="app-field">
          <span className="app-visually-hidden">Book</span>
          <select value={source.key} onChange={(e) => { const s = SAMPLES.find((x) => x.id === e.target.value); if (s) setSource({ key: s.id, src: s.url }); }}>
            {SAMPLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            {!SAMPLES.some((s) => s.id === source.key) && <option value={source.key}>{source.key}</option>}
          </select>
        </label>
        <button type="button" className="app-btn" onClick={() => file.current?.click()}>Open a book</button>
        <input ref={file} type="file" accept=".chalk,application/vnd.chalk+zip,application/zip" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) setSource({ key: f.name, src: f }); e.target.value = ''; }} />
      </header>
      <main className="app-main">
        <ChalkReader key={source.key} source={source.src} />
      </main>
    </div>
  );
}
