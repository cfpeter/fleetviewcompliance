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
