import type { ReactNode } from 'react';

/** How tall or wide the window's body is: the media's own shape, any shape, or a fixed width / height (e.g. 4 / 3). */
export type WindowAspect = 'media' | 'free' | number;

/**
 * Where an `open: window` object (spec 1.6) opens. `floating`: a window the student can move and resize, over the page. `side`: a panel docked to
 * one side of the reader, full height, over the page (the page is not resized: the other part stays usable). On a narrow reader both are a sheet
 * across the bottom.
 */
export type WindowLayout = {
  kind: 'floating' | 'side';
  /** Which side the `side` layout docks to. */
  side: 'right' | 'left';
  /** The width of the `side` layout: any CSS length, or a percentage of the reader. */
  width: string;
};

/** What a host's own window chrome (`config.window.render`) is given. */
export type WindowChrome = {
  title: string;
  /** Closes the window. */
  onClose: () => void;
  /** The body's width / height, or null for a free shape. Draw the media's box in this shape. */
  aspect: number | null;
  /** The layout this window has now: `sheet` is what a narrow reader makes of either layout. */
  kind: 'floating' | 'side' | 'sheet';
  /** The media, filling whatever box it is put in. */
  children: ReactNode;
};
export type RenderWindow = (w: WindowChrome) => ReactNode;

/** `config.window`: how the floating window looks and behaves, for the host (spec 1.6 §3). */
export type WindowConfig = {
  layout: WindowLayout;
  aspect: WindowAspect;
  /** Your own chrome around the media, in place of the reader's. Close it with `onClose`; Escape inside it closes it too. */
  render?: RenderWindow | undefined;
};

export const DEFAULT_WINDOW: WindowConfig = { layout: { kind: 'floating', side: 'right', width: '50%' }, aspect: 'media' };
