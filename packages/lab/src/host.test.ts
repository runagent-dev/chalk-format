import { describe, expect, it, vi } from 'vitest';
import { hashBytes, type Lab } from '@chalk-format/model';
import { createLabHost, type LabHostOptions, type StateKey } from './host.js';
import { STATE_MAX_BYTES } from './protocol.js';
import { tick, windowPair } from './testing.js';

// The host behaviours of host-api §7, one by one.
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
const glbId = await hashBytes(GLB);
const lab = (extra: Partial<Lab> = {}): Lab => ({
  id: 'org.example.pendulum', version: '1.4.2', title: 'Pendulum', entry: 'sha256:' + 'e'.repeat(64),
  params: { length: 0.8 }, capabilities: ['state', 'progress', 'assets'], assets: [glbId], ...extra,
});

function setup(o: { [K in keyof LabHostOptions]?: LabHostOptions[K] | undefined } = {}) {
  const w = windowPair();
  const store = new Map<string, unknown>();
  const k = (key: StateKey) => `${key.labId}@${key.major}`;
  const host = createLabHost({
    lab: lab(), frame: w.frame, events: w.hostWindow, locale: 'bn', theme: 'light',
    loadState: (key) => store.get(k(key)) ?? null,
    saveState: (key, s) => { store.set(k(key), s); },
    clearState: (key) => { store.delete(k(key)); },
    getAsset: async (id) => (id === glbId ? { type: 'model/gltf-binary', bytes: GLB.slice().buffer } : null),
    ...o,
  } as LabHostOptions);
  /** Send as the lab frame. */
  const send = (m: Record<string, unknown>) => w.parent.postMessage({ chalk: 1, ...m }, '*');
  const hello = (id = 'org.example.pendulum') => send({ type: 'hello', api: [1], lab: { id, version: '1.4.2' } });
  const replyTo = async (id: number) => { await tick(20); return w.sentToLab.find((m) => m.type === 'reply' && m.id === id); };
  return { w, host, store, send, hello, replyTo };
}

describe('handshake', () => {
  it('answers hello with one init carrying params, locale, theme and the granted capabilities', async () => {
    const { w, hello } = setup();
    hello(); hello(); hello();
    await tick(20);
    const inits = w.sentToLab.filter((m) => m.type === 'init');
    expect(inits).toHaveLength(1);
    expect(inits[0]).toMatchObject({ api: 1, params: { length: 0.8 }, locale: 'bn', theme: 'light', granted: ['state', 'progress', 'assets'], state: null, mode: 'interactive' });
  });

  it('grants only what the lab asked for, knows, and the host can serve', async () => {
    const { w, hello } = setup({ lab: lab({ capabilities: ['progress', 'data', 'camera'] }), getAsset: undefined });
    hello(); await tick(20);
    expect(w.sentToLab[0]!.granted).toEqual(['progress']);
  });

  it('lets the host app narrow the grant further', async () => {
    const { w, hello } = setup({ grant: (req) => req.filter((c) => c !== 'progress') });
    hello(); await tick(20);
    expect(w.sentToLab[0]!.granted).toEqual(['state', 'assets']);
  });

  it('stops a lab that is not the one the book names', async () => {
    const onError = vi.fn();
    const { w, hello } = setup({ onError });
    hello('org.evil.other'); await tick(20);
    expect(w.sentToLab).toEqual([]);
    expect(onError).toHaveBeenCalled();
  });

  it('sends api 0 and stops when there is no shared version', async () => {
    const { w, send } = setup();
    send({ type: 'hello', api: [2, 3], lab: { id: 'org.example.pendulum', version: '1' } }); await tick(20);
    expect(w.sentToLab).toHaveLength(1);
    expect(w.sentToLab[0]).toMatchObject({ type: 'init', api: 0, granted: [] });
  });
});

describe('who may speak', () => {
  it('ignores messages from any window other than the lab frame', async () => {
    const { w } = setup();
    w.fromStranger({ chalk: 1, type: 'hello', api: [1], lab: { id: 'org.example.pendulum', version: '1' } });
    await tick(20);
    expect(w.sentToLab).toEqual([]);
  });

  it('ignores messages without the chalk mark, and requests before init', async () => {
    const { w } = setup();
    w.parent.postMessage({ type: 'hello', api: [1], lab: { id: 'org.example.pendulum' } }, '*');
    w.parent.postMessage({ chalk: 1, type: 'state.save', id: 1, state: {} }, '*');
    await tick(20);
    expect(w.sentToLab).toEqual([]);
  });

  it('answers an unknown request with unknown and ignores an unknown notice', async () => {
    const { hello, send, replyTo, w } = setup();
    hello(); await tick(10);
    send({ type: 'camera.open', id: 7 });
    send({ type: 'telemetry.v9', x: 1 });
    expect(await replyTo(7)).toMatchObject({ ok: false, error: { code: 'unknown' } });
    expect(w.sentToLab.filter((m) => m.type === 'reply')).toHaveLength(1);
  });
});

