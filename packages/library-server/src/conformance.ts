import { assetKeyAndSha256 } from '@chalk-format/model';
import { createRegistryClient, registryLibrary, RegistryError } from '@chalk-format/store';

/**
 * Does a library server do what the registry API says (spec/1.2/registry-api.md)? A round trip through the API
 * with the same client authoring tools use: upload, verify, de-duplicate, search, fetch through the delivery store,
 * refuse wrong bytes and keys, keep book usage, honour tokens, withdraw. For the reference server's tests and for
 * anyone writing another one:  chalk-library check https://library.example.org --token … [--admin-token …]
 */
export type Check = { name: string; ok: boolean; detail?: string };

export async function checkLibrary(url: string, o: { token: string; adminToken?: string; fetch?: typeof fetch }): Promise<Check[]> {
  const out: Check[] = [];
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const step = async (name: string, fn: () => Promise<boolean | string>) => {
    try { const r = await fn(); out.push(r === true ? { name, ok: true } : { name, ok: false, ...(typeof r === 'string' ? { detail: r } : {}) }); }
    catch (e) { out.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }); }
  };
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
    record = await client.add(bytes, { type: 'image/png', title: `${word} কন্ডিশন পরীক্ষা`, tags: ['conformance'], filename: `${word}.png` });
    return record.key === key && record.status === 'available' ? true : JSON.stringify(record);
  });
  await step('check: now present', async () => (await client.check([key])).present.includes(key));
  await step('adding the same bytes again uploads nothing', async () => {
    const r = await f(`${url.replace(/\/?$/, '/')}v1/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` }, body: JSON.stringify({ key, sha256, type: 'image/png', size: bytes.byteLength }) });
    return ((await r.json()) as { exists?: boolean }).exists === true;
  });
  await step('GET v1/assets/{key}', async () => (await client.get(key)).sha256 === sha256);
  await step('search finds it by a word of its title', async () => (await client.search({ q: word })).items.some((i) => i.key === key));
  await step('search finds it by a Bengali word', async () => (await client.search({ q: 'কন্ডিশন' })).items.some((i) => i.key === key));
  await step('search filters by type', async () => !(await client.search({ q: word, type: ['video/*'] })).items.some((i) => i.key === key));
  await step('readers get the same bytes from the delivery store', async () => {
    const got = await lib.get(key);
    return got !== null && got.bytes.length === bytes.length && got.bytes.every((b, i) => b === bytes[i]);
  });
  await step('a key that is not the c1 key of its sha256 is refused', async () => {
    const r = await f(`${url.replace(/\/?$/, '/')}v1/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ key: 'c1:' + 'a'.repeat(25) + 'a', sha256, type: 'image/png', size: bytes.byteLength }) });
    return r.status === 400;
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
