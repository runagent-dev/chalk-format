/**
 * Who may do what (spec/1.2/registry-api.md §10.1). Roles are nested: an author is also a reader, an
 * administrator also an author. A caller holds the union of its roles; every route asks for one role.
 */
export const ROLES = ['reader', 'author', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export type CallerKind = 'user' | 'api-key' | 'bootstrap';

/** Who is calling, once its bearer token is accepted. */
export type Caller = {
  /** A name for records (`uploadedBy`): the username, the API key's name or the bootstrap token's name. */
  user: string;
  /** Holds `admin`. Kept for code written before roles; `roles` decides. */
  admin: boolean;
  /** Without roles: an administrator holds `admin`, anyone else `author` (the bootstrap rule). */
  roles?: Role[];
  kind?: CallerKind;
  /** The user's id, the API key's id or the bootstrap token's name. */
  sub?: string;
  /** An API key allowed to act for people (`actFor`): it may send `Chalk-Actor` (registry-api §10.7). */
  actFor?: boolean;
  /**
   * Set when an act-for key sent `Chalk-Actor`: the person (or job) it acts for. `user` is then the actor's id, so
   * every record names the person; `via` keeps the key's own name.
   */
  actingFor?: Actor;
  /** The credential's own name when `user` is an actor's id. */
  via?: string;
};

/** Who an act-for key acts for (`Chalk-Actor`): a lasting id (`staff:<id>`, `system:<job>`) and a display name. */
export type Actor = { id: string; name: string };

const RANK: Record<Role, number> = { reader: 0, author: 1, admin: 2 };

export const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLES as readonly string[]).includes(r);

/** Every role the given ones include, in the order reader, author, admin. */
export function expandRoles(roles: readonly string[]): Role[] {
  const top = Math.max(-1, ...roles.filter(isRole).map((r) => RANK[r]));
  return ROLES.filter((r) => RANK[r] <= top);
}

export const rolesOf = (c: Caller): Role[] => expandRoles(c.roles ?? (c.admin ? ['admin'] : ['author']));
export const hasRole = (c: Caller | null | undefined, role: Role): boolean => Boolean(c) && rolesOf(c!).includes(role);

/** `reader,author` → roles; throws on a name that is not a role. */
export function parseRoles(list: string): Role[] {
  const names = list.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !isRole(n));
  if (bad.length || !names.length) throw new Error(`roles are ${ROLES.join(', ')}; got ${list || 'none'}`);
  return expandRoles(names);
}
