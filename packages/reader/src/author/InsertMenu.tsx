import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MEDIA } from './AuthorRail.js';
import type { MediaKind } from './insert.js';
import type { AuthorStrings } from './i18n.js';

/**
 * Where a menu opened at `at` (px, inside the box it floats over) is drawn so that it stays inside that box: pushed left
 * when it would run off the right edge, and flipped above the pointer when there is no room below.
 */
export function menuPosition(at: { x: number; y: number }, menu: { width: number; height: number }, box: { width: number; height: number }, margin = 8) {
  const left = Math.max(margin, Math.min(at.x, box.width - menu.width - margin));
  const top = at.y + menu.height + margin > box.height ? Math.max(margin, at.y - menu.height) : at.y;
  return { left, top };
}

/**
 * The right-click menu of author mode: what can be added where the author clicked. Choosing one opens that media's picker in
 * the sidebar, and what is picked is placed at the clicked point. It floats over the reader (`at` is in px from the reader's
 * top left) and closes on Escape, on a click elsewhere, on scrolling or when the window changes.
 */
export function InsertMenu({ at, onPick, onClose, t }: { at: { x: number; y: number }; onPick: (kind: MediaKind) => void; onClose: () => void; t: AuthorStrings }) {
  const el = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  // where focus was, to give it back when the menu is dismissed (not when something was picked: the picker takes focus then)
  const before = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);

  useLayoutEffect(() => {
    const m = el.current, box = m?.parentElement;
    if (!m || !box) return;
    setPos(menuPosition(at, { width: m.offsetWidth, height: m.offsetHeight }, { width: box.clientWidth, height: box.clientHeight }));
    m.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [at]);

  useEffect(() => {
    const away = (e: Event) => { if (!el.current?.contains(e.target as Node)) onClose(); };
    addEventListener('pointerdown', away, true);
    addEventListener('wheel', onClose, { passive: true, capture: true });
    addEventListener('resize', onClose); addEventListener('blur', onClose);
    return () => {
      removeEventListener('pointerdown', away, true); removeEventListener('wheel', onClose, true);
      removeEventListener('resize', onClose); removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const move = useCallback((step: number | 'first' | 'last') => {
    const items = [...(el.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[step === 'first' ? 0 : step === 'last' ? items.length - 1 : (i + step + items.length) % items.length]?.focus();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === 'ArrowDown') move(1); else if (k === 'ArrowUp') move(-1); else if (k === 'Home') move('first'); else if (k === 'End') move('last');
    else if (k === 'Escape' || k === 'Tab') { onClose(); (before.current as HTMLElement | null)?.focus?.({ preventScroll: true }); }
    // Space and Enter press the item: the button's own default, kept from the reader's keys (Space turns the page in single layout)
    else if (k === ' ' || k === 'Enter') { e.stopPropagation(); return; }
    else return;
    e.preventDefault(); e.stopPropagation();
  };

  return (
    <div ref={el} className="chalk-insert-menu" role="menu" aria-label={t.addHere} style={{ left: pos.left, top: pos.top }} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()}>
      <div className="chalk-insert-menu-title" role="presentation">{t.addHere}</div>
      {MEDIA.map((m) => (
        <button key={m.kind} type="button" role="menuitem" className="chalk-rail-item" onClick={() => onPick(m.kind)}>
          {m.icon}<span>{t[m.kind]}</span>
        </button>
      ))}
    </div>
  );
}
