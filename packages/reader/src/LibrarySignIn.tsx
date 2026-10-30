import { useEffect, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react';
import { LibraryAuthError, type LibraryAuth, type LibraryUser } from '@chalk-format/store';
import { resolveConfig, type ReaderConfigInput } from './config.js';
import { strings } from './i18n.js';

/**
 * Signing in to a library from a host app: `useLibraryAuth(auth)` follows who is signed in, `<LibrarySignIn auth={auth} />` is a plain
 * username and password form in the reader's look. Once signed in, open the book with the sign-in's token:
 *
 *   const auth = useMemo(() => libraryAuth({ library, storage: webStorage(localStorage) }), [library]);
 *   const { user, ready } = useLibraryAuth(auth);
 *   if (!ready) return null;
 *   return user ? <ChalkReader source={{ library, slug, token: auth.token }} /> : <LibrarySignIn auth={auth} />;
 */

const noSubscribe = () => () => {};
const nobody = () => null;

/** Who is signed in to `auth` (null: nobody), and whether a sign-in kept from before has been read yet. `auth` may be null (no sign-in). */
export function useLibraryAuth(auth: LibraryAuth | null): { user: LibraryUser | null; ready: boolean } {
  const user = useSyncExternalStore(auth ? auth.onChange : noSubscribe, auth ? auth.user : nobody, auth ? auth.user : nobody);
  const [ready, setReady] = useState<LibraryAuth | null>(null);
  useEffect(() => {
    if (!auth) return;
    let live = true;
    void auth.ready.then(() => { if (live) setReady(auth); });
    return () => { live = false; };
  }, [auth]);
  return { user, ready: !auth || ready === auth };
}

export type LibrarySignInProps = {
  auth: LibraryAuth;
  /** Locale and theme, as the reader's (only `locale` and `theme` are used). */
  config?: ReaderConfigInput;
  /** A heading in place of "Sign in to the library" (e.g. the library's name). */
  title?: string;
  onSignedIn?: (user: LibraryUser) => void;
  /** Shown as a quiet link under the form when given (e.g. "continue without signing in" for a library anyone may read). */
  onSkip?: () => void;
  className?: string;
  style?: CSSProperties;
};

export function LibrarySignIn(props: LibrarySignInProps) {
  const config = resolveConfig(props.config);
  const t = strings(config.locale);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dark = config.theme === 'system' ? (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : config.theme;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !username || !password) return;
    setBusy(true); setError(null);
    try {
      const user = await props.auth.signIn(username.trim(), password);
      setPassword('');
      props.onSignedIn?.(user);
    } catch (err) {
      // the error says what went wrong, never what was typed (a LibraryAuthError carries no credential)
      setError(err instanceof LibraryAuthError && err.code === 'invalid_grant' ? t.wrongPassword
        : err instanceof LibraryAuthError && err.code === 'rate_limited' ? t.tooManyAttempts
        : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`chalk-reader chalk-signin-shell ${props.className ?? ''}`} data-theme={dark} lang={config.locale} style={props.style}>
      <form className="chalk-signin" onSubmit={(e) => void submit(e)} aria-busy={busy}>
        <h1 className="chalk-signin-title">{props.title ?? t.signInTitle}</h1>
        <p className="chalk-signin-where">{hostOf(props.auth.library)}</p>
        <label className="chalk-signin-field">
          <span>{t.username}</span>
          <input className="chalk-input" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required
            value={username} onChange={(e) => setUsername(e.target.value)} disabled={busy} />
        </label>
        <label className="chalk-signin-field">
          <span>{t.password}</span>
          <input className="chalk-input" name="password" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
        </label>
        {error && <p className="chalk-signin-error" role="alert"><strong>{t.signInFailed}</strong> {error}</p>}
        <button type="submit" className="chalk-signin-submit" disabled={busy || !username || !password}>{busy ? t.signingIn : t.signIn}</button>
        {props.onSkip && <button type="button" className="chalk-signin-skip" onClick={props.onSkip}>{t.continueWithout}</button>}
      </form>
    </div>
  );
}

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
