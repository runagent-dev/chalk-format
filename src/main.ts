import '@fontsource/noto-sans/500.css';
import '@fontsource/noto-sans/600.css';
import '@fontsource/noto-sans/700.css';
import '@fontsource/noto-sans-bengali/500.css';
import '@fontsource/noto-sans-bengali/600.css';
import './styles.css';
import { MODELS } from './models/registry';

const app = document.getElementById('app')!;
let dispose: (() => void) | null = null;

const SUBJECTS: Record<string, string> = { physics: 'Physics · পদার্থবিজ্ঞান', chemistry: 'Chemistry · রসায়ন', biology: 'Biology · জীববিজ্ঞান', math: 'Math · গণিত' };

function gallery() {
  app.innerHTML = `
  <main class="gallery">
    <header>
      <p class="eyebrow">PathshalaX · 3D</p>
      <h1>Science gallery <span class="bn">বিজ্ঞান গ্যালারি</span></h1>
      <p class="lede">Real instruments and models you can turn, measure and take apart. Built in code, light on phones.</p>
    </header>
    <ul class="cards">
      ${MODELS.map((m) => `
        <li><a class="card" href="#/${m.id}">
          <div class="art"><img src="${m.poster}" alt="" width="600" height="360" loading="lazy" /></div>
          <div class="meta"><span class="subject ${m.subject}">${SUBJECTS[m.subject]}</span><span class="level">${m.level}</span></div>
          <h2>${m.title} <span class="bn">${m.titleBn}</span></h2>
          <p>${m.summary}</p>
        </a></li>`).join('')}
      <li class="soon"><div class="card"><h2>Coming next</h2><p>Pendulum, optical bench, metre bridge, molecules, DNA, the human heart.</p></div></li>
    </ul>
  </main>`;
}

async function route() {
  dispose?.();
  dispose = null;
  const id = location.hash.replace(/^#\/?/, '');
  const model = MODELS.find((m) => m.id === id);
  if (!model) { gallery(); document.title = 'PathshalaX 3D Gallery'; return; }
  document.title = `${model.title} · PathshalaX 3D`;
  app.innerHTML = '<div class="loading">Loading…</div>';
  dispose = await model.mount(app);
}

window.addEventListener('hashchange', route);
route();
