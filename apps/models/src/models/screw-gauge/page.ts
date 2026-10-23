import * as THREE from 'three';
import { Viewer, type CameraView } from '../../core/viewer';
import { fontsReady } from '../../core/textures';
import { buildScrewGauge } from './model';
import { fmt, leastCount, read, type GaugeSettings } from './reading';
import { applyPose, type Pose, type Specimen, type SpecimenKind } from './specimens';

const PIXELS_PER_TURN = 220; // vertical drag distance for one full turn of the thimble
const BACKGROUND = '#196982'; // rgb(25, 105, 130), the Simphy default

export async function mountScrewGauge(host: HTMLElement): Promise<() => void> {
  await fontsReady();
  host.innerHTML = PAGE;
  const $ = <T extends HTMLElement>(sel: string) => host.querySelector(sel) as T;

  const settings: GaugeSettings = { pitch: 0.5, divisions: 50, zeroDivisions: 0 };
  let gap = 4.0;
  let held: Specimen | null = null;
  let flying = false;
  let showValues = true;

  const viewer = new Viewer($('.stage'));
  viewer.setBackground(BACKGROUND);
  const gauge = buildScrewGauge(settings);
  viewer.scene.add(gauge.root);

  const randomSize = ([a, b]: [number, number]) => {
    const lc = leastCount(settings);
    return Math.round((a + Math.random() * (b - a)) / lc) * lc;
  };
  gauge.makeSpecimens(randomSize);

  // ── camera ──────────────────────────────────────────────────────────────
  const overview = (): CameraView => {
    // Fit gauge + tray (≈ 160 × 60 mm) on any aspect ratio.
    const halfW = 0.084, halfH = 0.036, tan = Math.tan((viewer.camera.fov * Math.PI) / 360);
    const d = Math.max(halfH / tan, halfW / (tan * viewer.camera.aspect)) * 1.12;
    return { position: [0.056, 0.05, d], target: [0.056, -0.017, 0] };
  };
  const readView = (): CameraView => {
    const x = (50 + gap) / 1000;
    return { position: [x + 0.004, 0.009, 0.05], target: [x - 0.001, 0.001, 0.004] };
  };
  const facesView = (): CameraView => ({ position: [0.012, 0.03, 0.075], target: [0.004, -0.004, 0] });
  viewer.setView(overview());

  // ── state → model + panel ───────────────────────────────────────────────
  const minGap = () => held?.size ?? 0;
  let toastTimer = 0;
  const toast = (msg: string) => {
    const t = $('.toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (t.hidden = true), 1800);
  };

  function setGap(next: number, quiet = false) {
    const lc = leastCount(settings);
    let g = Math.round(next / lc) * lc; // the thimble clicks in whole divisions
    if (g < minGap() - 1e-9) {
      g = minGap();
      if (!quiet) toast(held ? 'Ratchet slips: the object is held · র‍্যাচেট ঘুরছে' : 'Faces touching · মুখ দুটি লেগে আছে');
    }
    gap = Math.min(gauge.range, Math.max(0, g));
    gauge.setGap(gap);
    render();
    viewer.invalidate();
  }

  function render() {
    const r = read(gap, settings);
    const lc = r.leastCount;
    $('.v-lc').textContent = `${fmt(lc, lc)} mm`;
    $('.v-ze').textContent = `${r.zeroError > 0 ? '+' : ''}${fmt(r.zeroError, lc)} mm`;
    $('.v-msr').textContent = `${fmt(r.msr, lc)} mm`;
    $('.v-csr').textContent = String(r.csr);
    $('.v-obs').textContent = `${fmt(r.msr, lc)} + ${r.csr} × ${fmt(lc, lc)} = ${fmt(r.observed, lc)} mm`;
    $('.v-cor').textContent = `${fmt(r.corrected, lc)} mm`;
    $('.values').hidden = !showValues;
    $('.hidden-note').hidden = showValues;
    ($('.zero-out') as HTMLOutputElement).value = String(settings.zeroDivisions);
    host.querySelectorAll<HTMLButtonElement>('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.kind === held?.info.kind)));
    $('.held').textContent = held ? `Holding: ${held.info.label} (${held.info.measures})` : 'Nothing between the faces.';
  }

  // ── objects: tray ⇄ gauge ───────────────────────────────────────────────
  const animateGap = (to: number, speed = 8) =>
    new Promise<void>((done) => {
      viewer.animate((dt) => {
        const step = Math.sign(to - gap) * Math.min(Math.abs(to - gap), dt * speed);
        gap += step;
        gauge.setGap(gap);
        render();
        if (Math.abs(to - gap) < 1e-6) { setGap(to, true); done(); return false; }
        return true;
      });
    });

  const fly = (sp: Specimen, from: Pose, to: Pose, seconds = 0.7) =>
    new Promise<void>((done) => {
      let t = 0;
      viewer.animate((dt) => {
        t = Math.min(1, t + dt / seconds);
        const e = t * t * (3 - 2 * t);
        sp.object.position.lerpVectors(from.position, to.position, e);
        sp.object.position.y += Math.sin(Math.PI * e) * 14; // lift over the frame
        sp.object.quaternion.slerpQuaternions(from.quaternion, to.quaternion, e);
        if (t >= 1) { applyPose(sp.object, to); done(); return false; }
        return true;
      });
    });

  async function toggle(kind: SpecimenKind) {
    if (flying) return;
    flying = true;
    try {
      const sp = gauge.specimens.find((s) => s.info.kind === kind)!;
      if (held) {
        const back = held;
        await animateGap(Math.min(gauge.range, back.size + 3)); // release it first
        held = null;
        render();
        await fly(back, back.held, back.tray);
        if (back === sp) return;
      }
      if (gap < sp.size + 2) await animateGap(Math.min(gauge.range, sp.size + 3));
      await fly(sp, sp.tray, sp.held);
      held = sp;
      ($('.guess') as HTMLInputElement).value = '';
      $('.answer').textContent = '';
      render();
      toast('Now close the screw with the ratchet · এখন র‍্যাচেট দিয়ে বন্ধ করো');
    } finally {
      flying = false;
    }
  }

  async function newSizes() {
    if (flying) return;
    if (held) await toggle(held.info.kind);
    gauge.makeSpecimens(randomSize);
    $('.answer').textContent = '';
    viewer.invalidate();
    toast('New objects in the tray');
  }

  // ── interaction ─────────────────────────────────────────────────────────
  const canvas = viewer.renderer.domElement;
  const specimenAt = (e: PointerEvent) => {
    const hit = viewer.pick(e, [gauge.specimenGroup])[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !o.userData.kind) o = o.parent;
    return (o?.userData.kind as SpecimenKind | undefined) ?? null;
  };
  let drag: { y: number; gap: number } | null = null;
  let downAt: { x: number; y: number; kind: SpecimenKind | null } | null = null;
  const onDown = (e: PointerEvent) => {
    downAt = { x: e.clientX, y: e.clientY, kind: specimenAt(e) };
    if (downAt.kind || !viewer.pick(e, gauge.handles).length) return;
    drag = { y: e.clientY, gap };
    viewer.controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  };
  const onMove = (e: PointerEvent) => {
    if (drag) {
      // dragging the near side of the thimble downward turns it to open the gap
      setGap(drag.gap + ((e.clientY - drag.y) / PIXELS_PER_TURN) * settings.pitch);
      return;
    }
    if (e.pointerType === 'mouse') canvas.style.cursor = specimenAt(e) ? 'pointer' : viewer.pick(e, gauge.handles).length ? 'grab' : '';
  };
  const onUp = (e: PointerEvent) => {
    // a tap (not a camera drag) on an object moves it between the tray and the gauge
    if (!drag && downAt?.kind && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6) void toggle(downAt.kind);
    drag = null;
    downAt = null;
    viewer.controls.enabled = true;
    canvas.style.cursor = '';
  };
  const onWheel = (e: WheelEvent) => {
    if (!viewer.pick(e, gauge.handles).length) return; // elsewhere: zoom
    e.preventDefault();
    e.stopImmediatePropagation();
    setGap(gap + Math.sign(e.deltaY) * leastCount(settings));
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    const step = e.shiftKey ? settings.pitch : leastCount(settings);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setGap(gap + step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setGap(gap - step);
    else return;
    e.preventDefault();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { capture: true, passive: false });
  window.addEventListener('keydown', onKey);

  // ── panel ───────────────────────────────────────────────────────────────
  $('.chips').innerHTML = gauge.specimens
    .map((s) => `<button class="chip" data-kind="${s.info.kind}" aria-pressed="false"><span>${s.info.label}</span><span class="bn">${s.info.labelBn}</span></button>`)
    .join('');
  host.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) => b.addEventListener('click', () => void toggle(b.dataset.kind as SpecimenKind)));
  $('.respecimen').addEventListener('click', () => void newSizes());

  host.querySelectorAll<HTMLButtonElement>('[data-turn]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.turn!;
      const amount = v.endsWith('t') ? parseFloat(v) * settings.pitch : parseFloat(v) * leastCount(settings);
      setGap(gap + amount);
    }),
  );
  $('.close-btn').addEventListener('click', () => void animateGap(minGap(), 6).then(() => { if (held) toast('Ratchet clicks: read the scales · এবার পাঠ নাও'); }));
  $('.open-btn').addEventListener('click', () => void animateGap(Math.min(gauge.range, Math.max(gap, minGap()) + 5)));

  $('.check').addEventListener('click', () => {
    const lc = leastCount(settings);
    const guess = parseFloat(($('.guess') as HTMLInputElement).value);
    const out = $('.answer');
    out.className = 'answer';
    if (!held) { out.textContent = 'Pick an object from the tray first.'; return; }
    if (gap - held.size > lc / 2) { out.textContent = 'Close the screw on the object first (Close with ratchet).'; return; }
    if (Number.isNaN(guess)) { out.textContent = 'Type your corrected reading in mm.'; return; }
    const ok = Math.abs(guess - held.size) < lc / 2;
    out.textContent = ok ? `✓ Correct: ${held.info.measures} = ${fmt(held.size, lc)} mm` : '✗ Not quite. Check MSR, CSR and the zero error.';
    out.className = `answer ${ok ? 'ok' : 'no'}`;
  });

  const applySettings = () => {
    settings.pitch = parseFloat(($('.pitch') as HTMLSelectElement).value);
    settings.divisions = parseInt(($('.divisions') as HTMLSelectElement).value, 10);
    settings.zeroDivisions = parseInt(($('.zero') as HTMLInputElement).value, 10);
    gauge.setSettings(settings);
    setGap(gap, true);
  };
  for (const sel of ['.pitch', '.divisions', '.zero']) $(sel).addEventListener('input', applySettings);
  $('.zero-rand').addEventListener('click', () => {
    ($('.zero') as HTMLInputElement).value = String(Math.round((Math.random() * 2 - 1) * 15));
    applySettings();
  });
  $<HTMLInputElement>('.show').addEventListener('change', (e) => { showValues = (e.target as HTMLInputElement).checked; render(); });
  $<HTMLInputElement>('.bg').addEventListener('input', (e) => viewer.setBackground((e.target as HTMLInputElement).value));
  $('[data-view="overview"]').addEventListener('click', () => viewer.goTo(overview()));
  $('[data-view="read"]').addEventListener('click', () => viewer.goTo(readView()));
  $('[data-view="faces"]').addEventListener('click', () => viewer.goTo(facesView()));

  gauge.setGap(gap);
  render();
  (window as unknown as Record<string, unknown>).__gauge = {
    setGap, toggle, viewer, gauge, settings,
    read: () => read(gap, settings),
    held: () => (held ? { kind: held.info.kind, size: held.size } : null),
    views: { overview, readView, facesView },
  };

  return () => {
    window.removeEventListener('keydown', onKey);
    clearTimeout(toastTimer);
    viewer.dispose();
    host.innerHTML = '';
  };
}

