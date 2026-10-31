import { useCallback, useEffect, useRef, useState } from 'react';
import type { Book } from '../book.js';

/** How long an element waits after its media failed before asking the book for the asset again (a moment for the library to settle). */
export const RENEW_DELAY_MS = 400;
/**
 * The least time between two renewals of one element, even when the renewed media loaded in between: media that load and then fail
 * every time (bytes a browser cannot decode, under URLs that change each time) are not asked for again and again. A signed link lasts
 * minutes (registry-api §7.1: 5 to 15), so one that expires again later is still renewed.
 */
export const RENEW_AGAIN_MS = 60_000;

/** The URL to draw an asset with: undefined while resolving, null if it is not available. */
export function useAssetUrl(book: Book, assetId: string | undefined): string | null | undefined {
  return useAssetSrc(book, assetId).url;
}

export type AssetSrc = {
  /** The URL to draw the asset with: undefined while resolving, null if it is not available. */
  url: string | null | undefined;
  /**
   * The element drawing `url` failed to load it (an `error` event: the library moved the file, a signed link expired). The book is asked
   * for the asset once more after a short wait, and a new URL replaces this one. Once per failure: a renewed URL that fails before it ever
   * loaded is not renewed again (no loop).
   */
  onError: () => void;
  /** The element loaded its media: a later failure (a link that expires while a long video plays) may renew it again, a minute after the last renewal at the earliest. */
  onLoad: () => void;
};

/**
 * One element's recovery from media that failed to load: `failed(url)` asks the book for the asset again after `delay`, once, and hands a
 * new answer to `set`; `loaded()` allows the next failure to renew again, `again` after the last renewal at the earliest. A renewed URL
 * that fails before it ever loaded is left as it is (no loop). `stop()` cancels a renewal on its way (the element went away, or draws
 * another asset).
 */
export function mediaRenewer(book: Book, assetId: string, set: (url: string | null) => void, delay = RENEW_DELAY_MS, again = RENEW_AGAIN_MS) {
  let budget = true, live = true, last = -Infinity, timer: ReturnType<typeof setTimeout> | undefined;
  return {
    failed(url: string | null) {
      if (!live || !budget || !book.renewUrl || Date.now() - last < again) return;
      budget = false; last = Date.now();
      timer = setTimeout(() => {
        void book.renewUrl!(assetId, url).catch(() => null).then((u) => {
          // the same answer again: nothing changes (the element stays as it is)
          if (live && u !== url) set(u);
        });
      }, delay);
    },
    loaded() { budget = true; },
    stop() { live = false; clearTimeout(timer); },
  };
}

/**
 * The URL to draw an asset with, and the element's way to recover when it fails to load. A resolution that failed (the media could not be
 * fetched, rather than "not available") is asked again once too.
 */
export function useAssetSrc(book: Book, assetId: string | undefined): AssetSrc {
  const [url, setUrl] = useState<string | null | undefined>(() => (assetId ? book.peekUrl(assetId) : null));
  const now = useRef(url); now.current = url;
  const renewer = useRef<ReturnType<typeof mediaRenewer> | null>(null);

  useEffect(() => {
    if (!assetId) { setUrl(null); return; }
    let live = true;
    const r = mediaRenewer(book, assetId, setUrl);
    renewer.current = r;
    const known = book.peekUrl(assetId);
    if (known !== undefined) { setUrl(known); if (known === null) r.failed(null); }
    else {
      setUrl(undefined);
      void book.assetUrl(assetId).then((u) => { if (!live) return; setUrl(u); if (u === null) r.failed(null); });
    }
    return () => { live = false; r.stop(); if (renewer.current === r) renewer.current = null; };
  }, [book, assetId]);

  const onError = useCallback(() => { const u = now.current; if (u) renewer.current?.failed(u); }, []);
  const onLoad = useCallback(() => { renewer.current?.loaded(); }, []);
  return { url, onError, onLoad };
}

/**
 * A video's or audio's handlers around `useAssetSrc`: on an error (a signed link that expired while it played) where it was and whether it
 * played are kept, the URL is renewed, and the new one starts from there.
 */
export function useResume(onError: () => void, onLoad: () => void) {
  const at = useRef<{ time: number; playing: boolean } | null>(null);
  // the student paused it (a `pause` event, the browser's controls included); playing again clears it
  const paused = useRef(false);
  return {
    onPlay: () => { paused.current = false; },
    onPause: () => { paused.current = true; },
    onError: (e: { currentTarget: HTMLMediaElement }) => {
      const m = e.currentTarget;
      // playing, or asked to play (a tap sets autoplay) and failed before it started; a player the student paused stays paused under its
      // new URL, so its autoplay is cleared (it would start it again)
      const playing = !m.paused || (m.autoplay && !paused.current);
      at.current = { time: m.currentTime, playing };
      if (!playing) m.autoplay = false;
      onError();
    },
    onLoadedMetadata: (e: { currentTarget: HTMLMediaElement }) => {
      onLoad();
      const r = at.current, m = e.currentTarget;
      if (!r) return;
      at.current = null;
      if (r.time > 0) m.currentTime = r.time;
      if (r.playing) void m.play().catch(() => {});
    },
  };
}
