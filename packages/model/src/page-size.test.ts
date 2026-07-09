import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_HEIGHT, DEFAULT_PAGE_WIDTH, getPageSize } from './lesson.js';
import { createLesson } from './helpers.js';

describe('getPageSize', () => {
  it('returns explicit page dimensions when present', () => {
    const lesson = createLesson();
    const page = { ...lesson.pages[0]!, width: 1200, height: 1553 };
    expect(getPageSize(page)).toEqual({ width: 1200, height: 1553 });
  });

  it('falls back to the default board size for legacy pages', () => {
    const lesson = createLesson();
    expect(getPageSize(lesson.pages[0]!)).toEqual({
      width: DEFAULT_PAGE_WIDTH,
      height: DEFAULT_PAGE_HEIGHT,
    });
  });
});
