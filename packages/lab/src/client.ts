/**
 * The lab side of the Host API (spec/1.1/host-api.md). A lab that bundles its code can use this;
 * one that does not can speak the protocol directly (examples/labs/pendulum.html does).
 *
 *   const lab = await connectLab({ id: 'org.example.pendulum', version: '1.0.0' });
 *   draw(lab.params, lab.state);
 *   lab.ready();
 *   lab.on('visibility', (v) => (v ? resume() : pause()));
 */
import {
  HOST_API_VERSION, MARK, isMessage,
  type Capability, type ErrorCode, type Init, type LabMode, type MessageEvents, type PostTarget, type Progress, type Theme,
} from './protocol.js';

export class LabError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); this.name = 'LabError'; }
}

type Events = { visibility: boolean; theme: Theme; locale: string; reset: void };

export type LabSession = {
  readonly api: number;
  readonly params: Record<string, unknown>;
  readonly locale: string;
  readonly theme: Theme;
  readonly reducedMotion: boolean;
  readonly granted: readonly Capability[];
  /** What was saved last time, or null. */
  readonly state: unknown;
  readonly mode: LabMode;
  /** Whether the lab is on screen at start; `on('visibility')` tells of changes. Don't render while false. */
  readonly visible: boolean;
  has(capability: Capability): boolean;
  /** The first frame is on screen: the host may hide the poster. */
  ready(): void;
  /** Save state (JSON, ≤ 64 KiB). Rejects with `denied` when `state` is not granted. */
  save(state: unknown): Promise<void>;
  /** Report where the student is (cumulative). Dropped when `progress` is not granted. */
  progress(progress: Progress): void;
  /** One of `lab.assets`, as bytes. */
  getAsset(assetId: string): Promise<{ type: string; bytes: ArrayBuffer }>;
  /** One of `lab.assets`, as a `blob:` URL (for loaders that want a URL, e.g. GLTFLoader). The same URL every
   *  time for the same asset; `releaseAsset` frees it once nothing needs it any more. */
  assetUrl(assetId: string): Promise<string>;
  releaseAsset(assetId: string): void;
  fullscreen(on: boolean): Promise<boolean>;
  on<K extends keyof Events>(type: K, listener: (value: Events[K]) => void): () => void;
};

export type ConnectOptions = {
  /** The lab's own window (default `globalThis`) and its parent, the host. */
  self?: MessageEvents & { parent: PostTarget };
  /** How long to wait for `init` (default 15 s). */
  timeoutMs?: number;
  /** How often to repeat `hello` until `init` arrives (default 500 ms). */
  helloEveryMs?: number;
  /** Request timeout (default 10 s, host-api §2). */
  requestTimeoutMs?: number;
};

/** Say hello to the host and resolve with the session once `init` arrives. */
export function connectLab(lab: { id: string; version: string }, o: ConnectOptions = {}): Promise<LabSession> {
  const self = o.self ?? (globalThis as unknown as MessageEvents & { parent: PostTarget });
  const host = self.parent;
  // the handshake goes on the window; after init, everything on the channel the host handed over
  let port: MessagePort | null = null;
  const send = (msg: Record<string, unknown>) => port?.postMessage({ chalk: MARK, ...msg });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners: { [K in keyof Events]: Set<(v: Events[K]) => void> } = { visibility: new Set(), theme: new Set(), locale: new Set(), reset: new Set() };
  let nextId = 1, session: LabSession | null = null;

  return new Promise<LabSession>((resolve, reject) => {
    const hello = () => host.postMessage({ chalk: MARK, type: 'hello', api: [HOST_API_VERSION], lab: { id: lab.id, version: lab.version } }, '*');
    const helloTimer = setInterval(hello, o.helloEveryMs ?? 500);
    const giveUp = setTimeout(() => { clearInterval(helloTimer); reject(new LabError('failed', 'no init from the host')); }, o.timeoutMs ?? 15000);

    const request = (msg: Record<string, unknown>) => new Promise<unknown>((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); rej(new LabError('failed', `${String(msg.type)}: no reply`)); }, o.requestTimeoutMs ?? 10000);
      pending.set(id, { resolve: res, reject: rej, timer });
      send({ ...msg, id });
    });

    function start(init: Init, channel: MessagePort | undefined) {
      clearInterval(helloTimer); clearTimeout(giveUp);
      if (init.api !== HOST_API_VERSION || !channel) { reject(new LabError('failed', 'the host speaks no Host API version this lab knows')); return; }
      port = channel;
      port.onmessage = (e) => onChannel(e.data);
      const granted = Object.freeze([...(init.granted ?? [])]);
      const has = (c: Capability) => granted.includes(c);
      const getAsset = async (assetId: string) => {
        if (!has('assets')) throw new LabError('denied', 'assets is not granted');
        return (await request({ type: 'asset.get', assetId })) as { type: string; bytes: ArrayBuffer };
      };
      const urls = new Map<string, Promise<string>>();
      session = {
        api: init.api, params: init.params ?? {}, locale: init.locale, theme: init.theme, reducedMotion: !!init.reducedMotion,
        granted, state: init.state ?? null, mode: init.mode ?? 'interactive', visible: init.visible !== false, has,
        ready: () => send({ type: 'ready' }),
        async save(state) {
          if (!has('state')) throw new LabError('denied', 'state is not granted');
          await request({ type: 'state.save', state });
        },
        progress(p) { if (has('progress')) send({ type: 'progress', ...p }); },
        getAsset,
        assetUrl(assetId) {
          let u = urls.get(assetId);
          if (!u) {
            u = getAsset(assetId).then((a) => URL.createObjectURL(new Blob([a.bytes], { type: a.type })));
            urls.set(assetId, u);
            u.catch(() => urls.delete(assetId));   // a failed load can be retried
          }
          return u;
        },
        releaseAsset(assetId) { const u = urls.get(assetId); urls.delete(assetId); void u?.then((url) => URL.revokeObjectURL(url), () => {}); },
        async fullscreen(on) { return ((await request({ type: 'ui.fullscreen', on })) as { on: boolean }).on; },
        on(type, listener) { listeners[type].add(listener); return () => listeners[type].delete(listener); },
      };
      resolve(session);
    }

    self.addEventListener('message', (e) => {
      // only the host speaks to us, and on the window only to start
      if (e.source !== host || !isMessage(e.data) || e.data.type !== 'init' || session) return;
      start(e.data as unknown as Init, e.ports?.[0]);
    });

    function onChannel(data: unknown) {
      if (!session || !isMessage(data)) return;
      const msg = data as Record<string, unknown> & { type: string };
      if (msg.type === 'reply' && typeof msg.id === 'number') {
        const p = pending.get(msg.id); if (!p) return;
        pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.ok === true) p.resolve(msg.result);
        else { const err = (msg.error ?? {}) as { code?: ErrorCode; message?: string }; p.reject(new LabError(err.code ?? 'failed', err.message ?? 'failed')); }
        return;
      }
      const emit = <K extends keyof Events>(k: K, v: Events[K]) => listeners[k].forEach((f) => f(v));
      if (msg.type === 'visibility') emit('visibility', msg.visible === true);
      else if (msg.type === 'theme') emit('theme', msg.theme === 'dark' ? 'dark' : 'light');
      else if (msg.type === 'locale' && typeof msg.locale === 'string') emit('locale', msg.locale);
      else if (msg.type === 'reset') emit('reset', undefined);
      // anything else: an event from a later version, ignored
    }
    hello();
  });
}
