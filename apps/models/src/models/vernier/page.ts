import * as THREE from 'three';
import { Viewer, type CameraView } from '../../core/viewer';
import { fontsReady } from '../../core/textures';
import { buildTray, fly } from '../../core/specimen';
import { BEAM_END, PLATE_TOP, RANGE, SCALE_ZERO_X, VERNIER_LENGTH, buildCaliper } from './model';
import { fmt, leastCount, read, type VernierSettings } from './reading';
import { V_SPECIMENS, V_TRAY, buildVSpecimen, type VKind, type VSpecimen } from './specimens';
import { applyPose } from '../../core/specimen';

const BACKGROUND = '#196982';
const MODE_LABEL = { outside: 'outside jaws', inside: 'inside jaws', depth: 'depth rod' } as const;

export async function mountVernier(host: HTMLElement): Promise<() => void> {
  await fontsReady();
  host.innerHTML = PAGE;
  const $ = <T extends HTMLElement>(sel: string) => host.querySelector(sel) as T;

  const settings: VernierSettings = { divisions: 10, zeroDivisions: 0 };
  let opening = 30;
  let held: VSpecimen | null = null;
  let busy = false;
  let showValues = true;

  const viewer = new Viewer($('.stage'));
  viewer.camera.near = 0.003;
  viewer.camera.updateProjectionMatrix();
  viewer.controls.maxDistance = 1;
  viewer.setBackground(BACKGROUND);
  const caliper = buildCaliper(settings);
  viewer.scene.add(caliper.root);
  caliper.root.add(buildTray(V_TRAY));
  const specimenGroup = new THREE.Group();
  caliper.root.add(specimenGroup);
  let specimens: VSpecimen[] = [];

  const lc = () => leastCount(settings);
  const randomSize = ([a, b]: [number, number]) => Math.round((a + Math.random() * (b - a)) / lc()) * lc();
  function makeSpecimens() {
    specimenGroup.clear();
    specimens = V_SPECIMENS.map((info) => buildVSpecimen(info, randomSize(info.range)));
    for (const sp of specimens) { applyPose(sp.object, sp.tray); specimenGroup.add(sp.object); }
  }
  makeSpecimens();

  // ── camera ──────────────────────────────────────────────────────────────
  const fit = (cx: number, cy: number, halfW: number, halfH: number, lift = 0.08): CameraView => {
    const tan = Math.tan((viewer.camera.fov * Math.PI) / 360);
    const d = Math.max(halfH / tan, halfW / (tan * viewer.camera.aspect)) * 1.1;
    return { position: [cx, cy + d * lift * 3, d], target: [cx, cy, 0] };
  };
  const overview = () => fit(0.116, -0.016, 0.142, 0.05, 0.12); // includes the depth rod at full length
  const readView = (): CameraView => {
    const len = VERNIER_LENGTH(settings);
    const cx = (opening + SCALE_ZERO_X + len / 2) / 1000;
    const v = fit(cx, PLATE_TOP / 1000, (len + 14) / 2000, 0.012, 0);
    return { position: [v.position[0], v.position[1] + 0.004, v.position[2]], target: v.target };
  };
  const jawsView = (): CameraView => {
    if (held?.info.mode === 'depth') return fit((BEAM_END + 18) / 1000, 0.004, 0.04, 0.03, 0.15);
    if (held?.info.mode === 'inside') return fit((opening / 2) / 1000, 0.027, 0.035, 0.016, 0.15);
    return fit((opening / 2) / 1000, -0.02, Math.max(0.035, (opening + 30) / 2000), 0.03, 0.15);
  };
  viewer.setView(overview());

  // ── state ───────────────────────────────────────────────────────────────
  let toastTimer = 0;
  const toast = (msg: string) => {
    const t = $('.toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (t.hidden = true), 1800);
  };
  /** Allowed opening range with the held object in place. */
  const limits = (): [number, number] => {
    if (!held) return [0, RANGE];
    return held.info.mode === 'outside' ? [held.size, RANGE] : [0, held.size];
  };

  function setOpening(next: number, quiet = false) {
    const step = lc();
    let o = Math.round(next / step) * step;
    const [lo, hi] = limits();
    if (o < lo - 1e-9 || o > hi + 1e-9) {
      o = Math.min(hi, Math.max(lo, o));
      if (!quiet) toast(held ? 'Touching the object · বস্তুটি স্পর্শ করছে' : o <= 0 ? 'Jaws closed · চোয়াল বন্ধ' : 'End of the scale');
    }
    opening = o;
    caliper.setOpening(opening);
    render();
    viewer.invalidate();
  }

  function render() {
    const r = read(opening, settings), l = r.leastCount;
    $('.v-lc').textContent = `${fmt(l, l)} mm`;
    $('.v-ze').textContent = `${r.zeroError > 0 ? '+' : ''}${fmt(r.zeroError, l)} mm`;
    $('.v-msr').textContent = `${fmt(r.msr, 1)} mm`;
    $('.v-vsr').textContent = String(r.vsr);
    $('.v-obs').textContent = `${fmt(r.msr, 1)} + ${r.vsr} × ${fmt(l, l)} = ${fmt(r.observed, l)} mm`;
    $('.v-cor').textContent = `${fmt(r.corrected, l)} mm`;
    $('.values').hidden = !showValues;
    $('.hidden-note').hidden = showValues;
    ($('.zero-out') as HTMLOutputElement).value = String(settings.zeroDivisions);
    host.querySelectorAll<HTMLButtonElement>('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.kind === held?.info.kind)));
    $('.held').textContent = held ? `${held.info.label}: ${held.info.measures}, with the ${MODE_LABEL[held.info.mode]}` : 'Nothing in the caliper.';
    $('.touch-btn').textContent = held?.info.mode === 'outside' || !held ? 'Close on object' : held.info.mode === 'inside' ? 'Open inside ring' : 'Push rod to bottom';
  }

  const animateOpening = (to: number, speed = 40) =>
    new Promise<void>((done) => {
      viewer.animate((dt) => {
        opening += Math.sign(to - opening) * Math.min(Math.abs(to - opening), dt * speed);
        caliper.setOpening(opening);
        render();
        if (Math.abs(to - opening) < 1e-6) { setOpening(to, true); done(); return false; }
        return true;
      });
    });

  async function toggle(kind: VKind) {
    if (busy) return;
    busy = true;
    try {
      const sp = specimens.find((s) => s.info.kind === kind)!;
      if (held) {
        const back = held;
        // free it: open the outside jaws, close the inside jaws / pull the rod back
        await animateOpening(back.info.mode === 'outside' ? Math.min(RANGE, back.size + 8) : 0);
        held = null;
        render();
        await fly(viewer, back.object, back.held, back.tray, 30);
        if (back === sp) return;
      }
      // make room before it arrives
      if (sp.info.mode === 'outside' && opening < sp.size + 6) await animateOpening(Math.min(RANGE, sp.size + 10));
      if (sp.info.mode !== 'outside' && opening > 0) await animateOpening(sp.info.mode === 'inside' ? Math.min(2, sp.size) : 0);
      await fly(viewer, sp.object, sp.tray, sp.held, 30);
      held = sp;
      ($('.guess') as HTMLInputElement).value = '';
      $('.answer').textContent = '';
      render();
      viewer.goTo(jawsView());
      toast(sp.info.mode === 'outside' ? 'Now close the jaws on it · এবার চোয়াল বন্ধ করো' : sp.info.mode === 'inside' ? 'Now open the inside jaws · এবার ভেতরের চোয়াল খোলো' : 'Now push the depth rod down · এবার গভীরতা দণ্ড নামাও');
    } finally {
      busy = false;
    }
  }

  // ── interaction ─────────────────────────────────────────────────────────
  const canvas = viewer.renderer.domElement;
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.00265); // the vernier plate front (z = 2.65 mm): the slider stays under the finger
  const specimenAt = (e: PointerEvent) => {
    let o: THREE.Object3D | null = viewer.pick(e, [specimenGroup])[0]?.object ?? null;
    while (o && !o.userData.kind) o = o.parent;
    return (o?.userData.kind as VKind | undefined) ?? null;
  };
  let drag: { offset: number } | null = null;
  let downAt: { x: number; y: number; kind: VKind | null } | null = null;
  const onDown = (e: PointerEvent) => {
    downAt = { x: e.clientX, y: e.clientY, kind: specimenAt(e) };
    if (downAt.kind || !viewer.pick(e, caliper.handles).length) return;
    const p = viewer.pointOnPlane(e, plane);
    if (!p) return;
    drag = { offset: p.x * 1000 - opening };
    viewer.controls.enabled = false;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  };
  const onMove = (e: PointerEvent) => {
    if (drag) {
      const p = viewer.pointOnPlane(e, plane);
      if (p) setOpening(p.x * 1000 - drag.offset);
      return;
    }
    if (e.pointerType === 'mouse') canvas.style.cursor = specimenAt(e) ? 'pointer' : viewer.pick(e, caliper.handles).length ? 'grab' : '';
  };
  const onUp = (e: PointerEvent) => {
    if (!drag && downAt?.kind && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6) void toggle(downAt.kind);
    drag = null;
    downAt = null;
    viewer.controls.enabled = true;
    canvas.style.cursor = '';
  };
  const onWheel = (e: WheelEvent) => {
    if (!viewer.pick(e, caliper.handles).length) return; // elsewhere: zoom
    e.preventDefault();
    e.stopImmediatePropagation();
    setOpening(opening - Math.sign(e.deltaY) * lc()); // the thumb roller: one division per notch
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return;
    const step = e.shiftKey ? 1 : lc();
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setOpening(opening + step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setOpening(opening - step);
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
  $('.chips').innerHTML = V_SPECIMENS.map((s) => `<button class="chip" data-kind="${s.kind}" aria-pressed="false"><span>${s.label}</span><span class="bn">${s.labelBn}</span></button>`).join('');
  host.querySelectorAll<HTMLButtonElement>('.chip').forEach((b) => b.addEventListener('click', () => void toggle(b.dataset.kind as VKind)));
  $('.respecimen').addEventListener('click', async () => {
    if (busy) return;
    if (held) await toggle(held.info.kind);
    makeSpecimens();
    viewer.invalidate();
    toast('New objects in the tray');
  });
  host.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.move!;
      setOpening(opening + (v.endsWith('mm') ? parseFloat(v) : parseFloat(v) * lc()));
    }),
  );
  $('.touch-btn').addEventListener('click', () => {
    const [lo, hi] = limits();
    const target = !held || held.info.mode === 'outside' ? lo : hi;
    void animateOpening(target, 30).then(() => { if (held) toast('Touching: read the scales · এবার পাঠ নাও'); });
  });
  $('.free-btn').addEventListener('click', () => {
    const [lo, hi] = limits();
    void animateOpening(!held || held.info.mode === 'outside' ? Math.min(hi, opening + 10) : Math.max(lo, opening - 5));
  });
  $('.check').addEventListener('click', () => {
    const l = lc(), out = $('.answer'), guess = parseFloat(($('.guess') as HTMLInputElement).value);
    out.className = 'answer';
    if (!held) { out.textContent = 'Pick an object from the tray first.'; return; }
    if (Math.abs(opening - held.size) > l / 2) { out.textContent = 'Make the caliper touch the object first.'; return; }
    if (Number.isNaN(guess)) { out.textContent = 'Type your corrected reading in mm.'; return; }
    const ok = Math.abs(guess - held.size) < l / 2;
    out.textContent = ok ? `✓ Correct: ${held.info.measures} = ${fmt(held.size, l)} mm` : '✗ Not quite. Check MSR, the coinciding vernier division and the zero error.';
    out.className = `answer ${ok ? 'ok' : 'no'}`;
  });
  const zeroInput = $<HTMLInputElement>('.zero');
  const applySettings = () => {
    settings.divisions = parseInt(($('.divisions') as HTMLSelectElement).value, 10);
    const max = Math.min(25, settings.divisions - 1);
    zeroInput.min = String(-max);
    zeroInput.max = String(max);
    settings.zeroDivisions = Math.max(-max, Math.min(max, parseInt(zeroInput.value, 10)));
    zeroInput.value = String(settings.zeroDivisions);
    caliper.setSettings(settings);
    setOpening(opening, true);
  };
  $('.divisions').addEventListener('input', applySettings);
  zeroInput.addEventListener('input', applySettings);
  $('.zero-rand').addEventListener('click', () => {
    const max = Math.min(25, settings.divisions - 1);
    zeroInput.value = String(Math.round((Math.random() * 2 - 1) * max * 0.7));
    applySettings();
  });
  $<HTMLInputElement>('.show').addEventListener('change', (e) => { showValues = (e.target as HTMLInputElement).checked; render(); });
  $<HTMLInputElement>('.bg').addEventListener('input', (e) => viewer.setBackground((e.target as HTMLInputElement).value));
  $('[data-view="overview"]').addEventListener('click', () => viewer.goTo(overview()));
  $('[data-view="read"]').addEventListener('click', () => viewer.goTo(readView()));
  $('[data-view="jaws"]').addEventListener('click', () => viewer.goTo(jawsView()));

  caliper.setOpening(opening);
  render();
  (window as unknown as Record<string, unknown>).__vernier = {
    setOpening, toggle, viewer, caliper, settings, applySettings,
    read: () => read(opening, settings),
    held: () => (held ? { kind: held.info.kind, size: held.size, mode: held.info.mode } : null),
    views: { overview, readView, jawsView },
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
  <div class="stage" aria-label="3D vernier caliper with a tray of objects. Tap an object to put it in the caliper. Drag the slider along the beam; drag elsewhere to look around.">
    <a class="back" href="#/">← Gallery</a>
    <div class="toast" role="status" hidden></div>
    <div class="views" role="group" aria-label="Camera">
      <button data-view="overview">Overview</button>
      <button data-view="read">Read scale</button>
      <button data-view="jaws">Jaws</button>
    </div>
  </div>
  <aside class="panel">
    <header>
      <h1>Vernier caliper <span class="bn">ভার্নিয়ার ক্যালিপার্স</span></h1>
      <p class="hint">Tap an object in the tray to put it in the caliper. Drag the slider along the beam (or scroll on it, or use ← →).</p>
    </header>

    <section>
      <h2>Objects <span class="bn">বস্তু</span></h2>
      <div class="chips"></div>
      <div class="row held-row"><span class="held"></span><button class="respecimen">New sizes</button></div>
    </section>

    <section>
      <h2>Move the slider</h2>
      <div class="turns">
        <button data-move="-1mm" title="1 mm closer">−1 mm</button>
        <button data-move="-1" title="One vernier division closer">−1 div</button>
        <button data-move="1" title="One vernier division wider">+1 div</button>
        <button data-move="1mm" title="1 mm wider">+1 mm</button>
      </div>
      <div class="turns two">
        <button class="touch-btn close-btn">Close on object</button>
        <button class="free-btn">Release</button>
      </div>
    </section>

    <section>
      <h2>Reading <span class="bn">পাঠ</span></h2>
      <dl class="values">
        <dt>Least count</dt><dd class="v-lc"></dd>
        <dt>Zero error</dt><dd class="v-ze"></dd>
        <dt>Main scale (MSR)</dt><dd class="v-msr"></dd>
        <dt>Vernier coincidence (VSR)</dt><dd class="v-vsr"></dd>
        <dt class="wide">Observed = MSR + VSR × LC</dt><dd class="v-obs wide"></dd>
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
      <label class="row"><span>Vernier divisions</span>
        <select class="divisions"><option value="10" selected>10 (LC 0.1 mm)</option><option value="20">20 (LC 0.05 mm)</option><option value="50">50 (LC 0.02 mm)</option></select></label>
      <label class="row"><span>Zero error <output class="zero-out">0</output> div</span>
        <input class="zero" type="range" min="-9" max="9" step="1" value="0" /></label>
      <div class="row"><button class="zero-rand">Random zero error</button></div>
      <label class="row check-row"><input class="show" type="checkbox" checked /> <span>Display values</span></label>
      <label class="row"><span>Background</span><input class="bg" type="color" value="${BACKGROUND}" /></label>
    </section>
  </aside>
</div>`;
