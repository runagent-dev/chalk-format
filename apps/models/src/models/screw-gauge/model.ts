import * as THREE from 'three';
import { FONT, axialCylinder, canvasTexture, knurlColorTexture, knurlTexture, wrapTexture } from '../../core/textures';
import { fmt, indicated, leastCount, zeroError, type GaugeSettings } from './reading';
import { SPECIMENS, buildSpecimen, buildTray, applyPose, type Specimen } from './specimens';

// A 0–25 mm outside micrometer, built in millimetres (the root group scales to metres).
// Axis of anvil/spindle = +X through y = z = 0. The anvil face is at x = 0; the spindle face is at x = gap.
// Named parts (`part:*`) follow the Chalk 3D asset profile so the model can be exported as GLB.

const RANGE = 25;
const ZERO_X = 50; // sleeve position of the main-scale zero (when there is no zero error)
const SLEEVE = { x0: 46, x1: 86, r: 7.2 };
const ROD_R = 6.35 / 2;

const steel = () => new THREE.MeshStandardMaterial({ color: 0xdfe3e6, metalness: 1, roughness: 0.24 });
const brassySteel = () => new THREE.MeshStandardMaterial({ color: 0xe2dab0, metalness: 0.95, roughness: 0.26 });
const carbide = () => new THREE.MeshStandardMaterial({ color: 0x8c9196, metalness: 1, roughness: 0.42 });

function mesh(name: string, geo: THREE.BufferGeometry, mat: THREE.Material) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  return m;
}

/** Frame outline in the XY plane: a C opening upward, arms holding anvil (left) and spindle hub (right). */
function frameShape() {
  const s = new THREE.Shape();
  s.moveTo(-18, 8);
  s.lineTo(-4, 8);
  s.lineTo(-4, -10);
  s.absarc(13, -10, 17, Math.PI, Math.PI * 2, false); // inner bow, bottom at y = −27
  s.lineTo(30, 8);
  s.lineTo(48, 8);
  s.lineTo(48, -12);
  s.absarc(15, -12, 33, 0, -Math.PI, true); // outer bow, bottom at y = −45
  s.lineTo(-18, 8);
  return s;
}

/** Heat-insulating plate on the frame's front face (C band between the two bows). */
function plateShape() {
  const cx = 14, cy = -11, r0 = 20.6, r1 = 29.4, a0 = Math.PI + 0.12, a1 = Math.PI * 2 - 0.12;
  const s = new THREE.Shape();
  s.absarc(cx, cy, r1, a0, a1, false);
  s.absarc(cx, cy, r0, a1, a0, true);
  s.closePath();
  return s;
}

function plateTexture(s: GaugeSettings) {
  // ExtrudeGeometry caps use (x, y) in mm as UVs; this texture covers x −20…50, y −46…−8.
  const X0 = -20, Y0 = -46, W = 70, H = 38, k = 24;
  const lc = leastCount(s);
  const t = canvasTexture(W * k, H * k, (g) => {
    g.fillStyle = '#3d0a8c';
    g.fillRect(0, 0, W * k, H * k);
    const at = (x: number, y: number) => [(x - X0) * k, (Y0 + H - y) * k] as const;
    g.textAlign = 'center';
    g.fillStyle = '#ffffff';
    // Keep both lines inside the curved band: it is only ~9 mm tall and narrows toward the sides.
    g.font = `600 ${1.9 * k}px ${FONT}`;
    g.fillText(`1 MSD = pitch = ${s.pitch} mm`, ...at(14, -33.6));
    g.fillStyle = '#ffb32b';
    g.font = `600 ${1.6 * k}px ${FONT}`;
    g.fillText(`LC = ${fmt(lc, lc)} mm  ·  0–25 mm`, ...at(14, -36.7));
  });
  t.repeat.set(1 / W, 1 / H);
  t.offset.set(-X0 / W, -Y0 / H);
  return t;
}

