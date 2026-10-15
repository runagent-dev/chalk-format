import { Viewer, type CameraView } from '../../core/viewer';
import { fontsReady } from '../../core/textures';
import { buildScrewGauge, type MeasuredObject } from './model';
import { fmt, leastCount, read, type GaugeSettings } from './reading';

const PIXELS_PER_TURN = 220; // vertical drag distance for one full turn of the thimble

export async function mountScrewGauge(host: HTMLElement): Promise<() => void> {
  await fontsReady();
  host.innerHTML = PAGE;
  const $ = <T extends HTMLElement>(sel: string) => host.querySelector(sel) as T;

  const settings: GaugeSettings = { pitch: 0.5, divisions: 50, zeroDivisions: 0 };
  let gap = 4.0;
  let specimen: MeasuredObject = { kind: 'none' };
  let showValues = true;

  const viewer = new Viewer($('.stage'));
  viewer.setBackground('#2f5f77');
  const gauge = buildScrewGauge(settings);
  viewer.scene.add(gauge.root);

  // ── camera ──────────────────────────────────────────────────────────────
  const overview = (): CameraView => {
    // Fit the instrument's ~150 mm width on narrow screens too.
    const halfW = 0.082, halfH = 0.04, tan = Math.tan((viewer.camera.fov * Math.PI) / 360);
    const d = Math.max(halfH / tan, halfW / (tan * viewer.camera.aspect)) * 1.12;
    return { position: [0.046, 0.004, d], target: [0.046, -0.016, 0] };
  };
  const readView = (): CameraView => {
    const x = (50 + gap) / 1000;
    return { position: [x + 0.004, 0.009, 0.05], target: [x - 0.001, 0.001, 0.004] };
  };
  const topView = (): CameraView => ({ position: [0.03, 0.2, 0.06], target: [0.03, 0, 0] });
  viewer.setView(overview());

  // ── state → model + panel ───────────────────────────────────────────────
  const minGap = () => (specimen.kind === 'none' ? 0 : specimen.diameter);
  let toastTimer = 0;
  const toast = (msg: string) => {
    const t = $('.toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (t.hidden = true), 1600);
  };

  function setGap(next: number) {
    const lc = leastCount(settings);
    let g = Math.round(next / lc) * lc; // the thimble clicks in whole divisions
    if (g < minGap()) {
      g = minGap();
      if (gap > g + 1e-9 || next < g - lc / 2) toast(specimen.kind === 'none' ? 'Faces touching · মুখ দুটি লেগে আছে' : 'Ratchet slips: the specimen is held · র‍্যাচেট ঘুরছে');
    }
    gap = Math.min(gauge.range, Math.max(0, g));
    gauge.setGap(gap);
    render();
    viewer.invalidate();
  }

  function render() {
    const r = read(gap, settings);
    const lc = r.leastCount;
    $('.v-lc').textContent = `${fmt(lc, lc / 10)} mm`;
    $('.v-ze').textContent = `${r.zeroError > 0 ? '+' : ''}${fmt(r.zeroError, lc)} mm`;
    $('.v-msr').textContent = `${fmt(r.msr, lc)} mm`;
    $('.v-csr').textContent = String(r.csr);
    $('.v-obs').textContent = `${fmt(r.msr, lc)} + ${r.csr} × ${fmt(lc, lc / 10)} = ${fmt(r.observed, lc)} mm`;
    $('.v-cor').textContent = `${fmt(r.corrected, lc)} mm`;
    $('.values').hidden = !showValues;
    $('.hidden-note').hidden = showValues;
    ($('.zero-out') as HTMLOutputElement).value = String(settings.zeroDivisions);
  }

  // ── interaction: turn the thimble ───────────────────────────────────────
  const canvas = viewer.renderer.domElement;
  let drag: { y: number; gap: number } | null = null;
  const onDown = (e: PointerEvent) => {
    if (!viewer.pick(e, gauge.handles).length) return;
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
    if (e.pointerType === 'mouse') canvas.style.cursor = viewer.pick(e, gauge.handles).length ? 'grab' : '';
  };
  const onUp = () => {
    drag = null;
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
  host.querySelectorAll<HTMLButtonElement>('[data-turn]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.turn!;
      const amount = v.endsWith('t') ? parseFloat(v) * settings.pitch : parseFloat(v) * leastCount(settings);
      setGap(gap + amount);
    }),
  );
  $('.close-btn').addEventListener('click', () => {
    // turn the ratchet until it slips: animate the spindle onto the faces / specimen
    viewer.animate((dt) => {
      const target = minGap();
      const next = Math.max(target, gap - dt * 6);
      gauge.setGap((gap = next));
      render();
      if (next <= target + 1e-9) { setGap(target); return false; }
      return true;
    });
  });
  $('.open-btn').addEventListener('click', () => setGap(Math.max(gap, minGap()) + 5));

  const specimenSel = $<HTMLSelectElement>('.specimen');
  const newSpecimen = () => {
    const kind = specimenSel.value as MeasuredObject['kind'];
    const lc = leastCount(settings);
    const rnd = (a: number, b: number) => Math.round((a + Math.random() * (b - a)) / lc) * lc;
    specimen = kind === 'none' ? { kind } : { kind, diameter: kind === 'wire' ? rnd(0.4, 3.2) : rnd(3, 12) };
    gauge.setObject(specimen);
    $('.answer').textContent = '';
    ($('.guess') as HTMLInputElement).value = '';
    setGap(Math.max(gap, minGap() + 2));
  };
  specimenSel.addEventListener('change', newSpecimen);
  $('.respecimen').addEventListener('click', newSpecimen);

  $('.check').addEventListener('click', () => {
    const lc = leastCount(settings);
    const guess = parseFloat(($('.guess') as HTMLInputElement).value);
    const out = $('.answer');
    if (specimen.kind === 'none') { out.textContent = 'Put a wire or ball between the faces first.'; return; }
    if (gap - specimen.diameter > lc / 2) { out.textContent = 'Close the screw on the specimen first (Close with ratchet).'; return; }
    if (Number.isNaN(guess)) { out.textContent = 'Type your corrected reading in mm.'; return; }
    const ok = Math.abs(guess - specimen.diameter) < lc / 2;
    out.textContent = ok ? `✓ Correct: ${fmt(specimen.diameter, lc)} mm` : `✗ Not quite. Check MSR, CSR and the zero error.`;
    out.className = `answer ${ok ? 'ok' : 'no'}`;
  });

  const applySettings = () => {
    settings.pitch = parseFloat(($('.pitch') as HTMLSelectElement).value);
    settings.divisions = parseInt(($('.divisions') as HTMLSelectElement).value, 10);
    settings.zeroDivisions = parseInt(($('.zero') as HTMLInputElement).value, 10);
    gauge.setSettings(settings);
    setGap(gap);
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
  $('[data-view="top"]').addEventListener('click', () => viewer.goTo(topView()));

  gauge.setGap(gap);
  render();
  (window as unknown as Record<string, unknown>).__gauge = { setGap, viewer, gauge, settings, read: () => read(gap, settings), views: { overview, readView, topView } };

  return () => {
    window.removeEventListener('keydown', onKey);
    clearTimeout(toastTimer);
    viewer.dispose();
    host.innerHTML = '';
  };
}

const PAGE = /* html */ `
<div class="model-page">
  <div class="stage" aria-label="3D screw gauge. Drag the thimble up or down to turn it; drag elsewhere to look around.">
    <a class="back" href="#/">← Gallery</a>
    <div class="toast" role="status" hidden></div>
    <div class="views" role="group" aria-label="Camera">
      <button data-view="overview">Overview</button>
      <button data-view="read">Read scale</button>
      <button data-view="top">Top</button>
    </div>
  </div>
  <aside class="panel">
    <header>
      <h1>Screw gauge <span class="bn">স্ক্রু গজ</span></h1>
      <p class="hint">Drag the thimble up/down (or scroll on it, or use ← →) to turn it. Drag anywhere else to look around.</p>
    </header>

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
    </section>

    <section>
      <h2>Measure <span class="bn">পরিমাপ</span></h2>
      <div class="row">
        <select class="specimen" aria-label="Specimen">
          <option value="none">Nothing</option>
          <option value="wire">Wire</option>
          <option value="ball">Steel ball</option>
        </select>
        <button class="respecimen">New one</button>
      </div>
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
      <label class="row"><span>Background</span><input class="bg" type="color" value="#2f5f77" /></label>
    </section>
  </aside>
</div>`;
