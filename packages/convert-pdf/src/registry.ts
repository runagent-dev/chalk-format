export type SourceFormat = 'pdf';

export interface ConvertOptions {
  /** Overrides the title derived from the document/filename. */
  title?: string;
  targetWidth?: number;
  format?: 'webp' | 'png';
  quality?: number;
  onProgress?: (pageNumber: number, total: number) => void;
}

export interface ConvertResult {
  /** The packed `.chalk` bytes. */
  chalk: Uint8Array;
  title: string;
  pageCount: number;
  /** First page's rendered raster — the library cover. */
  cover: { bytes: Uint8Array; type: string } | null;
}

/**
 * One source format's conversion. New formats (pptx, docx) register here
 * rather than being switched on at the call site, so the API route that
 * dispatches to them never changes.
 */
export interface SourceConverter {
  readonly format: SourceFormat;
  readonly mimeTypes: ReadonlySet<string>;
  convert(bytes: Uint8Array, options?: ConvertOptions): Promise<ConvertResult>;
}

const MAGIC: ReadonlyArray<{ format: SourceFormat; bytes: readonly number[] }> = [
  { format: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // "%PDF"
];

/**
 * Identify a source document from its magic bytes. The client's
 * `Content-Type` is not consulted: an upload endpoint that trusts a header
 * lets a caller pick which parser runs on their bytes.
 */
export function sniffSourceFormat(bytes: Uint8Array): SourceFormat | null {
  for (const { format, bytes: magic } of MAGIC) {
    if (bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b)) return format;
  }
  return null;
}

/** Human title from an upload's filename: `Ocean_Physics.pdf` → `Ocean Physics`. */
export function titleFromFilename(filename: string): string {
  const stem = filename.replace(/\.[a-z0-9]+$/i, '');
  // Underscores are almost always a filename artefact; hyphens are usually
  // deliberate ("physics-9-10"), so they survive.
  const title = stem.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  // A name that is nothing but an extension would otherwise title a book "".
  return title || filename;
}

export class ConverterRegistry {
  private readonly byFormat = new Map<SourceFormat, SourceConverter>();

  constructor(converters: SourceConverter[] = []) {
    for (const c of converters) this.register(c);
  }

  register(converter: SourceConverter): void {
    this.byFormat.set(converter.format, converter);
  }

  get(format: SourceFormat): SourceConverter | null {
    return this.byFormat.get(format) ?? null;
  }

  /** Pick a converter by sniffing the bytes. Null when nothing handles them. */
  forBytes(bytes: Uint8Array): SourceConverter | null {
    const format = sniffSourceFormat(bytes);
    return format ? this.get(format) : null;
  }

  formats(): SourceFormat[] {
    return [...this.byFormat.keys()];
  }
}
