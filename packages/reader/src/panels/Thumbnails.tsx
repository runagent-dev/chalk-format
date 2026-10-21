import { memo, useEffect, useRef, useState } from 'react';
import { getPageSize, type LessonPage } from '@chalk-format/model';
import type { Book } from '../book.js';
import type { Locale } from '../config.js';
import { num, strings } from '../i18n.js';
import { useAssetUrl } from '../render/assets.js';
import { PageView, type HtmlObjectRenderer } from '../render/PageView.js';

const THUMB_W = 116;

/** Every page as a small picture: the book's own thumbnail when it has one, else the page drawn small. */
export function Thumbnails({ book, pages, current, locale, onPick, renderHtmlObject, pdfWorkerSrc }: {
  book: Book; pages: readonly LessonPage[]; current: number; locale: Locale; onPick: (i: number) => void;
  /** Must draw inert previews: a thumbnail is itself a button. */
  renderHtmlObject: HtmlObjectRenderer; pdfWorkerSrc?: string | null | undefined;
}) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' }); }, [current]);
  const t = strings(locale);
  return (
    <ol ref={list} className="chalk-thumbs">
      {pages.map((p, i) => (
        <li key={p.id}>
          <button type="button" data-index={i} className="chalk-thumb" aria-current={i === current ? 'page' : undefined} aria-label={`${t.page} ${num(locale, i + 1)}`} onClick={() => onPick(i)}>
            <Thumb book={book} page={p} renderHtmlObject={renderHtmlObject} pdfWorkerSrc={pdfWorkerSrc} />
            <span className="chalk-thumb-no">{num(locale, i + 1)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

const Thumb = memo(function Thumb({ book, page, renderHtmlObject, pdfWorkerSrc }: { book: Book; page: LessonPage; renderHtmlObject: HtmlObjectRenderer; pdfWorkerSrc?: string | null | undefined }) {
  const box = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const e = box.current; if (!e || seen) return;
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(e); return () => io.disconnect();
  }, [seen]);
  const bg = page.background;
  const thumbId = bg.type === 'pdf_page' ? bg.thumbnailAssetId : undefined;
  const url = useAssetUrl(book, seen ? thumbId : undefined);
  const { width, height } = getPageSize(page);
  const scale = THUMB_W / width;
  return (
    <span ref={box} className="chalk-thumb-pic" style={{ width: THUMB_W, height: Math.round(height * scale) }}>
      {seen && (thumbId
        ? url && <img src={url} alt="" draggable={false} />
        : <PageView book={book} page={page} scale={scale} live renderHtmlObject={renderHtmlObject} textLayer={false} pdfWorkerSrc={pdfWorkerSrc} />)}
    </span>
  );
});
