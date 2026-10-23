// Publishes the four assembled packages in dist-packages/ that are not on npm yet, in dependency order (core first).
// Safe to run again: a package whose name@version already exists on the registry is skipped, so a release only publishes what the
// version in release.json has not published yet. Used by .github/workflows/release.yml; run it by hand after `node scripts/assemble-packages.mjs`.
//
//   node scripts/publish-packages.mjs --dry-run   shows what would be published, uploads nothing
//   node scripts/publish-packages.mjs             publishes (needs npm credentials, or trusted publishing in CI)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const ORDER = ['chalk-core', 'chalk-reader', 'chalk-pdf', 'chalk-library-server'];
const dryRun = process.argv.includes('--dry-run');

let published = 0, skipped = 0;
for (const dir of ORDER) {
  const cwd = path.join(root, 'dist-packages', dir);
  const { name, version } = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const view = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' });
  if (view.status === 0 && view.stdout.trim() === version) {
    console.log(`${name}@${version}: already on npm, skipped`);
    skipped++;
    continue;
  }
  // only "not found" means "not published"; anything else (network, auth) must stop the release rather than guess
  if (!/E404/.test(`${view.stdout}${view.stderr}`)) {
    console.error(`${name}@${version}: could not check the registry\n${view.stderr || view.stdout}`);
    process.exit(1);
  }
  console.log(`${name}@${version}: ${dryRun ? 'would publish (dry run)' : 'publishing'}`);
  const pub = spawnSync('npm', ['publish', '--access', 'public', ...(dryRun ? ['--dry-run'] : [])], { cwd, stdio: 'inherit' });
  if (pub.status !== 0) process.exit(pub.status ?? 1);
  published++;
}
console.log(`${dryRun ? 'dry run: ' : ''}${published} published, ${skipped} already on npm`);
