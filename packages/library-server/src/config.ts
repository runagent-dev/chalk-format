import { createHash, timingSafeEqual } from 'node:crypto';
import { openDb } from './db.js';
import { diskStorage, s3Storage, type Storage } from './storage.js';
import { checkKeySetup } from './auth/service.js';
import type { LibraryOptions } from './app.js';
import type { Caller } from './auth/roles.js';

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
 *   TOKENS           name:token,name:token           (bootstrap callers: author; a name ending in ! is an administrator)
 *   PUBLIC_READ      true | false                    (search and read without a token; default true)
 *   ACCESS_TOKEN_TTL 900                             (seconds an access token lasts)
 *   REFRESH_TOKEN_TTL 2592000                        (seconds a refresh token lasts: 30 days)
 *   REFRESH_TOKEN_GRACE 30                           (seconds a used refresh token still gives the same successor; 0: never)
 *   AUTH_KEY_SECRET  at least 32 characters          (encrypts the token signing keys; needed once there are users or PUBLIC_READ=false)
 *   AUTH_RATE_LIMIT  10                              (token requests per minute and username; per process)
 *   AUTH_RATE_LIMIT_IP 60                            (token requests per minute and address; per process)
 *   TRUST_PROXY      false                           (true: the caller's address is the last X-Forwarded-For entry)
 *   ORIGINS          https://app.example.org,…       (browsers allowed to call; default any)
 *   MAX_BYTES        536870912
 *   PORT             8080
 *   NAME             what tools show for this library (default "Chalk library")
 *   UPLOAD_SECRET    signs disk upload tickets (STORAGE=disk; default: random, so tickets end with a restart)
 */
export async function libraryFromEnv(env: Record<string, string | undefined> = process.env): Promise<LibraryOptions & { port: number }> {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`${k} is not set`); return v; };
  const port = Number(env.PORT ?? 8080);
  const positive = (k: string) => { const n = Number(env[k]); if (!Number.isInteger(n) || n <= 0) throw new Error(`${k} must be a whole number above 0`); return n; };
  const natural = (k: string) => { const n = Number(env[k]); if (!Number.isInteger(n) || n < 0) throw new Error(`${k} must be a whole number, 0 or more`); return n; };
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
  const publicRead = env.PUBLIC_READ !== 'false';
  const keySecret = env.AUTH_KEY_SECRET || undefined;
  try { await checkKeySetup(db, { publicRead, ...(keySecret ? { keySecret } : {}) }); } catch (e) { await db.close(); throw e; }
  return {
    db, storage, port,
    publicUrl: env.PUBLIC_URL ?? `${serverUrl.replace(/\/$/, '')}/files/`,
    callers: tokenCallers(env.TOKENS ?? ''),
    publicRead,
    issuer: serverUrl.replace(/\/+$/, ''),
    auth: {
      ...(env.ACCESS_TOKEN_TTL ? { accessTtl: positive('ACCESS_TOKEN_TTL') } : {}),
      ...(env.REFRESH_TOKEN_TTL ? { refreshTtl: positive('REFRESH_TOKEN_TTL') } : {}),
      ...(env.REFRESH_TOKEN_GRACE ? { refreshGrace: natural('REFRESH_TOKEN_GRACE') } : {}),
      ...(keySecret ? { keySecret } : {}),
      rateLimit: { ...(env.AUTH_RATE_LIMIT ? { perUser: positive('AUTH_RATE_LIMIT') } : {}), ...(env.AUTH_RATE_LIMIT_IP ? { perAddress: positive('AUTH_RATE_LIMIT_IP') } : {}) },
      trustProxy: env.TRUST_PROXY === 'true',
    },
    ...(env.MAX_BYTES ? { maxBytes: Number(env.MAX_BYTES) } : {}),
    ...(env.ORIGINS ? { origins: env.ORIGINS.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    ...(env.NAME ? { name: env.NAME } : {}),
  };
}

/** `name:token,…` (bootstrap tokens): a name ending in `!` is an administrator, any other an author. Compared in constant time. */
export function tokenCallers(spec: string): (token: string) => Caller | null {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  const list = spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf(':'), name = s.slice(0, i), token = s.slice(i + 1);
    const admin = name.endsWith('!'), user = name.replace(/!$/, '');
    return { d: digest(token), caller: { user, sub: user, admin, roles: admin ? ['reader', 'author', 'admin'] : ['reader', 'author'], kind: 'bootstrap' } satisfies Caller };
  });
  return (token) => { const d = digest(token); return list.find((c) => timingSafeEqual(c.d, d))?.caller ?? null; };
}
