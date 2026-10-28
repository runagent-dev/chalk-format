import { describe, expect, it } from 'vitest';
import { runSave, singleFlight, throttled, type SaveProgress } from './save-run.js';

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
