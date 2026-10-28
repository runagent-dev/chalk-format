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
      const p = job().finally(() => { if (current === p) current = null; });
      current = p;
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
