// the <model-viewer> JSX element type, wherever this file is compiled
import type {} from '../model-viewer-jsx.js';
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { PauseIcon, PlayIcon } from '@phosphor-icons/react';
import { mountLab, type LabHost, type StateKey } from '@chalk-format/lab';
import type { EmbedObject, LabObject } from '@chalk-format/model';
import type { Book } from '../book.js';
import type { Locale } from '../config.js';
import { num, strings } from '../i18n.js';
import { useAssetUrl } from './assets.js';
import { usePresenter } from '../present.js';
import { Box, EmbedCard, type Activate } from './Markers.js';

/** Where labs keep their saved state (host-api §4.1). The reader adds the book and object to the key. */
export type LabStorage = {
  load(key: string): unknown | Promise<unknown>;
  save(key: string, state: unknown): void | Promise<void>;
  clear(key: string): void | Promise<void>;
};

/** This browser's storage, for when the host does not provide its own. */
export const localLabStorage: LabStorage = {
  load(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  save(k, s) { try { localStorage.setItem(k, JSON.stringify(s)); } catch { /* full or blocked: the lab keeps working */ } },
  clear(k) { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};

const mediaUrl = (book: Book, o: EmbedObject) => ({ id: o.assetId, url: o.url });

/** Plays the element while at least half of it is on screen and the tab is visible; pauses it otherwise. */
function usePlayWhileVisible(el: RefObject<HTMLMediaElement | null>, on: boolean) {
  useEffect(() => {
    const m = el.current; if (!on || !m) return;
    let seen = false;
    const update = () => { if (seen && document.visibilityState === 'visible') void m.play().catch(() => {}); else m.pause(); };
    const io = new IntersectionObserver((es) => { seen = es.some((x) => x.intersectionRatio >= 0.5); update(); }, { threshold: [0, 0.5] });
    io.observe(m); document.addEventListener('visibilitychange', update);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, [el, on]);
}

/**
 * A video. Its card until tapped, then the browser's own player in the page; or the player at once if the author
 * asked for it live (spec 1.3), started by itself while on screen if they asked for autoplay. A tap that should
 * open it elsewhere (popup, full screen) goes to `onOpen`.
 */
export function VideoEmbed({ book, o, label, onOpen }: { book: Book; o: EmbedObject; label: string; onOpen?: Activate | undefined }) {
  const pr = usePresenter(), p = pr.present(o);
  const [playing, setPlaying] = useState(p.show === 'live');
  const { id, url } = mediaUrl(book, o);
  const src = useAssetUrl(book, playing ? id : undefined) ?? (playing ? url : undefined);
  const poster = useAssetUrl(book, o.poster);
  const el = useRef<HTMLVideoElement>(null);
  const [tapped, setTapped] = useState(false);
  // `src` too: the element only exists once the media's URL is known (the effect must run again then)
  usePlayWhileVisible(el, Boolean(src) && playing && p.autoplay && !tapped);
  if (!playing) return <EmbedCard book={book} o={o} label={label} onActivate={onOpen ?? (() => { setTapped(true); setPlaying(true); })} />;
  const R = pr.renderers.video;
  if (R) return <Box x={o.x} y={o.y} width={o.width} height={o.height} className="chalk-video" label={p.label ?? label} id={o.id}>{R({ object: o, src: src ?? null, poster: poster ?? null, presentation: p, where: 'page', ...pr.env })}</Box>;
  return (
    <Box x={o.x} y={o.y} width={o.width} height={o.height} className="chalk-video" label={p.label ?? label} id={o.id}>
      {/* browsers start a video by itself only without sound; a tap is the student asking, so then it plays as authored */}
      {src && <video ref={el} src={src} poster={poster ?? undefined} controls playsInline preload="metadata"
        autoPlay={tapped} loop={p.loop} muted={p.muted || (p.autoplay && !tapped)} />}
    </Box>
  );
}

/** Audio as a compact player bar drawn in the page: play, a seek bar, the time. */
export function AudioEmbed({ book, o, locale }: { book: Book; o: EmbedObject; locale: Locale }) {
  const t = strings(locale);
  const el = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState({ playing: false, time: 0, duration: 0 });
  const pr = usePresenter(), p = pr.present(o);
  // sound starts only when the student asks (spec 1.3 §1): audio has no autoplay
  const R = pr.renderers.audio;
  // a host's own player gets the media at once; ours loads it on the first tap
  const [want, setWant] = useState(Boolean(R));
  const src = useAssetUrl(book, want ? o.assetId : undefined) ?? (want ? o.url : undefined);
  // a tap before the media was loaded: play once it is there (once, so a later pause stays paused)
  const playWhenReady = useRef(false);
  useEffect(() => { if (src && playWhenReady.current) { playWhenReady.current = false; void el.current?.play(); } }, [src]);
  const fmt = (s: number) => num(locale, `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
  const toggle = () => { const a = el.current; if (!want || !a) { playWhenReady.current = true; setWant(true); return; } if (a.paused) void a.play(); else a.pause(); };
  const style = { '--h': `${o.height}px` } as CSSProperties;
  const poster = useAssetUrl(book, o.poster);
  if (R) return <Box x={o.x} y={o.y} width={o.width} height={o.height} className="chalk-audio" label={p.label} id={o.id}>{R({ object: o, src: src ?? null, poster: poster ?? null, presentation: p, where: 'page', ...pr.env })}</Box>;
  return (
    <Box x={o.x} y={o.y} width={o.width} height={o.height} className="chalk-audio" label={p.label} id={o.id}>
      <div className="chalk-audio-bar" style={style}>
        <button type="button" className="chalk-audio-play" aria-label={state.playing ? '❚❚' : t.play} onClick={toggle}>
          {state.playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
        </button>
        <input type="range" className="chalk-audio-seek" min={0} max={state.duration || 1} step={0.01} value={state.time} aria-label={t.play}
          onChange={(e) => { if (el.current) el.current.currentTime = Number(e.target.value); }} />
        <span className="chalk-audio-time">{fmt(state.time)}</span>
      </div>
      {src && (
        <audio ref={el} src={src} preload="metadata" loop={p.loop}
          onPlay={() => setState((s) => ({ ...s, playing: true }))} onPause={() => setState((s) => ({ ...s, playing: false }))}
          onTimeUpdate={(e) => { const a = e.currentTarget; setState((s) => ({ ...s, time: a.currentTime })); }}
          onLoadedMetadata={(e) => { const a = e.currentTarget; setState((s) => ({ ...s, duration: a.duration })); }} />
      )}
    </Box>
  );
}

/** A 3D model in <model-viewer>, loaded on first use: drag to turn, pinch or scroll to zoom. */
export function ModelViewer({ book, o, style, where = 'page' }: { book: Book; o: EmbedObject; style: CSSProperties; where?: 'page' | 'popup' }) {
  const src = useAssetUrl(book, o.assetId) ?? o.url;
  const poster = useAssetUrl(book, o.poster);
  const pr = usePresenter(), p = pr.present(o);
  const [loaded, setLoaded] = useState(false);
  const R = pr.renderers.model3d;
  // <model-viewer> (and three.js) only loads when the reader draws the model itself
  useEffect(() => { if (R) return; let live = true; void import('@google/model-viewer').then(() => { if (live) setLoaded(true); }); return () => { live = false; }; }, [R]);
  return (
    <div className="chalk-live chalk-model" style={style} aria-label={p.label}>
      {R && R({ object: o, src: src ?? null, poster: poster ?? null, presentation: p, where, ...pr.env })}
      {!R && loaded && src && (
        <model-viewer src={src} poster={poster ?? undefined} camera-controls="" touch-action="pan-y" shadow-intensity="0.7" exposure="1.05"
          environment-image="neutral" interaction-prompt="none" {...(p.autoRotate ? { 'auto-rotate': '' } : {})} style={{ width: '100%', height: '100%', background: 'transparent' }} />
      )}
      {!R && !loaded && <span className="chalk-spinner" aria-hidden />}
    </div>
  );
}

/**
 * A running lab (spec 1.1, Host API): its HTML from the book, mounted by @chalk-format/lab in a sandbox,
 * its poster shown until the lab draws its first frame. Told when it is off screen, so it stops rendering;
 * its state saved per book, object and lab version.
 */
export function LabFrame({ book, o, style, locale, theme, storage, onProgress, onStop }: {
  book: Book; o: LabObject; style: CSSProperties; locale: Locale; theme: 'light' | 'dark';
  storage: LabStorage | null; onProgress?: ((p: { step?: { done: number; total: number }; score?: number; completed?: boolean }) => void) | undefined;
  onStop: (reason: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null), frameHost = useRef<HTMLDivElement>(null);
  const host = useRef<LabHost | null>(null);
  const [ready, setReady] = useState(false);
  const poster = useAssetUrl(book, o.poster);
  const t = strings(locale);
  const props = useRef({ onProgress, onStop }); props.current = { onProgress, onStop };

  useEffect(() => {
    let live = true;
    const holder = frameHost.current;
    const key = (k: StateKey) => `chalk:${book.lesson.id}:lab:${o.id}:${k.labId}@${k.major}`;
    void (async () => {
      const entry = await book.assetBytes(o.lab.entry);
      if (!live) return;
      if (!entry) { props.current.onStop('the lab is not in this book'); return; }
      try {
        const r = await mountLab(holder!, {
          lab: o.lab, entry: new Uint8Array(entry.bytes), locale, theme,
          reducedMotion: typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
          ...(storage ? { loadState: (k: StateKey) => storage.load(key(k)), saveState: (k: StateKey, s: unknown) => storage.save(key(k), s), clearState: (k: StateKey) => storage.clear(key(k)) } : {}),
          getAsset: (id) => book.assetBytes(id),
          onReady: () => setReady(true),
          onProgress: (p) => props.current.onProgress?.(p),
          onFullscreen: async (on) => {
            if (on && wrap.current?.requestFullscreen) await wrap.current.requestFullscreen().catch(() => {});
            else if (!on && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
            return document.fullscreenElement === wrap.current;
          },
          onError: (m) => props.current.onStop(m),
        });
        if (!live) { r.host.dispose(); r.frame.remove(); return; }
        host.current = r.host;
      } catch (e) { props.current.onStop(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { live = false; host.current?.dispose(); host.current = null; holder?.replaceChildren(); };
  }, [book, o.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { host.current?.setLocale(locale); }, [locale]);
  useEffect(() => { host.current?.setTheme(theme); }, [theme]);

  // off screen or in a hidden tab: the lab stops rendering (spec 1.1 §3.4)
  useEffect(() => {
    const e = wrap.current; if (!e) return;
    let onScreen = true;
    const update = () => host.current?.setVisible(onScreen && document.visibilityState === 'visible');
    const io = new IntersectionObserver((es) => { onScreen = es.some((x) => x.isIntersecting); update(); });
    io.observe(e); document.addEventListener('visibilitychange', update);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);

  return (
    <div ref={wrap} className="chalk-live chalk-lab" style={style} aria-label={o.lab.title}>
      <div ref={frameHost} className="chalk-lab-frame" />
      {!ready && (
        <div className="chalk-lab-wait" aria-hidden>
          {poster && <img src={poster} alt="" />}
          <span className="chalk-spinner" />
        </div>
      )}
      <span className="chalk-visually-hidden" role="status">{ready ? o.lab.title : t.loading}</span>
    </div>
  );
}
