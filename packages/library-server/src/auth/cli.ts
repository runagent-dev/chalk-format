import { openDb } from '../db.js';
import { parseRoles } from './roles.js';
import { AuthError, createAuth } from './service.js';

/**
 * The operator's commands for users and API keys. They need only the database (DATABASE_URL, DB_SCHEMA), not the
 * storage. Passwords are read from the terminal without echo, or from the first line of stdin when it is not a
 * terminal (`printf '%s\n' "$PW" | chalk-library user add …`); never from the command line, where `ps` shows it.
 */
export const AUTH_USAGE = `  chalk-library user add <username> --roles reader[,author,admin]   (password: prompt or stdin)
  chalk-library user list
  chalk-library user disable|enable <username>
  chalk-library user password <username>                             (password: prompt or stdin)
  chalk-library key add <name> --roles reader[,author,admin]         (prints the key once)
  chalk-library key list
  chalk-library key revoke <id>
  chalk-library signing-key rotate`;

/** A line typed without echo (a terminal), or the first line of stdin. */
export async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let all = '';
    for await (const chunk of stdin) { all += String(chunk); if (all.includes('\n')) break; }
    return all.split(/\r?\n/)[0] ?? '';
  }
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let s = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = (v: string) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stderr.write('\n'); resolve(v); };
    const on = (d: string) => {
      for (const ch of d) {
        if (ch === '\r' || ch === '\n') return done(s);
        if (ch === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') s = [...s].slice(0, -1).join('');
        else if (ch >= ' ') s += ch;
      }
    };
    stdin.on('data', on);
  });
}

async function newPassword(): Promise<string> {
  const pw = await readSecret('password: ');
  if (process.stdin.isTTY && (await readSecret('again: ')) !== pw) throw new Error('the two passwords differ');
  return pw;
}

export async function runAuthCommand(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const [group, verb, name] = args;
  const opt = (n: string) => { const i = args.indexOf(n); return i > 0 ? args[i + 1] : undefined; };
  if (!env.DATABASE_URL) { console.error('DATABASE_URL is not set (the library\'s database)'); return 2; }
  const db = await openDb(env.DATABASE_URL, { ...(env.DB_SCHEMA ? { schema: env.DB_SCHEMA } : {}) });
  // AUTH_KEY_SECRET: adding a user and rotating the signing key need it (as the server does)
  let auth: ReturnType<typeof createAuth>;
  try { auth = createAuth({ db, ...(env.AUTH_KEY_SECRET ? { keySecret: env.AUTH_KEY_SECRET } : {}) }); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); await db.close(); return 2; }
  const user = async (n: string | undefined) => {
    const u = n ? await auth.findUser(n) : null;
    if (!u) throw new AuthError(404, 'not_found', `no user ${n ?? ''}`);
    return u;
  };
  try {
    if (group === 'user' && verb === 'add' && name) {
      const u = await auth.createUser({ username: name, roles: parseRoles(opt('--roles') ?? 'reader'), password: await newPassword() });
      console.log(`added ${u.username} (${u.roles.join(', ')}) id ${u.id}`);
    } else if (group === 'user' && verb === 'list') {
      for (const u of await auth.listUsers()) console.log(`${u.id}  ${u.username.padEnd(24)} ${u.roles.join(',').padEnd(20)} ${u.disabled ? 'disabled' : 'active  '} ${u.lastSignInAt ?? 'never signed in'}`);
    } else if (group === 'user' && (verb === 'disable' || verb === 'enable')) {
      const u = await auth.updateUser((await user(name)).id, { disabled: verb === 'disable' });
      console.log(`${u.username} ${u.disabled ? 'disabled; its sign-ins are revoked' : 'enabled'}`);
    } else if (group === 'user' && verb === 'password') {
      const u = await auth.updateUser((await user(name)).id, { password: await newPassword() });
      console.log(`new password for ${u.username}; its sign-ins are revoked`);
    } else if (group === 'key' && verb === 'add' && name) {
      const k = await auth.createApiKey({ name, roles: parseRoles(opt('--roles') ?? 'reader'), createdBy: 'cli' });
      console.error(`key ${k.id} "${k.name}" (${k.roles.join(', ')}). It is shown only now; keep it in a secret store:`);
      console.log(k.key);
    } else if (group === 'key' && verb === 'list') {
      for (const k of await auth.listApiKeys()) console.log(`${k.id}  ${k.name.padEnd(24)} ${k.hint} ${k.roles.join(',').padEnd(20)} ${k.revokedAt ? `revoked ${k.revokedAt}` : `last used ${k.lastUsedAt ?? 'never'}`}`);
    } else if (group === 'key' && verb === 'revoke' && name) {
      if (!(await auth.revokeApiKey(name))) throw new AuthError(404, 'not_found', `no key ${name}, or it is already revoked`);
      console.log(`key ${name} revoked`);
    } else if (group === 'signing-key' && verb === 'rotate') {
      console.log(`new signing key ${await auth.rotateSigningKey()}; the old one stays in JWKS until its tokens expire`);
    } else {
      console.error(`usage:\n${AUTH_USAGE}`);
      return 2;
    }
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    await db.close();
  }
}
