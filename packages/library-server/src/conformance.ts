import { assetKeyAndSha256 } from '@chalk-format/model';
import { createRegistryClient, derivedUrl, registryLibrary, RegistryError } from '@chalk-format/store';

/**
 * Does a library server do what the registry API says (spec/1.2/registry-api.md)? A round trip through the API
 * with the same client authoring tools use: upload, verify, de-duplicate, search, fetch through the delivery store,
 * refuse wrong bytes and keys, keep book usage, honour tokens, withdraw. For the reference server's tests and for
 * anyone writing another one:  chalk-library check https://library.example.org --token … [--admin-token …]
 *
 * With `username` and `password` instead of a token it signs in first (§10: the password grant) and also checks
 * the library's sign-in: who am I, and that a refresh token works once and only once.
 */
export type Check = { name: string; ok: boolean; detail?: string };

export type CheckOptions = { token?: string; username?: string; password?: string; adminToken?: string; fetch?: typeof fetch };

export async function checkLibrary(url: string, opts: CheckOptions): Promise<Check[]> {
  const out: Check[] = [];
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const step = async (name: string, fn: () => Promise<boolean | string>) => {
    try { const r = await fn(); out.push(r === true ? { name, ok: true } : { name, ok: false, ...(typeof r === 'string' ? { detail: r } : {}) }); }
    catch (e) { out.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }); }
  };
  const tokenUrl = `${url.replace(/\/?$/, '/')}v1/auth/token`;
  const grant = (body: Record<string, string>) => f(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let signedIn: { access_token: string; refresh_token: string; roles: string[] } | null = null;
  if (!opts.token) {
    if (!opts.username || !opts.password) throw new Error('checkLibrary needs a token, or a username and a password');
    await step('sign in with a username and a password', async () => {
      const r = await grant({ grant_type: 'password', username: opts.username!, password: opts.password! });
      if (!r.ok) return `answered ${r.status}`;
      signedIn = (await r.json()) as typeof signedIn;
      return signedIn?.access_token && signedIn.refresh_token ? true : 'no tokens in the answer';
    });
    if (!signedIn) return out;
  }
  const o = { ...opts, token: opts.token ?? signedIn!.access_token };
  const client = createRegistryClient(url, { token: o.token, fetch: f });
  const anon = createRegistryClient(url, { fetch: f });
  const lib = registryLibrary({ url, token: o.token, fetch: f });
  // unique bytes and a unique word, so a run never meets an earlier one
  const word = `chk${Math.random().toString(36).slice(2, 10)}`;
  const bytes = new TextEncoder().encode(`chalk conformance ${word} ${Date.now()}`);
  const { key, sha256 } = await assetKeyAndSha256(bytes);
  const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof RegistryError ? e : null; } };

  await step('GET v1/stores names a delivery store for readers', async () => (await client.stores()).items.length > 0);
  await step('check: an unknown key is missing', async () => (await client.check([key])).missing.includes(key));
  await step('writing needs a token', async () => (await err(anon.add(bytes, { type: 'image/png', title: word })))?.status === 401);
  let record: Awaited<ReturnType<typeof client.add>> | null = null;
  await step('add: upload to the pre-signed URL, register, verified', async () => {
    record = await client.add(bytes, { type: 'image/png', title: `${word} কন্ডিশন পরীক্ষা`, tags: ['conformance', `chk:${word}`, 'state:current'], filename: `${word}.png` });
    return record.key === key && record.status === 'available' ? true : JSON.stringify(record);
  });
  await step('check: now present', async () => (await client.check([key])).present.includes(key));
  await step('adding the same bytes again uploads nothing', async () => {
    const r = await f(`${url.replace(/\/?$/, '/')}v1/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` }, body: JSON.stringify({ key, sha256, type: 'image/png', size: bytes.byteLength }) });
    return ((await r.json()) as { exists?: boolean }).exists === true;
  });
  await step('GET v1/assets/{key}', async () => (await client.get(key)).sha256 === sha256);
  await step('POST v1/assets/current: the newest available item of a tag, null for an unknown tag, over 500 tags refused', async () => {
    const r = await client.current([`chk:${word}`, `chk:nothing-${word}`]);
    if (r.items[`chk:${word}`]?.key !== key || r.items[`chk:nothing-${word}`] !== null) return JSON.stringify(r);
    const none = await client.current([`chk:${word}`], { require: ['state:superseded'] });
    if (none.items[`chk:${word}`] !== null) return 'require was not applied';
    const many = await f(`${url.replace(/\/?$/, '/')}v1/assets/current`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` }, body: JSON.stringify({ tags: Array.from({ length: 501 }, (_, i) => `chk:${i}`) }) });
    return many.status === 400 ? true : `501 tags answered ${many.status}`;
  });
  await step('search finds it by a word of its title', async () => (await client.search({ q: word })).items.some((i) => i.key === key));
  await step('search finds it by a Bengali word', async () => (await client.search({ q: 'কন্ডিশন' })).items.some((i) => i.key === key));
  await step('search filters by type', async () => !(await client.search({ q: word, type: ['video/*'] })).items.some((i) => i.key === key));
  await step('readers get the same bytes from the delivery store', async () => {
    // a private library's store (auth "bearer") is read with the token
    const bearer = (await client.stores()).items.find((d) => d.auth === 'bearer' && d.kind === 'derived');
    const got = bearer ? new Uint8Array(await (await f(derivedUrl(bearer, key), { headers: { Authorization: `Bearer ${o.token}` } })).arrayBuffer()) : (await lib.get(key))?.bytes ?? null;
    return got !== null && got.length === bytes.length && got.every((b, i) => b === bytes[i]);
  });
  await step('a key that is not the c1 key of its sha256 is refused', async () => {
    const r = await f(`${url.replace(/\/?$/, '/')}v1/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ key: 'c1:' + 'a'.repeat(25) + 'a', sha256, type: 'image/png', size: bytes.byteLength }) });
    return r.status === 400;
  });
  // §3.1 is optional (404/405: not offered; 403: not enabled), but no registry may adopt a path outside its bucket
  await step('adopting never takes a path outside the bucket', async () => {
    const r = await f(`${url.replace(/\/?$/, '/')}v1/assets/adopt`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ key, sha256, type: 'image/png', size: bytes.byteLength, path: '../outside' }) });
    return [400, 403, 404, 405].includes(r.status) ? true : `answered ${r.status}`;
  });
  await step('bytes that are not what the key names are refused, and removed', async () => {
    const real = new TextEncoder().encode(`announced ${word}`), fake = new TextEncoder().encode(`different ${word}`);
    const ks = await assetKeyAndSha256(real);
    const up = await f(`${url.replace(/\/?$/, '/')}v1/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` }, body: JSON.stringify({ key: ks.key, sha256: ks.sha256, type: 'image/png', size: real.byteLength }) });
    const { upload } = (await up.json()) as { upload: { url: string; headers?: Record<string, string> } };
    // the same length, other content: only hashing can tell
    await f(upload.url, { method: 'PUT', headers: upload.headers ?? {}, body: fake.slice(0, real.byteLength) as unknown as BodyInit });
    const reg = await f(`${url.replace(/\/?$/, '/')}v1/assets`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` }, body: JSON.stringify({ key: ks.key, sha256: ks.sha256, type: 'image/png', size: real.byteLength }) });
    if (reg.status !== 422) return `answered ${reg.status}`;
    return (await client.check([ks.key])).missing.includes(ks.key);
  });
  await step('books: the set of keys a book uses, and which books use a key', async () => {
    await client.setBookAssets(`conformance-${word}`, [key]);
    // with the token: a library may need one to read (PUBLIC_READ=false)
    const r = await f(`${url.replace(/\/?$/, '/')}v1/assets/${encodeURIComponent(key)}/books`, { headers: { Authorization: `Bearer ${o.token}` } });
    return ((await r.json()) as { items: { bookId: string }[] }).items.some((b) => b.bookId === `conformance-${word}`);
  });
  if (signedIn) {
    const s = signedIn as { access_token: string; refresh_token: string };
    await step('GET v1/auth/me names the signed-in user', async () => {
      const r = await f(`${url.replace(/\/?$/, '/')}v1/auth/me`, { headers: { Authorization: `Bearer ${s.access_token}` } });
      const me = (await r.json()) as { name?: string; kind?: string };
      return me.name?.toLowerCase() === opts.username!.trim().toLowerCase() && me.kind === 'user' ? true : JSON.stringify(me);
    });
    await step('a refresh token gives new tokens once, and using it again ends the sign-in', async () => {
      const first = await grant({ grant_type: 'refresh_token', refresh_token: s.refresh_token });
      if (!first.ok) return `refresh answered ${first.status}`;
      const next = (await first.json()) as { refresh_token: string };
      if (next.refresh_token === s.refresh_token) return 'the refresh token was not rotated';
      // the successor used in turn: the first answer arrived, so the first token coming back now is a reuse, even
      // within a registry's grace window for lost answers
      const second = await grant({ grant_type: 'refresh_token', refresh_token: next.refresh_token });
      if (!second.ok) return `refreshing with the new token answered ${second.status}`;
      const last = (await second.json()) as { refresh_token: string };
      const again = await grant({ grant_type: 'refresh_token', refresh_token: s.refresh_token });
      const after = await grant({ grant_type: 'refresh_token', refresh_token: last.refresh_token });
      return again.status === 400 && after.status === 400 ? true : `reuse answered ${again.status}, the newest token ${after.status}`;
    });
  }
  if (o.adminToken) {
    const admin = o.adminToken;
    await step('withdraw: readers get nothing, and the key cannot be uploaded again', async () => {
      const w = await f(`${url.replace(/\/?$/, '/')}v1/assets/${encodeURIComponent(key)}/withdraw`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify({ reason: 'conformance' }) });
      if (!w.ok) return `withdraw answered ${w.status}`;
      const u = await lib.url(key);
      const r = u ? await f(u) : null;
      const again = await err(client.add(bytes, { type: 'image/png' }));
      return (!r || r.status === 404 || r.status === 410 || r.status === 403) && again?.status === 410 ? true : `delivery ${r?.status}, upload ${again?.status}`;
    });
  }
  return out;
}
