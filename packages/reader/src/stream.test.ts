import { describe, expect, it } from 'vitest';
import { publishStreamed } from '@chalk-format/container';
import type { Lesson } from '@chalk-format/model';
import { openStreamedBook, windowAround } from './stream.js';

const page = (i: number) => ({ id: `p${i}`, title: `Page ${i}`, background: { type: 'blank' as const }, objects: [], textLayer: [{ text: `word${i}`, x: 0, y: 0, width: 50, fontSize: 12 }] });
const lesson: Lesson = { id: 'big', title: 'Big', locale: 'bn', createdAt: '', updatedAt: '', snipPages: [], pages: Array.from({ length: 40 }, (_, i) => page(i)) };

/** A fake web server over the published files; records what was asked for, and can hold answers back. */
async function server() {
  const { files } = await publishStreamed(lesson);
  const asked: string[] = [];
  let hold: (() => void)[] | null = null;
  const fetch = (async (url: string) => {
    const path = new URL(url).pathname.replace(/^\/books\/big\//, '');
    asked.push(path);
    if (hold) await new Promise<void>((r) => hold!.push(r));
    const f = files.get(path);
    return f ? new Response(f as unknown as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, asked, holdAll: () => { hold = []; }, release: () => { const h = hold ?? []; hold = null; h.forEach((r) => r()); } };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

/** A web server with a delay per file, that counts how many requests are in flight at once, and can fail some files. */
async function slowServer(o: { delay?: (path: string) => number; fail?: (path: string) => boolean } = {}) {
  const { files } = await publishStreamed(lesson);
  const state = { inFlight: 0, maxInFlight: 0 };
  const fetch = (async (url: string) => {
    const path = new URL(url).pathname.replace(/^\/books\/big\//, '');
    state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      const ms = o.delay?.(path) ?? 0;
      if (ms) await new Promise((r) => setTimeout(r, ms));
      if (o.fail?.(path)) return new Response(null, { status: 500 });
      const f = files.get(path);
      return f ? new Response(f as unknown as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
    } finally { state.inFlight--; }
  }) as unknown as typeof globalThis.fetch;
  return { fetch, state };
}
const pageNumber = (path: string) => Number(/^pages\/(\d+)-/.exec(path)?.[1] ?? -1);

describe('streamed books in the reader (spec 1.4 §5)', () => {
  it('orders a window nearest first, inside the book', () => {
    expect(windowAround(10, 40, 2)).toEqual([10, 11, 9, 12, 8]);
    expect(windowAround(0, 40, 2)).toEqual([0, 1, 2]);
  });

  it('knows its version: the SHA-256 of the exact book.json bytes it opened', async () => {
    const { files } = await publishStreamed(lesson);
    const raw = files.get('book.json')!;
    const want = `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', raw as unknown as ArrayBuffer))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const s = await server();
    const b = await openStreamedBook('https://cdn.example/books/big/', { fetch: s.fetch });
    expect(b.version).toBe(want);
  });

  it('learns where files the host gained since it was opened are, without replacing the lesson', async () => {
    const s = await server();
    const b = await openStreamedBook('https://cdn.example/books/big/', { fetch: s.fetch });
    expect(b.peekUrl('c1:newmedia')).toBeUndefined();
    const lessonBefore = b.lesson;
    let told = 0; b.subscribe(() => told++);
    b.addAssets([{ id: 'c1:newmedia', type: 'image/png', path: 'assets/c1_newmedia' }]);
    expect(b.peekUrl('c1:newmedia')).toBe('https://cdn.example/books/big/assets/c1_newmedia');
    expect(await b.assetUrl('c1:newmedia')).toBe('https://cdn.example/books/big/assets/c1_newmedia');
    expect(b.lesson).toBe(lessonBefore); // an editor that follows the book's lesson must not be handed the original again
    expect(told).toBe(0);
  });

  it('shows the book from its index alone: every page there, none loaded', async () => {
    const s = await server();
    const b = await openStreamedBook('https://cdn.example/books/big/', { fetch: s.fetch });
    expect(b.lesson.pages).toHaveLength(40);
    expect(s.asked).toEqual(['book.json']);
    expect(b.isLoaded('p0')).toBe(false);
  });

  it('loads only what is wanted, at most 6 at a time, and drops what is no longer wanted', async () => {
    const s = await server();
    const b = await openStreamedBook('https://cdn.example/books/big/', { fetch: s.fetch });
    s.holdAll();
    b.want(windowAround(20, 40, 5));
    await settle();
    expect(s.asked.slice(1)).toHaveLength(6);
    expect(s.asked[1]).toMatch(/^pages\/21-/);   // the current page first (page 21 is index 20)
    // a jump: what was queued for the old window is dropped
    b.want(windowAround(2, 40, 1));
    s.release(); await settle(); await settle();
    const fetched = s.asked.slice(1).map((p) => Number(/pages\/(\d+)-/.exec(p)![1]));
    expect(fetched.slice(0, 6)).toEqual([21, 22, 20, 23, 19, 24]);
    expect(fetched.slice(6).sort((x, y) => x - y)).toEqual([2, 3, 4]);
    expect(b.isLoaded('p2') && b.isLoaded('p20')).toBe(true);
    expect(b.isLoaded('p30')).toBe(false);
  });

  it('tells the reader when pages arrive, with a new lesson each time', async () => {
    const s = await server();
    const b = await openStreamedBook('https://cdn.example/books/big/book.json', { fetch: s.fetch });
    const before = b.lesson;
    let calls = 0; b.subscribe(() => calls++);
    b.want([5]); await settle();
    expect(calls).toBe(1);
    expect(b.lesson).not.toBe(before);
    expect(b.lesson.pages[5]!.textLayer?.[0]?.text).toBe('word5');
  });

  it('searches every page through the text file, without loading the pages', async () => {
    const s = await server();
    const b = await openStreamedBook('https://cdn.example/books/big/', { fetch: s.fetch });
    const text = await b.searchText();
    expect(text?.pages.p33?.[0]?.text).toBe('word33');
    expect(s.asked.filter((p) => p.startsWith('pages/'))).toEqual([]);
  });

  it('loads everything for author mode', async () => {
    const s = await server();
    const b = await openStreamedBook('https://cdn.example/books/big/', { fetch: s.fetch });
    await b.loadAll();
    expect(b.complete).toBe(true);
  });

  describe('loading the whole book for author mode', () => {
    it('does not let one slow page hold up the pages after it (no waiting for the slowest of a batch)', async () => {
      const s = await slowServer({ delay: (p) => (pageNumber(p) === 2 ? 300 : 5) });
      const b = await openStreamedBook('https://cdn.example/books/big/', { fetch: s.fetch });
      const all = b.loadAll({ concurrency: 3 });
      await new Promise((r) => setTimeout(r, 120));
      // page 2 (p1) is still in its 300 ms; with batches of 3 nothing past the first batch could have started
      expect(b.isLoaded('p0')).toBe(true);
      expect(b.isLoaded('p1')).toBe(false);
      expect(b.loadedPages).toBeGreaterThan(10);
      await all;
      expect(b.complete).toBe(true);
    });

    it('keeps at most `concurrency` requests in flight, and uses all of them', async () => {
      const s = await slowServer({ delay: () => 15 });
      const b = await openStreamedBook('https://cdn.example/books/big/', { fetch: s.fetch });
      await b.loadAll({ concurrency: 5 });
      expect(s.state.maxInFlight).toBe(5);
      const s2 = await slowServer({ delay: () => 15 });
      const b2 = await openStreamedBook('https://cdn.example/books/big/', { fetch: s2.fetch });
      await b2.loadAll();   // the default is 12
      expect(s2.state.maxInFlight).toBe(12);
    });

    it('counts its progress from none to every page', async () => {
      const s = await slowServer({ delay: () => 5 });
      const b = await openStreamedBook('https://cdn.example/books/big/', { fetch: s.fetch });
      expect([b.loadedPages, b.totalPages]).toEqual([0, 40]);
      const seen: number[] = [];
      b.subscribe(() => seen.push(b.loadedPages));
      await b.loadAll({ concurrency: 4 });
      expect(seen.length).toBe(40);
      expect(seen).toEqual([...seen].sort((x, y) => x - y));   // never goes back
      expect(seen.at(-1)).toBe(40);
      expect([b.loadedPages, b.totalPages]).toEqual([40, 40]);
    });

    it('rejects when a page cannot be loaded, and keeps the others', async () => {
      const s = await slowServer({ fail: (p) => pageNumber(p) === 7 });
      const b = await openStreamedBook('https://cdn.example/books/big/', { fetch: s.fetch });
      await expect(b.loadAll()).rejects.toThrow('could not be loaded');
      expect(b.isLoaded('p6')).toBe(false);   // page 7 is index 6
      expect(b.loadedPages).toBe(39);
      expect(b.complete).toBe(false);
    });

    it('leaves the reading window as it was: still 6 at a time, nearest first, even after a loadAll', async () => {
      const s = await slowServer({ delay: () => 30 });
      const b = await openStreamedBook('https://cdn.example/books/big/', { fetch: s.fetch });
      b.want(windowAround(20, 40, 8));
      await new Promise((r) => setTimeout(r, 10));
      expect(s.state.maxInFlight).toBe(6);
      await new Promise((r) => setTimeout(r, 400));
      expect(s.state.maxInFlight).toBe(6);
      await b.loadAll();   // the rest, with the larger pool
      expect(b.complete).toBe(true);
    });
  });
});
