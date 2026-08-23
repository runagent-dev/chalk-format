import { describe, expect, it } from 'vitest';
import {
  CHALK_FORMAT_VERSION,
  lessonSchema,
  parseLesson,
  safeParseLesson,
  validateLessonModel,
} from './schema.js';
import { createLesson } from './helpers.js';

function validLesson() {
  const lesson = createLesson('Valid');
  return {
    ...lesson,
    pages: [
      {
        ...lesson.pages[0]!,
        width: 1600,
        height: 900,
        background: {
          type: 'pdf_page',
          assetId: 'sha256:pdf',
          pageNumber: 1,
          renderedImageAssetId: 'sha256:r',
        },
        objects: [
          { id: 'r1', x: 1, y: 2, type: 'rect', width: 3, height: 4, fill: '#f00', stroke: '#000', strokeWidth: 1 },
          { id: 'i1', x: 0, y: 0, type: 'ink', points: [0, 0, 1, 1], color: '#111', size: 4 },
          { id: 't1', x: 5, y: 6, type: 'text', text: 'hi', fontSize: 20, fill: '#000' },
        ],
      },
    ],
  };
}

describe('lessonSchema', () => {
  it('parses a well-formed lesson from createLesson()', () => {
    expect(() => parseLesson(createLesson('X'))).not.toThrow();
  });

  it('parses a lesson with every object type and a pdf_page background', () => {
    const parsed = parseLesson(validLesson());
    expect(parsed.pages[0]!.objects).toHaveLength(3);
  });

  it('accepts blank and color backgrounds', () => {
    expect(lessonSchema.safeParse({ ...validLesson(), pages: [{ id: 'p', title: 't', background: { type: 'blank' }, objects: [] }] }).success).toBe(true);
    expect(lessonSchema.safeParse({ ...validLesson(), pages: [{ id: 'p', title: 't', background: { type: 'color', color: '#fff' }, objects: [] }] }).success).toBe(true);
  });

  it('accepts an image background (a frozen region-snip capture)', () => {
    const parsed = lessonSchema.safeParse({
      ...validLesson(),
      pages: [{ id: 'p', title: 't', background: { type: 'image', assetId: 'sha256:cap' }, objects: [] }],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a snip object pointing at a satellite page, and defaults snipPages to []', () => {
    const lesson = validLesson();
    const snipPageId = 'snippage_1';
    const withSnip = {
      ...lesson,
      pages: [
        {
          ...lesson.pages[0]!,
          objects: [
            ...lesson.pages[0]!.objects,
            { id: 's1', x: 10, y: 20, type: 'snip', snipPageId },
          ],
        },
      ],
      snipPages: [
        { id: snipPageId, title: 'Snip', background: { type: 'image', assetId: 'sha256:cap' }, objects: [] },
      ],
    };
    const parsed = parseLesson(withSnip);
    expect(parsed.pages[0]!.objects).toHaveLength(4);
    expect(parsed.snipPages).toHaveLength(1);
  });

  it('defaults snipPages to [] when absent (pre-v5 documents)', () => {
    const lesson = validLesson() as Record<string, unknown>;
    delete lesson.snipPages;
    const parsed = parseLesson(lesson);
    expect(parsed.snipPages).toEqual([]);
  });

  it('rejects an object with an unknown type', () => {
    const bad = validLesson();
    (bad.pages[0]!.objects as unknown[])[0] = { id: 'x', x: 0, y: 0, type: 'triangle' };
    expect(safeParseLesson(bad).success).toBe(false);
  });

  it('rejects a rect missing a required field', () => {
    const bad = validLesson();
    delete (bad.pages[0]!.objects[0] as Record<string, unknown>).strokeWidth;
    expect(safeParseLesson(bad).success).toBe(false);
  });

  it('rejects a background with an unknown type', () => {
    const bad = { ...validLesson(), pages: [{ id: 'p', title: 't', background: { type: 'gradient' }, objects: [] }] };
    expect(safeParseLesson(bad).success).toBe(false);
  });

  it('rejects a non-string id', () => {
    const bad = validLesson();
    (bad as Record<string, unknown>).id = 42;
    expect(safeParseLesson(bad).success).toBe(false);
  });

  it('parseLesson throws on invalid input', () => {
    expect(() => parseLesson({ nope: true })).toThrow();
  });
});

describe('validateLessonModel', () => {
  it('reports ok for a valid lesson', () => {
    expect(validateLessonModel(createLesson('Y'))).toEqual({ ok: true });
  });
  it('reports issues with paths for an invalid lesson', () => {
    const result = validateLessonModel({ id: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });
});

describe('CHALK_FORMAT_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(CHALK_FORMAT_VERSION)).toBe(true);
    expect(CHALK_FORMAT_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('is 5 now that lessons carry snipPages', () => {
    expect(CHALK_FORMAT_VERSION).toBe(5);
  });
});

describe('rich item types (schema v3)', () => {
  const page = (obj: unknown) => {
    const l = createLesson('R');
    return { ...l, pages: [{ ...l.pages[0]!, objects: [obj] }] };
  };
  const ok = (obj: unknown) => safeParseLesson(page(obj)).success;

  it('accepts an image object', () => {
    expect(ok({ id: 'im', x: 1, y: 2, type: 'image', assetId: 'sha256:i', width: 100, height: 80 })).toBe(true);
  });
  it('accepts an ellipse object', () => {
    expect(ok({ id: 'e', x: 0, y: 0, type: 'ellipse', width: 50, height: 30, fill: '#f00', stroke: '#000', strokeWidth: 2 })).toBe(true);
  });
  it('accepts line and arrow objects', () => {
    expect(ok({ id: 'l', x: 0, y: 0, type: 'line', x2: 10, y2: 20, stroke: '#000', strokeWidth: 2 })).toBe(true);
    expect(ok({ id: 'a', x: 0, y: 0, type: 'arrow', x2: 10, y2: 20, stroke: '#000', strokeWidth: 2 })).toBe(true);
  });
  it('accepts a vector object', () => {
    expect(ok({ id: 'v', x: 0, y: 0, type: 'vector', path: 'M0 0 L10 10', stroke: '#000' })).toBe(true);
  });
  it('accepts an embed object referencing external media', () => {
    expect(ok({ id: 'v3', x: 0, y: 0, type: 'embed', embed: 'model3d', width: 200, height: 200, assetId: 'sha256:m', poster: 'sha256:p' })).toBe(true);
    expect(ok({ id: 'vid', x: 0, y: 0, type: 'embed', embed: 'video', width: 320, height: 180, url: 'https://cdn/x.mp4' })).toBe(true);
  });
  it('rejects an embed with an unknown kind', () => {
    expect(ok({ id: 'x', x: 0, y: 0, type: 'embed', embed: 'hologram', width: 1, height: 1 })).toBe(false);
  });
  it('rejects an image missing its assetId', () => {
    expect(ok({ id: 'im', x: 0, y: 0, type: 'image', width: 1, height: 1 })).toBe(false);
  });
});

describe('textLayer (schema v2)', () => {
  it('accepts a page with an extracted text layer', () => {
    const lesson = createLesson('T');
    const withText = {
      ...lesson,
      pages: [
        {
          ...lesson.pages[0]!,
          textLayer: [
            { text: 'Hello', x: 10, y: 20, width: 60, fontSize: 16 },
            { text: 'World', x: 80, y: 20, width: 55, fontSize: 16 },
          ],
        },
      ],
    };
    expect(safeParseLesson(withText).success).toBe(true);
  });

  it('still accepts a page with no textLayer (optional, backward compatible)', () => {
    expect(safeParseLesson(createLesson('NoText')).success).toBe(true);
  });

  it('rejects a text run missing a required field', () => {
    const lesson = createLesson('Bad');
    const bad = {
      ...lesson,
      pages: [{ ...lesson.pages[0]!, textLayer: [{ text: 'x', y: 0, width: 1, fontSize: 1 }] }],
    };
    expect(safeParseLesson(bad).success).toBe(false);
  });
});
