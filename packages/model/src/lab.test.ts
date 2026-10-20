import { describe, expect, it } from 'vitest';
import { LAB_PARAMS_MAX_BYTES, isLabObject, lessonObjectSchema } from './schema.js';

// Labs (spec 1.1 §2): an embed with embed: 'plugin', plugin: 'chalk.lab' and a `lab` descriptor.
const sha = (c: string) => 'sha256:' + c.repeat(64);
const lab = (extra: Record<string, unknown> = {}) => ({
  id: 'lab1', type: 'embed', embed: 'plugin', plugin: 'chalk.lab', x: 0, y: 0, width: 960, height: 540, poster: sha('a'),
  lab: { id: 'org.pathshalax.physics.pendulum', version: '1.2.0', title: 'সরল দোলক', entry: sha('b'), ...extra },
});
const parse = (o: unknown) => lessonObjectSchema.safeParse(o);

describe('lab objects', () => {
  it('accepts a lab with params, assets and capabilities', () => {
    const r = parse(lab({ assets: [sha('c')], params: { length: 0.8, showTimer: true }, capabilities: ['state', 'progress', 'assets'] }));
    expect(r.success).toBe(true);
    expect(r.success && isLabObject(r.data)).toBe(true);
  });

  it('keeps capability names it does not know (later versions add more)', () => {
    expect(parse(lab({ capabilities: ['state', 'data', 'org.example.future'] })).success).toBe(true);
  });

  it('requires a content-addressed entry', () => {
    expect(parse(lab({ entry: 'pendulum.html' })).success).toBe(false);
    expect(parse(lab({ entry: 'sha256:ABC' })).success).toBe(false);
    expect(parse(lab({ assets: ['model.glb'] })).success).toBe(false);
  });

  it('requires id, version and title', () => {
    for (const k of ['id', 'version', 'title']) {
      const o = lab(); delete (o.lab as Record<string, unknown>)[k];
      expect(parse(o).success, k).toBe(false);
    }
  });

  it('caps params at 16 KiB serialised', () => {
    expect(parse(lab({ params: { blob: 'x'.repeat(LAB_PARAMS_MAX_BYTES - 20) } })).success).toBe(true);
    expect(parse(lab({ params: { blob: 'x'.repeat(LAB_PARAMS_MAX_BYTES) } })).success).toBe(false);
  });

  it("needs 'lab' with plugin chalk.lab, and allows it nowhere else", () => {
    expect(parse({ ...lab(), lab: undefined }).success).toBe(false);
    expect(parse({ ...lab(), plugin: 'org.example.widget' }).success).toBe(false);
    expect(parse({ ...lab(), plugin: undefined }).success).toBe(false);
  });

  it("allows 'plugin' only on embed: 'plugin'", () => {
    expect(parse({ id: 'v', type: 'embed', embed: 'video', x: 0, y: 0, width: 1, height: 1, plugin: 'org.example.x' }).success).toBe(false);
  });
});

describe('plugin ids (spec 1.1 §2.2)', () => {
  const widget = (plugin: string) => ({ id: 'w', type: 'embed', embed: 'plugin', x: 0, y: 0, width: 1, height: 1, plugin });

  it('accepts namespaced ids, including ones this reader cannot run', () => {
    for (const id of ['org.example.widget', 'bd.pathshalax.quiz-v2', 'chalk.future-type']) expect(parse(widget(id)).success, id).toBe(true);
  });

  it('rejects ids without a namespace or with other characters', () => {
    for (const id of ['lab', 'Org.Example', 'org..x', 'org.example.', 'org/example', '']) expect(parse(widget(id)).success, id).toBe(false);
  });

  it('keeps fields it does not know, so a writer preserves a plugin\'s own data', () => {
    const r = parse({ ...widget('org.example.widget'), widget: { level: 3, tags: ['a'] } });
    expect(r.success && (r.data as unknown as { widget: unknown }).widget).toEqual({ level: 3, tags: ['a'] });
    const l = parse(lab({ hints: { bn: 'দোলকটি টানো' } }));
    expect(l.success && isLabObject(l.data) && (l.data.lab as unknown as { hints: unknown }).hints).toEqual({ bn: 'দোলকটি টানো' });
  });

  it('still accepts a 1.0 plugin embed without an id', () => {
    expect(parse({ id: 'w', type: 'embed', embed: 'plugin', x: 0, y: 0, width: 1, height: 1 }).success).toBe(true);
  });
});
