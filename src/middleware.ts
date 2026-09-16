/**
 * Route guard.
 *
 * Everything under /app requires a session AND a carrier. The check happens
 * here rather than in each page because a page that forgets is a page that
 * silently serves a signed-out visitor.
 */
import { defineMiddleware } from 'astro:middleware'
import { sessionClient } from './lib/supabase/server.ts'

const GUARDED = /^\/app(\/|$)/
const API = /^\/api\//

/**
 * Endpoints that authenticate themselves and must NOT require a session.
 *
 * A scheduled job has no signed-in user. Guarding these with the session check
 * meant the digest could never run at all — the scheduler got a 401 every
 * morning, which reads exactly like "a quiet week" for a product whose whole
 * promise is telling you before it bites.
 *
 * These carry their own shared-secret check, compared in constant time, and
 * refuse to run when the secret is unset rather than defaulting to open.
 */
const SELF_AUTHENTICATING = /^\/api\/cron\//

/**
 * Keep every non-production deployment out of search results.
 *
 * dev.fleetviewcompliance.com serves the same marketing pages as the real site,
 * so indexed it competes with the pages it is a copy of AND puts a signup form
 * backed by a test database in front of strangers who found it on Google. The
 * `noindex` meta tag in Public.astro is per-page and easy to forget on the next
 * page somebody adds; this covers the whole host.
 *
 * Applied by WRAPPING the router rather than by returning early from inside it.
 * The early-return version was written first and silently disabled
 * authentication on dev: it answered every request before the signed-in checks
 * below ever ran, so /app stopped redirecting to /login. A header is not worth
 * a single line of control flow anywhere near an auth guard.
 *
 * NOT a substitute for Cloudflare Access. A crawler obeys this; a person who
 * has the URL does not.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const response = await route(context, next)
  if (import.meta.env.DEPLOY_ENV !== 'production') {
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  }
  return response
})

// Typed to return a Response, not `void | Response`. The middleware contract
// permits either, but every branch below genuinely returns one, and saying so
// is what lets the wrapper above set a header without a cast that would hide a
// branch quietly returning nothing.
const route = async (
  context: Parameters<Parameters<typeof defineMiddleware>[0]>[0],
  next: Parameters<Parameters<typeof defineMiddleware>[0]>[1],
): Promise<Response> => {
  const { pathname } = context.url

  if (SELF_AUTHENTICATING.test(pathname)) return next()

  /**
   * A confirmation code that landed on the wrong path.
   *
   * Supabase sends the email link to `emailRedirectTo` ONLY if that URL is on
   * the project's redirect allow-list. When it is not, it falls back to the
   * project's Site URL WITHOUT saying so — which is how a real signup produced
   * `http://localhost:3000/?code=...`, a port nothing listens on, and a customer
   * who could never finish creating an account.
   *
   * The fix is the allow-list in the Supabase dashboard; this is the safety net
   * under it. A `?code=` on any path other than the callback is rescued rather
   * than dropped, so links already sent still work and a future misconfiguration
   * costs a redirect instead of a lost customer. Scoped to a UUID shape so it
   * cannot swallow some other page's `?code=` parameter.
   */
  const strayCode = context.url.searchParams.get('code')
  if (
    strayCode &&
    pathname !== '/auth/callback' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(strayCode)
  ) {
    return context.redirect(`/auth/callback?code=${encodeURIComponent(strayCode)}`, 303)
  }
  if (!GUARDED.test(pathname) && !API.test(pathname)) return next()

  const supabase = sessionClient(context.cookies, context.request.headers)

  // getUser() revalidates against Supabase. getSession() only decodes the
  // cookie, which the client controls — never guard a route on it.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    if (API.test(pathname)) {
      return new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const next_ = encodeURIComponent(pathname + context.url.search)
    return context.redirect(`/login?next=${next_}`)
  }

  context.locals.supabase = supabase
  context.locals.userId = user.id

  // Which carrier this user is working in. RLS means this returns only their
  // own memberships, so there is nothing to filter here.
  const { data: memberships } = await supabase.from('memberships').select('carrier_id').limit(1)

  const carrierId = memberships?.[0]?.carrier_id
  if (!carrierId && pathname !== '/app/setup') {
    return context.redirect('/app/setup')
  }
  context.locals.carrierId = carrierId

  const response = await next()
  // Signed-in pages are per-user. Without this an intermediary could serve one
  // carrier's dashboard to another.
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
