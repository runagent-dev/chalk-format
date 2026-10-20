import { hashBytes } from '@chalk-format/model';
import { createLabHost, type LabHost, type LabHostOptions } from './host.js';

/** The frame's sandbox (spec 1.1 §3.3): scripts, and an opaque origin (no `allow-same-origin`). */
export const LAB_SANDBOX = 'allow-scripts';

/** The Content Security Policy every lab runs under (spec 1.1 §3.3). `connect-src 'none'`: no network. */
export const LAB_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data: blob:',
  "connect-src 'none'",
  'worker-src blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** Does a lab entry's content match its id? A host MUST NOT run it otherwise (spec 1.1 §3.3). */
export async function verifyLabEntry(bytes: Uint8Array, entry: string): Promise<boolean> {
  return (await hashBytes(bytes)) === entry;
}

/**
 * The lab's HTML as the frame should load it: decoded as UTF-8 and with the CSP as a `<meta>` placed
 * before any of the lab's own markup (right after the doctype). The HTML parser puts it into `<head>`
 * whatever follows, so a lab cannot get a script in ahead of it.
 */
export function prepareLabDocument(entry: Uint8Array | string): string {
  let html = typeof entry === 'string' ? entry : new TextDecoder('utf-8').decode(entry);
  if (html.charCodeAt(0) === 0xfeff) html = html.slice(1);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${LAB_CSP}">`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + meta + html.slice(doctype[0].length) : '<!doctype html>' + meta + html;
}

export type MountLabOptions = Omit<LabHostOptions, 'frame'> & {
  /** The bytes of `lab.entry`. Checked against the id before anything runs. */
  entry: Uint8Array;
};

/**
 * Browser helper: put a lab in `container` (an iframe filling it) and start its host.
 * Rejects without creating anything if the entry's bytes do not match `lab.entry`.
 *
 * The frame loads through `srcdoc`, which inherits the host page's own CSP: a host whose page forbids
 * inline scripts must serve labs from a separate origin instead (spec 1.1 §3.3).
 */
export async function mountLab(container: HTMLElement, o: MountLabOptions): Promise<{ frame: HTMLIFrameElement; host: LabHost }> {
  if (!(await verifyLabEntry(o.entry, o.lab.entry))) throw new Error(`lab ${o.lab.id}: entry bytes do not match ${o.lab.entry}`);
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', LAB_SANDBOX);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.title = o.lab.title;
  frame.style.cssText = 'border:0;width:100%;height:100%;display:block';
  const host = createLabHost({ ...o, frame });   // listening before the lab can say hello
  frame.srcdoc = prepareLabDocument(o.entry);
  container.appendChild(frame);
  return { frame, host };
}
