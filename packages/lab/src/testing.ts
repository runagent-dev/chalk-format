/**
 * Two fake windows, a host page and a lab frame, that deliver postMessage asynchronously with the
 * sender as `source` and structured cloning (transfer included), as browsers do. For tests.
 */
type Listener = (e: { data: unknown; source: unknown }) => void;
type Target = { postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void };

class FakeWindow {
  readonly listeners = new Set<Listener>();
  addEventListener(_t: 'message', l: Listener) { this.listeners.add(l); }
  removeEventListener(_t: 'message', l: Listener) { this.listeners.delete(l); }
  deliver(data: unknown, source: unknown, transfer?: Transferable[]) {
    const copy = structuredClone(data, transfer ? { transfer } : undefined);
    setTimeout(() => this.listeners.forEach((l) => l({ data: copy, source })), 0);
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
  const toLabFromStranger = (m: unknown) => labWindow.deliver(m, stranger);
  /** Messages the host sent to the lab, in order. */
  const sentToLab: Record<string, unknown>[] = [];
  labWindow.addEventListener('message', (e) => { if (e.source === parent) sentToLab.push(e.data as Record<string, unknown>); });
  return { hostWindow, lab, frame: { contentWindow: frameWindow }, parent, fromStranger, toLabFromStranger, sentToLab };
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
