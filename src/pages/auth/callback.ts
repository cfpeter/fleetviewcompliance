/**
 * Where a confirmation email lands.
 *
 * THIS ROUTE DID NOT EXIST, AND ITS ABSENCE BROKE SIGN-UP COMPLETELY.
 *
 * With `@supabase/ssr` the link in a confirmation email comes back as a `code`
 * in the query string, and that code has to be exchanged for a session ON THE
 * SERVER. The exchange is the only thing that sets the auth cookies. Without a
 * route to do it, a new customer clicked the link in their email, arrived at a
 * URL this app does not serve, and could never sign in — and the failure looked
 * like a broken link rather than like missing software, so it would have been
 * reported as "your email didn't work" if it was reported at all.
 *
 * It is invisible in development because the project's email confirmation
 * setting is what decides whether the link is ever sent. Turn confirmation on
 * in production and every single sign-up dead-ends.
 *
 * An API route rather than a page: nothing is rendered here, and a page would
 * invite somebody to put markup in it.
 */
import type { APIRoute } from 'astro'
import { safeNext } from '../../lib/redirect.ts'
import { sessionClient } from '../../lib/supabase/server.ts'

export const GET: APIRoute = async ({ url, cookies, request, redirect }) => {
  const code = url.searchParams.get('code')

  // Supabase reports a refused link in the query string rather than by failing
  // the exchange, so this is checked first and kept separate from "no code at
  // all" — one of them means the link aged out, the other means somebody
  // opened this URL by hand.
  const authError = url.searchParams.get('error') ?? url.searchParams.get('error_code')
  if (authError) return redirect('/login?notice=link_expired', 303)
  if (!code) return redirect('/login?notice=link_invalid', 303)

  const supabase = sessionClient(cookies, request.headers)
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  // The message is deliberately dropped. Supabase distinguishes an expired code
  // from one already used, and surfacing that difference tells whoever is
  // holding an intercepted link which one they have.
  if (error) return redirect('/login?notice=link_expired', 303)

  // `next` goes through the same allow-list the login form uses. Without it
  // this route is an open redirect wearing a confirmation link — the most
  // trustworthy-looking link this product ever sends.
  const next = safeNext(url.searchParams.get('next'))

  // Straight into onboarding rather than to /login. They have just proved they
  // own the address and the exchange above signed them in; asking them to type
  // the password they set ninety seconds ago is a step that exists only because
  // the redirect was lazy. Middleware sends them to /app/setup if they have no
  // carrier yet.
  return redirect(next === '/login' ? '/app' : next, 303)
}
