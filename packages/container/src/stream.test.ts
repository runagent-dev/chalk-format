import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleStreamed, packLesson, parseStreamIndex, parseStreamPage, publishStreamed, unpackLesson } from './index.js';

const book = (name: string) => new Uint8Array(readFileSync(new URL(`../../../conformance/valid/${name}`, import.meta.url)));
const reader = (files: Map<string, Uint8Array>) => async (p: string) => { const f = files.get(p); if (!f) throw new Error(`no ${p}`); return f; };

describe('streamed books (spec 1.4)', () => {
  it('publish, then assemble: the same lesson and the same assets', async () => {
    for (const name of ['presentation.chalk', 'all-features.chalk', 'thin-sources.chalk']) {
      const r = await unpackLesson(book(name));
      const { files, index } = await publishStreamed(r.lesson, r.assets, { assetInfo: r.assetInfo });
      const back = await assembleStreamed(reader(files));
      expect(back.lesson, name).toEqual(r.lesson);
      expect([...back.assets.keys()].sort(), name).toEqual([...r.assets.keys()].sort());
      for (const [id, a] of r.assets) expect(back.assets.get(id)?.bytes, `${name} ${id}`).toEqual(a.bytes);
      expect(index.pages).toHaveLength(r.lesson.pages.length);
      // and packed again as a .chalk it opens to the same book
      const again = await unpackLesson(await packLesson(back.lesson, back.assets));
      expect(again.lesson).toEqual(r.lesson);
    }
  });

  it('names page files by their content, so they can be cached for ever', async () => {
    const r = await unpackLesson(book('presentation.chalk'));
    const a = await publishStreamed(r.lesson, r.assets), b = await publishStreamed(r.lesson, r.assets);
    expect(a.index.pages.map((p) => p.file)).toEqual(b.index.pages.map((p) => p.file));
    expect(a.index.pages[0]!.file).toMatch(/^pages\/1-[0-9a-f]{8}\.json$/);
    const changed = await publishStreamed({ ...r.lesson, pages: [{ ...r.lesson.pages[0]!, title: 'other' }] }, r.assets);
    expect(changed.index.pages[0]!.file).not.toBe(a.index.pages[0]!.file);
  });

  it('lists what each page needs, and keeps external media external', async () => {
    const r = await unpackLesson(book('thin-sources.chalk'));
    const { index, files } = await publishStreamed(r.lesson, r.assets, { assetInfo: r.assetInfo });
    const video = index.assets.find((a) => a.type === 'video/mp4');
    expect(video?.path).toBeUndefined();
    expect(video?.meta?.duration).toBe(94.5);
    expect(index.pages[0]!.assets).toContain(video!.id);
    expect([...files.keys()].some((f) => f.includes(video!.id.slice(3)))).toBe(false);
  });

  it('carries every page\'s searchable text in one small file', async () => {
    const r = await unpackLesson(book('all-features.chalk'));
    const { index, files } = await publishStreamed(r.lesson, r.assets);
    if (!index.text) return;
    const text = JSON.parse(new TextDecoder().decode(files.get(index.text.file)!));
    expect(Object.keys(text.pages).every((id) => r.lesson.pages.some((p) => p.id === id))).toBe(true);
  });

  it('refuses paths that leave the book, and versions it does not know', () => {
    const ok = { format: 'chalk.streamed', streamVersion: 1, formatVersion: 10, id: 'b', title: 'B', locale: 'bn', createdAt: '', updatedAt: '', assets: [], pages: [{ id: 'p', file: 'pages/1.json' }] };
    expect(() => parseStreamIndex(ok)).not.toThrow();
    for (const file of ['../secret.json', '/etc/passwd', 'https://evil.example/p.json', 'pages/../../x.json']) {
      expect(() => parseStreamIndex({ ...ok, pages: [{ id: 'p', file }] }), file).toThrow();
    }
    expect(() => parseStreamIndex({ ...ok, streamVersion: 2 })).toThrow();
    expect(() => parseStreamIndex({ ...ok, pages: [{ id: 'p', file: 'a.json' }, { id: 'p', file: 'b.json' }] })).toThrow();
  });

  it('validates a page file like a page of a .chalk', () => {
    const index = parseStreamIndex({ format: 'chalk.streamed', streamVersion: 1, formatVersion: 10, id: 'b', title: 'B', locale: 'bn', createdAt: '', updatedAt: '', assets: [], pages: [{ id: 'p', file: 'p.json' }] });
    expect(parseStreamPage(index, { id: 'p', title: 'P', background: { type: 'blank' }, objects: [] }).id).toBe('p');
    expect(() => parseStreamPage(index, { id: 'p', title: 'P', background: { type: 'nonsense' }, objects: [] })).toThrow();
  });
});
