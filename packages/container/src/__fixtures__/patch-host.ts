import type { Lesson, LessonObject, LessonPage, StreamText } from '@chalk-format/model';
import {
  applyStreamPatch, assembleStreamed, mergeBook, pageHashes, pagesNeeded, parseStreamIndex, parseStreamPage, parseStreamText, publishStreamed,
  type BookPatch, type MergeResult, type PatchResult,
} from '../index.js';

/** Test helpers for the patch save: small books, and a host that does what a real host does (read what is needed, merge, apply, write files then book.json). */
export const text = (id: string, t = 'hello', over: Record<string, unknown> = {}): LessonObject => ({ id, type: 'text', x: 10, y: 10, text: t, fontSize: 20, fill: '#000000', ...over }) as LessonObject;
export const page = (id: string, objects: LessonObject[] = [], over: Record<string, unknown> = {}): LessonPage => ({ id, title: `Page ${id}`, background: { type: 'blank' }, objects, width: 100, height: 100, ...over }) as LessonPage;
export const lessonOf = (pages: LessonPage[], snipPages: LessonPage[] = [], over: Record<string, unknown> = {}): Lesson =>
  ({ id: 'book', title: 'A book', locale: 'bn', pages, snipPages, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over }) as Lesson;

/** The host in a test: a store of files, and the whole patch save (read what is needed, merge, apply, write files then book.json). */
export class Host {
  files = new Map<string, Uint8Array>();
  version = '';
  static async open(lesson: Lesson, assets = new Map<string, { type: string; bytes: Uint8Array }>()): Promise<Host> {
    const h = new Host();
    const { files } = await publishStreamed(lesson, assets);
    h.files = new Map(files);
    h.version = await sha(h.files.get('book.json')!);
    return h;
  }
  get index() { return parseStreamIndex(JSON.parse(new TextDecoder().decode(this.files.get('book.json')!))); }
  get text(): StreamText | null { const f = this.index.text?.file; return f ? parseStreamText(JSON.parse(new TextDecoder().decode(this.files.get(f)!))) : null; }
  page(id: string): LessonPage {
    const idx = this.index; const snip = !idx.pages.some((p) => p.id === id);
    const e = [...idx.pages, ...(idx.snipPages ?? [])].find((p) => p.id === id)!;
    return parseStreamPage(idx, JSON.parse(new TextDecoder().decode(this.files.get(e.file)!)), snip);
  }
  async lesson(): Promise<Lesson> { return (await assembleStreamed(async (p) => this.files.get(p)!)).lesson; }
  /** What an editor that opened this book sees: its lesson, its hashes and its version id. */
  async editor() { return { version: this.version, lesson: await this.lesson(), hashes: pageHashes(this.index) }; }
  async save(patch: BookPatch, media = new Map<string, { type: string; bytes: Uint8Array }>(), now = '2026-02-01T00:00:00.000Z', restore?: ReadonlyMap<string, { type: string; size?: number }>): Promise<{ merge: MergeResult; result: PatchResult; written: string[] }> {
    const idx = this.index;
    const pages = new Map(pagesNeeded(patch, idx).map((id) => [id, this.page(id)]));
    const merge = mergeBook(patch, { index: idx, pages });
    const applied = await applyStreamPatch({ index: idx, text: this.text }, merge, media, { now, ...(patch.expects ? { expects: patch.expects } : {}), ...(restore ? { restore } : {}) });
    const written = [...applied.files.keys()];
    for (const [p, b] of applied.files) this.files.set(p, b);
    if (!applied.result.unchanged) this.files.set('book.json', applied.indexBytes); // the index goes last
    this.version = applied.result.version;
    return { merge, result: applied.result, written };
  }
}
export async function sha(bytes: Uint8Array) { return `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))].map((b) => b.toString(16).padStart(2, '0')).join('')}`; }
