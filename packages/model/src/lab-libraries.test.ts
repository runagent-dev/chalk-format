import { describe, expect, it } from 'vitest';
import { checkLabParams, labManifestSchema, labObjectFromManifest, labParams, inLanguage, lessonObjectSchema, migrateToLatest, parseLesson, referencedAssetIds, type Lesson } from './index.js';

const K = (c: string) => 'c1:' + c.repeat(25) + 'a';
const three = { specifier: 'three', version: '0.183.0', asset: K('t') };
const lab = (extra: Record<string, unknown> = {}) => ({ id: 'l', type: 'embed', embed: 'plugin', plugin: 'chalk.lab', x: 0, y: 0, width: 960, height: 540,
  lab: { id: 'org.example.gauge', version: '1.0.0', title: 'Gauge', entry: K('e'), ...extra } });

describe('lab libraries (spec 1.5 §2)', () => {
  it('accepts libraries by bare specifier and content-addressed asset', () => {
    expect(lessonObjectSchema.safeParse(lab({ libraries: [three, { specifier: 'three/addons/controls/OrbitControls.js', version: '0.183.0', asset: K('o') }] })).success).toBe(true);
  });
  it('refuses relative or URL specifiers, plain ids, and a specifier twice', () => {
    for (const specifier of ['./three.js', '/three.js', 'https://cdn.example/three.js']) expect(lessonObjectSchema.safeParse(lab({ libraries: [{ ...three, specifier }] })).success, specifier).toBe(false);
    expect(lessonObjectSchema.safeParse(lab({ libraries: [{ ...three, asset: 'three.js' }] })).success).toBe(false);
    expect(lessonObjectSchema.safeParse(lab({ libraries: [three, three] })).success).toBe(false);
  });
  it('counts libraries among the assets a book uses (so they are packed, streamed, stored)', () => {
    const l: Lesson = { id: 'b', title: 'B', locale: 'bn', createdAt: '', updatedAt: '', snipPages: [], pages: [{ id: 'p', title: 'P', background: { type: 'blank' }, objects: [lab({ libraries: [three] }) as never] }] };
    expect(referencedAssetIds(l)).toContain(three.asset);
  });
  it('migrates a v10 book unchanged', () => {
    const v10 = { id: 'b', title: 'B', locale: 'bn', createdAt: '', updatedAt: '', snipPages: [], pages: [{ id: 'p', title: 'P', background: { type: 'blank' }, objects: [lab()] }] };
    expect(migrateToLatest(v10, 10)).toBe(v10);
    expect(() => parseLesson(v10)).not.toThrow();
  });
});

const manifest = labManifestSchema.parse({
  format: 'chalk.lab', manifestVersion: 1, id: 'org.example.gauge', version: '1.0.0', title: { bn: 'স্ক্রু গজ', en: 'Screw gauge' },
  entry: K('e'), poster: K('p'), libraries: [three], capabilities: ['state'], size: { width: 960, height: 600 },
  params: { type: 'object', properties: {
    pitch: { type: 'number', minimum: 0.25, maximum: 1, multipleOf: 0.25, default: 0.5 },
    divisions: { type: 'integer', enum: [50, 100], default: 50 },
    zeroError: { type: 'boolean', default: false },
  } },
  presets: [{ id: 'practice', title: 'Practice', params: { zeroError: true } }],
});

describe('lab manifests (spec 1.5 §4)', () => {
  it('starts from defaults, then a preset, then the designer', () => {
    expect(labParams(manifest)).toEqual({ pitch: 0.5, divisions: 50, zeroError: false });
    expect(labParams(manifest, 'practice', { pitch: 0.75 })).toEqual({ pitch: 0.75, divisions: 50, zeroError: true });
  });
  it('checks settings against the schema', () => {
    expect(checkLabParams(manifest, { pitch: 0.75, divisions: 100 })).toEqual([]);
    expect(checkLabParams(manifest, { pitch: 0.3 })).toEqual(['pitch: a multiple of 0.25']);
    expect(checkLabParams(manifest, { pitch: 2, divisions: 60, zeroError: 'yes', colour: 'red' })).toHaveLength(4);
  });
  it('places a lab: the descriptor from the manifest, the title in the book\'s language, a valid object', () => {
    const o = labObjectFromManifest(manifest, { id: 'x', x: 10, y: 20, locale: 'bn', width: 480 });
    expect(lessonObjectSchema.safeParse(o).success).toBe(true);
    expect(o).toMatchObject({ width: 480, height: 300, poster: K('p'), lab: { title: 'স্ক্রু গজ', libraries: [three], params: { pitch: 0.5 } } });
    expect(() => labObjectFromManifest(manifest, { id: 'y', x: 0, y: 0, locale: 'en', params: { pitch: 9 } })).toThrow(/at most 1/);
    expect(inLanguage(manifest.title, 'fr')).toBe('Screw gauge');
  });
});
