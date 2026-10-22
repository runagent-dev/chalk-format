import { createHash, timingSafeEqual } from 'node:crypto';
import { openDb } from './db.js';
import { diskStorage, s3Storage, type Storage } from './storage.js';
import type { Caller, LibraryOptions } from './app.js';

/**
 * A library from environment variables (Docker, Coolify):
 *
 *   DATABASE_URL     postgres://user:pass@host/db   (or pglite:./data to keep it in a folder, pglite: in memory)
 *   DB_SCHEMA        chalk_library                  (Postgres: the library keeps everything in this schema)
 *   STORAGE          s3 | disk
 *   S3_ENDPOINT      https://<account>.r2.cloudflarestorage.com · http://minio:9000 · https://s3.<region>.amazonaws.com
 *   S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION (R2: auto), S3_VIRTUAL_HOSTED (true for AWS)
 *   DISK_DIR         ./library                       (STORAGE=disk)
 *   PUBLIC_URL       where readers fetch bytes: the bucket's public domain or CDN (disk: <this server>/files/)
 *   SERVER_URL       this server's own address (disk uploads come here)
 *   TOKENS           name:token,name:token           (callers; a name ending in ! is an administrator)
 *   PUBLIC_READ      true | false                    (search and read without a token; default true)
 *   ORIGINS          https://app.example.org,…       (browsers allowed to call; default any)
 *   MAX_BYTES        536870912
 *   PORT             8080
 */
export async function libraryFromEnv(env: Record<string, string | undefined> = process.env): Promise<LibraryOptions & { port: number }> {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
  const port = Number(env.PORT ?? 8080);
  const serverUrl = env.SERVER_URL ?? `http://localhost:${port}`;
  const db = await openDb(env.DATABASE_URL ?? 'pglite:', { ...(env.DB_SCHEMA ? { schema: env.DB_SCHEMA } : {}) });
  let storage: Storage;
  if ((env.STORAGE ?? 'disk') === 's3') {
    storage = s3Storage({
      endpoint: need('S3_ENDPOINT'), bucket: need('S3_BUCKET'), accessKeyId: need('S3_ACCESS_KEY_ID'), secretAccessKey: need('S3_SECRET_ACCESS_KEY'),
      region: env.S3_REGION ?? 'auto', virtualHosted: env.S3_VIRTUAL_HOSTED === 'true',
    });
  } else {
    storage = diskStorage(env.DISK_DIR ?? './library', { uploadBase: serverUrl, ...(env.UPLOAD_SECRET ? { secret: env.UPLOAD_SECRET } : {}) });
  }
  return {
    db, storage, port,
    publicUrl: env.PUBLIC_URL ?? `${serverUrl.replace(/\/$/, '')}/files/`,
    callers: tokenCallers(env.TOKENS ?? ''),
    publicRead: env.PUBLIC_READ !== 'false',
    ...(env.MAX_BYTES ? { maxBytes: Number(env.MAX_BYTES) } : {}),
    ...(env.ORIGINS ? { origins: env.ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    ...(env.NAME ? { name: env.NAME } : {}),
  };
}

/** `name:token,…`; a name ending in `!` is an administrator. Compared in constant time. */
export function tokenCallers(spec: string): (token: string) => Caller | null {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const list = spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf(':'), name = s.slice(0, i), token = s.slice(i + 1);
    return { user: name.replace(/!$/, ''), admin: name.endsWith('!'), d: digest(token) };
  });
  return (token) => { const d = digest(token); return list.find((c) => timingSafeEqual(c.d, d)) ?? null; };
}
