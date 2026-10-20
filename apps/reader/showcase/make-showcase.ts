// Builds the showcase book, public/samples/showcase.chalk, from committed sources:
//   chapter.html  the pages (printed to PDF in Chromium, then converted with @chalk-format/convert-pdf)
//   media/        video, audio, 3D model and posters (made once by make-media.mjs)
//   examples/labs/pendulum.html  the lab
// Every embed goes where chapter.html has a matching [data-embed] frame, so the layout lives in one place.
//
//   pnpm --filter @chalk-format/reader-app showcase
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { convertPdfToChalk } from '@chalk-format/convert-pdf';
import { packLesson, unpackLesson } from '@chalk-format/container';
import { getPageSize, hashBytes, type LessonObject, type LessonPage } from '@chalk-format/model';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const media = (f: string) => new Uint8Array(readFileSync(path.join(here, 'media', f)));
const font = (pkg: string, file: string) => 'file://' + path.join(repo, 'packages/reader/node_modules/@fontsource', pkg, 'files', file);
const FONTS = ['400', '600'].map((w) =>
  `@font-face{font-family:"Noto Sans Bengali";font-weight:${w};src:url(${font('noto-sans-bengali', `noto-sans-bengali-bengali-${w}-normal.woff2`)})}` +
  `@font-face{font-family:"Noto Sans";font-weight:${w};src:url(${font('noto-sans', `noto-sans-latin-${w}-normal.woff2`)})}`).join('');

type Box = { page: number; x: number; y: number; w: number; h: number };   // mm, from the page's top left

// ---------- 1. print the chapter, and read where its frames are ----------
const tmp = path.join(here, '.tmp-chapter.html');
writeFileSync(tmp, readFileSync(path.join(here, 'chapter.html'), 'utf8').replace('</head>', `<style>${FONTS}</style></head>`));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
// tsx compiles named functions with a __name helper; functions sent into the page need it there too
await page.addInitScript({ content: 'window.__name = (f) => f' });
await page.goto('file://' + tmp);
await page.evaluate(() => document.fonts.ready);
const { frames, snip, lines } = await page.evaluate(() => {
  const mm = 25.4 / 96, pages = [...document.querySelectorAll('.page')];
  const box = (el: Element) => {
    const p = el.closest('.page')!, pr = p.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { page: pages.indexOf(p), x: (r.left - pr.left) * mm, y: (r.top - pr.top) * mm, w: r.width * mm, h: r.height * mm };
  };
  const frames: Record<string, ReturnType<typeof box>> = {};
  document.querySelectorAll('[data-embed]').forEach((el) => { frames[(el as HTMLElement).dataset.embed!] = box(el); });
  // the text layer, from the page as laid out: one run per line of words, exact Unicode (see below)
  const lines: { page: number; text: string; x: number; y: number; w: number; size: number }[] = [];
  pages.forEach((p, pi) => {
    const pr = p.getBoundingClientRect(), walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement; if (!el || el.closest('script, style')) continue;
      const size = parseFloat(getComputedStyle(el).fontSize) * mm, text = n.textContent ?? '';
      let cur: (typeof lines)[number] | null = null, top = NaN;
      for (const m of text.matchAll(/\S+/g)) {
        const r = document.createRange(); r.setStart(n, m.index!); r.setEnd(n, m.index! + m[0].length);
        const b = r.getBoundingClientRect(); if (!b.width) continue;
        const x = (b.left - pr.left) * mm, y = (b.top - pr.top) * mm;
        if (cur && Math.abs(b.top - top) < 2) { cur.text += ' ' + m[0]; cur.w = x + b.width * mm - cur.x; }
        else { cur = { page: pi, text: m[0], x, y, w: b.width * mm, size }; lines.push(cur); top = b.top; }
      }
    }
  });
  return { frames, snip: box(document.querySelector('[data-snip]')!), lines };
});
const snipPng = await (await page.$('[data-snip]'))!.screenshot({ scale: 'device' });
const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
await browser.close();
rmSync(tmp);
console.log(`chapter.pdf: ${(pdf.length / 1024).toFixed(0)} KB, frames: ${Object.keys(frames).join(', ')}`);

// ---------- 2. convert ----------
const converted = await convertPdfToChalk(new Uint8Array(pdf), 'পদার্থবিজ্ঞান · নমুনা অধ্যায়', { locale: 'bn', license: 'CC BY 4.0', author: 'Chalk format showcase' });
const { lesson, assets } = await unpackLesson(converted);
lesson.id = 'chalk-showcase-physics';   // stable, so saved notes and lab state survive a rebuild

// The text layer from the PDF is not usable for Bengali: Chromium's PDF has no Unicode for shaped glyphs
// (conjuncts, pre-base vowel signs), so pdf.js reads them as U+0000. We have the source, so the text layer
// comes from the laid-out page instead: the same positions, the right characters.
lesson.pages.forEach((p, pi) => {
  const { width, height } = getPageSize(p), kx = width / 210, ky = height / 297;
  p.textLayer = lines.filter((l) => l.page === pi).map((l) => ({
    text: l.text, x: Math.round(l.x * kx * 10) / 10, y: Math.round(l.y * ky * 10) / 10, width: Math.round(l.w * kx * 10) / 10, fontSize: Math.round(l.size * ky * 10) / 10,
  }));
});

