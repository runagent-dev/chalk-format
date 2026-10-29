import { describe, expect, it } from 'vitest';
import { ignoreWhile, runSave, saveEvents, saveHostLink, singleFlight, throttled, type SaveProgress } from './save-run.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('one save at a time', () => {
  it('a call while one runs joins it: one job, the same promise, the same result', async () => {
    const f = singleFlight<boolean>();
    let starts = 0;
    let release!: (v: boolean) => void;
    const job = () => { starts++; return new Promise<boolean>((r) => (release = r)); };
    const a = f.run(job);
    expect(f.busy()).toBe(true);
    const b = f.run(job);
    const c = f.run(job);
    expect(b).toBe(a);
    expect(c).toBe(a);
    release(true);
    expect(await Promise.all([a, b, c])).toEqual([true, true, true]);
    expect(starts).toBe(1);
    expect(f.busy()).toBe(false);
  });

  it('after it ends, the next call starts a new one, also after a failure', async () => {
    const f = singleFlight<string>();
    await expect(f.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(f.busy()).toBe(false);
    expect(await f.run(async () => 'again')).toBe('again');
  });
});

describe('the steps of a save', () => {
  it('reports collecting at once, then packing, then handing over; the host\'s part runs last', async () => {
    const seen: string[] = [];
    const built = await runSave({
      progress: (p: SaveProgress) => seen.push(p.phase),
      build: async (pr) => { seen.push('build starts'); pr({ phase: 'collecting', done: 1, total: 2 }); pr({ phase: 'packing' }); return { bytes: new Uint8Array([1]) }; },
      hand: async () => { seen.push('hand'); },
    });
    expect(seen).toEqual(['collecting', 'build starts', 'collecting', 'packing', 'handing-over', 'hand']);
    expect(built.bytes.length).toBe(1);
  });

  it('a failure while building stops before the host is called; a failure in the host is thrown as it is', async () => {
    let handed = 0;
    await expect(runSave({ progress: () => {}, build: async () => { throw new Error('no pictures'); }, hand: async () => { handed++; } })).rejects.toThrow('no pictures');
    expect(handed).toBe(0);
    await expect(runSave({ progress: () => {}, build: async () => ({ bytes: new Uint8Array() }), hand: async () => { throw new Error('HTTP 500'); } })).rejects.toThrow('HTTP 500');
  });
});

describe('throttling the counter', () => {
  it('lets the first through, holds the rest to one per interval, keeps the latest, flush and cancel work', async () => {
    let t = 0;
    const calls: number[] = [];
    const f = throttled((n: number) => calls.push(n), 100, () => t);
    f(1); expect(calls).toEqual([1]);
    t = 10; f(2); t = 20; f(3); expect(calls).toEqual([1]);
    f.flush(); expect(calls).toEqual([1, 3]);
    t = 500; f(4); expect(calls).toEqual([1, 3, 4]);
    t = 510; f(5); f.cancel(); f.flush(); expect(calls).toEqual([1, 3, 4]); // cancelled: nothing arrives later
  });

  it('a held value is delivered when the interval is over, without another call', async () => {
    const calls: number[] = [];
    const f = throttled((n: number) => calls.push(n), 20);
    f(1); f(2);
    await new Promise((r) => setTimeout(r, 60));
    await tick();
    expect(calls).toEqual([1, 2]);
  });
});

