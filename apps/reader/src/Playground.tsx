import { useState } from 'react';
import { DEFAULT_CONFIG, type DockItemId, type MediaRendererProps, type PresentationConfig, type ReaderConfig, type ReaderConfigInput, type ToolId, type WindowChrome } from '@chalk-format/reader';

const ALL_TOOLS: ToolId[] = ['pan', 'pen', 'highlighter', 'eraser', 'text', 'rect', 'ellipse', 'line', 'arrow', 'select'];
const ALL_ITEMS: Exclude<DockItemId, '|'>[] = ['thumbnails', 'search', 'prev', 'page', 'next', 'zoomOut', 'fit', 'zoomIn', 'layout', 'tools', 'undo', 'redo', 'export', 'import', 'theme', 'language', 'fullscreen'];
const FEATURE_LABEL: Record<keyof ReaderConfig['features'], string> = {
  thumbnails: 'Thumbnails', search: 'Search', annotations: 'Annotations', media: 'Video & audio', model3d: '3D models', labs: 'Labs',
  snips: 'Snips', fullscreen: 'Full screen', export: 'Save / open notes', keyboard: 'Keyboard', textSelection: 'Text selection',
  themeToggle: 'Theme toggle', languageToggle: 'Language toggle',
};

// ---- presentation examples: what a host app might set (spec 1.3 §5) ----
const EMOJI: PresentationConfig['icons'] = { video: '🎬', audio: '🎵', model3d: '🧊', lab: '🧪', image: '🖼️', snip: '✂️', plugin: '📦', ruler: '📏', atom: '⚛️', magnet: '🧲', flask: '🧪' };
const BRAND: PresentationConfig['defaults'] = { model3d: { accent: '#7c3aed' }, video: { accent: '#b42318' }, audio: { accent: '#b54708' }, lab: { accent: '#175cd3' }, image: { accent: '#0e7c66' }, snip: { accent: '#3f621a' } };
const withAccents = (d: PresentationConfig['defaults'], on: boolean): PresentationConfig['defaults'] => {
  const out: PresentationConfig['defaults'] = {};
  for (const k of new Set([...Object.keys(d), ...(on ? Object.keys(BRAND) : [])]) as Set<keyof typeof BRAND>) {
    const v = { ...d[k] };
    if (on) v.accent = BRAND[k]!.accent; else delete v.accent;
    if (Object.keys(v).length) out[k] = v;
  }
  return out;
};

/** Stands in for a host's own 3D viewer (config.renderers.model3d). */
function DemoViewer(p: MediaRendererProps) {
  return (
    <div className="demo-viewer">
      {p.poster && <img src={p.poster} alt="" />}
      <span>{p.locale === 'bn' ? 'আপনার নিজের ভিউয়ার' : 'Your own viewer'} · {p.where}</span>
    </div>
  );
}
/** Stands in for a host's own chrome around a floating window (config.window.render): the media is the host's to frame. */
function DemoWindow(w: WindowChrome) {
  return (
    <aside className="demo-window" role="dialog" aria-modal="false" aria-label={w.title} data-layout={w.kind}>
      <header><strong>{w.title}</strong><button type="button" aria-label="Close" onClick={w.onClose}>×</button></header>
      <div className="demo-window-body" style={w.aspect ? { aspectRatio: String(w.aspect) } : { height: 280 }}>{w.children}</div>
    </aside>
  );
}
/** Printed as is in the code sample (not quoted). */
class Raw { constructor(readonly code: string) {} }

/** What the config has that the defaults do not, for the code sample. */
function changed(cur: unknown, def: unknown): unknown {
  if (JSON.stringify(cur) === JSON.stringify(def)) return undefined;
  if (cur && def && typeof cur === 'object' && typeof def === 'object' && !Array.isArray(cur)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cur)) { const d = changed(v, (def as Record<string, unknown>)[k]); if (d !== undefined) out[k] = d; }
    return Object.keys(out).length ? out : undefined;
  }
  return cur;
}
const js = (v: unknown, ind = 2): string => {
  const pad = ' '.repeat(ind);
  if (v instanceof Raw) return v.code;
  if (Array.isArray(v)) return `[${v.map((x) => js(x, ind)).join(', ')}]`;
  if (v && typeof v === 'object') return `{\n${Object.entries(v).map(([k, x]) => `${pad}  ${/^\w+$/.test(k) ? k : `'${k}'`}: ${js(x, ind + 2)}`).join(',\n')}\n${pad}}`;
  return typeof v === 'string' ? `'${v}'` : String(v);
};

