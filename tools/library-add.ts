// Fill a library from a list: media with titles, tags and posters, and labs from their manifests (the lab's page,
// its poster, the shared libraries it names, then the manifest itself, so an authoring tool can place it whole).
// Adding what is already there uploads nothing, so a list can be run again.
//
//   CHALK_LIBRARY_TOKEN=… npx tsx tools/library-add.ts https://library.example.org examples/library-seed.json
//
// The list (paths relative to it):
//   [{ "file": "a.webm", "title": "…", "tags": ["…"], "subject": "physics", "license": "…", "poster": "a.png" },
//    { "lab": "labs/x.lab.json", "files": { "c1:…": "labs/x.html" } }]
// A lab's manifest names its entry and poster by key; "files" says which file has those bytes. Shared libraries
// (three.js …) come from libraries/catalog.json.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assetKey, inLanguage, LAB_MANIFEST_TYPE, labManifestSchema, type AssetMeta } from '../packages/model/src/index.ts';
import { createRegistryClient } from '../packages/store/src/index.ts';

type Media = { file: string; title?: string; tags?: string[]; subject?: string; license?: string; poster?: string; type?: string };
type Lab = { lab: string; files: Record<string, string> };

const [url, listFile] = process.argv.slice(2);
const token = process.env.CHALK_LIBRARY_TOKEN;
if (!url || !listFile || !token) { console.error('usage: CHALK_LIBRARY_TOKEN=… npx tsx tools/library-add.ts <library url> <list.json>'); process.exit(2); }
const base = path.dirname(path.resolve(listFile));
const repo = path.resolve(import.meta.dirname, '..');
const client = createRegistryClient(url, { token });

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary', '.html': 'text/html', '.js': 'text/javascript', '.pdf': 'application/pdf',
};
const typeOf = (f: string) => TYPES[path.extname(f).toLowerCase()] ?? 'application/octet-stream';

/** Size and length from ffprobe, for images, video and audio (what a gallery shows, and how an editor places it). */
function metaOf(file: string, type: string): AssetMeta | undefined {
  if (!/^(image|video|audio)\//.test(type) || type === 'image/svg+xml') return undefined;
  try {
    const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' })) as
      { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
    const s = out.streams?.find((x) => x.width), d = Number(out.format?.duration);
    const m: AssetMeta = {};
    if (s?.width && s.height) { m.width = s.width; m.height = s.height; }
    if (/^(video|audio)\//.test(type) && d > 0) m.duration = Math.round(d * 100) / 100;
    return Object.keys(m).length ? m : undefined;
  } catch { return undefined; }
}

const done = new Map<string, string>();
async function add(file: string, o: Omit<Media, 'file' | 'poster'> & { poster?: string } = {}): Promise<string> {
  const abs = path.resolve(base, file), type = o.type ?? typeOf(abs);
  if (done.has(abs)) return done.get(abs)!;
  const bytes = new Uint8Array(readFileSync(abs));
  const meta = metaOf(abs, type);
  const r = await client.add(bytes, {
    type, filename: path.basename(abs),
    ...(o.title ? { title: o.title } : {}), ...(o.tags?.length ? { tags: o.tags } : {}), ...(o.subject ? { subject: o.subject } : {}),
    ...(o.license ? { license: o.license } : {}), ...(meta ? { meta } : {}), ...(o.poster ? { poster: o.poster } : {}),
  });
  done.set(abs, r.key);
  console.log(`${r.key}  ${type.padEnd(32)} ${o.title ?? path.basename(abs)}`);
  return r.key;
}

const list = JSON.parse(readFileSync(listFile, 'utf8')) as (Media | Lab)[];
const catalog = JSON.parse(readFileSync(path.join(repo, 'libraries/catalog.json'), 'utf8')) as { libraries: { key: string; file: string; specifier: string; version: string }[] };

for (const entry of list) {
  if ('lab' in entry) {
    const raw = readFileSync(path.resolve(base, entry.lab));
    const m = labManifestSchema.parse(JSON.parse(raw.toString('utf8')));
    const title = [inLanguage(m.title, 'bn'), inLanguage(m.title, 'en')].filter((v, i, a) => a.indexOf(v) === i).join(' · ');
    // every key the manifest names must be bytes we have, and they must be those bytes
    const need = [m.entry, ...(m.poster ? [m.poster] : []), ...(m.assets ?? [])];
    for (const k of need) {
      const f = entry.files[k];
      if (!f) throw new Error(`${entry.lab}: no file for ${k}`);
      const got = await assetKey(new Uint8Array(readFileSync(path.resolve(base, f))));
      if (got !== k) throw new Error(`${entry.lab}: ${f} is ${got}, the manifest says ${k}`);
      await add(f, k === m.poster ? { title: `${title} (poster)` } : { title: k === m.entry ? `${title} (lab page)` : path.basename(f) });
    }
    for (const lib of m.libraries ?? []) {
      const c = catalog.libraries.find((x) => x.key === lib.asset);
      if (!c) throw new Error(`${entry.lab}: ${lib.specifier} ${lib.asset} is not in libraries/catalog.json (run tools/lab-libraries.ts)`);
      const built = path.join(repo, 'libraries', c.file);
      if (!existsSync(built)) throw new Error(`${built} is missing: build the shared libraries first (npx tsx tools/lab-libraries.ts)`);
      await add(built, { title: `${c.specifier} ${c.version}`, tags: ['lab library'], type: 'text/javascript' });
    }
    await add(entry.lab, { type: LAB_MANIFEST_TYPE, title, ...(m.tags ? { tags: m.tags } : {}), ...(m.subject ? { subject: m.subject } : {}), ...(m.license ? { license: m.license } : {}), ...(m.poster ? { poster: m.poster } : {}) });
  } else {
    const poster = entry.poster ? await add(entry.poster, { ...(entry.title ? { title: `${entry.title} (poster)` } : {}) }) : undefined;
    await add(entry.file, { ...entry, ...(poster ? { poster } : {}) });
  }
}
console.log(`${done.size} files in ${url}`);
