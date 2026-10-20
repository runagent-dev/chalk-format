/**
 * Two fake windows, a host page and a lab frame, that deliver postMessage asynchronously with the
 * sender as `source`, structured cloning (ArrayBuffers transferred) and MessagePorts in `ports`, as
 * browsers do. The ports themselves are real (Node's MessageChannel). For tests.
 */
import type { WindowMessage } from './protocol.js';

type Listener = (e: WindowMessage) => void;
type Target = { postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void };

class FakeWindow {
  readonly listeners = new Set<Listener>();
  addEventListener(_t: 'message', l: Listener) { this.listeners.add(l); }
  removeEventListener(_t: 'message', l: Listener) { this.listeners.delete(l); }
  deliver(data: unknown, source: unknown, transfer: Transferable[] = []) {
    const ports = transfer.filter((t): t is MessagePort => !(t instanceof ArrayBuffer));
    const buffers = transfer.filter((t): t is ArrayBuffer => t instanceof ArrayBuffer);
    const copy = structuredClone(data, { transfer: buffers });
    setTimeout(() => this.listeners.forEach((l) => l({ data: copy, source, ports })), 0);
  }
}

export function windowPair() {
  const hostWindow = new FakeWindow(), labWindow = new FakeWindow();
  /** What the lab sees as `window.parent`; posting to it reaches the host page, from the lab's frame. */
  const parent: Target = { postMessage: (m, _o, t) => hostWindow.deliver(m, frameWindow, t) };
  /** The lab frame's `contentWindow` as the host sees it; posting to it reaches the lab, from the parent. */
  const frameWindow: Target = { postMessage: (m, _o, t) => labWindow.deliver(m, parent, t) };
  const lab = Object.assign(labWindow, { parent });
  /** Post into the host page as some other frame (an attacker, another lab). */
  const stranger: Target = { postMessage: () => {} };
  const fromStranger = (m: unknown) => hostWindow.deliver(m, stranger);
  /** Post into the lab as someone other than its parent. */
  const toLabFromStranger = (m: unknown, transfer?: Transferable[]) => labWindow.deliver(m, stranger, transfer);
  return { hostWindow, lab, frame: { contentWindow: frameWindow }, parent, fromStranger, toLabFromStranger };
}

/**
 * A hand-driven lab for host tests: says what it is told to on the window before init and on the
 * channel after, and records everything the host sends it (init, replies, events) in order.
 */
export function fakeLab(w: ReturnType<typeof windowPair>) {
  const received: Record<string, unknown>[] = [];
  let port: MessagePort | null = null;
  w.lab.addEventListener('message', (e) => {
    if (e.source !== w.parent) return;
    received.push(e.data as Record<string, unknown>);
    const p = e.ports?.[0];
    if (p) { port = p; port.onmessage = (m) => received.push(m.data as Record<string, unknown>); }
  });
  return {
    received,
    get port() { return port; },
    /** On the window (the handshake, or what a lab might try there). */
    toWindow: (m: Record<string, unknown>) => w.parent.postMessage({ chalk: 1, ...m }, '*'),
    /** On the channel, once init has handed it over. */
    send: (m: Record<string, unknown>) => { if (!port) throw new Error('no channel yet'); port.postMessage({ chalk: 1, ...m }); },
    close: () => port?.close(),
  };
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
