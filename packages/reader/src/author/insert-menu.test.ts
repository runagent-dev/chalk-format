import { describe, expect, it } from 'vitest';
import { menuPosition } from './InsertMenu.js';

const menu = { width: 190, height: 250 }, box = { width: 1200, height: 800 };

describe('where the right-click menu is drawn', () => {
  it('opens at the pointer when there is room', () => {
    expect(menuPosition({ x: 300, y: 200 }, menu, box)).toEqual({ left: 300, top: 200 });
  });
  it('is pushed left when it would run off the right edge', () => {
    expect(menuPosition({ x: 1150, y: 200 }, menu, box)).toEqual({ left: 1200 - 190 - 8, top: 200 });
  });
  it('flips above the pointer when there is no room below', () => {
    expect(menuPosition({ x: 300, y: 700 }, menu, box)).toEqual({ left: 300, top: 700 - 250 });
  });
  it('does both in the bottom right corner', () => {
    expect(menuPosition({ x: 1190, y: 790 }, menu, box)).toEqual({ left: 1200 - 190 - 8, top: 790 - 250 });
  });
  it('never leaves the top left, even in a box smaller than the menu', () => {
    expect(menuPosition({ x: 2, y: 3 }, menu, box)).toEqual({ left: 8, top: 3 });
    expect(menuPosition({ x: 100, y: 100 }, menu, { width: 100, height: 100 })).toEqual({ left: 8, top: 8 });
  });
});
