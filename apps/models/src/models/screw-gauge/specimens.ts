import * as THREE from 'three';
import { applyPose, buildTray as buildTrayBox, pose, type Pose } from '../../core/specimen';

export { applyPose, type Pose };

// Small objects to measure, and the tray they sit in. Millimetres, same frame as the gauge:
// the anvil face is the plane x = 0 and the measured dimension always lies along +X when held.

export type SpecimenKind = 'wire' | 'nail' | 'ball' | 'coin' | 'plate' | 'cube';

export interface SpecimenInfo {
  kind: SpecimenKind;
  label: string;
  labelBn: string;
  /** What the gauge measures on this object. */
  measures: string;
  /** Size range of the measured dimension (mm). */
  range: [number, number];
}

export const SPECIMENS: SpecimenInfo[] = [
  { kind: 'wire', label: 'Copper wire', labelBn: 'তামার তার', measures: 'diameter', range: [0.4, 3.2] },
  { kind: 'nail', label: 'Nail', labelBn: 'পেরেক', measures: 'shank diameter', range: [1.8, 4.2] },
  { kind: 'ball', label: 'Steel ball', labelBn: 'স্টিলের বল', measures: 'diameter', range: [3, 9.5] },
  { kind: 'coin', label: 'Coin', labelBn: 'মুদ্রা', measures: 'thickness', range: [1.4, 2.3] },
  { kind: 'plate', label: 'Glass plate', labelBn: 'কাচের পাত', measures: 'thickness', range: [1, 4] },
  { kind: 'cube', label: 'Metal cube', labelBn: 'ধাতব ঘনক', measures: 'side', range: [4, 9.5] },
];

// ── tray ──────────────────────────────────────────────────────────────────
export const TRAY = { x0: 52, x1: 132, z0: -18, z1: 20, floor: -42 };
const FLOOR_TOP = TRAY.floor + 1.2;

export const buildTray = () => buildTrayBox(TRAY);

// ── objects ───────────────────────────────────────────────────────────────
const copper = () => new THREE.MeshStandardMaterial({ color: 0xc8753a, metalness: 1, roughness: 0.3 });
const steel = () => new THREE.MeshStandardMaterial({ color: 0xd4d8dc, metalness: 1, roughness: 0.22 });
const nickel = () => new THREE.MeshStandardMaterial({ color: 0xc9c4b4, metalness: 1, roughness: 0.34 });
const glass = () => new THREE.MeshStandardMaterial({ color: 0xbfe6dd, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.55, depthWrite: false });
const brass = () => new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 1, roughness: 0.32 });

export interface Specimen {
  info: SpecimenInfo;
  size: number;
  object: THREE.Group;
  tray: Pose;
  held: Pose;
}

/** Build one object with measured dimension `size` (mm); its group origin is its centre. */
export function buildSpecimen(info: SpecimenInfo, size: number): Specimen {
  const o = new THREE.Group();
  o.name = `part:specimen_${info.kind}`;
  o.userData.kind = info.kind;
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, fn?: (m: THREE.Mesh) => void) => {
    const m = new THREE.Mesh(geo, mat);
    fn?.(m);
    o.add(m);
    return m;
  };
  const r = size / 2;
  switch (info.kind) {
    case 'wire': {
      // a short bent-free length of wire; axis along local Y
      add(new THREE.CylinderGeometry(r, r, 30, 32), copper());
      return { info, size, object: o, tray: pose(73, FLOOR_TOP + r, 11, 0, 0, Math.PI / 2), held: pose(r, 0, 6, Math.PI / 2) };
    }
    case 'nail': {
      // shank along local Y, head at −Y, point at +Y
      add(new THREE.CylinderGeometry(r, r, 24, 32), steel());
      add(new THREE.CylinderGeometry(r * 2.4, r * 2.4, 1.1, 40), steel(), (m) => (m.position.y = -12.5));
      add(new THREE.ConeGeometry(r, 3.2, 32), steel(), (m) => (m.position.y = 13.6));
      return { info, size, object: o, tray: pose(108, FLOOR_TOP + r * 2.4, 11, 0, 0, -Math.PI / 2), held: pose(r, 0, 8, Math.PI / 2) };
    }
    case 'ball': {
      add(new THREE.SphereGeometry(r, 48, 32), steel());
      return { info, size, object: o, tray: pose(122, FLOOR_TOP + r, -6), held: pose(r, 0, 0) };
    }
    case 'coin': {
      const R = 11;
      add(new THREE.CylinderGeometry(R, R, size, 64), nickel());
      // raised rim on both faces
      for (const s of [-1, 1]) add(new THREE.TorusGeometry(R - 0.8, 0.35, 8, 64), nickel(), (m) => { m.rotation.x = Math.PI / 2; m.position.y = s * (r - 0.25); });
      // coin axis = local Y: lies flat in the tray, faces the anvil/spindle when held
      return { info, size, object: o, tray: pose(68, FLOOR_TOP + r, -5), held: pose(r, -1, 0, 0, 0, Math.PI / 2) };
    }
    case 'plate': {
      // thickness along local Y
      add(new THREE.BoxGeometry(16, size, 16), glass());
      add(new THREE.BoxGeometry(16.02, size * 1.002, 16.02), new THREE.MeshBasicMaterial({ color: 0x5fa79a, wireframe: true, transparent: true, opacity: 0.25 }));
      return { info, size, object: o, tray: pose(90, FLOOR_TOP + r, -5), held: pose(r, 0, 0, 0, 0, Math.PI / 2) };
    }
    case 'cube': {
      add(new THREE.BoxGeometry(size, size, size), brass());
      return { info, size, object: o, tray: pose(106, FLOOR_TOP + r, -6, 0, 0.35, 0), held: pose(r, 0, 0) };
    }
  }
}
