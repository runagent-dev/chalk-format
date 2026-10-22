// One file for deployment: dist/server.mjs (the CLI, everything bundled but PGlite) and dist/registry.sql.
import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';
mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/cli.ts'], outfile: 'dist/server.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22',
  // PGlite (tests and small setups) is loaded only for pglite: URLs; a deployment uses Postgres
  external: ['@electric-sql/pglite', '@electric-sql/pglite/*'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  legalComments: 'none', logLevel: 'warning',
});
copyFileSync(new URL('../../spec/1.2/registry.sql', import.meta.url), 'dist/registry.sql');
console.log('dist/server.mjs, dist/registry.sql');
