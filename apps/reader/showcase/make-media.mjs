// Makes the showcase book's media, once. The outputs in showcase/media/ are committed; rerun only to change them.
//
//   node apps/reader/showcase/make-media.mjs [path/to/chalk-3d]
//
// Needs ffmpeg, Playwright's Chromium, and (for the 3D model) a checkout of chalk-3d next to this repo.
//   pendulum.webm + pendulum-poster.png  a 1 m pendulum swinging at its real period, T = 2π√(L/g) ≈ 2.01 s
//   tuning-fork.mp3                      a 440 Hz tone that dies away like a struck fork
//   screw-gauge.glb + screw-gauge-poster.png  chalk-3d's screw gauge (pitch 0.5 mm, 50 divisions) as binary glTF
//   lab-poster.png                       the pendulum lab's opening view
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const out = path.join(here, 'media');
const chalk3d = path.resolve(process.argv[2] ?? path.join(repo, '../chalk-3d'));
mkdirSync(out, { recursive: true });
const font = (pkg, file) => 'file://' + path.join(repo, 'packages/reader/node_modules/@fontsource', pkg, 'files', file);
const FONTS = `@font-face{font-family:"Noto Sans Bengali";src:url(${font('noto-sans-bengali', 'noto-sans-bengali-bengali-400-normal.woff2')})}@font-face{font-family:"Noto Sans";src:url(${font('noto-sans', 'noto-sans-latin-400-normal.woff2')})}`;
/** A page loaded from a file next to the fonts, so file:// fonts load (about:blank may not fetch them). */
async function filePage(html, opts) {
  const f = path.join(here, `.tmp-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(f, `<!doctype html><meta charset="utf-8"><style>${FONTS}</style>${html}`);
  const p = await b.newPage(opts);
  await p.goto('file://' + f);
  rmSync(f);
  await p.evaluate(() => Promise.all([document.fonts.load('20px "Noto Sans"'), document.fonts.load('20px "Noto Sans Bengali"', 'ব')]));
  return p;
}
const b = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });

// ---------- pendulum video: drawn on a canvas, recorded in real time ----------
{
  const p = await filePage('<canvas id="c" width="640" height="360"></canvas>');
  const { webm, poster } = await p.evaluate(async () => {
    const c = document.getElementById('c'), g = c.getContext('2d');
    const L = 1, G = 9.8, T = 2 * Math.PI * Math.sqrt(L / G), th0 = 0.22, px = 320, py = 40, len = 250;
    const draw = (t) => {
      const th = th0 * Math.cos((2 * Math.PI * t) / T), bx = px + len * Math.sin(th), by = py + len * Math.cos(th);
      g.fillStyle = '#f6f3ea'; g.fillRect(0, 0, 640, 360);
      g.strokeStyle = '#1d2733'; g.lineWidth = 6; g.beginPath(); g.moveTo(220, py); g.lineTo(420, py); g.stroke();
      g.setLineDash([6, 6]); g.strokeStyle = '#b8c2cc'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px, py); g.lineTo(px, py + len + 30); g.stroke(); g.setLineDash([]);
      g.strokeStyle = '#1d2733'; g.lineWidth = 2; g.beginPath(); g.moveTo(px, py); g.lineTo(bx, by); g.stroke();
      g.fillStyle = '#9a3b12'; g.beginPath(); g.arc(bx, by, 18, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#1d2733'; g.font = '20px "Noto Sans Bengali", "Noto Sans"'; g.fillText('L = ১ m', 24, 300);
      g.fillText('T = 2π√(L/g) ≈ ২.০১ s', 24, 332);
      g.font = '28px "Noto Sans"'; g.textAlign = 'right'; g.fillText(`${t.toFixed(1)} s`, 616, 332); g.textAlign = 'left';
    };
    draw(0);
    const poster = c.toDataURL('image/png');
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 700_000 });
    const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start();
    const t0 = performance.now();
    await new Promise((r) => { const step = () => { const t = (performance.now() - t0) / 1000; draw(Math.min(t, 8.04)); if (t < 8.04) requestAnimationFrame(step); else r(); }; requestAnimationFrame(step); });
    rec.stop(); await done;
    const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { webm: btoa(s), poster };
  });
  writeFileSync(path.join(out, 'pendulum.webm'), Buffer.from(webm, 'base64'));
  writeFileSync(path.join(out, 'pendulum-poster.png'), Buffer.from(poster.split(',')[1], 'base64'));
  await p.close();
  console.log('pendulum.webm, pendulum-poster.png');
}

// ---------- tuning fork: 440 Hz, decaying ----------
execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'aevalsrc=0.6*sin(2*PI*440*t)*exp(-0.8*t):s=44100:d=5',
  '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', path.join(out, 'tuning-fork.mp3')]);
console.log('tuning-fork.mp3');

// ---------- the screw gauge as GLB, from chalk-3d's procedural model ----------
if (existsSync(path.join(chalk3d, 'src/models/screw-gauge/model.ts'))) {
  const tmp = path.join(here, '.tmp-export'); mkdirSync(tmp, { recursive: true });
  const entry = path.join(tmp, 'entry.ts');
  writeFileSync(entry, `
    import * as THREE from 'three';
    import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
    import { buildScrewGauge } from ${JSON.stringify(path.join(chalk3d, 'src/models/screw-gauge/model.ts'))};
    (window as any).make = async () => {
      const g = buildScrewGauge({ pitch: 0.5, divisions: 50, zeroDivisions: 0 });
      g.setGap(5.37);
      const scene = new THREE.Scene(); scene.add(g.root);
      // poster: the gauge on a light desk, three-quarter view
      const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); r.setSize(960, 720); r.setClearColor(0xeef1f4);
      r.toneMapping = THREE.ACESFilmicToneMapping; r.outputColorSpace = THREE.SRGBColorSpace;
      const pm = new THREE.PMREMGenerator(r); const env = new THREE.Scene(); env.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 3));
      scene.environment = pm.fromScene(env).texture;
      scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 1.4)); const d = new THREE.DirectionalLight(0xffffff, 2.2); d.position.set(0.1, 0.2, 0.15); scene.add(d);
      const box = new THREE.Box3().setFromObject(g.root), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).length();
      const cam = new THREE.PerspectiveCamera(30, 960 / 720, 0.001, 10); cam.position.set(c.x + s * 0.55, c.y + s * 0.45, c.z + s * 1.55); cam.lookAt(c);
      r.render(scene, cam);
      const poster = r.domElement.toDataURL('image/png');
      scene.remove(d);
      const glb = await new GLTFExporter().parseAsync(g.root, { binary: true }) as ArrayBuffer;
      const u = new Uint8Array(glb); let str = ''; for (let i = 0; i < u.length; i += 0x8000) str += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return { glb: btoa(str), poster };
    };`);
  const esbuild = path.join(repo, 'node_modules/.pnpm/node_modules/esbuild/bin/esbuild');
  execFileSync(existsSync(esbuild) ? esbuild : 'npx', [...(existsSync(esbuild) ? [] : ['esbuild']), entry, '--bundle', '--format=iife', `--outfile=${path.join(tmp, 'bundle.js')}`],
    { env: { ...process.env, NODE_PATH: path.join(chalk3d, 'node_modules') }, stdio: 'inherit' });
  const p = await filePage('');
  await p.addScriptTag({ content: readFileSync(path.join(tmp, 'bundle.js'), 'utf8') });
  const { glb, poster } = await p.evaluate(() => window.make());
  writeFileSync(path.join(out, 'screw-gauge.glb'), Buffer.from(glb, 'base64'));
  writeFileSync(path.join(out, 'screw-gauge-poster.png'), Buffer.from(poster.split(',')[1], 'base64'));
  rmSync(tmp, { recursive: true, force: true });
  await p.close();
  console.log('screw-gauge.glb, screw-gauge-poster.png');
} else console.log(`skipped the 3D model: no chalk-3d at ${chalk3d}`);

// ---------- the lab's poster: its opening view ----------
{
  const p = await b.newPage({ viewport: { width: 1160, height: 400 }, locale: 'bn-BD' });   // the book is Bengali, so is its poster
  await p.goto('file://' + path.join(repo, 'examples/labs/pendulum.html'));
  await p.addStyleTag({ content: FONTS });
  await p.waitForTimeout(800);
  await p.screenshot({ path: path.join(out, 'lab-poster.png') });
  await p.close();
  console.log('lab-poster.png');
}
await b.close();
