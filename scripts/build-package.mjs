// Builds the package in the current directory: type-checks and emits dist/ (ESM JS + .d.ts) with tsc, then copies any extra
// files given as arguments (e.g. CSS) into dist/. The monorepo itself keeps using the TypeScript source; dist/ is what is published.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';

rmSync('dist', { recursive: true, force: true });
const tsc = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
mkdirSync('dist', { recursive: true });
for (const file of process.argv.slice(2)) cpSync(file, `dist/${basename(file)}`);
