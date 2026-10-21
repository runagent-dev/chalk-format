import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from '@phosphor-icons/react';

/**
 * A dialog over the reader (icon-mode media, snip pages): Escape or the backdrop closes it, focus moves in
 * and comes back to what opened it. Rendered into the reader's own root, so its theme tokens apply.
 */
export function Modal({ title, closeLabel, onClose, children, container, wide, full }: {
  title: string; closeLabel: string; onClose: () => void; children: ReactNode; container: HTMLElement | null; wide?: boolean;
  /** Fill the reader, and ask the browser for the whole screen (spec 1.3 `open: fullscreen`). Leaving the browser's
   *  full screen closes it. Where a browser cannot (iPhone Safari), it still fills the reader. */
  full?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('keydown', onKey, true);
    return () => { removeEventListener('keydown', onKey, true); before?.focus?.(); };
  }, [onClose]);
  useEffect(() => {
    const d = dialog.current;
    if (!full || !d?.requestFullscreen) return;
    let entered = false;
    const onChange = () => { if (document.fullscreenElement === d) entered = true; else if (entered) onClose(); };
    document.addEventListener('fullscreenchange', onChange);
    d.requestFullscreen().catch(() => {});
    return () => { document.removeEventListener('fullscreenchange', onChange); if (document.fullscreenElement === d) void document.exitFullscreen().catch(() => {}); };
  }, [full, onClose]);
  if (!container) return null;
  return createPortal(
    <div className={`chalk-modal-back ${full ? 'is-full' : ''}`} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} className={`chalk-modal ${wide ? 'is-wide' : ''} ${full ? 'is-full' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="chalk-panel-head">
          <h2>{title}</h2>
          <button type="button" className="chalk-icon-btn" aria-label={closeLabel} onClick={onClose}><XIcon size={18} weight="bold" /></button>
        </header>
        <div className="chalk-modal-body">{children}</div>
      </div>
    </div>,
    container,
  );
}