const PAGE = /* html */ `
<div class="model-page">
  <div class="stage" aria-label="3D screw gauge with a tray of objects. Tap an object to put it between the faces. Drag the thimble up or down to turn it; drag elsewhere to look around.">
    <a class="back" href="#/">← Gallery</a>
    <div class="toast" role="status" hidden></div>
    <div class="views" role="group" aria-label="Camera">
      <button data-view="overview">Overview</button>
      <button data-view="read">Read scale</button>
      <button data-view="faces">Faces</button>
    </div>
  </div>
  <aside class="panel">
    <header>
      <h1>Screw gauge <span class="bn">স্ক্রু গজ</span></h1>
      <p class="hint">Tap an object in the tray to put it between the anvil and spindle. Drag the thimble up/down (or scroll on it, or use ← →) to turn it.</p>
    </header>

    <section>
      <h2>Objects <span class="bn">বস্তু</span></h2>
      <div class="chips"></div>
      <div class="row held-row"><span class="held"></span><button class="respecimen">New sizes</button></div>
    </section>

    <section>
      <h2>Turn</h2>
      <div class="turns">
        <button data-turn="-1t" title="One full turn closer">−1 turn</button>
        <button data-turn="-1" title="One division closer">−1 div</button>
        <button data-turn="1" title="One division wider">+1 div</button>
        <button data-turn="1t" title="One full turn wider">+1 turn</button>
      </div>
      <div class="turns two">
        <button class="close-btn">Close with ratchet</button>
        <button class="open-btn">Open</button>
      </div>
    </section>

    <section>
      <h2>Reading <span class="bn">পাঠ</span></h2>
      <dl class="values">
        <dt>Least count</dt><dd class="v-lc"></dd>
        <dt>Zero error</dt><dd class="v-ze"></dd>
        <dt>Main scale (MSR)</dt><dd class="v-msr"></dd>
        <dt>Circular scale (CSR)</dt><dd class="v-csr"></dd>
        <dt class="wide">Observed = MSR + CSR × LC</dt><dd class="v-obs wide"></dd>
        <dt>Corrected</dt><dd class="v-cor strong"></dd>
      </dl>
      <p class="hidden-note" hidden>Values hidden. Read the scales yourself.</p>
      <div class="row">
        <input class="guess" inputmode="decimal" placeholder="Your corrected reading (mm)" aria-label="Your corrected reading in mm" />
        <button class="check">Check</button>
      </div>
      <p class="answer" aria-live="polite"></p>
    </section>

    <section>
      <h2>Settings</h2>
      <label class="row"><span>Pitch (1 MSD)</span>
        <select class="pitch"><option value="0.5" selected>0.5 mm</option><option value="1">1 mm</option></select></label>
      <label class="row"><span>Circular divisions</span>
        <select class="divisions"><option value="50" selected>50</option><option value="100">100</option></select></label>
      <label class="row"><span>Zero error <output class="zero-out">0</output> div</span>
        <input class="zero" type="range" min="-25" max="25" step="1" value="0" /></label>
      <div class="row"><button class="zero-rand">Random zero error</button></div>
      <label class="row check-row"><input class="show" type="checkbox" checked /> <span>Display values</span></label>
      <label class="row"><span>Background</span><input class="bg" type="color" value="${BACKGROUND}" /></label>
    </section>
  </aside>
</div>`;
