import * as THREE from 'three';
import { pose, type Pose } from '../../core/specimen';
import { BEAM_END } from './model';

// Objects for the vernier caliper (mm). Each says which part of the caliper measures it:
//   outside: lower jaws close on it (opening ≥ size)
//   inside:  upper knife edges open inside it (opening ≤ size)
//   depth:   the depth rod goes down a hole (opening ≤ size)

export type Mode = 'outside' | 'inside' | 'depth';
export type VKind = 'ball' | 'rod' | 'block' | 'coin' | 'ring' | 'hole';

export interface VInfo { kind: VKind; label: string; labelBn: string; measures: string; mode: Mode; range: [number, number] }

export const V_SPECIMENS: VInfo[] = [
  { kind: 'ball', label: 'Steel ball', labelBn: 'স্টিলের বল', measures: 'diameter', mode: 'outside', range: [10, 26] },
  { kind: 'rod', label: 'Wooden rod', labelBn: 'কাঠের দণ্ড', measures: 'diameter', mode: 'outside', range: [12, 30] },
  { kind: 'block', label: 'Brass block', labelBn: 'পিতলের ব্লক', measures: 'side', mode: 'outside', range: [10, 28] },
  { kind: 'coin', label: 'Coin', labelBn: 'মুদ্রা', measures: 'diameter', mode: 'outside', range: [19, 28] },
  { kind: 'ring', label: 'Metal ring', labelBn: 'ধাতব আংটা', measures: 'inner diameter', mode: 'inside', range: [12, 38] },
  { kind: 'hole', label: 'Acrylic block with hole', labelBn: 'ছিদ্রযুক্ত ব্লক', measures: 'hole depth', mode: 'depth', range: [8, 34] },
];

export const V_TRAY = { x0: 6, x1: 206, z0: -38, z1: 40, floor: -64 };
const FT = V_TRAY.floor + 1.2;
const JAW_Y = -22; // middle of the lower jaws
const TIP_Y = 29.3; // around the inside-jaw tips

export interface VSpecimen { info: VInfo; size: number; object: THREE.Group; tray: Pose; held: Pose }

const mat = {
  steel: () => new THREE.MeshStandardMaterial({ color: 0xd4d8dc, metalness: 1, roughness: 0.22 }),
  wood: () => new THREE.MeshStandardMaterial({ color: 0xb0794a, metalness: 0, roughness: 0.75 }),
  brass: () => new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 1, roughness: 0.32 }),
  nickel: () => new THREE.MeshStandardMaterial({ color: 0xc9c4b4, metalness: 1, roughness: 0.34 }),
  alu: () => new THREE.MeshStandardMaterial({ color: 0xb8bec4, metalness: 0.9, roughness: 0.4 }),
  // clear acrylic, so the depth rod is visible inside the hole
  acrylic: () => new THREE.MeshStandardMaterial({ color: 0xa9d8e8, metalness: 0, roughness: 0.08, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }),
};

export function buildVSpecimen(info: VInfo, size: number): VSpecimen {
  const o = new THREE.Group();
  o.name = `part:specimen_${info.kind}`;
  o.userData.kind = info.kind;
  const add = (geo: THREE.BufferGeometry, m: THREE.Material) => { const mesh = new THREE.Mesh(geo, m); o.add(mesh); return mesh; };
  const r = size / 2;
  switch (info.kind) {
    case 'ball':
      add(new THREE.SphereGeometry(r, 48, 32), mat.steel());
      return { info, size, object: o, tray: pose(24, FT + r, 16), held: pose(r, JAW_Y, 0) };
    case 'rod': {
      // wooden dowel, axis = local Y, 40 mm long; held front-to-back across the jaws
      add(new THREE.CylinderGeometry(r, r, 40, 48), mat.wood());
      return { info, size, object: o, tray: pose(64, FT + r, 16, 0, 0, Math.PI / 2), held: pose(r, JAW_Y, 0, Math.PI / 2) };
    }
    case 'block':
      add(new THREE.BoxGeometry(size, size, size), mat.brass());
      return { info, size, object: o, tray: pose(104, FT + r, 16, 0, 0.3, 0), held: pose(r, JAW_Y, 0) };
    case 'coin': {
      // axis = local Y; lies flat in the tray, stands facing you between the jaws (diameter along X)
      add(new THREE.CylinderGeometry(r, r, 2, 64), mat.nickel());
      for (const sgn of [-1, 1]) {
        const rim = add(new THREE.TorusGeometry(r - 0.8, 0.3, 8, 64), mat.nickel());
        rim.rotation.x = Math.PI / 2;
        rim.position.y = sgn * 0.85;
      }
      return { info, size, object: o, tray: pose(142, FT + 1, 16), held: pose(r, JAW_Y, 0, Math.PI / 2) };
    }
    case 'ring': {
      // inner diameter = size, 3 mm wall, 6 mm tall; axis = local Y (the inside jaws enter from below)
      const shape = new THREE.Shape().absarc(0, 0, r + 3, 0, Math.PI * 2, false);
      shape.holes.push(new THREE.Path().absarc(0, 0, r, 0, Math.PI * 2, true));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 6, bevelEnabled: false, curveSegments: 72 });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, -3, 0);
      add(geo, mat.alu());
      return { info, size, object: o, tray: pose(182, FT + 3, 14), held: pose(r, TIP_Y, 0) };
    }
    case 'hole': {
      // 40 × 30 × 30 mm block; hole Ø7 along local +X, depth = size. Origin = centre of the hole mouth.
      const L = 40, S = 30, holeR = 3.5;
      const sq = () => new THREE.Shape([new THREE.Vector2(-S / 2, -S / 2), new THREE.Vector2(S / 2, -S / 2), new THREE.Vector2(S / 2, S / 2), new THREE.Vector2(-S / 2, S / 2)]);
      const holed = sq();
      holed.holes.push(new THREE.Path().absarc(0, 0, holeR, 0, Math.PI * 2, true));
      const g1 = new THREE.ExtrudeGeometry(holed, { depth: size, bevelEnabled: false, curveSegments: 48 });
      const g2 = new THREE.ExtrudeGeometry(sq(), { depth: L - size, bevelEnabled: false });
      g2.translate(0, 0, size);
      for (const g of [g1, g2]) { g.rotateY(Math.PI / 2); add(g, mat.acrylic()); } // extrusion z → +X
      // hole bottom, tinted so the end of the hole reads clearly through the acrylic
      const bottom = add(new THREE.CircleGeometry(holeR, 40), new THREE.MeshStandardMaterial({ color: 0x2d6f86, roughness: 0.5 }));
      bottom.rotation.y = -Math.PI / 2;
      bottom.position.x = size + 0.05;
      return { info, size, object: o, tray: pose(54, FT + L, -20, 0, 0, -Math.PI / 2), held: pose(BEAM_END, 4.5, -1, 0, 0, 0) };
    }
  }
}
