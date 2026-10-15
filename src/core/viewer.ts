import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export type CameraView = { position: THREE.Vector3Tuple; target: THREE.Vector3Tuple };

/**
 * One renderer + scene + orbit camera shared by every gallery model.
 * Renders on demand only (after a change, or while an animation runs), so an idle model costs ~0 GPU.
 * World units are metres; models build in their own units inside a scaled group.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.005, 20);
  readonly controls: OrbitControls;
  private dirty = true;
  private raf = 0;
  private last = 0;
  private readonly tickers = new Set<(dt: number) => boolean>();
  private readonly resize: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();

  constructor(readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.9;

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.4, 0.8, 0.9);
    const fill = new THREE.HemisphereLight(0xf2f6ff, 0x30363c, 0.55);
    this.scene.add(key, fill);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.minDistance = 0.04;
    this.controls.maxDistance = 0.6;
    this.controls.addEventListener('change', () => this.invalidate());

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(container);
    this.fit();
  }

  setBackground(color: string) {
    this.scene.background = new THREE.Color(color);
    this.invalidate();
  }

  /** Request one frame. */
  invalidate() {
    this.dirty = true;
    this.schedule();
  }

  /** Run `fn(dt)` every frame until it returns false. */
  animate(fn: (dt: number) => boolean) {
    this.tickers.add(fn);
    this.schedule();
  }

  /** Smoothly move the camera to a preset view. */
  goTo(view: CameraView, seconds = 0.6) {
    const p0 = this.camera.position.clone(), t0 = this.controls.target.clone();
    const p1 = new THREE.Vector3(...view.position), t1 = new THREE.Vector3(...view.target);
    let t = 0;
    this.animate((dt) => {
      t = Math.min(1, t + dt / seconds);
      const e = t * t * (3 - 2 * t);
      this.camera.position.lerpVectors(p0, p1, e);
      this.controls.target.lerpVectors(t0, t1, e);
      this.controls.update();
      return t < 1;
    });
  }

  setView(view: CameraView) {
    this.camera.position.set(...view.position);
    this.controls.target.set(...view.target);
    this.controls.update();
    this.invalidate();
  }

  /** Objects under a pointer event, nearest first. */
  pick(event: PointerEvent | WheelEvent, objects: THREE.Object3D[]) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(objects, true);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      for (const mat of mats) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
        mat.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  private frame(now: number) {
    this.raf = 0;
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    for (const fn of [...this.tickers]) if (!fn(dt)) this.tickers.delete(fn);
    if (this.tickers.size || this.dirty) {
      this.renderer.render(this.scene, this.camera);
      this.dirty = false;
    }
    if (this.tickers.size) this.schedule();
    else this.last = 0;
  }
}