function sleeveTexture(s: GaugeSettings) {
  const zero = ZERO_X - zeroError(s) - SLEEVE.x0; // sleeve-local X of the main-scale zero
  return wrapTexture({
    lengthMm: SLEEVE.x1 - SLEEVE.x0,
    radiusMm: SLEEVE.r,
    pxPerMm: 48,
    background: '#eef0ea',
    draw: (g) => {
      g.strokeStyle = g.fillStyle = '#0a0c0d';
      g.lineWidth = 0.13;
      g.beginPath();
      g.moveTo(zero - 1.2, 0);
      g.lineTo(SLEEVE.x1 - SLEEVE.x0 - 1, 0); // datum (index) line
      g.stroke();
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      g.font = `700 1.75px ${FONT}`;
      for (let mm = 0; mm <= RANGE; mm++) {
        const x = zero + mm;
        const long = mm % 5 === 0;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, long ? -2.0 : -1.35);
        g.stroke();
        if (long) g.fillText(String(mm), x, -2.4);
      }
      if (s.pitch < 1) {
        // lower half-mm marks
        for (let v = s.pitch; v < RANGE; v += s.pitch) {
          if (Math.abs(v - Math.round(v)) < 1e-6) continue;
          g.beginPath();
          g.moveTo(zero + v, 0);
          g.lineTo(zero + v, 1.35);
          g.stroke();
        }
      }
    },
  });
}

const BEVEL = { len: 4.5, r0: 7.32, r1: 8.6 };

function thimbleTexture(s: GaugeSettings) {
  return wrapTexture({
    lengthMm: BEVEL.len,
    radiusMm: (BEVEL.r0 + BEVEL.r1) / 2,
    pxPerMm: 120,
    background: '#eceee8',
    draw: (g, circ) => {
      g.strokeStyle = g.fillStyle = '#0a0c0d';
      g.lineWidth = 0.1;
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.font = `700 0.92px ${FONT}`;
      const step = circ / s.divisions;
      const numberEvery = s.divisions >= 100 ? 10 : 5;
      for (let k = 0; k < s.divisions; k++) {
        const y = -k * step; // division k sits k steps above the front line at zero rotation
        const long = k % numberEvery === 0;
        g.beginPath();
        g.moveTo(0.05, y);
        g.lineTo(long ? 2.3 : 1.45, y);
        g.stroke();
        if (long) g.fillText(String(k), 2.5, y);
      }
    },
  });
}

