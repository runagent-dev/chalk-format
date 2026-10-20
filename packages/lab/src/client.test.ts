import { describe, expect, it } from 'vitest';
import { hashBytes, type Lab } from '@chalk-format/model';
import { connectLab, LabError } from './client.js';
import { createLabHost } from './host.js';
import { prepareLabDocument, verifyLabEntry, LAB_CSP } from './document.js';
import { tick, windowPair } from './testing.js';

// The client against the reference host: the two halves of the protocol together.
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
const glbId = await hashBytes(GLB);
const desc = (extra: Partial<Lab> = {}): Lab => ({
  id: 'org.example.titration', version: '2.0.0', title: 'Titration', entry: 'sha256:' + 'e'.repeat(64),
  params: { acid: 'HCl' }, capabilities: ['state', 'progress', 'assets'], assets: [glbId], ...extra,
});

function connected(lab: Lab = desc(), saved: unknown = null) {
  const w = windowPair();
  const store = new Map<string, unknown>([['org.example.titration@2', saved]]);
  const progress: unknown[] = [];
  const host = createLabHost({
    lab, frame: w.frame, events: w.hostWindow, locale: 'en', theme: 'dark', reducedMotion: true,
    loadState: (k) => store.get(`${k.labId}@${k.major}`) ?? null, saveState: (k, s) => { store.set(`${k.labId}@${k.major}`, s); },
    getAsset: async (id) => (id === glbId ? { type: 'model/gltf-binary', bytes: GLB.slice().buffer } : null),
    onProgress: (p) => progress.push(p),
  });
  const session = connectLab({ id: lab.id, version: lab.version }, { self: w.lab, helloEveryMs: 20, timeoutMs: 500 });
  return { w, host, store, progress, session };
}

describe('connectLab', () => {
  it('starts with what the host sends', async () => {
    const s = await connected(desc(), { added: 12.5 }).session;
    expect(s).toMatchObject({ api: 1, params: { acid: 'HCl' }, locale: 'en', theme: 'dark', reducedMotion: true, state: { added: 12.5 }, mode: 'interactive' });
    expect(s.has('state') && s.has('assets') && s.has('progress')).toBe(true);
  });

  it('saves, reports progress and loads assets', async () => {
    const c = connected();
    const s = await c.session;
    await s.save({ added: 20.1 });
    expect(c.store.get('org.example.titration@2')).toEqual({ added: 20.1 });
    s.progress({ step: { done: 3, total: 4 } }); await tick(20);
    expect(c.progress).toEqual([{ step: { done: 3, total: 4 } }]);
    const a = await s.getAsset(glbId);
    expect(new Uint8Array(a.bytes)).toEqual(GLB);
  });

  it('works with nothing granted, and refuses locally what is not granted', async () => {
    const s = await connected(desc({ capabilities: [] })).session;
    expect(s.granted).toEqual([]);
    await expect(s.save({})).rejects.toMatchObject({ code: 'denied' });
    await expect(s.getAsset(glbId)).rejects.toBeInstanceOf(LabError);
    s.progress({ completed: true });   // dropped, no error
  });

  it('surfaces host errors with their code', async () => {
    const s = await connected().session;
    await expect(s.getAsset('sha256:' + '0'.repeat(64))).rejects.toMatchObject({ code: 'denied' });
    await expect(s.save('x'.repeat(70 * 1024))).rejects.toMatchObject({ code: 'too_large' });
  });

  it('hears visibility, theme, locale and reset', async () => {
    const c = connected();
    const s = await c.session;
    const got: unknown[] = [];
    s.on('visibility', (v) => got.push(['visibility', v])); s.on('theme', (v) => got.push(['theme', v]));
    s.on('locale', (v) => got.push(['locale', v])); s.on('reset', () => got.push(['reset']));
    c.host.setVisible(false); c.host.setTheme('light'); c.host.setLocale('bn'); await c.host.reset(); await tick(20);
    expect(got).toEqual([['visibility', false], ['theme', 'light'], ['locale', 'bn'], ['reset']]);
  });

  it('listens only to its parent', async () => {
    const w = windowPair();
    const session = connectLab({ id: 'x.y', version: '1' }, { self: w.lab, helloEveryMs: 20, timeoutMs: 120 });
    w.toLabFromStranger({ chalk: 1, type: 'init', api: 1, params: { evil: true }, locale: 'en', theme: 'light', granted: ['state'], state: null, mode: 'interactive' });
    await expect(session).rejects.toMatchObject({ code: 'failed' });
  });
});

describe('the lab document', () => {
  const html = '<!DOCTYPE html>\n<html lang="bn"><head><script>fetch("https://x")</script></head><body></body></html>';

  it('puts the CSP before any of the lab\'s markup', () => {
    const out = prepareLabDocument(new TextEncoder().encode('﻿' + html));
    expect(out.startsWith(`<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="${LAB_CSP}">`)).toBe(true);
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<script>'));
    expect(LAB_CSP).toContain("connect-src 'none'");
  });

  it('adds a doctype when the lab has none', () => {
    expect(prepareLabDocument('<html><body>x</body></html>').startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  it('checks the entry bytes against the id', async () => {
    const bytes = new TextEncoder().encode(html);
    expect(await verifyLabEntry(bytes, await hashBytes(bytes))).toBe(true);
    expect(await verifyLabEntry(bytes, 'sha256:' + '0'.repeat(64))).toBe(false);
  });
});
