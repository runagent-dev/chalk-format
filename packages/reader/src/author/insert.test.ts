import { describe, expect, it } from 'vitest';
import { mediaKindOf } from './insert.js';

describe('what a file becomes', () => {
  it('goes by type, then by name for files browsers leave untyped', () => {
    expect(mediaKindOf({ name: 'a.png', type: 'image/png' })).toBe('image');
    expect(mediaKindOf({ name: 'a.webm', type: 'video/webm' })).toBe('video');
    expect(mediaKindOf({ name: 'a.mp3', type: 'audio/mpeg' })).toBe('audio');
    expect(mediaKindOf({ name: 'gauge.glb', type: '' })).toBe('model3d');
    expect(mediaKindOf({ name: 'pendulum.html', type: 'text/html' })).toBe('lab');
    expect(mediaKindOf({ name: 'notes.pdf', type: 'application/pdf' })).toBeNull();
  });
});
