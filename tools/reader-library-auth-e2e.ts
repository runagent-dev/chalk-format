// Signing in to a library from the showcase, in a real browser, against a fake library that follows the authentication contract
// (tools/fake-auth-library.ts: PUBLIC_READ=false, a bearer store, access tokens of --access-seconds, refresh tokens rotated on use).
// Publishes the streamed physics sample into the fake as library items, opens `?library=…&book=…` in the showcase and checks: the sign-in
// form comes first, a wrong password is refused, the right one opens the book with every request carrying the token and the pictures drawn
// from fetched bytes, the sign-in survives a reload, the access token is refreshed (and the rotated refresh token kept) when it runs low,
// and signing out revokes it and brings the form back.
//
//   npx tsx tools/reader-library-auth-e2e.ts [showcase-url] [--port 4923] [--shots <dir>]
//
// The showcase must be running (default http://localhost:5190/). Nothing outside this process is written to.
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { StreamIndex } from '@chalk-format/model';
import { fakeAuthLibrary } from './fake-auth-library.ts';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const PORT = Number(opt('--port') ?? 4923);
const SHOTS = opt('--shots');
const [SHOWCASE = 'http://localhost:5190/'] = args;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ACCESS_SECONDS = 75;        // the reader refreshes with less than 60 s left: 15 s after a sign-in

let failed = false;
const check = (name: string, ok: boolean, detail = '') => { if (!ok) failed = true; console.log(ok ? 'ok  ' : 'FAIL', name, detail); };

// ---- the fake library, with the sample book in it ----
const BASE = `http://127.0.0.1:${PORT}/`;
const lib = fakeAuthLibrary({ base: BASE, users: { rahim: { password: 'pendulum-period-42', roles: ['reader'] } }, accessSeconds: ACCESS_SECONDS, cors: true });
const dir = path.join(import.meta.dirname, '../apps/reader/public/samples/showcase');
const index = JSON.parse(readFileSync(path.join(dir, 'book.json'), 'utf8')) as StreamIndex;
const slug = 'physics-signin-e2e';
const tags = (kind: string) => [`book:${slug}`, 'book-revision:1', `kind:${kind}`, 'state:current'];
for (const a of index.assets) await lib.add(readFileSync(path.join(dir, a.path!)), a.type);
const toItem = async (p: StreamIndex['pages'][number]) => {
  const { key } = await lib.add(readFileSync(path.join(dir, p.file)), 'application/vnd.chalk.page+json', tags('page'));
  const { file: _file, ...rest } = p;
  return { ...rest, key };
};
const textBytes = readFileSync(path.join(dir, index.text!.file));
const text = await lib.add(textBytes, 'application/vnd.chalk.text+json', tags('text'));
const { text: _text, ...rest } = index;
await lib.add(new TextEncoder().encode(JSON.stringify({
  ...rest,
  pages: await Promise.all(index.pages.map(toItem)),
  ...(index.snipPages ? { snipPages: await Promise.all(index.snipPages.map(toItem)) } : {}),
  text: { key: text.key, bytes: textBytes.byteLength },
  assets: index.assets.map(({ path: _path, ...a }) => a),
})), 'application/vnd.chalk.book+json', tags('book'));

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const body = chunks.length && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
    void lib.handle(new Request(new URL(req.url!, BASE), { method: req.method!, headers, ...(body ? { body } : {}) })).then(async (r) => {
      res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
      res.end(Buffer.from(await r.arrayBuffer()));
    });
  });
});
await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`fake library on ${BASE}: ${lib.items.length} items`);

// ---- the browser ----
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
const errors: string[] = [], consoleText: string[] = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => consoleText.push(m.text()));
const storageKey = `chalk-library-auth:${BASE}`;
const stored = () => p.evaluate((k) => localStorage.getItem(k), storageKey).then((v) => (v ? JSON.parse(v) as { refresh: string; access: string } : null));
const bookOpen = () => p.waitForFunction(() => document.querySelectorAll('.chalk-page').length > 0 && !document.querySelector('.chalk-state'), null, { timeout: 30000, polling: 250 }).then(() => true, () => false);
const blobPictures = () => p.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.chalk-page img')].filter((i) => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0).length);

