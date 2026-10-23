// Builds the four packages published to npm from the workspace's internal packages:
//
//   @chalk-format/book            model, container, store, lab     (the format: books, files, keys, stores, libraries, labs)
//   @chalk-format/reader          reader (+ pdf-engine)            (the React reader and editor)
//   @chalk-format/pdf             convert-pdf, cli (+ pdf-engine)  (PDF → .chalk, and the chalk-pdf command)
//   @chalk-format/library-server  library-server                   (the registry API server, and the chalk-library command)
//
// (The folders under dist-packages/ and packaging/ are named chalk-book, chalk-reader, chalk-pdf and chalk-library-server.)
//
// Each internal package is compiled by tsc into its own dist/ (scripts/build-package.mjs). This copies those into
// dist-packages/<name>/dist/<part>/, rewrites imports between internal packages (to a relative path inside the same
// published package, or to @chalk-format/book), writes each package.json from what the parts really depend on, and checks
// that every import in the output is a relative file, a Node builtin or a declared dependency.
//
//   node scripts/assemble-packages.mjs            build the internal packages, then assemble into dist-packages/
//   node scripts/assemble-packages.mjs --no-build assemble from the dist/ folders already there
//
// The version of all four is the one in release.json (they are released together).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist-packages');
const { version } = JSON.parse(readFileSync(path.join(root, 'release.json'), 'utf8'));
const SCOPE = '@chalk-format/';
const BOOK_PARTS = ['model', 'container', 'store', 'lab'];
/** The id of each published package (its folder in dist-packages/ and packaging/) → its name on npm. */
const NPM_NAMES = {
  'chalk-book': '@chalk-format/book',
  'chalk-reader': '@chalk-format/reader',
  'chalk-pdf': '@chalk-format/pdf',
  'chalk-library-server': '@chalk-format/library-server',
};
const BOOK = NPM_NAMES['chalk-book'];

const COMMON = {
  license: 'Apache-2.0',
  homepage: 'https://github.com/runagent-dev/chalk-format#readme',
  repository: { type: 'git', url: 'git+https://github.com/runagent-dev/chalk-format.git' },
  bugs: { url: 'https://github.com/runagent-dev/chalk-format/issues' },
  type: 'module',
  engines: { node: '>=20' },
};

/** What each published package holds. `index`: the parts re-exported from its root; `exports`: other entry points. */
const PACKAGES = [
  {
    name: 'chalk-book',
    description: 'The .chalk interactive book format: the data model, reading and writing .chalk files, asset keys and stores, media libraries, and labs.',
    keywords: ['chalk', 'chalk-format', 'interactive-book', 'textbook', 'education', 'bengali', 'zod'],
    parts: BOOK_PARTS,
    index: ['model', 'container', 'store', 'lab'],
    exports: { './lab/client': 'lab/client' },
  },
  {
    name: 'chalk-reader',
    description: 'The reader and editor for .chalk books: a configurable React component (pages, search, notes, video, 3D, labs, author mode, media libraries).',
    keywords: ['chalk', 'chalk-format', 'react', 'reader', 'ebook', 'editor', 'education', 'bengali'],
    parts: ['reader', 'pdf-engine'],
    index: ['reader'],
    files: { './styles.css': 'reader/styles.css', './fonts.css': 'reader/fonts.css' },
    sideEffects: ['*.css'],
  },
  {
    name: 'chalk-pdf',
    description: 'Convert a PDF into a .chalk book, in Node: rendered pages and a searchable text layer. Includes the chalk-pdf command.',
    keywords: ['chalk', 'chalk-format', 'pdf', 'convert', 'pdfjs', 'education'],
    parts: ['convert-pdf', 'pdf-engine', 'cli'],
    index: ['convert-pdf'],
    exports: { './engine': 'pdf-engine/index' },
    bin: { 'chalk-pdf': 'cli/cli' },
  },
  {
    name: 'chalk-library-server',
    description: 'A Chalk library server: the registry API over Postgres and S3-compatible storage (Cloudflare R2, MinIO, AWS S3), with a conformance check. Includes the chalk-library command.',
    keywords: ['chalk', 'chalk-format', 'media-library', 'registry', 's3', 'r2', 'postgres', 'education'],
    parts: ['library-server'],
    index: ['library-server'],
    bin: { 'chalk-library': 'library-server/cli' },
    // the one-file Docker bundle is not needed here: the command runs from the compiled modules
    skip: ['library-server/server.mjs'],
  },
];

