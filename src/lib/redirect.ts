/**
 * Where to go after signing in.
 *
 * `startsWith('/')` is NOT enough on its own: "//evil.example" also starts with
 * a slash and is a protocol-relative URL, so the browser treats it as another
 * origin. That is an open redirect — an attacker sends a real login link to our
 * real domain and lands the user on their page, already trusting us. Reject a
 * second slash and a backslash, which some browsers normalise into one.
 */
export function safeNext(raw: string | null): string {
  if (!raw) return '/app'
  if (!raw.startsWith('/')) return '/app'
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/app'
  return raw
}

/**
 * The routes that read an auth `code` out of their own URL.
 *
 * The middleware rescues a stray `?code=` — a confirmation or reset link that
 * Supabase sent to the project's Site URL because our redirect was not on its
 * allow-list — by forwarding it to /auth/callback. That rescue MUST NOT fire on
 * a route that was going to handle the code itself.
 *
 * The bug it would otherwise cause is the whole password-reset flow: a Supabase
 * auth code is a UUID, so a perfectly good reset link to /auth/new-password
 * matches the rescue's shape test, gets forwarded to the callback, is exchanged
 * for a session there — and the person lands on the dashboard, signed in,
 * having never been shown the box that sets the password they came to set. The
 * feature would look broken in the one way nobody would think to test: by
 * working, silently, as a login.
 *
 * A trailing slash is stripped before matching. Astro serves both spellings,
 * and Supabase sends back whatever `redirectTo` it was given.
 */
const CODE_ROUTES = new Set(['/auth/callback', '/auth/new-password'])

export function handlesAuthCode(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return CODE_ROUTES.has(path)
}
