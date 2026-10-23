import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashBytes, type Lab } from '@chalk-format/model';
import { createLabHost, type LabHost, type LabHostOptions, type StateKey } from './host.js';
import { STATE_MAX_BYTES } from './protocol.js';
import { fakeLab, tick, windowPair } from './testing.js';

// The host behaviours of host-api §7, one by one.
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
const glbId = await hashBytes(GLB);
const lab = (extra: Partial<Lab> = {}): Lab => ({
  id: 'org.example.pendulum', version: '1.4.2', title: 'Pendulum', entry: 'sha256:' + 'e'.repeat(64),
  params: { length: 0.8 }, capabilities: ['state', 'progress', 'assets'], assets: [glbId], ...extra,
});

const open: { host: LabHost; close: () => void }[] = [];
afterEach(() => { open.splice(0).forEach((x) => { x.host.dispose(); x.close(); }); });

function setup(o: { [K in keyof LabHostOptions]?: LabHostOptions[K] | undefined } = {}) {
  const w = windowPair(), l = fakeLab(w);
  const store = new Map<string, unknown>();
  const k = (key: StateKey) => `${key.labId}@${key.major}`;
  const host = createLabHost({
    lab: lab(), frame: w.frame, events: w.hostWindow, nonce: 'nonce-for-tests', locale: 'bn', theme: 'light',
    loadState: (key) => store.get(k(key)) ?? null,
    saveState: (key, s) => { store.set(k(key), s); },
    clearState: (key) => { store.delete(k(key)); },
    getAsset: async (id) => (id === glbId ? { type: 'model/gltf-binary', bytes: GLB.slice().buffer } : null),
    ...o,
  } as LabHostOptions);
  open.push({ host, close: l.close });
  const hello = (id = 'org.example.pendulum') => l.toWindow({ type: 'hello', api: [1], lab: { id, version: '1.4.2' } });
  // wait for what is expected (up to a second), not a fixed time: under load a fixed 20 ms was sometimes too short
  const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await tick(10); };
  const started = async () => { hello(); await until(() => l.received.some((m) => m.type === 'init')); };
  const replyTo = async (id: number) => {
    await until(() => l.received.some((m) => m.type === 'reply' && m.id === id));
    return l.received.find((m) => m.type === 'reply' && m.id === id);
  };
  return { w, l, host, store, hello, started, replyTo };
}

describe('handshake', () => {
  it('answers hello with one init (params, locale, theme, granted, visible) and a private channel', async () => {
    const { l, hello } = setup();
    hello(); hello(); hello();
    await tick(20);
    const inits = l.received.filter((m) => m.type === 'init');
    expect(inits).toHaveLength(1);
    expect(inits[0]).toMatchObject({ api: 1, params: { length: 0.8 }, locale: 'bn', theme: 'light', granted: ['state', 'progress', 'assets'], state: null, mode: 'interactive', visible: true });
    expect(l.port).not.toBeNull();
  });

  it('grants only what the lab asked for, knows, and the host can serve', async () => {
    const { l, started } = setup({ lab: lab({ capabilities: ['progress', 'data', 'camera'] }), getAsset: undefined });
    await started();
    expect(l.received[0]!.granted).toEqual(['progress']);
  });

  it('lets the host app narrow the grant further', async () => {
    const { l, started } = setup({ grant: (req) => req.filter((c) => c !== 'progress') });
    await started();
    expect(l.received[0]!.granted).toEqual(['state', 'assets']);
  });

  it('stops a lab that is not the one the book names, and rejects started', async () => {
    const onError = vi.fn();
    const { l, hello, host } = setup({ onError });
    hello('org.evil.other'); await tick(20);
    expect(l.received).toEqual([]);
    expect(onError).toHaveBeenCalled();
    await expect(host.started).rejects.toThrow(/book says/);
  });

  it('sends api 0 without a channel and stops when there is no shared version', async () => {
    const { l, host } = setup();
    l.toWindow({ type: 'hello', api: [2, 3], lab: { id: 'org.example.pendulum', version: '1' } }); await tick(20);
    expect(l.received).toHaveLength(1);
    expect(l.received[0]).toMatchObject({ type: 'init', api: 0, granted: [] });
    expect(l.port).toBeNull();
    await expect(host.started).rejects.toThrow();
  });

  it('starts fresh when loading saved state fails, instead of hanging on the poster', async () => {
    const { l, started, host } = setup({ loadState: () => { throw new Error('IndexedDB is down'); } });
    await started();
    expect(l.received[0]).toMatchObject({ type: 'init', state: null });
    await expect(host.started).resolves.toBeUndefined();
  });

  it('rejects started when disposed before the handshake', async () => {
    const { host } = setup();
    host.dispose();
    await expect(host.started).rejects.toThrow('disposed');
  });
});

