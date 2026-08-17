/**
 * Media type detection from magic bytes.
 *
 * The single place that decides what a blob actually is. A client's
 * `Content-Type` is a claim, not evidence: an upload endpoint that believes it
 * lets the caller choose which decoder — or which same-origin content type —
 * their bytes get. Every ingest path sniffs instead.
 */

export const IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

/** Containers/codecs every target browser decodes natively. We do not transcode. */
export const VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
export const AUDIO_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/ogg'] as const;

export type ImageType = (typeof IMAGE_TYPES)[number];
export type VideoType = (typeof VIDEO_TYPES)[number];
export type AudioType = (typeof AUDIO_TYPES)[number];
export type MediaType = ImageType | VideoType | AudioType;

export type MediaKind = 'image' | 'video' | 'audio';

const at = (b: Uint8Array, offset: number, ascii: string): boolean => {
  if (b.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (b[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
};

const bytesAt = (b: Uint8Array, offset: number, expected: readonly number[]): boolean => {
  if (b.length < offset + expected.length) return false;
  return expected.every((v, i) => b[offset + i] === v);
};

/**
 * The ISO base-media `ftyp` brand distinguishes an MP4 video from an M4A
 * audio file — they share a container, so the brand is the only signal.
 */
function sniffIsoBmff(b: Uint8Array): MediaType | null {
  if (!at(b, 4, 'ftyp')) return null;
  const brand = String.fromCharCode(...b.slice(8, 12));
  if (brand === 'avif' || brand === 'avis') return 'image/avif';
  if (brand.startsWith('M4A') || brand === 'M4B ' || brand === 'M4P ') return 'audio/mp4';
  // isom/mp42/iso5/avc1/dash/qt… — treat the rest of the family as video.
  return 'video/mp4';
}

/** Identify a blob, or null when it is not something we accept. */
export function sniffMediaType(bytes: Uint8Array): MediaType | null {
  if (bytesAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (bytesAt(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(bytes, 0, 'GIF87a') || at(bytes, 0, 'GIF89a')) return 'image/gif';
  if (at(bytes, 0, 'RIFF') && at(bytes, 8, 'WEBP')) return 'image/webp';

  const iso = sniffIsoBmff(bytes);
  if (iso) return iso;

  // Matroska/WebM share the EBML header; the DocType decides, and it appears
  // within the first few dozen bytes of any real file.
  if (bytesAt(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) {
    const head = bytes.slice(0, 64);
    for (let i = 0; i < head.length - 4; i++) {
      if (at(head, i, 'webm')) return 'video/webm';
    }
    return null; // .mkv — a container browsers will not play
  }

  if (at(bytes, 0, 'OggS')) return 'audio/ogg';
  // MP3: an ID3 tag, or a bare frame sync (11 set bits).
  if (at(bytes, 0, 'ID3')) return 'audio/mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return 'audio/mpeg';

  return null;
}

export function mediaKindOf(type: MediaType): MediaKind {
  if ((IMAGE_TYPES as readonly string[]).includes(type)) return 'image';
  if ((VIDEO_TYPES as readonly string[]).includes(type)) return 'video';
  return 'audio';
}

export function isImageType(type: string): type is ImageType {
  return (IMAGE_TYPES as readonly string[]).includes(type);
}
