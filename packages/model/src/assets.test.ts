import { describe, expect, it } from 'vitest';
import { referencedAssetIds } from './assets.js';
import { createLesson } from './helpers.js';
import type { Lesson } from './lesson.js';

function lessonWith(pages: Lesson['pages']): Lesson {
  return { ...createLesson('T'), pages };
}

describe('referencedAssetIds', () => {
  it('collects pdf_page background assets (pdf + rendered image)', () => {
    const l = lessonWith([
      {
        id: 'p1',
        title: 'P',
        background: { type: 'pdf_page', assetId: 'sha256:pdf', pageNumber: 1, renderedImageAssetId: 'sha256:r' },
        objects: [],
      },
    ]);
    expect(referencedAssetIds(l).sort()).toEqual(['sha256:pdf', 'sha256:r']);
  });

  it('collects image object assets', () => {
    const l = lessonWith([
      {
        id: 'p1',
        title: 'P',
        background: { type: 'blank' },
        objects: [{ id: 'im', x: 0, y: 0, type: 'image', assetId: 'sha256:img', width: 10, height: 10 }],
      },
    ]);
    expect(referencedAssetIds(l)).toEqual(['sha256:img']);
  });

  it('collects embed assetId and poster, but not url', () => {
    const l = lessonWith([
      {
        id: 'p1',
        title: 'P',
        background: { type: 'blank' },
        objects: [
          { id: 'v', x: 0, y: 0, type: 'embed', embed: 'model3d', width: 10, height: 10, assetId: 'sha256:m', poster: 'sha256:p' },
          { id: 'vid', x: 0, y: 0, type: 'embed', embed: 'video', width: 10, height: 10, url: 'https://cdn/x.mp4' },
        ],
      },
    ]);
    expect(referencedAssetIds(l).sort()).toEqual(['sha256:m', 'sha256:p']);
  });

  it('dedups ids referenced by multiple pages/objects', () => {
    const bg = { type: 'pdf_page' as const, assetId: 'sha256:pdf', pageNumber: 1, renderedImageAssetId: 'sha256:r1' };
    const l = lessonWith([
      { id: 'p1', title: 'P1', background: bg, objects: [] },
      { id: 'p2', title: 'P2', background: { ...bg, pageNumber: 2, renderedImageAssetId: 'sha256:r2' }, objects: [] },
    ]);
    // shared pdf id appears once
    expect(referencedAssetIds(l).filter((id) => id === 'sha256:pdf')).toHaveLength(1);
    expect(referencedAssetIds(l).sort()).toEqual(['sha256:pdf', 'sha256:r1', 'sha256:r2']);
  });

  it('returns [] for a lesson with only blank pages and non-asset objects', () => {
    const l = lessonWith([
      {
        id: 'p1',
        title: 'P',
        background: { type: 'color', color: '#fff' },
        objects: [
          { id: 'r', x: 0, y: 0, type: 'rect', width: 1, height: 1, fill: '#000', stroke: '#000', strokeWidth: 1 },
          { id: 't', x: 0, y: 0, type: 'text', text: 'hi', fontSize: 12, fill: '#000' },
        ],
      },
    ]);
    expect(referencedAssetIds(l)).toEqual([]);
  });
});
