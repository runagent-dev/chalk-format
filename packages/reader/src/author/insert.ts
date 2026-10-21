import { generateId, type LessonObject } from '@chalk-format/model';

/** What a file becomes on the page, by its type; null for files the reader cannot place. */
export type MediaKind = 'image' | 'video' | 'audio' | 'model3d' | 'lab';

export function mediaKindOf(file: { name: string; type: string }): MediaKind | null {
  const t = file.type.toLowerCase(), n = file.name.toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'model/gltf-binary' || n.endsWith('.glb')) return 'model3d';
  if (t === 'text/html' || n.endsWith('.html') || n.endsWith('.htm')) return 'lab';
  return null;
}
/** For the file picker. */
export const ACCEPT = 'image/*,video/*,audio/*,.glb,model/gltf-binary,.html,text/html';

const typeOf = (file: { name: string; type: string }, kind: MediaKind) =>
  kind === 'model3d' ? 'model/gltf-binary' : kind === 'lab' ? 'text/html' : file.type || 'application/octet-stream';

/** The media's own size in pixels, where it has one. */
async function naturalSize(kind: MediaKind, url: string): Promise<{ width: number; height: number } | null> {
  if (kind === 'image') {
    const img = new Image(); img.src = url;
    await img.decode().catch(() => {});
    return img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : null;
  }
  if (kind === 'video') {
    const v = await loadVideo(url);
    return v?.videoWidth ? { width: v.videoWidth, height: v.videoHeight } : null;
  }
  return null;
}

function loadVideo(url: string): Promise<HTMLVideoElement | null> {
  return new Promise((res) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.src = url;
    v.onloadedmetadata = () => res(v);
    v.onerror = () => res(null);
    setTimeout(() => res(null), 8000);
  });
}

/** A still from early in the video (not the very first frame, which is often black), as a WebP poster. */
async function videoPoster(url: string): Promise<Blob | null> {
  const v = await loadVideo(url);
  if (!v || !v.videoWidth) return null;
  v.currentTime = Math.min(1, (v.duration || 2) / 4);
  await new Promise<void>((r) => { v.onseeked = () => r(); setTimeout(r, 4000); });
  const scale = Math.min(1, 1280 / v.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/webp', 0.82));
}

/** A box for the media: its proportions, at most 60 % of the page either way, centred on `at`. */
function place(size: { width: number; height: number }, page: { width: number; height: number }, at: { x: number; y: number }) {
  const k = Math.min(1, (page.width * 0.6) / size.width, (page.height * 0.6) / size.height);
  const width = Math.round(size.width * k), height = Math.round(size.height * k);
  const x = Math.round(Math.min(Math.max(0, at.x - width / 2), page.width - width));
  const y = Math.round(Math.min(Math.max(0, at.y - height / 2), page.height - height));
  return { x, y, width, height };
}

/**
 * A file, made into an object on a page: its bytes added to the book (through `addAsset`), placed with its own
 * proportions around `at`. Videos get a poster from one of their frames.
 */
export async function objectFromFile(
  file: File, page: { width: number; height: number }, at: { x: number; y: number },
  addAsset: (bytes: Uint8Array, type: string) => Promise<string>,
): Promise<LessonObject | null> {
  const kind = mediaKindOf(file);
  if (!kind) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = typeOf(file, kind);
  const assetId = await addAsset(bytes, type);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  try {
    const id = generateId(kind);
    const sizes = { image: null, video: { width: 1280, height: 720 }, audio: { width: 640, height: 120 }, model3d: { width: 720, height: 720 }, lab: { width: 960, height: 720 } };
    const box = place((await naturalSize(kind, url)) ?? sizes[kind] ?? { width: 800, height: 600 }, page, at);
    switch (kind) {
      case 'image': return { id, type: 'image', ...box, assetId };
      case 'video': {
        const poster = await videoPoster(url);
        const posterId = poster ? await addAsset(new Uint8Array(await poster.arrayBuffer()), 'image/webp') : undefined;
        return { id, type: 'embed', embed: 'video', ...box, assetId, ...(posterId ? { poster: posterId } : {}) };
      }
      case 'audio': return { id, type: 'embed', embed: 'audio', ...box, assetId };
      case 'model3d': return { id, type: 'embed', embed: 'model3d', ...box, assetId };
      case 'lab': {
        const title = file.name.replace(/\.html?$/i, '');
        return { id, type: 'embed', embed: 'plugin', plugin: 'chalk.lab', ...box,
          lab: { id: `local.${assetId.slice(3, 15)}`, version: '1.0.0', title, entry: assetId, capabilities: ['state', 'progress'] } } as LessonObject;
      }
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}
