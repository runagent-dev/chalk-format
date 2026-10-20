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
 * Runs before any of the lab's code: when the lab's document goes away (it navigated its frame, or was
 * unloaded), tell the host, which stops serving it for good (spec 1.1 §3.3). It holds its own reference to
 * the parent and listens first, in the capture phase, so nothing the lab does later can silence it.
 *
 * A message from a document that is unloading does not carry the frame as its `source`, so `gone` carries
 * this mount's nonce instead: the host accepts it only with its own nonce. A lab can read its nonce, but
 * forging `gone` only stops itself; it cannot stop another lab, whose nonce it does not know.
 */
export const labGuard = (nonce: string) => {
  if (!/^[\w-]{8,64}$/.test(nonce)) throw new Error('lab guard nonce: 8-64 word characters');
  return `<script>(function(){var p=parent;addEventListener('pagehide',function(){try{p.postMessage({chalk:1,type:'gone',nonce:'${nonce}'},'*')}catch(e){}},true)})()</script>`;
};

/** A fresh nonce for one mount of a lab. */
export const labNonce = () => crypto.randomUUID();

/**
 * The lab's HTML as the frame should load it: decoded as UTF-8, with the CSP as a `<meta>` and then the
 * guard script (for this mount's `nonce`, the one given to createLabHost), both before any of the lab's own
 * markup (right after the doctype). The HTML parser puts them into `<head>` whatever follows, so a lab
 * cannot get anything in ahead of them.
 */
export function prepareLabDocument(entry: Uint8Array | string, nonce: string): string {
  let html = typeof entry === 'string' ? entry : new TextDecoder('utf-8').decode(entry);
  if (html.charCodeAt(0) === 0xfeff) html = html.slice(1);
  const head = `<meta http-equiv="Content-Security-Policy" content="${LAB_CSP}">${labGuard(nonce)}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + head + html.slice(doctype[0].length) : '<!doctype html>' + head + html;
}

export type MountLabOptions = Omit<LabHostOptions, 'frame' | 'nonce'> & {
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
  // A lab that leaves its document is stopped, and the frame emptied so what it navigated to does not stay.
  let blanked = false;
  const blank = () => { if (blanked) return; blanked = true; frame.removeAttribute('srcdoc'); frame.src = 'about:blank'; };
  const nonce = labNonce();
  const host = createLabHost({ ...o, frame, nonce, onError: (m) => { blank(); o.onError?.(m); } });   // listening before the lab can say hello
  // Second line of defence for the guard script: the frame loading a second document.
  let loads = 0;
  frame.addEventListener('load', () => { if (++loads > 1 && !blanked) { host.dispose(); blank(); o.onError?.(`lab ${o.lab.id} navigated its frame`); } });
  frame.srcdoc = prepareLabDocument(o.entry, nonce);
  container.appendChild(frame);
  return { frame, host };
}