const owner = (part) => (BOOK_PARTS.includes(part) ? 'chalk-book' : null);
const pkgJson = (part) => JSON.parse(readFileSync(path.join(root, 'packages', part, 'package.json'), 'utf8'));
/** An internal package's entry point (".", "./client", …) → its compiled file, relative to its dist/ ("client.js"). */
function entryFile(part, sub) {
  const ex = pkgJson(part).exports ?? {};
  const target = ex[sub] ?? (sub === '.' ? pkgJson(part).main : undefined);
  const src = typeof target === 'string' ? target : target?.import ?? target?.default;
  if (!src) throw new Error(`${part} has no entry point ${sub}`);
  return src.replace(/^\.\/src\//, '').replace(/\.tsx?$/, '.js');
}

if (!process.argv.includes('--no-build')) {
  for (const part of new Set(PACKAGES.flatMap((p) => p.parts))) {
    const r = spawnSync('pnpm', ['run', 'build'], { cwd: path.join(root, 'packages', part), stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

rmSync(out, { recursive: true, force: true });
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
let problems = 0;

for (const pkg of PACKAGES) {
  const dir = path.join(out, pkg.name), dist = path.join(dir, 'dist');
  const usesBook = new Set();
  for (const part of pkg.parts) {
    const from = path.join(root, 'packages', part, 'dist');
    if (!existsSync(from)) throw new Error(`packages/${part}/dist is missing: build it first`);
    cpSync(from, path.join(dist, part), { recursive: true, filter: (f) => !(pkg.skip ?? []).includes(`${part}/${path.relative(from, f).split(path.sep).join('/')}`) });
  }
  // imports between internal packages → a file in this package, or chalk-book
  for (const file of walk(dist).filter((f) => /\.(js|mjs|d\.ts)$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    const next = text.replace(/(['"])@chalk-format\/([a-z-]+)(\/[a-z-]+)?\1/g, (_m, q, part, subpath) => {
      const sub = subpath ? `.${subpath}` : '.';
      if (pkg.parts.includes(part)) {
        let rel = path.relative(path.dirname(file), path.join(dist, part, entryFile(part, sub))).split(path.sep).join('/');
        if (!rel.startsWith('.')) rel = `./${rel}`;
        return q + rel + q;
      }
      if (owner(part) === 'chalk-book') {
        usesBook.add(part);
        if (sub === '.') return `${q}${BOOK}${q}`;
        if (part === 'lab' && sub === './client') return `${q}${BOOK}/lab/client${q}`;
      }
      throw new Error(`${NPM_NAMES[pkg.name]}: ${path.relative(dist, file)} imports ${SCOPE}${part}${subpath ?? ''}, which no published package provides`);
    });
    if (next !== text) writeFileSync(file, next);
  }
  // the root entry point re-exports its parts
  const reexport = (ext) => pkg.index.map((p) => `export * from './${p}/${entryFile(p, '.').replace(/\.js$/, ext)}';`).join('\n') + '\n';
  writeFileSync(path.join(dist, 'index.js'), reexport('.js'));
  writeFileSync(path.join(dist, 'index.d.ts'), reexport('.js'));

  // dependencies: what the parts declare (internal ones become @chalk-format/book), at the parts' own ranges
  const deps = {}, peers = {};
  for (const part of pkg.parts) {
    const pj = pkgJson(part);
    for (const [n, v] of Object.entries(pj.dependencies ?? {})) if (!n.startsWith(SCOPE)) deps[n] = v;
    for (const [n, v] of Object.entries(pj.peerDependencies ?? {})) peers[n] = v;
  }
  if (usesBook.size) deps[BOOK] = `^${version}`;

  const exports = { '.': { types: './dist/index.d.ts', import: './dist/index.js' } };
  for (const [k, f] of Object.entries(pkg.exports ?? {})) exports[k] = { types: `./dist/${f}.d.ts`, import: `./dist/${f}.js` };
  for (const [k, f] of Object.entries(pkg.files ?? {})) exports[k] = `./dist/${f}`;
  exports['./package.json'] = './package.json';

  const manifest = {
    name: NPM_NAMES[pkg.name], version, description: pkg.description, keywords: pkg.keywords, ...COMMON,
    main: './dist/index.js', types: './dist/index.d.ts', exports,
    ...(pkg.bin ? { bin: Object.fromEntries(Object.entries(pkg.bin).map(([k, f]) => [k, `./dist/${f}.js`])) } : {}),
    files: ['dist', 'README.md', 'LICENSE', 'NOTICE'],
    sideEffects: pkg.sideEffects ?? false,
    dependencies: Object.fromEntries(Object.entries(deps).sort()),
    ...(Object.keys(peers).length ? { peerDependencies: peers } : {}),
    // provenance is added by the release workflow (`npm publish --provenance`); it only works from CI, not from a laptop
    publishConfig: { access: 'public' },
  };
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const f of ['LICENSE', 'NOTICE']) cpSync(path.join(root, f), path.join(dir, f));
  cpSync(path.join(root, 'packaging', pkg.name, 'README.md'), path.join(dir, 'README.md'));

  // every bare import must be a Node builtin or a declared dependency
  const allowed = new Set([...Object.keys(deps), ...Object.keys(peers)]);
  for (const file of walk(dist).filter((f) => /\.(js|mjs)$/.test(f))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\1/g)) {
      const spec = m[2];
      if (spec.startsWith('.') || spec.startsWith('node:') || builtinModules.includes(spec.split('/')[0])) continue;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!allowed.has(name)) { problems++; console.error(`${NPM_NAMES[pkg.name]}: ${path.relative(dir, file)} imports ${spec}, not a dependency`); }
    }
  }
  console.log(`${NPM_NAMES[pkg.name]}@${version}: ${pkg.parts.join(' + ')} · ${Object.keys(deps).length} dependencies`);
}
if (problems) process.exit(1);