/** The configuration playground: change the reader live, and see the code for what you set. */
export function Playground({ config, base, onChange, onClose }: { config: ReaderConfig; base: ReaderConfig; onChange: (c: ReaderConfig) => void; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const set = (patch: Partial<ReaderConfig>) => onChange({ ...config, ...patch });
  const dock = config.dock || { position: 'bottom' as const, items: [] };
  const items = dock.items.filter((i): i is DockItemId => typeof i === 'string' && i !== '|');
  const toggleItem = (id: DockItemId) => {
    // keep the default order and its group dividers for the items that remain
    const on = new Set(items.includes(id) ? items.filter((x) => x !== id) : [...items, id]);
    const next = (DEFAULT_CONFIG.dock as Exclude<ReaderConfig['dock'], false>).items.filter((x) => x === '|' || on.has(x as DockItemId));
    for (const x of on) if (!next.includes(x)) next.push(x);   // items not in the default dock go at the end
    set({ dock: { ...dock, items: next } });
  };
  // the app's own setting (the pdf.js worker URL) is not something to copy
  const diff = changed({ ...config, pdfWorkerSrc: null, renderers: {}, window: { ...config.window, render: undefined } }, DEFAULT_CONFIG) as Record<string, unknown> | undefined as ReaderConfigInput | undefined;
  if (config.renderers.model3d) Object.assign(diff ?? {}, { renderers: { model3d: new Raw('(p) => <MyViewer src={p.src} poster={p.poster} />') } });
  if (config.window.render) Object.assign(diff ?? {}, { window: { ...(diff as { window?: object } | undefined)?.window, render: new Raw('(w) => <MyWindow title={w.title} onClose={w.onClose}>{w.children}</MyWindow>') } });
  const pres = config.presentation;
  const setPres = (patch: Partial<PresentationConfig>) => set({ presentation: { ...pres, ...patch } });
  const brand = Object.values(pres.defaults).some((d) => d?.accent);
  const code = `<ChalkReader\n  source="/books/physics.chalk"${diff ? `\n  config={${js(diff, 2)}}` : ''}\n/>`;

  return (
    <aside className="pg" aria-label="Configure the reader">
      <header className="pg-head">
        <h2>Configure</h2>
        <button type="button" className="app-btn" onClick={() => onChange(base)}>Reset</button>
        <button type="button" className="pg-close" aria-label="Close" onClick={onClose}>×</button>
      </header>
      <div className="pg-body">
        <section>
          <h3>Look</h3>
          <Choice label="Theme" value={config.theme} options={['system', 'light', 'dark']} onChange={(v) => set({ theme: v })} />
          <Choice label="Language" value={config.locale} options={['bn', 'en']} onChange={(v) => set({ locale: v })} />
          <Choice label="Layout" value={config.layout} options={['continuous', 'single', 'spread']} onChange={(v) => set({ layout: v })} />
          <Choice label="Fit" value={config.fit} options={['auto', 'width', 'page']} onChange={(v) => set({ fit: v })} />
        </section>
        <section>
          <h3>Features</h3>
          <div className="pg-checks">
            {(Object.keys(FEATURE_LABEL) as (keyof ReaderConfig['features'])[]).map((k) => (
              <Check key={k} label={FEATURE_LABEL[k]} checked={config.features[k]} onChange={(v) => set({ features: { ...config.features, [k]: v } })} />
            ))}
            <Check label="Read only" checked={config.readOnly} onChange={(v) => set({ readOnly: v })} />
          </div>
        </section>
        <section>
          <h3>Dock</h3>
          <Check label="Show the dock" checked={config.dock !== false} onChange={(v) => set({ dock: v ? dock : false })} />
          {config.dock && (
            <>
              <Choice label="Position" value={dock.position} options={['bottom', 'top', 'left', 'right']} onChange={(v) => set({ dock: { ...dock, position: v } })} />
              <div className="pg-checks">{ALL_ITEMS.map((id) => <Check key={id} label={id} checked={items.includes(id)} onChange={() => toggleItem(id)} mono />)}</div>
            </>
          )}
        </section>
        <section>
          <h3>Annotations</h3>
          <div className="pg-checks">
            {ALL_TOOLS.map((id) => (
              <Check key={id} label={id} mono checked={config.annotations.tools.includes(id)}
                onChange={(v) => set({ annotations: { ...config.annotations, tools: ALL_TOOLS.filter((x) => (x === id ? v : config.annotations.tools.includes(x))) } })} />
            ))}
            <Check wide label="May edit the book's own objects" checked={config.annotations.editBase} onChange={(v) => set({ annotations: { ...config.annotations, editBase: v } })} />
          </div>
          <Choice label="Keep notes in" value={config.persistence} options={['local', 'none']} onChange={(v) => set({ persistence: v })} />
        </section>
        <section>
          <h3>Authoring</h3>
          <Check wide label="Allow author mode (place media, choose how it is shown, save)" checked={config.authoring.enabled}
            onChange={(v) => set({ authoring: { ...config.authoring, enabled: v } })} />
          {config.authoring.enabled && (
            <Choice label="Language of the author's tools" value={config.authoring.locale} options={['en', 'bn']} onChange={(v) => set({ authoring: { ...config.authoring, locale: v } })} />
          )}
          {config.authoring.enabled && (
            <Check wide label="Right-click menu to add media" checked={config.authoring.contextMenu} onChange={(v) => set({ authoring: { ...config.authoring, contextMenu: v } })} />
          )}
        </section>
        <section>
          <h3>Media</h3>
          <div className="pg-checks">
            <Check wide label="Use the colours authors chose" checked={pres.authorAccents} onChange={(v) => setPres({ authorAccents: v })} />
            <Check wide label="Let media start by itself (live, autoplay)" checked={pres.live} onChange={(v) => setPres({ live: v })} />
            <Check wide label="My colour for each kind" checked={brand} onChange={(v) => setPres({ defaults: withAccents(pres.defaults, v) })} />
          </div>
          <Choice label="Icons" value={pres.icons === EMOJI ? 'emoji' : 'built-in'} options={['built-in', 'emoji']} onChange={(v) => setPres({ icons: v === 'emoji' ? EMOJI : {} })} />
          <Choice label="3D models with no choice of their own" value={pres.defaults.model3d?.show === 'live' ? 'live' : 'card'} options={['card', 'live']}
            onChange={(v) => { const m = { ...pres.defaults.model3d }; delete m.show; delete m.autoRotate; setPres({ defaults: { ...pres.defaults, model3d: v === 'live' ? { ...m, show: 'live', autoRotate: true } : m } }); }} />
          <Check wide label="My own 3D viewer (demo renderer)" checked={Boolean(config.renderers.model3d)} onChange={(v) => set({ renderers: v ? { model3d: DemoViewer } : {} })} />
        </section>
        <section>
          <h3>Floating window (open: window)</h3>
          <Choice label="Where it opens" value={config.window.layout.kind === 'side' ? (config.window.layout.side === 'left' ? 'left panel' : 'right panel') : 'floating'} options={['floating', 'right panel', 'left panel']}
            onChange={(v) => set({ window: { ...config.window, layout: v === 'floating' ? { ...config.window.layout, kind: 'floating' } : { ...config.window.layout, kind: 'side', side: v === 'left panel' ? 'left' : 'right' } } })} />
          <Choice label="Its shape" value={config.window.aspect === 'free' ? 'free' : config.window.aspect === 'media' ? 'media' : '4:3'} options={['media', 'free', '4:3']}
            onChange={(v) => set({ window: { ...config.window, aspect: v === '4:3' ? 4 / 3 : v } })} />
          <Check wide label="My own window chrome (demo)" checked={Boolean(config.window.render)} onChange={(v) => set({ window: { ...config.window, render: v ? DemoWindow : undefined } })} />
        </section>
        <section>
          <h3>Labs</h3>
          <Check label="Start a lab when its page opens" checked={config.labs.autoStart} onChange={(v) => set({ labs: { autoStart: v } })} />
        </section>
        <section>
          <h3>Code</h3>
          <pre className="pg-code"><code>{code}</code></pre>
          <button type="button" className="app-btn" onClick={() => { void navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </section>
      </div>
    </aside>
  );
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <fieldset className="pg-choice">
      <legend>{label}</legend>
      <div className="pg-seg">
        {options.map((o) => (
          <label key={o} className={o === value ? 'is-on' : ''}>
            <input type="radio" name={label} value={o} checked={o === value} onChange={() => onChange(o)} />{o}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Check({ label, checked, onChange, mono, wide }: { label: string; checked: boolean; onChange: (v: boolean) => void; mono?: boolean; wide?: boolean }) {
  return (
    <label className={`pg-check ${mono ? 'is-mono' : ''} ${wide ? 'is-wide' : ''}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
