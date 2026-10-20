import { hashBytes, type Lab } from '@chalk-format/model';
import {
  HOST_API_VERSION, KNOWN_CAPABILITIES, MARK, STATE_MAX_BYTES, isMessage, jsonBytes, majorVersion,
  type Capability, type ErrorCode, type HostEvent, type LabMode, type MessageEvents, type PostTarget,
  type Progress, type Reply, type Theme,
} from './protocol.js';

/** Saved state belongs to a lab id and major version (host-api §4.1); the host app adds book, object and learner. */
export type StateKey = { labId: string; major: string };

export type LabHostOptions = {
  /** The lab's descriptor from the book (`object.lab`). */
  lab: Lab;
  /** The lab's iframe. Read at message time, so it may be attached after the host is created. */
  frame: { readonly contentWindow: PostTarget | null };
  /** Where the lab's messages arrive: the host page's window (default `globalThis`). */
  events?: MessageEvents;
  /** The reader's UI language, BCP 47. */
  locale: string;
  theme?: Theme;
  reducedMotion?: boolean;
  mode?: LabMode;
  /** Narrow the capabilities granted (called with those requested that this host can serve). */
  grant?: (requested: Capability[]) => Capability[];
  /** Saved state for this book object and learner, or null. Providing both grants `state`. */
  loadState?: (key: StateKey) => unknown | Promise<unknown>;
  saveState?: (key: StateKey, state: unknown) => void | Promise<void>;
  /** Forget saved state (on `reset()`). */
  clearState?: (key: StateKey) => void | Promise<void>;
  /** The bytes of one of the book's assets, or null. Providing it grants `assets` (for `lab.assets` only). */
  getAsset?: (assetId: string) => Promise<{ type: string; bytes: ArrayBuffer } | null>;
  onProgress?: (progress: Progress) => void;
  /** The lab drew its first frame: hide the poster. */
  onReady?: () => void;
  /** The lab asks for full screen; return the state after deciding. */
  onFullscreen?: (on: boolean) => boolean | Promise<boolean>;
  /** Something the host refused to go on with (a lab id mismatch, no shared API version). */
  onError?: (message: string) => void;
};

export type LabHost = {
  /** The lab's capabilities as granted. */
  readonly granted: readonly Capability[];
  /** Resolves when the lab has been sent `init`. */
  readonly started: Promise<void>;
  setVisible(visible: boolean): void;
  setTheme(theme: Theme): void;
  setLocale(locale: string): void;
  /** Start over: forget saved state and tell the lab to return to its `params`. */
  reset(): Promise<void>;
  dispose(): void;
};

class RequestError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}