describe('who may speak', () => {
  it('ignores messages from any window other than the lab frame', async () => {
    const { w, l } = setup();
    w.fromStranger({ chalk: 1, type: 'hello', api: [1], lab: { id: 'org.example.pendulum', version: '1' } });
    await tick(20);
    expect(l.received).toEqual([]);
  });

  it('ignores messages without the chalk mark, and requests on the window', async () => {
    const { w, l, started, replyTo } = setup();
    w.parent.postMessage({ type: 'hello', api: [1], lab: { id: 'org.example.pendulum' } }, '*');
    await tick(10);
    expect(l.received).toEqual([]);
    await started();
    l.toWindow({ type: 'state.save', id: 1, state: {} });   // after init, only the channel counts
    expect(await replyTo(1)).toBeUndefined();
  });

  it('stops for good when the lab leaves its document, before or after init', async () => {
    const onError = vi.fn();
    const a = setup({ onError });
    // as browsers deliver it: the unloading document is no longer the frame's, so no source
    a.w.hostWindow.deliver({ chalk: 1, type: 'gone', nonce: 'nonce-for-tests' }, null); await tick(10);
    a.hello(); await tick(20);   // what the frame navigated to says hello: nothing
    expect(a.l.received).toEqual([]);
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/left its document/));

    const b = setup();
    await b.started();
    b.l.toWindow({ type: 'gone', nonce: 'nonce-for-tests' }); await tick(10);
    b.l.send({ type: 'state.save', id: 2, state: {} });
    expect(await b.replyTo(2)).toBeUndefined();
  });

  it("ignores a gone without this mount's nonce, or from another live window", async () => {
    const onError = vi.fn();
    const a = setup({ onError });
    await a.started();
    a.w.hostWindow.deliver({ chalk: 1, type: 'gone', nonce: 'some-other-lab' }, null);
    a.l.toWindow({ type: 'gone' });
    a.w.fromStranger({ chalk: 1, type: 'gone', nonce: 'nonce-for-tests' });
    await tick(10);
    a.l.send({ type: 'state.save', id: 3, state: {} });
    expect(await a.replyTo(3)).toMatchObject({ ok: true });
    expect(onError).not.toHaveBeenCalled();
  });

  it('answers an unknown request with unknown and ignores an unknown notice', async () => {
    const { l, started, replyTo } = setup();
    await started();
    l.send({ type: 'camera.open', id: 7 });
    l.send({ type: 'telemetry.v9', x: 1 });
    expect(await replyTo(7)).toMatchObject({ ok: false, error: { code: 'unknown' } });
    expect(l.received.filter((m) => m.type === 'reply')).toHaveLength(1);
  });
});

describe('state', () => {
  it('saves, and hands the state back to the same lab and major version', async () => {
    const a = setup();
    await a.started();
    a.l.send({ type: 'state.save', id: 1, state: { readings: [1.62, 1.6] } });
    expect(await a.replyTo(1)).toMatchObject({ ok: true });
    expect([...a.store.keys()]).toEqual(['org.example.pendulum@1']);

    const b = setup({ loadState: (k) => a.store.get(`${k.labId}@${k.major}`) ?? null, lab: lab({ version: '1.9.0' }) });
    await b.started();
    expect(b.l.received[0]!.state).toEqual({ readings: [1.62, 1.6] });

    const c = setup({ loadState: (k) => a.store.get(`${k.labId}@${k.major}`) ?? null, lab: lab({ version: '2.0.0' }) });
    await c.started();
    expect(c.l.received[0]!.state).toBeNull();
  });

  it('refuses state over 64 KiB, and state when not granted', async () => {
    const a = setup();
    await a.started();
    a.l.send({ type: 'state.save', id: 2, state: 'x'.repeat(STATE_MAX_BYTES) });
    expect(await a.replyTo(2)).toMatchObject({ ok: false, error: { code: 'too_large' } });

    const b = setup({ lab: lab({ capabilities: ['progress'] }) });
    await b.started();
    b.l.send({ type: 'state.save', id: 3, state: {} });
    expect(await b.replyTo(3)).toMatchObject({ ok: false, error: { code: 'denied' } });
  });

  it('reset forgets the state and tells the lab', async () => {
    const a = setup();
    await a.started();
    a.l.send({ type: 'state.save', id: 1, state: { x: 1 } }); await a.replyTo(1);
    await a.host.reset(); await tick(10);
    expect(a.store.size).toBe(0);
    expect(a.l.received.at(-1)).toMatchObject({ type: 'reset' });
  });
});

