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
});
