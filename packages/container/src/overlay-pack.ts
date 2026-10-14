import JSZip from 'jszip';
import {
  CHALK_FORMAT_VERSION,
  overlayReferencedAssetIds,
  parseOverlay,
  type Overlay,
} from '@chalk-format/model';
import {
  CHALKBOOK_FORMAT,
  CHALKBOOK_VERSION,
  type OverlayManifest,
} from './manifest.js';
import { writeAssetsToZip, type AssetBundle } from './pack.js';
import {
  checkEntryCount,
  readAssetsFromZip,
  DEFAULT_MAX_TOTAL_BYTES,
  type UnpackInput,
  type UnpackLimits,
} from './unpack.js';

export interface PackOverlayOptions {
  /** `fat` (default) inlines new-asset bytes; `thin` externalizes hashes. */
  mode?: 'fat' | 'thin';
}

/**
 * Pack an overlay into an overlay `.chalk`: `manifest.json` (kind=overlay +
 * base pointer), `overlay.json` (the delta), and the NEW assets the overlay
 * introduces. The base's own assets are NOT carried — they come from the
 * base bundle. `assets` should cover {@link overlayReferencedAssetIds};
 * a referenced asset with no payload is simply omitted (thin/deferred).
 */
export async function packOverlay(
  overlay: Overlay,
  assets?: AssetBundle,
  options?: PackOverlayOptions,
): Promise<Uint8Array> {
  parseOverlay(overlay); // reject an invalid overlay before writing
  const thin = options?.mode === 'thin';

  const zip = new JSZip();
  // Only carry assets the overlay actually references (ignore any extras).
  const referenced = new Set(overlayReferencedAssetIds(overlay));
  const overlayAssets: AssetBundle = new Map();
  if (assets) for (const id of referenced) {
    const payload = assets.get(id);
    if (payload) overlayAssets.set(id, payload);
  }
  const assetEntries = writeAssetsToZip(zip, overlayAssets, thin);

  const manifest: OverlayManifest = {
    format: CHALKBOOK_FORMAT,
    version: CHALKBOOK_VERSION,
    formatVersion: CHALK_FORMAT_VERSION,
    kind: 'overlay',
    base: overlay.base,
    assets: assetEntries,
    bundling: thin ? 'thin' : 'fat',
    metadata: { createdAt: overlay.updatedAt, updatedAt: overlay.updatedAt },
  };

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('overlay.json', JSON.stringify(overlay, null, 2));
  // See packLesson: DEFLATE the JSON entries; asset bytes already opted
  // into STORE via writeAssetsToZip.
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

export interface UnpackOverlayResult {
  overlay: Overlay;
  assets: AssetBundle;
  /** Referenced asset ids whose bytes weren't in the ZIP (thin/deferred). */
  missingAssetIds: string[];
}

/** Read an overlay `.chalk` produced by {@link packOverlay}. */
export async function unpackOverlay(
  input: UnpackInput,
  limits?: UnpackLimits,
): Promise<UnpackOverlayResult> {
  const zip = await JSZip.loadAsync(input);
  checkEntryCount(zip, limits);
  const maxTotalBytes = limits?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  let totalBytes = 0;
  const countBytes = (n: number, path: string) => {
    totalBytes += n;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`package exceeds the total-size limit while reading ${path}`);
    }
  };

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw new Error('missing manifest.json');
  const manifestText = await manifestFile.async('string');
  countBytes(manifestText.length, 'manifest.json');
  const manifest = JSON.parse(manifestText) as OverlayManifest;
  if (manifest.format !== CHALKBOOK_FORMAT) {
    throw new Error(`unexpected format: ${manifest.format}`);
  }
  if (manifest.kind !== 'overlay') {
    throw new Error(`not an overlay bundle (kind: ${manifest.kind ?? 'lesson'})`);
  }

  const overlayFile = zip.file('overlay.json');
  if (!overlayFile) throw new Error('missing overlay.json');
  const overlayText = await overlayFile.async('string');
  countBytes(overlayText.length, 'overlay.json');
  const overlay = parseOverlay(JSON.parse(overlayText));

  const { assets, missingAssetIds } = await readAssetsFromZip(
    zip,
    manifest.assets ?? [],
    countBytes,
  );
  return { overlay, assets, missingAssetIds };
}