describe('assets', () => {
  it('serves an asset in lab.assets, as transferred bytes', async () => {
    const a = setup();
    await a.started();
    a.l.send({ type: 'asset.get', id: 4, assetId: glbId });
    const r = await a.replyTo(4) as { ok: boolean; result: { type: string; bytes: ArrayBuffer } };
    expect(r.ok).toBe(true);
    expect(r.result.type).toBe('model/gltf-binary');
    expect(new Uint8Array(r.result.bytes)).toEqual(GLB);
  });

  it("keeps the host's own buffer: the same cached bytes serve every request, hashed once", async () => {
    const cached = GLB.slice().buffer;
    const getAsset = vi.fn(async () => ({ type: 'model/gltf-binary', bytes: cached }));
    const hashed = vi.spyOn(crypto.subtle, 'digest');
    const a = setup({ getAsset });
    await a.started();
    for (const id of [5, 6, 7]) a.l.send({ type: 'asset.get', id, assetId: glbId });
    for (const id of [5, 6, 7]) expect(await a.replyTo(id)).toMatchObject({ ok: true });
    expect(cached.byteLength).toBe(GLB.length);   // not detached
    expect(hashed).toHaveBeenCalledTimes(1);
    hashed.mockRestore();
  });

  it('denies any asset not listed, even one in the book', async () => {
    const a = setup({ lab: lab({ assets: [] }) });
    await a.started();
    a.l.send({ type: 'asset.get', id: 5, assetId: glbId });
    expect(await a.replyTo(5)).toMatchObject({ ok: false, error: { code: 'denied' } });
  });

  it('says not_found when the bytes are missing or are not what the id says', async () => {
    const a = setup({ getAsset: async () => ({ type: 'model/gltf-binary', bytes: new Uint8Array([1, 2, 3]).buffer }) });
    await a.started();
    a.l.send({ type: 'asset.get', id: 6, assetId: glbId });
    expect(await a.replyTo(6)).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });
});

describe('notices and events', () => {
  it('passes on ready and checked progress (only when granted)', async () => {
    const onReady = vi.fn(), onProgress = vi.fn();
    const a = setup({ onReady, onProgress });
    await a.started();
    a.l.send({ type: 'ready' });
    a.l.send({ type: 'progress', step: { done: 2, total: 5 }, score: 7, completed: false });
    await tick(20);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith({ step: { done: 2, total: 5 }, completed: false });

    const onProgress2 = vi.fn();
    const b = setup({ onProgress: onProgress2, lab: lab({ capabilities: [] }) });
    await b.started();
    b.l.send({ type: 'progress', completed: true }); await tick(20);
    expect(onProgress2).not.toHaveBeenCalled();
  });

  it('sends visibility, theme and locale on the channel', async () => {
    const a = setup();
    await a.started();
    a.host.setVisible(false); a.host.setTheme('dark'); a.host.setLocale('en'); await tick(10);
    expect(a.l.received.slice(1).map((m) => m.type)).toEqual(['visibility', 'theme', 'locale']);
    expect(a.l.received[1]).toMatchObject({ visible: false });
  });

  it('remembers what changed before the handshake and says it in init', async () => {
    const a = setup();
    a.host.setVisible(false); a.host.setTheme('dark'); a.host.setLocale('en');
    await a.started();
    expect(a.l.received).toHaveLength(1);
    expect(a.l.received[0]).toMatchObject({ type: 'init', visible: false, theme: 'dark', locale: 'en' });
  });

  it('goes quiet after dispose', async () => {
    const a = setup();
    a.host.dispose(); a.hello(); await tick(20);
    expect(a.l.received).toEqual([]);
  });
});
