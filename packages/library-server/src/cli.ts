#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { createLibraryApp } from './app.js';
import { AUTH_USAGE, readSecret, runAuthCommand } from './auth/cli.js';
import { libraryFromEnv } from './config.js';
import { scanStorage } from './scan.js';

// chalk-library serve | scan [prefix] | check <url> (--token … | --user …) [--admin-token …] | user … | key … (configuration: see config.ts)
const [cmd = 'serve', arg] = process.argv.slice(2);
if (cmd === 'check') {
  const opt = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  if (!arg || !(opt('--token') || opt('--user'))) { console.error('usage: chalk-library check <url> (--token … | --user … [password: CHALK_LIBRARY_PASSWORD, prompt or stdin]) [--admin-token …]'); process.exit(2); }
  const { checkLibrary } = await import('./conformance.js');
  const who = opt('--token') ? { token: opt('--token')! } : { username: opt('--user')!, password: process.env.CHALK_LIBRARY_PASSWORD ?? (await readSecret('password: ')) };
  const results = await checkLibrary(arg, { ...who, ...(opt('--admin-token') ? { adminToken: opt('--admin-token')! } : {}) });
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
if (cmd === 'user' || cmd === 'key' || cmd === 'signing-key') process.exit(await runAuthCommand(process.argv.slice(2)));
const o = await libraryFromEnv();
if (cmd === 'serve') {
  const app = createLibraryApp(o);
  serve({ fetch: app.fetch, port: o.port }, (i) => console.log(`chalk library on :${i.port} · storage ${o.storage.id} · readers fetch from ${o.publicUrl}`));
} else if (cmd === 'scan') {
  const r = await scanStorage(o.db, o.storage, { ...(arg ? { prefix: arg } : {}), onProgress: (d, n, p) => process.stdout.write(`\r${d}/${n} ${p.slice(-60).padEnd(60)}`) });
  console.log(`\n${r.found} media files found, ${r.added} added to the library`);
  await o.db.close();
} else {
  console.error(`usage: chalk-library serve | scan [prefix] | check <url> …\n${AUTH_USAGE}`);
  process.exit(2);
}
