import * as THREE from 'three';
import { FONT, canvasTexture, knurlColorTexture, knurlTexture } from '../../core/textures';
import { fmt, leastCount, vsd, zeroError, type VernierSettings } from './reading';

// A 150 mm vernier caliper, built in millimetres (root scales to metres). Beam along +X, scales face +Z.
// One opening D drives every measuring surface, as on a real caliper:
//   outside jaws (below the beam): fixed face x = 0, moving face x = D
//   inside jaws (knife edges above the beam): fixed outer edge x = 0, moving outer edge x = D
//   depth rod: its tip sticks out of the beam end (x = BEAM_END) by D
// Named parts (`part:*`) follow the Chalk 3D asset profile.

export const RANGE = 150;
export const BEAM_END = 222;
const BEAM = { x0: -14, x1: BEAM_END, y0: 0, y1: 16, t: 3.5 };
const SCALE_X1 = 160; // the scaled part of the beam (its own mesh, so its texture can be sharp)
const OFF = 4; // main-scale zero sits 4 mm right of the fixed jaw face; the vernier zero 4 mm right of the moving face
const PLATE = { len: 58, y0: -4, y1: 7.5 }; // vernier plate on the slider front (x from D)
const Z_FRONT = BEAM.t / 2;

const steel = () => new THREE.MeshStandardMaterial({ color: 0xc9ced3, metalness: 0.85, roughness: 0.32 });
const darkSteel = () => new THREE.MeshStandardMaterial({ color: 0x9aa1a7, metalness: 0.9, roughness: 0.36 });

function box(name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: THREE.Material | THREE.Material[]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.name = name;
  return m;
}

function extruded(name: string, pts: [number, number][], z0: number, z1: number, mat: THREE.Material) {
  const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  // the bevel adds 0.15 mm on each side, so extrude 0.3 mm less to span exactly z0…z1
  const geo = new THREE.ExtrudeGeometry(s, { depth: z1 - z0 - 0.3, bevelEnabled: true, bevelThickness: 0.15, bevelSize: 0.15, bevelSegments: 1 });
  geo.translate(0, 0, z0 + 0.15);
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  return m;
}

/** Texture for a box's +Z face, drawn in mm with Y up (origin = bottom-left of the face). */
function faceTexture(wMm: number, hMm: number, pxPerMm: number, background: string, draw: (g: CanvasRenderingContext2D) => void) {
  const W = Math.min(4096, Math.round(wMm * pxPerMm)), H = Math.round(hMm * pxPerMm), k = W / wMm;
  return canvasTexture(W, H, (g) => {
    g.fillStyle = background;
    g.fillRect(0, 0, W, H);
    g.setTransform(k, 0, 0, -k, 0, H); // mm, Y up
    draw(g);
    g.setTransform(1, 0, 0, 1, 0, 0);
  });
}

/** Text in a Y-up transform (flip locally so glyphs stay upright). */
function text(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, align: CanvasTextAlign = 'center', weight = 700) {
  g.save();
  g.translate(x, y);
  g.scale(1, -1);
  g.font = `${weight} ${size}px ${FONT}`;
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  g.fillText(s, 0, 0);
  g.restore();
}

function mainScaleTexture() {
  const w = SCALE_X1 - BEAM.x0, h = BEAM.y1 - BEAM.y0, base = PLATE.y1; // ticks rise from the plate's top edge
  return faceTexture(w, h, 23, '#e9ebe6', (g) => {
    g.strokeStyle = g.fillStyle = '#0a0c0d';
    g.lineWidth = 0.13;
    for (let mm = 0; mm <= RANGE; mm++) {
      const x = mm + OFF - BEAM.x0;
      const len = mm % 10 === 0 ? 4.6 : mm % 5 === 0 ? 3.4 : 2.4;
      g.beginPath(); g.moveTo(x, base); g.lineTo(x, base + len); g.stroke();
      if (mm % 10 === 0) text(g, String(mm / 10), x, base + 5.2, 2.5);
    }
    text(g, 'cm', 2.2 - BEAM.x0 + 150 + OFF + 3, base + 5.2, 1.9, 'left', 600);
    text(g, 'mm', OFF - BEAM.x0 - 7.5, base + 1.2, 1.6, 'center', 600);
  });
}

function plateTexture(s: VernierSettings) {
  const h = PLATE.y1 - PLATE.y0, top = h, x0 = OFF + zeroError(s), step = vsd(s), lc = leastCount(s);
  // Label every 0.5 mm-equivalent on a 10-division vernier (0, 5, 10), every 0.1 mm on 20/50 (spacing stays ≥ 1.9 mm).
  const labelEvery = s.divisions === 10 ? 5 : s.divisions === 20 ? 2 : 5;
  const labelSize = s.divisions === 20 ? 1.3 : 1.6;
  return faceTexture(PLATE.len, h, 64, '#e9ebe6', (g) => {
    g.strokeStyle = g.fillStyle = '#0a0c0d';
    g.lineWidth = 0.1;
    for (let k = 0; k <= s.divisions; k++) {
      const x = x0 + k * step;
      const long = k % labelEvery === 0;
      const len = long ? 3.0 : 2.0;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, top - len); g.stroke();
      if (long) text(g, String(Math.round(k * lc * 10)), x, top - len - 1.8, labelSize);
    }
    g.fillStyle = '#3d0a8c';
    text(g, `${fmt(lc, lc)} mm`, PLATE.len - 3, 1.6, 1.7, 'right');
  });
}

