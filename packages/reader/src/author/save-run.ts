/**
 * What a Save does, in steps a host can watch (`onSaveProgress`), and the guard that keeps two saves of one book from running at once.
 * Plain functions (no React) so each part is tested on its own.
 */

/** Where a save is: fetching the pictures the book uses, packing the .chalk, handing it to the host (`onSave`: its upload). */
export interface SaveProgress {
  phase: 'collecting' | 'packing' | 'handing-over';
  /** While collecting: how many of the book's assets are in hand, of how many. */
  done?: number;
  total?: number;
}

/**
 * One job at a time. A call made while one runs joins it (it gets the same promise, and the job does not start again); once it settles
 * (done or failed) the next call starts a new one.
 */
export function singleFlight<T>(): { run: (job: () => Promise<T>) => Promise<T>; busy: () => boolean } {
  let current: Promise<T> | null = null;
  return {
    busy: () => current !== null,
    run(job) {
      if (current) return current;
      // `current` is set before the job starts: a call made from inside it (a host's callback calling save() at once) joins, it does not start a second
      let settle!: { ok: (v: T) => void; fail: (e: unknown) => void };
      const p = new Promise<T>((ok, fail) => { settle = { ok, fail }; });
      current = p;
      const clear = () => { if (current === p) current = null; };
      p.then(clear, clear); // registered first, so the next call after this one settles already finds it free
      let started: Promise<T>;
      try { started = job(); } catch (e) { started = Promise.reject(e); }
      started.then(settle.ok, settle.fail);
      return p;
    },
  };
}

/** Calls `fn` at most once per `ms` (the latest value wins), and at once for the first call and for `flush()`; `cancel()` drops what is waiting. For a counter that ticks hundreds of times. */
export function throttled<A extends unknown[]>(fn: (...a: A) => void, ms: number, now: () => number = Date.now): ((...a: A) => void) & { flush: () => void; cancel: () => void } {
  let last = -Infinity;
  let pending: A | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => { timer = null; if (pending) { const a = pending; pending = null; last = now(); fn(...a); } };
  const t = ((...a: A) => {
    pending = a;
    const wait = last + ms - now();
    if (wait <= 0) { if (timer) { clearTimeout(timer); timer = null; } fire(); } else if (!timer) timer = setTimeout(fire, wait);
  }) as ((...a: A) => void) & { flush: () => void; cancel: () => void };
  t.flush = () => { if (timer) { clearTimeout(timer); timer = null; } fire(); };
  t.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } pending = null; };
  return t;
}

/**
 * Builds the book (`build`, which reports collecting and packing), then hands it on (`hand`). Reports `collecting` before anything is fetched,
 * so a host can show it at once; a failure in either step is thrown as it is (the caller keeps the unsaved mark).
 */
export async function runSave<R extends { bytes: Uint8Array }>(o: {
  build: (progress: (p: SaveProgress) => void) => Promise<R>;
  hand: (built: R) => Promise<void>;
  progress: (p: SaveProgress) => void;
}): Promise<R> {
  o.progress({ phase: 'collecting' });
  const built = await o.build(o.progress);
  o.progress({ phase: 'handing-over' });
  await o.hand(built);
  return built;
}

/** What a host can listen to while a save runs (the reader's `onSavingChange` and `onSaveProgress`). */
export interface HostSaveEvents {
  progress?: ((p: SaveProgress) => void) | undefined;
  change?: ((saving: boolean) => void) | undefined;
}

/**
 * Tells the host about a save, safely: a callback that throws is logged and never breaks the save; `saving` changes are balanced (a true is
 * always followed by one false, also when the reader goes away mid-save: `dispose()` sends it, and afterwards nothing more is sent, so an old
 * reader cannot clear the saving state of the one that replaced it).
 */
export function saveEvents(host: () => HostSaveEvents) {
  let alive = true;
  let saving = false;
  const call = (fn: () => void) => { try { fn(); } catch (e) { console.error('chalk reader: a save callback threw', e); } };
  return {
    start() { if (alive && !saving) { saving = true; call(() => host().change?.(true)); } },
    progress(p: SaveProgress) { if (alive) call(() => host().progress?.(p)); },
    end() { if (alive && saving) { saving = false; call(() => host().change?.(false)); } },
    dispose() { if (alive && saving) { saving = false; call(() => host().change?.(false)); } alive = false; },
    get alive() { return alive; },
  };
}

/** A button's action that does nothing while `busy()` says so (a button announced as disabled still gets clicks and Enter). */
export const ignoreWhile = (busy: () => boolean, fn: () => void) => () => { if (!busy()) fn(); };

/**
 * The host's view of a save, tied to the reader's life. `get()` always gives an emitter (made on first use, so a save started before the
 * reader's effects have run still reaches the host). `detach()` ends it one tick later: React's StrictMode unmounts and at once remounts, and
 * that `attach()` cancels the end, so the same emitter goes on; a real unmount runs it, and the host hears `false` once.
 */
export function saveHostLink(host: () => HostSaveEvents, schedule: (fn: () => void) => unknown = (fn) => setTimeout(fn, 0), cancel: (t: unknown) => void = (t) => clearTimeout(t as ReturnType<typeof setTimeout>)) {
  let ev: ReturnType<typeof saveEvents> | null = null;
  let timer: unknown = null;
  const get = () => (ev ??= saveEvents(host));
  return {
    get,
    attach() { if (timer !== null) { cancel(timer); timer = null; } get(); },
    detach(onEnded?: () => void) { timer = schedule(() => { timer = null; ev?.dispose(); ev = null; onEnded?.(); }); },
  };
}