// ---------- 3. the media, the lab, a snip and the book's own notes ----------
const add = async (bytes: Uint8Array, type: string) => { const id = await hashBytes(bytes); assets.set(id, { type, bytes }); return id; };
const ids = {
  video: await add(media('pendulum.webm'), 'video/webm'), videoPoster: await add(media('pendulum-poster.png'), 'image/png'),
  audio: await add(media('tuning-fork.mp3'), 'audio/mpeg'),
  model: await add(media('screw-gauge.glb'), 'model/gltf-binary'), modelPoster: await add(media('screw-gauge-poster.png'), 'image/png'),
  lab: await add(new Uint8Array(readFileSync(path.join(repo, 'examples/labs/pendulum.html'))), 'text/html'), labPoster: await add(media('lab-poster.png'), 'image/png'),
  snip: await add(new Uint8Array(snipPng), 'image/png'),
};
const at = (b: Box) => {
  const p = lesson.pages[b.page]!, { width, height } = getPageSize(p), kx = width / 210, ky = height / 297;
  return { page: p, x: Math.round(b.x * kx), y: Math.round(b.y * ky), width: Math.round(b.w * kx), height: Math.round(b.h * ky), kx, ky };
};
const put = (p: LessonPage, o: LessonObject) => { p.objects.push(o); };

{ const b = at(frames.model3d!); put(b.page, { id: 'screw-gauge', type: 'embed', embed: 'model3d', x: b.x, y: b.y, width: b.width, height: b.height, assetId: ids.model, poster: ids.modelPoster }); }
{ const b = at(frames.video!); put(b.page, { id: 'pendulum-video', type: 'embed', embed: 'video', x: b.x, y: b.y, width: b.width, height: b.height, assetId: ids.video, poster: ids.videoPoster }); }
{ const b = at(frames.audio!); put(b.page, { id: 'tuning-fork', type: 'embed', embed: 'audio', x: b.x, y: b.y, width: b.width, height: b.height, assetId: ids.audio }); }
{
  const b = at(frames.lab!);
  put(b.page, {
    id: 'pendulum-lab', type: 'embed', embed: 'plugin', plugin: 'chalk.lab', x: b.x, y: b.y, width: b.width, height: b.height, poster: ids.labPoster,
    lab: { id: 'org.chalk-format.examples.pendulum', version: '1.0.0', title: 'সরল দোলক · Simple pendulum', entry: ids.lab,
      params: { length: 1, swings: 10, readings: 3 }, capabilities: ['state', 'progress'] },
  });
}
{
  // a snip of the pendulum diagram: a marker beside it opens it as its own page, for the student to write on
  const b = at(snip), w = snipPng.readUInt32BE(16), h = snipPng.readUInt32BE(20);
  lesson.snipPages.push({ id: 'snip-pendulum', title: 'সরল দোলকের চিত্র', width: w, height: h, background: { type: 'image', assetId: ids.snip }, objects: [] });
  put(b.page, { id: 'snip-pendulum-marker', type: 'snip', x: b.x + b.width - 30, y: b.y - 10, snipPageId: 'snip-pendulum' });
}
{
  // the book's own notes, drawn over the printed page: a ring round the worked example, and a reminder
  const p = lesson.pages[1]!, { width, height } = getPageSize(p), kx = width / 210, ky = height / 297;
  const cx = 105 * kx, cy = 158 * ky, rx = 92 * kx, ry = 9 * ky, pts: number[] = [];
  for (let i = 0; i <= 64; i++) { const a = -Math.PI / 2 + (i / 64) * Math.PI * 2.08; pts.push(Math.round(Math.cos(a) * rx * (1 + 0.012 * Math.sin(i))), Math.round(Math.sin(a) * ry)); }
  put(p, { id: 'teacher-ring', type: 'ink', x: Math.round(cx), y: Math.round(cy), points: pts, color: '#c0392b', size: 5 });
  put(p, { id: 'teacher-note', type: 'text', x: Math.round(150 * kx), y: Math.round(170 * ky), text: 'মনে রাখো!', fontSize: Math.round(5.2 * ky), fill: '#c0392b' });
}
{
  // page 4: the tuning fork again as a small marker (icon display mode) beside the table
  const p = lesson.pages[3]!, { width, height } = getPageSize(p), kx = width / 210, ky = height / 297;
  put(p, { id: 'tuning-fork-icon', type: 'embed', embed: 'audio', x: Math.round(176 * kx), y: Math.round(233 * ky), width: 56, height: 56, assetId: ids.audio, displayMode: 'icon' });
}

// ---------- 4. pack ----------
const out = path.join(repo, 'apps/reader/public/samples');
mkdirSync(out, { recursive: true });
const bytes = await packLesson(lesson, assets);
writeFileSync(path.join(out, 'showcase.chalk'), bytes);
const runs = lesson.pages.reduce((n, p) => n + (p.textLayer?.length ?? 0), 0);
console.log(`showcase.chalk: ${(bytes.length / 1024 / 1024).toFixed(2)} MB, ${lesson.pages.length} pages, ${runs} text runs, ${assets.size} assets`);