/** Run the host side of the Host API for one lab frame (spec/1.1/host-api.md). */
export function createLabHost(o: LabHostOptions): LabHost {
  const events = o.events ?? (globalThis as unknown as MessageEvents);
  const key: StateKey = { labId: o.lab.id, major: majorVersion(o.lab.version) };
  const allowedAssets = new Set(o.lab.assets ?? []);
  const requested = [...new Set(o.lab.capabilities ?? [])].filter((c): c is Capability => (KNOWN_CAPABILITIES as readonly string[]).includes(c));
  const servable = requested.filter((c) => c === 'progress' || (c === 'state' ? !!(o.loadState && o.saveState) : !!o.getAsset));
  const granted = Object.freeze(o.grant ? o.grant(servable).filter((c) => servable.includes(c)) : servable);
  const has = (c: Capability) => granted.includes(c);
  let theme: Theme = o.theme ?? 'light', locale = o.locale, initSent = false, stopped = false;
  let resolveStarted!: () => void;
  const started = new Promise<void>((r) => { resolveStarted = r; });

  const post = (msg: HostEvent | Reply, transfer?: Transferable[]) => {
    const w = o.frame.contentWindow;
    if (w && !stopped) w.postMessage(msg, '*', transfer);
  };
  const reply = (id: number, result: unknown, transfer?: Transferable[]) => post({ chalk: MARK, type: 'reply', id, ok: true, result }, transfer);
  const fail = (id: number, code: ErrorCode, message: string) => post({ chalk: MARK, type: 'reply', id, ok: false, error: { code, message } });
  const stop = (message: string) => { o.onError?.(message); stopped = true; events.removeEventListener('message', onMessage); };

  async function hello(msg: Record<string, unknown>) {
    if (initSent) return;   // exactly one init; a resent hello is the lab not having heard us yet
    initSent = true;
    const api = Array.isArray(msg.api) && msg.api.includes(HOST_API_VERSION) ? HOST_API_VERSION : 0;
    const lab = msg.lab as { id?: unknown } | undefined;
    if (api === 0) {
      post({ chalk: MARK, type: 'init', api: 0, params: {}, locale, theme, reducedMotion: !!o.reducedMotion, granted: [], state: null, mode: o.mode ?? 'interactive' });
      return stop(`lab ${o.lab.id} speaks no Host API version this host knows`);
    }
    if (!lab || lab.id !== o.lab.id) return stop(`lab says it is ${String(lab?.id)}, the book says ${o.lab.id}`);
    const state = has('state') ? ((await o.loadState!(key)) ?? null) : null;
    post({ chalk: MARK, type: 'init', api, params: o.lab.params ?? {}, locale, theme, reducedMotion: !!o.reducedMotion, granted: [...granted], state, mode: o.mode ?? 'interactive' });
    resolveStarted();
  }

  async function request(msg: Record<string, unknown> & { type: string }): Promise<{ result: unknown; transfer?: Transferable[] }> {
    switch (msg.type) {
      case 'state.save': {
        if (!has('state')) throw new RequestError('denied', 'state is not granted');
        const n = jsonBytes(msg.state);
        if (n === null) throw new RequestError('invalid', 'state is not JSON');
        if (n > STATE_MAX_BYTES) throw new RequestError('too_large', `state is ${n} bytes, the limit is ${STATE_MAX_BYTES}`);
        await o.saveState!(key, msg.state);
        return { result: null };
      }
      case 'asset.get': {
        const id = msg.assetId;
        if (!has('assets')) throw new RequestError('denied', 'assets is not granted');
        if (typeof id !== 'string' || !allowedAssets.has(id)) throw new RequestError('denied', `${String(id)} is not in lab.assets`);
        const got = await o.getAsset!(id);
        // the lab gets bytes that are what the book says they are, or nothing
        if (!got || (await hashBytes(new Uint8Array(got.bytes))) !== id) throw new RequestError('not_found', `no bytes for ${id}`);
        return { result: { type: got.type, bytes: got.bytes }, transfer: [got.bytes] };
      }
      case 'ui.fullscreen':
        return { result: { on: o.onFullscreen ? await o.onFullscreen(msg.on === true) : false } };
      default:
        throw new RequestError('unknown', `unknown request ${msg.type}`);
    }
  }

  function onMessage(e: { data: unknown; source: unknown }) {
    if (stopped || e.source !== o.frame.contentWindow || e.source == null || !isMessage(e.data)) return;
    const msg = e.data;
    if (msg.type === 'hello') { void hello(msg); return; }
    if (!initSent) return;
    if (typeof msg.id === 'number') {
      const id = msg.id;
      request(msg).then(({ result, transfer }) => reply(id, result, transfer), (err: unknown) => {
        if (err instanceof RequestError) fail(id, err.code, err.message);
        else fail(id, 'failed', err instanceof Error ? err.message : String(err));
      });
      return;
    }
    if (msg.type === 'ready') o.onReady?.();
    else if (msg.type === 'progress' && has('progress')) o.onProgress?.(progressOf(msg));
    // anything else: a notice from a later version, ignored
  }
  events.addEventListener('message', onMessage);

  return {
    granted,
    started,
    setVisible: (visible) => post({ chalk: MARK, type: 'visibility', visible }),
    setTheme: (t) => { theme = t; post({ chalk: MARK, type: 'theme', theme: t }); },
    setLocale: (l) => { locale = l; post({ chalk: MARK, type: 'locale', locale: l }); },
    async reset() { if (has('state')) await o.clearState?.(key); post({ chalk: MARK, type: 'reset' }); },
    dispose: () => { stopped = true; events.removeEventListener('message', onMessage); },
  };
}

/** Only the fields host-api §4.2 defines, checked; a malformed notice reports nothing wrong. */
function progressOf(m: Record<string, unknown>): Progress {
  const p: Progress = {};
  const s = m.step as { done?: unknown; total?: unknown } | undefined;
  if (s && Number.isInteger(s.done) && Number.isInteger(s.total)) p.step = { done: s.done as number, total: s.total as number };
  if (typeof m.score === 'number' && m.score >= 0 && m.score <= 1) p.score = m.score;
  if (typeof m.completed === 'boolean') p.completed = m.completed;
  return p;
}
