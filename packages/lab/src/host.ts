import { hashBytes, type Lab } from '@chalk-format/model';
import {
  HOST_API_VERSION, KNOWN_CAPABILITIES, MARK, STATE_MAX_BYTES, isMessage, jsonBytes, majorVersion,
  type Capability, type ErrorCode, type HostEvent, type LabMode, type MessageEvents, type PostTarget,
  type Progress, type Reply, type Theme, type WindowMessage,
} from './protocol.js';

/** Saved state belongs to a lab id and major version (host-api §4.1); the host app adds book, object and learner. */
export type StateKey = { labId: string; major: string };

export type LabHostOptions = {
  /** The lab's descriptor from the book (`object.lab`). */
  lab: Lab;
  /** The lab's iframe. Read at message time, so it may be attached after the host is created. */
  frame: { readonly contentWindow: PostTarget | null };
  /** The nonce the frame's guard script was made with (prepareLabDocument / labGuard): `gone` is accepted
   *  only with it. mountLab does this for you. */
  nonce: string;
  /** Where the lab's window messages arrive: the host page's window (default `globalThis`). */
  events?: MessageEvents;
  /** The reader's UI language, BCP 47. */
  locale: string;
  theme?: Theme;
  reducedMotion?: boolean;
  mode?: LabMode;
  /** Whether the lab starts on screen (default true). `setVisible` changes it, before or after start. */
  visible?: boolean;
  /** Narrow the capabilities granted (called with those requested that this host can serve). */
  grant?: (requested: Capability[]) => Capability[];
  /** Saved state for this book object and learner, or null. Providing both grants `state`. */
  loadState?: (key: StateKey) => unknown | Promise<unknown>;
  saveState?: (key: StateKey, state: unknown) => void | Promise<void>;
  /** Forget saved state (on `reset()`). */
  clearState?: (key: StateKey) => void | Promise<void>;
  /**
   * The bytes of one of the book's assets, or null. Providing it grants `assets` (for `lab.assets` only).
   * The host sends the lab a copy, so returning the same cached buffer every time is fine (and lets the
   * host skip re-checking its hash).
   */
  getAsset?: (assetId: string) => Promise<{ type: string; bytes: ArrayBuffer } | null>;
  onProgress?: (progress: Progress) => void;
  /** The lab drew its first frame: hide the poster. */
  onReady?: () => void;
  /** The lab asks for full screen; return the state after deciding. */
  onFullscreen?: (on: boolean) => boolean | Promise<boolean>;
  /** The host stopped the lab: its document went away (it navigated), a lab id mismatch, no shared version. */
  onError?: (message: string) => void;
};

export type LabHost = {
  /** The lab's capabilities as granted. */
  readonly granted: readonly Capability[];
  /** Resolves when the lab has been sent `init`; rejects if the host stops or is disposed first. */
  readonly started: Promise<void>;
  setVisible(visible: boolean): void;
  setTheme(theme: Theme): void;
  setLocale(locale: string): void;
  /** Start over: forget saved state and tell the lab to return to its `params`. */
  reset(): Promise<void>;
  /** Stop talking to the lab, for good (e.g. the frame was removed). */
  dispose(): void;
};

class RequestError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}

/**
 * Run the host side of the Host API for one lab frame (spec/1.1/host-api.md).
 *
 * The window only carries the handshake: the lab's `hello`, and `init`, which hands the lab one end of a
 * private MessageChannel. Everything after that goes over the channel, so a document the frame navigates to
 * (which cannot have that port) gets nothing. The guard script prepareLabDocument puts ahead of the lab's
 * code reports `gone` when the lab's document goes away, and the host stops for good.
 */