describe('review findings, round 1', () => {
  it('a call made from inside the job (a host callback calling save() at once) joins it, it does not start a second', async () => {
    const f = singleFlight<boolean>();
    let starts = 0;
    let inner: Promise<boolean> | null = null;
    const outer = f.run(async () => { starts++; inner = f.run(async () => { starts++; return false; }); return true; });
    expect(inner).toBe(outer);
    expect(await outer).toBe(true);
    expect(await inner).toBe(true);
    expect(starts).toBe(1);
    expect(f.busy()).toBe(false);
    // a job that throws before its first await, and one that rejects, both release it
    await expect(f.run(() => { throw new Error('sync boom'); })).rejects.toThrow('sync boom');
    expect(f.busy()).toBe(false);
    await expect(f.run(() => Promise.reject(new Error('late boom')))).rejects.toThrow('late boom');
    expect(f.busy()).toBe(false);
    expect(await f.run(async () => true)).toBe(true);
  });

  it('a host callback that throws is logged and never breaks the save; the saving changes stay balanced', () => {
    const log: string[] = [];
    const err = console.error; console.error = () => log.push('logged');
    try {
      const ev = saveEvents(() => ({ change: (s) => { log.push(`change ${s}`); throw new Error('host bug'); }, progress: () => { throw new Error('host bug'); } }));
      ev.start(); ev.start(); ev.progress({ phase: 'packing' }); ev.end(); ev.end();
      expect(log.filter((l) => l.startsWith('change'))).toEqual(['change true', 'change false']); // once each, however often it is asked
      expect(log.filter((l) => l === 'logged').length).toBe(3);
    } finally { console.error = err; }
  });

  it('when the reader goes away mid-save the host hears false once, and the old reader is quiet afterwards', () => {
    const heard: string[] = [];
    const ev = saveEvents(() => ({ change: (s) => heard.push(`change ${s}`), progress: (p) => heard.push(`progress ${p.phase}`) }));
    ev.start(); ev.progress({ phase: 'collecting', done: 1, total: 9 });
    ev.dispose();
    ev.progress({ phase: 'packing' }); ev.end(); ev.start(); ev.dispose();
    expect(heard).toEqual(['change true', 'progress collecting', 'change false']);
    expect(ev.alive).toBe(false);
    // a reader that never saved says nothing when it goes away
    const quiet: string[] = [];
    saveEvents(() => ({ change: (s) => quiet.push(String(s)) })).dispose();
    expect(quiet).toEqual([]);
  });

  it('a busy button ignores what it is asked to do', () => {
    let busy = true; let n = 0;
    const go = ignoreWhile(() => busy, () => n++);
    go(); go(); expect(n).toBe(0);
    busy = false; go(); expect(n).toBe(1);
  });
});

describe('review findings, round 2: the host link', () => {
  const manual = () => { const q: (() => void)[] = []; return { schedule: (fn: () => void) => { q.push(fn); return q.length - 1; }, cancel: (i: unknown) => { q[i as number] = () => {}; }, flush: () => { for (const fn of q.splice(0)) fn(); } }; };

  it('a save that starts before the reader\'s effects have run still reaches the host', () => {
    const heard: string[] = [];
    const m = manual();
    const link = saveHostLink(() => ({ change: (s) => heard.push(`change ${s}`), progress: (p) => heard.push(p.phase) }), m.schedule, m.cancel);
    const ev = link.get();            // before attach()
    ev.start(); ev.progress({ phase: 'collecting' });
    link.attach();                    // the effect runs after; it keeps the same emitter
    expect(link.get()).toBe(ev);
    ev.end();
    expect(heard).toEqual(['change true', 'collecting', 'change false']);
  });

  it('StrictMode\'s unmount and immediate remount in the middle of a save changes nothing for the host', () => {
    const heard: string[] = [];
    const m = manual();
    const link = saveHostLink(() => ({ change: (s) => heard.push(`change ${s}`), progress: (p) => heard.push(p.phase) }), m.schedule, m.cancel);
    link.attach();
    const ev = link.get();
    ev.start();                       // a save begun in a mount effect
    link.detach(); link.attach();     // the fake unmount and remount
    m.flush();                        // nothing left to run: the end was cancelled
    expect(link.get()).toBe(ev);
    ev.progress({ phase: 'packing' }); ev.end();
    expect(heard).toEqual(['change true', 'packing', 'change false']);
  });

  it('a real unmount ends it a tick later: the host hears false once, then nothing', () => {
    const heard: string[] = [];
    const m = manual();
    const link = saveHostLink(() => ({ change: (s) => heard.push(`change ${s}`), progress: (p) => heard.push(p.phase) }), m.schedule, m.cancel);
    link.attach();
    const ev = link.get();
    ev.start();
    let ended = 0;
    link.detach(() => ended++);
    expect(heard).toEqual(['change true']);   // not yet: it waits to see whether a remount follows
    m.flush();
    expect(heard).toEqual(['change true', 'change false']);
    expect(ended).toBe(1);
    ev.progress({ phase: 'packing' }); ev.end();
    expect(heard).toEqual(['change true', 'change false']);
  });
});
