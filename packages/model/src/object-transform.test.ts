import { describe, expect, it } from 'vitest';
import { MEDIA_ICON_SIZE, inkBox, moveObjectBy, objectBBox, scaleObjectAbout } from './object-transform.js';
import type {
  ArrowObject,
  EllipseObject,
  EmbedObject,
  ImageObject,
  InkObject,
  LessonObject,
  RectObject,
  TextObject,
} from './schema.js';

function rect(): RectObject {
  return { id: 'r1', type: 'rect', x: 10, y: 20, width: 40, height: 30, fill: '#f00', stroke: '#000', strokeWidth: 2 };
}
function text(): TextObject {
  return { id: 't1', type: 'text', x: 5, y: 5, text: 'hello', fontSize: 20, fill: '#000' };
}
function ink(): InkObject {
  return { id: 'i1', type: 'ink', x: 0, y: 0, points: [10, 10, 30, 10, 30, 40], color: '#111', size: 4 };
}
function arrow(): ArrowObject {
  return { id: 'a1', type: 'arrow', x: 0, y: 0, x2: 100, y2: 50, stroke: '#000', strokeWidth: 2 };
}
function image(): ImageObject {
  return { id: 'im1', type: 'image', x: 100, y: 100, width: 200, height: 100, assetId: 'sha256:' + 'a'.repeat(64) };
}
function embed(): EmbedObject {
  return { id: 'em1', type: 'embed', embed: 'video', x: 50, y: 60, width: 320, height: 180 };
}
function ellipse(): EllipseObject {
  return { id: 'e1', type: 'ellipse', x: 0, y: 0, width: 50, height: 50, fill: 'rgba(0,0,0,0)', stroke: '#000', strokeWidth: 1 };
}

describe('objectBBox', () => {
  it('uses the rect itself', () => {
    expect(objectBBox(rect())).toEqual({ x: 10, y: 20, width: 40, height: 30 });
  });

  it('normalizes a backwards arrow', () => {
    expect(objectBBox(arrow())).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    const back: ArrowObject = { ...arrow(), x: 100, y: 50, x2: 0, y2: 0 };
    expect(objectBBox(back)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it('takes ink extremes over its points', () => {
    expect(inkBox(ink())).toEqual({ x: 10, y: 10, width: 20, height: 30 });
  });

  it('reports vector as zero-sized (position only)', () => {
    const v = { id: 'v1', type: 'vector', x: 7, y: 8, path: 'M0 0' } as LessonObject;
    expect(objectBBox(v)).toEqual({ x: 7, y: 8, width: 0, height: 0 });
  });

  it('uses stored width/height for image/embed when displayMode is absent or "full"', () => {
    expect(objectBBox(image())).toEqual({ x: 100, y: 100, width: 200, height: 100 });
    expect(objectBBox({ ...image(), displayMode: 'full' })).toEqual({ x: 100, y: 100, width: 200, height: 100 });
    expect(objectBBox(embed())).toEqual({ x: 50, y: 60, width: 320, height: 180 });
  });

  it('uses the fixed MEDIA_ICON_SIZE for image/embed when displayMode is "icon"', () => {
    expect(objectBBox({ ...image(), displayMode: 'icon' })).toEqual({
      x: 100,
      y: 100,
      width: MEDIA_ICON_SIZE,
      height: MEDIA_ICON_SIZE,
    });
    expect(objectBBox({ ...embed(), displayMode: 'icon' })).toEqual({
      x: 50,
      y: 60,
      width: MEDIA_ICON_SIZE,
      height: MEDIA_ICON_SIZE,
    });
  });
});

describe('moveObjectBy', () => {
  it('shifts rect x/y only', () => {
    expect(moveObjectBy(rect(), 5, 7)).toMatchObject({ x: 15, y: 27, width: 40, height: 30 });
  });

  it('shifts both arrow endpoints', () => {
    expect(moveObjectBy(arrow(), 10, 10)).toMatchObject({ x: 10, y: 10, x2: 110, y2: 60 });
  });

  it('shifts every ink point pair', () => {
    expect(moveObjectBy(ink(), 1, 2)).toMatchObject({ points: [11, 12, 31, 12, 31, 42] });
  });
});

describe('scaleObjectAbout', () => {
  it('scales text font size, clamped and rounded', () => {
    expect(scaleObjectAbout(text(), 5, 5, 2)).toMatchObject({ fontSize: 40, x: 5, y: 5 });
    expect(scaleObjectAbout(text(), 5, 5, 0.01)).toMatchObject({ fontSize: 6 });
    expect(scaleObjectAbout({ ...text(), fontSize: 700 }, 0, 0, 4)).toMatchObject({ fontSize: 800 });
  });

  it('scales rect geometry and stroke about its top-left', () => {
    expect(scaleObjectAbout(rect(), 10, 20, 2)).toMatchObject({
      x: 10, y: 20, width: 80, height: 60, strokeWidth: 4,
    });
  });

  it('scales ellipse stroke and size', () => {
    expect(scaleObjectAbout(ellipse(), 0, 0, 1.5)).toMatchObject({
      width: 75, height: 75, strokeWidth: 1.5,
    });
  });

  it('scales the far endpoint of a line/arrow, keeping the anchor end planted', () => {
    expect(scaleObjectAbout(arrow(), 0, 0, 2)).toMatchObject({ x: 0, y: 0, x2: 200, y2: 100, strokeWidth: 4 });
  });

  it('scales image boxes', () => {
    expect(scaleObjectAbout(image(), 100, 100, 0.5)).toMatchObject({ width: 100, height: 50 });
  });

  it('scales ink points away from the anchor and thickens the stroke', () => {
    expect(scaleObjectAbout(ink(), 10, 10, 2)).toMatchObject({
      points: [10, 10, 50, 10, 50, 70],
      size: 8,
    });
  });

  it('ignores non-positive factors', () => {
    expect(scaleObjectByZero(rect(), 0)).toEqual(rect());
  });

  it('returns vector unchanged (no computable extent)', () => {
    const v = { id: 'v1', type: 'vector', x: 0, y: 0, path: 'M0 0L10 10' } as LessonObject;
    expect(scaleObjectAbout(v, 0, 0, 3)).toEqual(v);
  });
});

function scaleObjectByZero(obj: LessonObject, factor: number): LessonObject {
  return scaleObjectAbout(obj, 0, 0, factor);
}