describe('state', () => {
  it('saves, and hands the state back to the same lab and major version', async () => {
    const a = setup();
    a.hello(); await tick(10);
    a.send({ type: 'state.save', id: 1, state: { readings: [1.62, 1.6] } });
    expect(await a.replyTo(1)).toMatchObject({ ok: true });
    expect([...a.store.keys()]).toEqual(['org.example.pendulum@1']);

    const b = setup({ loadState: (k) => a.store.get(`${k.labId}@${k.major}`) ?? null, lab: lab({ version: '1.9.0' }) });
    b.hello(); await tick(20);
    expect(b.w.sentToLab[0]!.state).toEqual({ readings: [1.62, 1.6] });

    const c = setup({ loadState: (k) => a.store.get(`${k.labId}@${k.major}`) ?? null, lab: lab({ version: '2.0.0' }) });
    c.hello(); await tick(20);
    expect(c.w.sentToLab[0]!.state).toBeNull();
  });

  it('refuses state over 64 KiB, and state when not granted', async () => {
    const a = setup();
    a.hello(); await tick(10);
    a.send({ type: 'state.save', id: 2, state: 'x'.repeat(STATE_MAX_BYTES) });
    expect(await a.replyTo(2)).toMatchObject({ ok: false, error: { code: 'too_large' } });

    const b = setup({ lab: lab({ capabilities: ['progress'] }) });
    b.hello(); await tick(10);
    b.send({ type: 'state.save', id: 3, state: {} });
    expect(await b.replyTo(3)).toMatchObject({ ok: false, error: { code: 'denied' } });
  });

  it('reset forgets the state and tells the lab', async () => {
    const a = setup();
    a.hello(); await tick(10);
    a.send({ type: 'state.save', id: 1, state: { x: 1 } }); await a.replyTo(1);
    await a.host.reset(); await tick(10);
    expect(a.store.size).toBe(0);
    expect(a.w.sentToLab.at(-1)).toMatchObject({ type: 'reset' });
  });
});

describe('assets', () => {
  it('serves an asset in lab.assets, as transferred bytes', async () => {
    const a = setup();
    a.hello(); await tick(10);
    a.send({ type: 'asset.get', id: 4, assetId: glbId });
    const r = await a.replyTo(4) as { ok: boolean; result: { type: string; bytes: ArrayBuffer } };
    expect(r.ok).toBe(true);
    expect(r.result.type).toBe('model/gltf-binary');
    expect(new Uint8Array(r.result.bytes)).toEqual(GLB);
  });

  it('denies any asset not listed, even one in the book', async () => {
    const a = setup({ lab: lab({ assets: [] }) });
    a.hello(); await tick(10);
    a.send({ type: 'asset.get', id: 5, assetId: glbId });
    expect(await a.replyTo(5)).toMatchObject({ ok: false, error: { code: 'denied' } });
  });

  it('says not_found when the bytes are missing or are not what the id says', async () => {
    const a = setup({ getAsset: async () => ({ type: 'model/gltf-binary', bytes: new Uint8Array([1, 2, 3]).buffer }) });
    a.hello(); await tick(10);
    a.send({ type: 'asset.get', id: 6, assetId: glbId });
    expect(await a.replyTo(6)).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('notices and events', () => {
  it('passes on ready and checked progress (only when granted)', async () => {
    const onReady = vi.fn(), onProgress = vi.fn();
    const a = setup({ onReady, onProgress });
    a.hello(); await tick(10);
    a.send({ type: 'ready' });
    a.send({ type: 'progress', step: { done: 2, total: 5 }, score: 7, completed: false });
    await tick(20);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith({ step: { done: 2, total: 5 }, completed: false });

    const onProgress2 = vi.fn();
    const b = setup({ onProgress: onProgress2, lab: lab({ capabilities: [] }) });
    b.hello(); await tick(10);
    b.send({ type: 'progress', completed: true }); await tick(20);
    expect(onProgress2).not.toHaveBeenCalled();
  });

  it('sends visibility, theme and locale', async () => {
    const a = setup();
    a.hello(); await tick(10);
    a.host.setVisible(false); a.host.setTheme('dark'); a.host.setLocale('en'); await tick(10);
    expect(a.w.sentToLab.slice(1).map((m) => m.type)).toEqual(['visibility', 'theme', 'locale']);
    expect(a.w.sentToLab[1]).toMatchObject({ visible: false });
  });

  it('goes quiet after dispose', async () => {
    const a = setup();
    a.host.dispose(); a.hello(); await tick(20);
    expect(a.w.sentToLab).toEqual([]);
  });
});