export function buildCaliper(initial: VernierSettings) {
  const root = new THREE.Group();
  root.name = 'vernier-caliper';
  root.scale.setScalar(0.001);

  // ── beam (fixed) ────────────────────────────────────────────────────────
  const s = steel();
  const scaleMat = new THREE.MeshStandardMaterial({ map: mainScaleTexture(), metalness: 0.3, roughness: 0.5 });
  root.add(box('part:beam_scale', BEAM.x0, SCALE_X1, BEAM.y0, BEAM.y1, -BEAM.t / 2, BEAM.t / 2, [s, s, s, s, scaleMat, s]));
  const plainFace = new THREE.MeshStandardMaterial({ color: 0xe9ebe6, metalness: 0.3, roughness: 0.5 }); // matches the scale face
  root.add(box('part:beam', SCALE_X1, BEAM.x1, BEAM.y0, BEAM.y1, -BEAM.t / 2, BEAM.t / 2, [s, s, s, s, plainFace, s]));
  // fixed outside jaw (below), measuring face at x = 0
  root.add(extruded('part:jaw_fixed', [[0, 0.5], [0, -40], [-1.2, -42], [-4.5, -40.6], [-10.5, -30], [-14, -9], [-14, 0.5]], -BEAM.t / 2, BEAM.t / 2, s));
  // fixed inside jaw (above): front half, outer measuring edge x = 0 near the tip
  root.add(extruded('part:inside_jaw_fixed', [[-7, 15.5], [-1, 15.5], [-0.25, 19.4], [2.6, 25], [2.4, 31.6], [0.3, 32.6], [0, 31], [0, 26], [-7, 18.5]], 0.05, BEAM.t / 2, s));

  // ── slider (moves with D) ───────────────────────────────────────────────
  const slider = new THREE.Group();
  slider.name = 'part:slider';
  const ds = darkSteel();
  const plateMat = new THREE.MeshStandardMaterial({ map: plateTexture(initial), metalness: 0.3, roughness: 0.5 });
  const zf0 = Z_FRONT + 0.1, zf1 = Z_FRONT + 0.9;
  slider.add(box('part:vernier_plate', 0, PLATE.len, PLATE.y0, PLATE.y1, zf0, zf1, [s, s, s, s, plateMat, s]));
  slider.add(box('part:slider_top_front', 0, PLATE.len, BEAM.y1 + 0.15, BEAM.y1 + 3, zf0, zf1, s));
  slider.add(box('part:slider_back', 0, PLATE.len, PLATE.y0, BEAM.y1 + 3, -zf1, -zf0, s));
  slider.add(box('part:slider_top', 0, PLATE.len, BEAM.y1 + 0.15, BEAM.y1 + 3, -zf0, zf0, s));
  slider.add(box('part:slider_bottom', 0, PLATE.len, PLATE.y0, BEAM.y0 - 0.15, -zf0, zf0, s));
  // moving outside jaw, measuring face at x = D (slider origin)
  slider.add(extruded('part:jaw_moving', [[0, PLATE.y0 + 0.2], [0, -40], [1.2, -42], [4.5, -40.6], [10.5, -30], [13, -9], [13, PLATE.y0 + 0.2]], -BEAM.t / 2, BEAM.t / 2, s));
  // moving inside jaw: back half, outer measuring edge x = D near the tip
  slider.add(extruded('part:inside_jaw_moving', [[7, BEAM.y1 + 2.8], [1, BEAM.y1 + 2.8], [-2.6, 25], [-2.4, 31.6], [-0.3, 32.6], [0, 31], [0, 26], [7, 21.5]], -BEAM.t / 2, -0.05, s));
  // lock screw and thumb roller
  const knob = (rx: number, ry: number) => new THREE.MeshStandardMaterial({ map: knurlColorTexture(rx, ry), bumpMap: knurlTexture(rx, ry), bumpScale: 1.5, metalness: 0.6, roughness: 0.45 });
  const screw = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 2.7, 3.2, 40), knob(4, 1));
  screw.position.set(30, BEAM.y1 + 3 + 1.9, 0);
  screw.name = 'part:lock_screw';
  slider.add(screw);
  const roller = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 2.8, 40), knob(5, 0.6));
  roller.rotation.x = Math.PI / 2;
  roller.position.set(46, PLATE.y0 - 3, 0);
  roller.name = 'part:thumb_roller';
  slider.add(roller);
  slider.add(box('part:roller_bracket', 41, 51, PLATE.y0 - 0.6, PLATE.y0, -1.6, 1.6, ds));
  // depth rod: runs inside the beam, attached to the slider; only its end outside the beam shows
  slider.add(box('part:depth_rod', 20, BEAM_END, 3, 6, -1.4, -0.6, ds));
  root.add(slider);

  let settings = { ...initial };
  let opening = 0;
  // The scales encode the reading (incl. zero error); the slider itself sits at the true opening.
  const place = () => { slider.position.x = opening; };
  place();

  return {
    root,
    slider,
    handles: [slider] as THREE.Object3D[],
    /** Depth-rod tip position (mm) for the current opening. */
    rodTip: () => BEAM_END + opening,
    setSettings(next: VernierSettings) {
      settings = { ...next };
      plateMat.map?.dispose();
      plateMat.map = plateTexture(settings);
      plateMat.needsUpdate = true;
    },
    setOpening(mm: number) {
      opening = mm;
      place();
    },
  };
}

export type Caliper = ReturnType<typeof buildCaliper>;
export const VERNIER_LENGTH = (s: VernierSettings) => (s.divisions - 1) * 1;
export const SCALE_ZERO_X = OFF;
export const PLATE_TOP = PLATE.y1;
