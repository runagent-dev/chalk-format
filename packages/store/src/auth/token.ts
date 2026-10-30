/**
 * How a library client is given its credential: a fixed token (an API key, a bootstrap token), or a function giving the current one (a
 * sign-in, whose access tokens expire and are refreshed). Every library client of this package takes either.
 */

/** Passed to a token function when the library has just refused `rejected` (401): give a fresher one if there is one. */
export type TokenRequest = { rejected?: string };

export type TokenSource = string | ((request?: TokenRequest) => string | undefined | null | Promise<string | undefined | null>);

/** The token to send now, or undefined for none. */
export async function resolveToken(token: TokenSource | undefined, request?: TokenRequest): Promise<string | undefined> {
  if (typeof token !== 'function') return token || undefined;
  return (await token(request)) || undefined;
}

const withBearer = (init: RequestInit, token: string | undefined): RequestInit => {
  if (!token) return init;
  // kept a plain object (as every client here builds its headers)
  const h = init.headers;
  const plain: Record<string, string> = h instanceof Headers ? Object.fromEntries(h.entries()) : Array.isArray(h) ? Object.fromEntries(h) : { ...(h as Record<string, string> | undefined) };
  return { ...init, headers: { ...plain, Authorization: `Bearer ${token}` } };
};

/**
 * `fetch` with `Authorization: Bearer <token>`. When the token is a function and the library answers 401, the function is asked once more
 * (`{ rejected }`), and the request is sent again if that gives a different token; a fixed token is never retried. The body must be
 * replayable (a string or bytes, not a stream) for the retry.
 */
export async function fetchWithToken(f: typeof fetch, token: TokenSource | undefined, input: string, init: RequestInit = {}): Promise<Response> {
  const first = await resolveToken(token);
  const r = await f(input, withBearer(init, first));
  if (r.status !== 401 || typeof token !== 'function') return r;
  const fresh = await resolveToken(token, first ? { rejected: first } : {}).catch(() => undefined);
  if (!fresh || fresh === first) return r;
  await r.body?.cancel().catch(() => {});
  return f(input, withBearer(init, fresh));
}
