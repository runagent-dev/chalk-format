import { useEffect, useRef, type ReactNode } from 'react';
import { XIcon } from '@phosphor-icons/react';

/**
 * A side sheet (wide readers) or a bottom sheet (phone-width readers): the switch is a container query on
 * the reader, so a host embedding it in a narrow column gets the phone form. Not modal: the book stays
 * usable beside it. Escape closes it.
 */
export function Panel({ title, closeLabel, onClose, children, actions }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && ref.current?.contains(document.activeElement)) { e.stopPropagation(); onClose(); } };
    addEventListener('keydown', onKey, true); return () => removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <aside ref={ref} className="chalk-panel" aria-label={title}>
      <header className="chalk-panel-head">
        <h2>{title}</h2>
        {actions}
        <button type="button" className="chalk-icon-btn" aria-label={closeLabel} onClick={onClose}><XIcon size={18} weight="bold" /></button>
      </header>
      <div className="chalk-panel-body">{children}</div>
    </aside>
  );
}