await p.goto(`${SHOWCASE}?${new URLSearchParams({ library: BASE, book: slug })}`);
await p.waitForSelector('.chalk-signin', { timeout: 15000 }).catch(() => {});
check('the sign-in form comes first', !!(await p.$('.chalk-signin')) && !(await p.$('.chalk-page')));
if (SHOTS) await p.screenshot({ path: `${SHOTS}/signin.png` });

await p.fill('input[name="username"]', 'rahim');
await p.fill('input[name="password"]', 'not-the-password');
await p.click('.chalk-signin-submit');
await p.waitForSelector('.chalk-signin-error', { timeout: 10000 }).catch(() => {});
check('a wrong password is refused, on the form', !!(await p.$('.chalk-signin-error')) && !(await stored()), (await (await p.$('.chalk-signin-error'))?.textContent()) ?? '');

await p.fill('input[name="password"]', 'pendulum-period-42');
const signedInAt = lib.log.length;
await p.click('.chalk-signin-submit');
check('the right password opens the book', await bookOpen(), (await (await p.$('.chalk-state'))?.textContent()) ?? '');
await p.waitForTimeout(1500);
check('the pictures are drawn from bytes fetched with the token', (await blobPictures()) > 0, `${await blobPictures()} drawn`);
// (before it, the showcase asked the library once without a token whether anyone may read it: 401)
check('the library was asked, without a token, whether it lets anyone read', lib.log.slice(0, signedInAt).some((l) => l.path === '/v1/search' && !l.token && l.status === 401));
const v1 = lib.log.slice(signedInAt).filter((l) => l.path.startsWith('/v1/') && !l.path.startsWith('/v1/auth/'));
check('every library request after signing in carried the token and was let in', v1.length > 0 && v1.every((l) => l.token && l.status === 200), `${v1.length} requests`);
const first = await stored();
check('the sign-in is kept in this browser', !!first?.refresh);
if (SHOTS) await p.screenshot({ path: `${SHOTS}/signed-in.png` });

await p.reload();
check('after a reload the book opens without signing in again', await bookOpen() && !(await p.$('.chalk-signin')));
check('…and with no new password sign-in', lib.grants.filter((g) => g.grant === 'password' && g.ok).length === 1);

// the access token runs low: the next request refreshes it, and the rotated refresh token is what is kept
await p.waitForTimeout((ACCESS_SECONDS - 60 + 2) * 1000);
await p.click('.chalk-dock button[aria-label="খোঁজো"], .chalk-dock button[aria-label="Search"]');
await p.fill('.chalk-search input', 'দোলক');
await p.waitForTimeout(2000);
const hits = await p.evaluate(() => document.querySelectorAll('.chalk-results li').length);
const refreshes = lib.grants.filter((g) => g.grant === 'refresh_token');
check('a low access token is refreshed once, and the request goes through', refreshes.length === 1 && refreshes[0]!.ok && hits > 0, `${refreshes.length} refreshes, ${hits} hits`);
const second = await stored();
check('the rotated refresh token is the one kept, and the only live one', !!second && second.refresh !== first?.refresh && JSON.stringify(lib.liveRefreshTokens()) === JSON.stringify([second.refresh]));

await p.click('.app-signout');
await p.waitForSelector('.chalk-signin', { timeout: 10000 }).catch(() => {});
check('signing out brings the form back', !!(await p.$('.chalk-signin')));
await p.waitForTimeout(500);
check('…revokes the sign-in at the library and forgets it here', lib.log.some((l) => l.path === '/v1/auth/revoke') && lib.liveRefreshTokens().length === 0 && !(await stored()));

const secrets = [first?.access, first?.refresh, second?.access, second?.refresh, 'pendulum-period-42'].filter(Boolean) as string[];
check('no token or password in the console', !consoleText.some((t) => secrets.some((s) => t.includes(s))), `${consoleText.length} console messages`);
check('no errors in the page', errors.length === 0, errors.join(' | '));

await b.close();
server.close();
console.log(failed ? '\nSOME CHECKS FAILED' : '\nall checks passed');
process.exit(failed ? 1 : 0);