export function createLabHost(o: LabHostOptions): LabHost {
  const events = o.events ?? (globalThis as unknown as MessageEvents);
  const key: StateKey = { labId: o.lab.id, major: majorVersion(o.lab.version) };
  const allowedAssets = new Set(o.lab.assets ?? []);
  const requested = [...new Set(o.lab.capabilities ?? [])].filter((c): c is Capability => (KNOWN_CAPABILITIES as readonly string[]).includes(c));
  const servable = requested.filter((c) => c === 'progress' || (c === 'state' ? !!(o.loadState && o.saveState) : !!o.getAsset));
  const granted = Object.freeze(o.grant ? o.grant(servable).filter((c) => servable.includes(c)) : servable);
  const has = (c: Capability) => granted.includes(c);
  /** The hash of each buffer the host app returned, so one it caches is hashed once, however many requests. */
  const hashes = new WeakMap<ArrayBuffer, Promise<string>>();
  const hashOf = (b: ArrayBuffer) => { let h = hashes.get(b); if (!h) { h = hashBytes(new Uint8Array(b)); hashes.set(b, h); } return h; };
  let theme: Theme = o.theme ?? 'light', locale = o.locale, visible = o.visible ?? true;
  let helloSeen = false, stopped = false, port: MessagePort | null = null;
  let settle!: { resolve: () => void; reject: (e: Error) => void };
  const started = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
  started.catch(() => {});   // a host that never awaits `started` is not an unhandled rejection

  const post = (msg: HostEvent | Reply, transfer: Transferable[] = []) => { if (port && !stopped) port.postMessage(msg, transfer); };
  const reply = (id: number, result: unknown, transfer?: Transferable[]) => post({ chalk: MARK, type: 'reply', id, ok: true, result }, transfer);
  const fail = (id: number, code: ErrorCode, message: string) => post({ chalk: MARK, type: 'reply', id, ok: false, error: { code, message } });
  function end() {
    stopped = true;
    events.removeEventListener('message', onWindowMessage);
    if (port) { port.onmessage = null; port.close(); }
  }
  function stop(message: string) {
    if (stopped) return;
    end();
    settle.reject(new Error(message));
    o.onError?.(message);
  }

  async function hello(msg: Record<string, unknown>, frame: PostTarget) {
    helloSeen = true;   // exactly one init: a resent hello is the lab not having heard us yet
    const api = Array.isArray(msg.api) && msg.api.includes(HOST_API_VERSION) ? HOST_API_VERSION : 0;
    const lab = msg.lab as { id?: unknown } | undefined;
    const base = { chalk: MARK, type: 'init' as const, locale, theme, reducedMotion: !!o.reducedMotion, mode: o.mode ?? 'interactive', visible };
    if (api === 0) {
      frame.postMessage({ ...base, api: 0, params: {}, granted: [], state: null }, '*');
      return stop(`lab ${o.lab.id} speaks no Host API version this host knows`);
    }
    if (!lab || lab.id !== o.lab.id) return stop(`lab says it is ${String(lab?.id)}, the book says ${o.lab.id}`);
    let state: unknown = null;
    // storage trouble is no reason for the student to stare at a poster: start fresh instead
    if (has('state')) state = await Promise.resolve().then(() => o.loadState!(key)).catch(() => null) ?? null;
    if (stopped) return;   // disposed, or the document went away, while state was loading
    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = (e) => onChannelMessage(e.data);
    frame.postMessage({ ...base, api, params: o.lab.params ?? {}, granted: [...granted], state, visible }, '*', [channel.port2]);
    settle.resolve();
  }

  function onWindowMessage(e: WindowMessage) {
    const frame = o.frame.contentWindow;
    if (stopped || !frame || !isMessage(e.data)) return;
    // an unloading document's message does not come from the frame: `gone` is known by its nonce, and is
    // never accepted from another live window
    if (e.data.type === 'gone' && e.data.nonce === o.nonce && (e.source === frame || !isLiveWindow(e.source))) {
      return stop(`lab ${o.lab.id} left its document (it navigated or was unloaded)`);
    }
    if (e.source !== frame) return;
    if (e.data.type === 'hello' && !helloSeen) void hello(e.data, frame);
    // nothing else is accepted on the window: after init the lab talks on its channel
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
        if (!got) throw new RequestError('not_found', `no bytes for ${id}`);
        // the lab gets bytes that are what the book says they are, or nothing
        if ((await hashOf(got.bytes)) !== id) throw new RequestError('not_found', `the bytes for ${id} do not match it`);
        // a copy is transferred: the host's own buffer stays usable (by the reader, and for the next request)
        const copy = got.bytes.slice(0);
        return { result: { type: got.type, bytes: copy }, transfer: [copy] };
      }
      case 'ui.fullscreen':
        return { result: { on: o.onFullscreen ? await o.onFullscreen(msg.on === true) : false } };
      default:
        throw new RequestError('unknown', `unknown request ${msg.type}`);
    }
  }

  function onChannelMessage(data: unknown) {
    if (stopped || !isMessage(data)) return;
    if (typeof data.id === 'number') {
      const id = data.id;
      request(data).then(({ result, transfer }) => reply(id, result, transfer), (err: unknown) => {
        if (err instanceof RequestError) fail(id, err.code, err.message);
        else fail(id, 'failed', err instanceof Error ? err.message : String(err));
      });
      return;
    }
    if (data.type === 'ready') o.onReady?.();
    else if (data.type === 'progress' && has('progress')) o.onProgress?.(progressOf(data));
    // anything else: a notice from a later version, ignored
  }
  events.addEventListener('message', onWindowMessage);

  return {
    granted,
    started,
    // before start these only change what `init` will say
    setVisible: (v) => { if (v !== visible) { visible = v; post({ chalk: MARK, type: 'visibility', visible: v }); } },
    setTheme: (t) => { theme = t; post({ chalk: MARK, type: 'theme', theme: t }); },
    setLocale: (l) => { locale = l; post({ chalk: MARK, type: 'locale', locale: l }); },
    async reset() { if (has('state')) await o.clearState?.(key); post({ chalk: MARK, type: 'reset' }); },
    dispose: () => { if (stopped) return; end(); settle.reject(new Error('disposed')); },
  };
}

/** A window that can still receive messages (not null, not closed). */
function isLiveWindow(w: unknown): boolean {
  return w != null && !(w as { closed?: boolean }).closed;
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