export function buildScrewGauge(initial: GaugeSettings) {
  const root = new THREE.Group();
  root.name = 'screw-gauge';
  root.scale.setScalar(0.001); // mm → m

  // Frame (painted) + insulating plate
  const frameGeo = new THREE.ExtrudeGeometry(frameShape(), { depth: 10, bevelEnabled: true, bevelThickness: 1, bevelSize: 1, bevelSegments: 3, curveSegments: 64 });
  frameGeo.translate(0, 0, -5);
  const paint = new THREE.MeshStandardMaterial({ color: 0x8d9c90, metalness: 0.7, roughness: 0.32 }); // gunmetal-green, Simphy-like
  root.add(mesh('part:frame', frameGeo, paint));
  const plateGeo = new THREE.ExtrudeGeometry(plateShape(), { depth: 0.6, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 2, curveSegments: 64 });
  plateGeo.translate(0, 0, 5.75); // frame face is at z = 6; the plate stands 0.55 mm proud
  const plateMat = new THREE.MeshStandardMaterial({ map: plateTexture(initial), metalness: 0.05, roughness: 0.5 });
  root.add(mesh('part:plate', plateGeo, plateMat));
  const backGeo = new THREE.ExtrudeGeometry(plateShape(), { depth: 0.6, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 2, curveSegments: 64 });
  backGeo.translate(0, 0, -6.35); // mirror of the front plate on the back face (z = −6), plain (text would read mirrored)
  root.add(mesh('part:plate_back', backGeo, new THREE.MeshStandardMaterial({ color: 0x3d0a8c, metalness: 0.05, roughness: 0.5 })));

  // Hub boss on the right arm, lock ring, anvil
  root.add(mesh('part:hub', axialCylinder(8.2, 8.2, 30, 47.5), paint));
  const knurled = (rx: number, ry: number) => {
    const bump = knurlTexture(rx, ry);
    return new THREE.MeshStandardMaterial({ map: knurlColorTexture(rx, ry), metalness: 0.6, roughness: 0.45, bumpMap: bump, bumpScale: 2 });
  };
  root.add(mesh('part:lock_ring', axialCylinder(5.6, 5.6, 25.4, 30), knurled(10, 1)));
  root.add(mesh('part:anvil', axialCylinder(ROD_R, ROD_R, -18.5, -0.9), steel()));
  root.add(mesh('part:anvil_face', axialCylinder(ROD_R, ROD_R, -0.9, 0), carbide()));

  // Sleeve (barrel) with the main scale
  // Satin, not mirror: the scale must stay readable under any light.
  const sleeveMat = new THREE.MeshStandardMaterial({ map: sleeveTexture(initial), metalness: 0.3, roughness: 0.5 });
  root.add(mesh('part:sleeve', axialCylinder(SLEEVE.r, SLEEVE.r, SLEEVE.x0, SLEEVE.x1), sleeveMat));

  // Spindle (moves with the thimble)
  const spindle = new THREE.Group();
  spindle.name = 'part:spindle';
  spindle.add(mesh('part:spindle_face', axialCylinder(ROD_R, ROD_R, 0, 0.9), carbide()));
  spindle.add(mesh('part:spindle_rod', axialCylinder(ROD_R, ROD_R, 0.9, 31), brassySteel()));
  root.add(spindle);

  // Thimble + ratchet (group origin = the bevel's front edge), turns about X
  const thimble = new THREE.Group();
  thimble.name = 'part:thimble';
  const bevelMat = new THREE.MeshStandardMaterial({ map: thimbleTexture(initial), metalness: 0.3, roughness: 0.48 });
  thimble.add(mesh('part:thimble_scale', axialCylinder(BEVEL.r0, BEVEL.r1, 0, BEVEL.len, 128, true), bevelMat));
  thimble.add(mesh('part:thimble_body', axialCylinder(8.6, 8.6, BEVEL.len, 16, 96, true), steel()));
  thimble.add(mesh('part:thimble_grip', axialCylinder(8.75, 8.75, 16, 42, 96, true), knurled(9, 1.4)));
  thimble.add(mesh('part:thimble_rear', axialCylinder(8.6, 8.6, 42, 46, 96, true), steel()));
  thimble.add(mesh('part:thimble_cap', axialCylinder(8.6, 4.2, 46, 48.5, 96), steel()));
  thimble.add(mesh('part:ratchet_neck', axialCylinder(4, 4, 48.5, 50.5), steel()));
  thimble.add(mesh('part:ratchet', axialCylinder(5.3, 5.3, 50.5, 61), knurled(6, 1)));
  thimble.add(mesh('part:ratchet_cap', axialCylinder(5.3, 3.8, 61, 62.2), steel()));
  root.add(thimble);

  // Tray of objects to measure
  root.add(buildTray());
  let specimens: Specimen[] = [];
  const specimenGroup = new THREE.Group();
  specimenGroup.name = 'part:specimens';
  root.add(specimenGroup);
  function makeSpecimens(sizeOf: (range: [number, number]) => number) {
    for (const sp of specimens) sp.object.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    specimenGroup.clear();
    specimens = SPECIMENS.map((info) => buildSpecimen(info, sizeOf(info.range)));
    for (const sp of specimens) {
      applyPose(sp.object, sp.tray);
      specimenGroup.add(sp.object);
    }
    return specimens;
  }

  let settings = { ...initial };
  let gap = 0;

  function place() {
    const r = indicated(gap, settings);
    spindle.position.x = gap;
    thimble.position.x = ZERO_X + gap;
    thimble.rotation.x = (2 * Math.PI * r) / settings.pitch;
  }

  return {
    root,
    /** Meshes that turn the screw when dragged. */
    handles: [thimble] as THREE.Object3D[],
    range: RANGE,
    setSettings(next: GaugeSettings) {
      settings = { ...next };
      sleeveMat.map?.dispose();
      sleeveMat.map = sleeveTexture(settings);
      bevelMat.map?.dispose();
      bevelMat.map = thimbleTexture(settings);
      plateMat.map?.dispose();
      plateMat.map = plateTexture(settings);
      sleeveMat.needsUpdate = bevelMat.needsUpdate = plateMat.needsUpdate = true;
      place();
    },
    setGap(mm: number) {
      gap = mm;
      place();
    },
    makeSpecimens,
    get specimens() { return specimens; },
    specimenGroup,
  };
}

export type ScrewGauge = ReturnType<typeof buildScrewGauge>;
