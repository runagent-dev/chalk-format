import { useEffect, useState } from 'react';
import type { Book } from '../book.js';

/** The URL to draw an asset with: undefined while resolving, null if it is not available. */
export function useAssetUrl(book: Book, assetId: string | undefined): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(() => (assetId ? book.peekUrl(assetId) : null));
  useEffect(() => {
    if (!assetId) { setUrl(null); return; }
    const known = book.peekUrl(assetId);
    if (known !== undefined) { setUrl(known); return; }
    let live = true;
    setUrl(undefined);
    void book.assetUrl(assetId).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [book, assetId]);
  return url;
}
