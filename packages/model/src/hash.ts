/**
 * Content-addressed asset ID from raw bytes.
 *
 * Format: `sha256:<64 lowercase hex chars>`. Chosen so IDs are
 * deterministic (same bytes = same ID → free dedup) and self-verifying
 * (a stored ID can be checked against the content it names). See §8A.2.
 *
 * Uses Web Crypto's `crypto.subtle.digest` which is present in modern
 * browsers and Node 20+, so this works uniformly on both sides of the
 * app without a polyfill.
 */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  // crypto.subtle.digest expects an ArrayBuffer / view; Uint8Array is fine
  // on modern platforms. The `.buffer as ArrayBuffer` cast satisfies TS's
  // narrower BufferSource typing without allocating a copy.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += (view[i]! + 0x100).toString(16).slice(1);
  }
  return `sha256:${hex}`;
}

/** Type guard for the shape of a content-hash asset ID. */
export function isSha256AssetId(id: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(id);
}
