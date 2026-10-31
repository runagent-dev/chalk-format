import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lesson } from '@chalk-format/model';
import type { Library } from '@chalk-format/store';
import { bookFrom, type Book } from './book.js';
import { newLookup, withLibraries } from './libraries.js';
import { mediaRenewer, RENEW_DELAY_MS } from './render/assets.js';

const lesson: Lesson = { id: 'b', title: 'B', locale: 'bn', createdAt: '', updatedAt: '', snipPages: [], pages: [] };

/** A host resolver handing out signed links (`/v1/assets/{key}/link`): each call a new one, as the library signs a new link each time. */
function signer() {
  let n = 0;
  const resolve = vi.fn(async (id: string) => `https://lib.example/files/${id}?sig=${++n}`);
  return { resolve };
}

describe('a book renews a URL that failed to draw', () => {
  it("asks the host's resolver again: a new signed link replaces the expired one, for every element that drew it", async () => {
    const s = signer();
    const book = bookFrom(lesson, new Map(), [], s.resolve);
    const first = await book.assetUrl('c1:pic');
    expect(first).toMatch(/sig=1$/);
    const renewed = await book.renewUrl!('c1:pic', first!);
    expect(renewed).toMatch(/sig=2$/);
    expect(book.peekUrl('c1:pic')).toBe(renewed);
    expect(await book.assetUrl('c1:pic')).toBe(renewed);
    // a second element that drew the expired link: the new one, not a third signature
    expect(await book.renewUrl!('c1:pic', first!)).toBe(renewed);
    expect(s.resolve).toHaveBeenCalledTimes(2);
  });

  it('two elements failing on the same URL at once: one new resolution', async () => {
    const s = signer();
    const book = bookFrom(lesson, new Map(), [], s.resolve);
    const first = (await book.assetUrl('c1:pic'))!;
    const [a, b] = await Promise.all([book.renewUrl!('c1:pic', first), book.renewUrl!('c1:pic', first)]);
    expect(a).toBe(b);
    expect(s.resolve).toHaveBeenCalledTimes(2);
  });

  it('asks again for an asset whose resolution failed, never for one that is not available', async () => {
    let calls = 0;
    const flaky = bookFrom(lesson, new Map(), [], async () => { if (++calls === 1) throw new Error('offline'); return 'https://lib.example/files/x'; });
    expect(await flaky.assetUrl('c1:x')).toBeNull();
    expect(await flaky.renewUrl!('c1:x', null)).toBe('https://lib.example/files/x');
    let asked = 0;
    const none = bookFrom(lesson, new Map(), [], () => { asked++; return null; });
    expect(await none.assetUrl('c1:y')).toBeNull();
    expect(await none.renewUrl!('c1:y', null)).toBeNull();
    expect(asked).toBe(1);
  });

  it("hands out an asset's bytes from a renewed link when the first one has expired", async () => {
    const s = signer();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => (String(u).endsWith('sig=1') ? new Response('expired', { status: 403 }) : new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
    try {
      const book = bookFrom(lesson, new Map(), [], s.resolve);
      expect(new Uint8Array((await book.assetBytes('c1:pic'))!.bytes)).toEqual(new Uint8Array([1, 2, 3]));
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { fetch.mockRestore(); }
  });

  it('through the connected libraries: a URL a library gave that failed is forgotten there and asked again', async () => {
    let dir = 'a';
    const forget = vi.fn();
    const lib = { id: 'l', name: 'L', kind: 'registry', writable: false, url: vi.fn(async (k: string) => `https://cdn.example/${dir}/${k}`), forget, get: async () => null } as unknown as Library;
    const book = withLibraries(bookFrom(lesson, new Map()), [lib], newLookup());
    const first = await book.assetUrl('c1:pic');
    expect(first).toBe('https://cdn.example/a/c1:pic');
    dir = 'b';
    expect(await book.renewUrl!('c1:pic', first!)).toBe('https://cdn.example/b/c1:pic');
    expect(forget).toHaveBeenCalledWith('c1:pic');
    expect(book.peekUrl('c1:pic')).toBe('https://cdn.example/b/c1:pic');
  });
});

describe('an element whose media failed to load', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** A fake book whose resolver gives the URLs listed, one per call. */
  const fakeBook = (answers: (string | null)[]) => {
    const renewUrl = vi.fn(async () => answers.shift() ?? null);
    return { book: { renewUrl } as unknown as Book, renewUrl };
  };

  it('the first URL 404s: after a short wait the book is asked once, and the src is swapped once', async () => {
    vi.useFakeTimers();
    const { book, renewUrl } = fakeBook(['https://cdn.example/b/pic']);
    const set = vi.fn();
    const r = mediaRenewer(book, 'c1:pic', set);
    r.failed('https://cdn.example/a/pic');
    r.failed('https://cdn.example/a/pic');   // the same failure reported twice (an <img> and its <source>)
    await vi.advanceTimersByTimeAsync(RENEW_DELAY_MS - 1);
    expect(renewUrl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renewUrl).toHaveBeenCalledTimes(1);
    expect(renewUrl).toHaveBeenCalledWith('c1:pic', 'https://cdn.example/a/pic');
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('https://cdn.example/b/pic');
  });

  it('a second failure, of the renewed URL before it ever loaded, does not loop', async () => {
    vi.useFakeTimers();
    const { book, renewUrl } = fakeBook(['https://cdn.example/b/pic', 'https://cdn.example/c/pic']);
    const set = vi.fn();
    const r = mediaRenewer(book, 'c1:pic', set);
    r.failed('https://cdn.example/a/pic');
    await vi.advanceTimersByTimeAsync(RENEW_DELAY_MS);
    r.failed('https://cdn.example/b/pic');
    await vi.advanceTimersByTimeAsync(RENEW_DELAY_MS * 10);
    expect(renewUrl).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('a renewed URL that loaded may be renewed again later (a signed link that expires while a long video plays)', async () => {
    vi.useFakeTimers();
    const { book, renewUrl } = fakeBook(['https://lib.example/v?sig=2', 'https://lib.example/v?sig=3']);
    const set = vi.fn();
    const r = mediaRenewer(book, 'c1:video', set);
    r.failed('https://lib.example/v?sig=1');
    await vi.advanceTimersByTimeAsync(RENEW_DELAY_MS);
    r.loaded();
    r.failed('https://lib.example/v?sig=2');
    await vi.advanceTimersByTimeAsync(RENEW_DELAY_MS);
    expect(renewUrl).toHaveBeenCalledTimes(2);
    expect(set.mock.calls).toEqual([['https://lib.example/v?sig=2'], ['https://lib.example/v?sig=3']]);
  });

  it('the same URL again changes nothing, and an element that went away is not updated', async () => {
    vi.useFakeTimers();
    const same = fakeBook(['https://cdn.example/a/pic']);
    const set = vi.fn();
    mediaRenewer(same.book, 'c1:pic', set).failed('https://cdn.example/a/pic');
    await vi.advanceTimersByTimeAsync(RENEW_DELAY_MS);
    expect(set).not.toHaveBeenCalled();
    const gone = fakeBook(['https://cdn.example/b/pic']);
    const r = mediaRenewer(gone.book, 'c1:pic', set);
    r.failed('https://cdn.example/a/pic');
    r.stop();
    await vi.advanceTimersByTimeAsync(RENEW_DELAY_MS);
    expect(gone.renewUrl).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('with a real book: the expired link is swapped for a new one once', async () => {
    vi.useFakeTimers();
    const s = signer();
    const book = bookFrom(lesson, new Map(), [], s.resolve);
    const first = (await book.assetUrl('c1:pic'))!;
    const set = vi.fn();
    const r = mediaRenewer(book, 'c1:pic', set);
    r.failed(first);
    await vi.advanceTimersByTimeAsync(RENEW_DELAY_MS);
    expect(set.mock.calls).toEqual([[expect.stringMatching(/sig=2$/)]]);
    r.failed(set.mock.calls[0]![0] as string);
    await vi.advanceTimersByTimeAsync(RENEW_DELAY_MS * 5);
    expect(s.resolve).toHaveBeenCalledTimes(2);
  });
});
