import * as THREE from 'three';

export const FONT = '"Noto Sans", "Noto Sans Bengali", system-ui, sans-serif';

/** Canvas → texture. `draw` paints in canvas pixels. */
export function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, color = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * A texture wrapped around a cylinder/cone whose axis is the world X axis (see `axialCylinder`).
 * Draw in "surface millimetres": X = along the axis (mm from the part's left end, + to the right on screen),
 * Y = arc length from the front-facing line (mm, + downward on screen at the front). Text drawn with the
 * normal canvas API then reads correctly from the front.
 */
export function wrapTexture(opts: {
  lengthMm: number;
  radiusMm: number;
  pxPerMm: number;
  background: string;
  draw: (g: CanvasRenderingContext2D, circumferenceMm: number) => void;
}) {
  const circ = 2 * Math.PI * opts.radiusMm;
  const W = Math.min(4096, Math.round(circ * opts.pxPerMm));
  const H = Math.min(2048, Math.round(opts.lengthMm * opts.pxPerMm));
  const kY = W / circ, kX = H / opts.lengthMm;
  return canvasTexture(W, H, (g) => {
    g.fillStyle = opts.background;
    g.fillRect(0, 0, W, H);
    // (X, Y) mm → (column, row): column = W/2 + kY·Y, row = H − kX·X.
    const paint = (shiftY: number) => {
      g.setTransform(0, -kX, kY, 0, W / 2 + shiftY * kY, H);
      opts.draw(g, circ);
    };
    // Draw three times, one circumference apart, so marks near the seam wrap around.
    paint(0);
    paint(circ);
    paint(-circ);
    g.setTransform(1, 0, 0, 1, 0, 0);
  });
}

/** Cylinder or cone along +X from x0 to x1 (mm), UVs as `wrapTexture` expects (front = u 0.5). */
export function axialCylinder(r0: number, r1: number, x0: number, x1: number, segments = 96, open = false) {
  const geo = new THREE.CylinderGeometry(r1, r0, x1 - x0, segments, 1, open, Math.PI, Math.PI * 2);
  geo.rotateZ(-Math.PI / 2);
  geo.translate((x0 + x1) / 2, 0, 0);
  return geo;
}

/** Diamond knurl: greyscale bump/roughness pattern that tiles. */
export function knurlTexture(repeatX: number, repeatY: number) {
  const t = canvasTexture(128, 128, (g) => {
    g.fillStyle = '#9a9a9a';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#2a2a2a';
    g.lineWidth = 14;
    for (const d of [-128, 0, 128]) {
      g.beginPath(); g.moveTo(d, 0); g.lineTo(d + 128, 128); g.stroke();
      g.beginPath(); g.moveTo(d + 128, 0); g.lineTo(d, 128); g.stroke();
    }
  }, false);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  return t;
}

/** Wait for the UI/scale fonts before painting any canvas text (a canvas painted early never repaints). */
export async function fontsReady() {
  await Promise.all([
    document.fonts.load('600 40px "Noto Sans"'),
    document.fonts.load('500 40px "Noto Sans"'),
    document.fonts.load('600 40px "Noto Sans Bengali"'),
  ]).catch(() => undefined);
  await document.fonts.ready;
}
