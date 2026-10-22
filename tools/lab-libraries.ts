// Shared library builds for labs (spec 1.5 §2): three.js and the add-ons labs use most, each one ES module that
// imports the shared `three`. Reproducible: the same three version gives the same bytes, so the same keys, on any
// machine, and books share them.
//
//   npx tsx tools/lab-libraries.ts            build into libraries/build/, write libraries/catalog.json
//   npx tsx tools/lab-libraries.ts --check    build, and fail if the keys differ from catalog.json (CI)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { assetKey } from '../packages/model/src/index.ts';

const root = new URL('..', import.meta.url).pathname;
const require = createRequire(path.join(root, 'packages/reader/package.json'));
// three's exports do not include package.json: find the package from its main module
const threeDir = path.resolve(path.dirname(require.resolve('three')), '..');
const version: string = JSON.parse(readFileSync(path.join(threeDir, 'package.json'), 'utf8')).version;

/** specifier → source file in the three package */
const LIBRARIES: [string, string][] = [
  ['three', 'build/three.module.js'],
  ['three/addons/controls/OrbitControls.js', 'examples/jsm/controls/OrbitControls.js'],
  ['three/addons/loaders/GLTFLoader.js', 'examples/jsm/loaders/GLTFLoader.js'],
  ['three/addons/renderers/CSS2DRenderer.js', 'examples/jsm/renderers/CSS2DRenderer.js'],
];

const out = path.join(root, 'libraries/build');
mkdirSync(out, { recursive: true });
const catalog = [];
for (const [specifier, file] of LIBRARIES) {
  const r = await build({
    entryPoints: [path.join(threeDir, file)], bundle: true, minify: true, format: 'esm', target: 'es2020',
    external: specifier === 'three' ? [] : ['three'], write: false, legalComments: 'inline', logLevel: 'error',
  });
  const bytes = r.outputFiles[0]!.contents;
  const name = `three-${version}-${specifier === 'three' ? 'core' : path.basename(file, '.js')}.js`;
  writeFileSync(path.join(out, name), bytes);
  catalog.push({ specifier, version, file: `build/${name}`, size: bytes.byteLength, key: await assetKey(bytes) });
}

const doc = { about: 'Shared library builds for Chalk labs (spec 1.5 §2). Built by tools/lab-libraries.ts; same version, same bytes, same keys.', libraries: catalog };
const at = path.join(root, 'libraries/catalog.json');
if (process.argv.includes('--check')) {
  const before = JSON.parse(readFileSync(at, 'utf8')).libraries as { specifier: string; key: string }[];
  const diff = catalog.filter((c) => before.find((b) => b.specifier === c.specifier)?.key !== c.key);
  if (diff.length) { console.error('library builds differ from libraries/catalog.json:', diff.map((d) => d.specifier).join(', ')); process.exit(1); }
  console.log('library builds match libraries/catalog.json');
} else {
  writeFileSync(at, JSON.stringify(doc, null, 2) + '\n');
  for (const c of catalog) console.log(`${c.specifier.padEnd(42)} ${(c.size / 1024).toFixed(0).padStart(5)} KB  ${c.key}`);
}
