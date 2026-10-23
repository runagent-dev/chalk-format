import * as THREE from 'three';
import type { Viewer } from './viewer';

// Shared pieces for "objects you measure": poses, the felt tray, and the flight between tray and instrument.

export interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export const pose = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Pose => ({
  position: new THREE.Vector3(x, y, z),
  quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
});

export function applyPose(o: THREE.Object3D, p: Pose) {
  o.position.copy(p.position);
  o.quaternion.copy(p.quaternion);
}

export interface TrayBox { x0: number; x1: number; z0: number; z1: number; floor: number }

/** A shallow felt-lined tray (mm). Objects rest on y = floor + 1.2. */
export function buildTray(t: TrayBox) {
  const g = new THREE.Group();
  g.name = 'part:tray';
  const felt = new THREE.MeshStandardMaterial({ color: 0x1d2b33, roughness: 0.95, metalness: 0 });
  const rim = new THREE.MeshStandardMaterial({ color: 0x3a4a52, roughness: 0.6, metalness: 0.2 });
  const w = t.x1 - t.x0, d = t.z1 - t.z0, cx = (t.x0 + t.x1) / 2, cz = (t.z0 + t.z1) / 2;
  const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 1.2, d), felt);
  floor.position.set(cx, t.floor + 0.6, cz);
  g.add(floor);
  const wall = (sx: number, sz: number, x: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, 4.5, sz), rim);
    m.position.set(x, t.floor + 2.25, z);
    g.add(m);
  };
  wall(w + 3, 1.5, cx, t.z0 - 0.75);
  wall(w + 3, 1.5, cx, t.z1 + 0.75);
  wall(1.5, d, t.x0 - 0.75, cz);
  wall(1.5, d, t.x1 + 0.75, cz);
  return g;
}

/** Animate `o` from one pose to another along an arc that lifts by `lift` (object units). */
export function fly(viewer: Viewer, o: THREE.Object3D, from: Pose, to: Pose, lift: number, seconds = 0.7) {
  return new Promise<void>((done) => {
    let t = 0;
    viewer.animate((dt) => {
      t = Math.min(1, t + dt / seconds);
      const e = t * t * (3 - 2 * t);
      o.position.lerpVectors(from.position, to.position, e);
      o.position.y += Math.sin(Math.PI * e) * lift;
      o.quaternion.slerpQuaternions(from.quaternion, to.quaternion, e);
      if (t >= 1) { applyPose(o, to); done(); return false; }
      return true;
    });
  });
}
