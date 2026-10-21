import { useEffect, useRef } from 'react';
import { CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react';
import type { Locale } from '../config.js';
import { num, strings } from '../i18n.js';
import type { Hit } from '../search.js';

/** The search box and the results, grouped by page; the current hit is also highlighted on the page. */
export function Search({ locale, query, onQuery, hits, current, onPick, onStep }: {
  locale: Locale; query: string; onQuery: (q: string) => void; hits: Hit[]; current: number;
  onPick: (i: number) => void; onStep: (dir: 1 | -1) => void;
}) {
  const t = strings(locale);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }); }, [current]);

  let lastPage = -1;
  return (
    <div className="chalk-search">
      <div className="chalk-search-bar">
        <input
          ref={input} type="search" className="chalk-input" value={query} placeholder={t.searchPlaceholder} aria-label={t.search}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onStep(e.shiftKey ? -1 : 1); } }}
        />
        <button type="button" className="chalk-icon-btn" aria-label="↑" disabled={!hits.length} onClick={() => onStep(-1)}><CaretUpIcon size={18} weight="bold" /></button>
        <button type="button" className="chalk-icon-btn" aria-label="↓" disabled={!hits.length} onClick={() => onStep(1)}><CaretDownIcon size={18} weight="bold" /></button>
      </div>
      <p className="chalk-search-status" role="status">
        {query.trim() ? (hits.length ? `${num(locale, current + 1)} / ${num(locale, hits.length)}` : t.noResults) : ''}
      </p>
      <ol ref={list} className="chalk-results">
        {hits.map((h, i) => {
          const head = h.page !== lastPage; lastPage = h.page;
          const before = h.line.slice(Math.max(0, h.start - 40), h.start), after = h.line.slice(h.end, h.end + 60);
          return (
            <li key={i}>
              {head && <span className="chalk-results-page">{t.page} {num(locale, h.page + 1)}</span>}
              <button type="button" className="chalk-result" aria-current={i === current} onClick={() => onPick(i)}>
                {h.start > 40 && '…'}{before}<mark>{h.line.slice(h.start, h.end)}</mark>{after}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
