/**
 * The Chalk Host API, version 1 (spec/1.1/host-api.md): the messages a lab and the reader running it
 * (the host) exchange with postMessage. Shared by the host (host.ts) and the lab client (client.ts).
 */

export const HOST_API_VERSION = 1;
/** Every message carries `chalk: 1`; anything without it is not ours and is ignored. */
export const MARK = 1;

/** Capabilities defined in 1.1 (spec 1.1 §2.1). Others are ignored, never granted. */
export const KNOWN_CAPABILITIES = ['state', 'progress', 'assets'] as const;
export type Capability = (typeof KNOWN_CAPABILITIES)[number];

/** Largest saved state, serialised (host-api §4.1). */
export const STATE_MAX_BYTES = 64 * 1024;

export type Theme = 'light' | 'dark';
export type LabMode = 'interactive' | 'preview';

export type ErrorCode = 'denied' | 'not_found' | 'too_large' | 'invalid' | 'unknown' | 'failed';

export type Progress = { step?: { done: number; total: number }; score?: number; completed?: boolean };

// lab → host, on the window
export type Hello = { chalk: 1; type: 'hello'; api: number[]; lab: { id: string; version: string } };
/** Sent by the guard the host puts ahead of the lab's code when the lab's document goes away (spec 1.1 §3.3). */
export type Gone = { chalk: 1; type: 'gone' };
// lab → host, on the channel
export type ReadyNotice = { chalk: 1; type: 'ready' };
export type ProgressNotice = { chalk: 1; type: 'progress' } & Progress;
export type StateSave = { chalk: 1; type: 'state.save'; id: number; state: unknown };
export type AssetGet = { chalk: 1; type: 'asset.get'; id: number; assetId: string };
export type UiFullscreen = { chalk: 1; type: 'ui.fullscreen'; id: number; on: boolean };
export type LabRequest = StateSave | AssetGet | UiFullscreen;

// host → lab: init on the window, carrying the channel's port; everything else on the channel
export type Init = {
  chalk: 1; type: 'init'; api: number; params: Record<string, unknown>; locale: string; theme: Theme;
  reducedMotion: boolean; granted: Capability[]; state: unknown; mode: LabMode;
  /** Whether the lab is on screen now; until a `visibility` event says otherwise. */
  visible: boolean;
};
export type Reply =
  | { chalk: 1; type: 'reply'; id: number; ok: true; result: unknown }
  | { chalk: 1; type: 'reply'; id: number; ok: false; error: { code: ErrorCode; message: string } };
export type HostEvent =
  | Init
  | { chalk: 1; type: 'visibility'; visible: boolean }
  | { chalk: 1; type: 'theme'; theme: Theme }
  | { chalk: 1; type: 'locale'; locale: string }
  | { chalk: 1; type: 'reset' };

/** A message of ours: an object with `chalk: 1` and a string `type`. */
export function isMessage(data: unknown): data is { chalk: 1; type: string; id?: unknown } & Record<string, unknown> {
  return typeof data === 'object' && data !== null && (data as { chalk?: unknown }).chalk === MARK
    && typeof (data as { type?: unknown }).type === 'string';
}

/** `1.2.0` → `1`: saved state is kept per lab id and major version (host-api §4.1). */
export function majorVersion(version: string): string {
  const m = /^v?(\d+)/.exec(version.trim());
  return m ? m[1]! : version.trim();
}

/** Serialised size of a JSON value in bytes, or null when it is not JSON-serialisable. */
export function jsonBytes(value: unknown): number | null {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? null : new TextEncoder().encode(s).length;
  } catch {
    return null;
  }
}

/**
 * The window-like object both sides talk through. A browser `Window` fits; tests use fakes.
 * `postMessage(message, targetOrigin, transfer)`, as on Window.
 */
export type PostTarget = {
  postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
};
export type WindowMessage = { data: unknown; source: unknown; ports?: readonly MessagePort[] };
export type MessageEvents = {
  addEventListener(type: 'message', listener: (e: WindowMessage) => void): void;
  removeEventListener(type: 'message', listener: (e: WindowMessage) => void): void;
};
