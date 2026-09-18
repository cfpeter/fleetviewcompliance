/**
 * Route guard.
 *
 * Everything under /app requires a session AND a carrier. The check happens
 * here rather than in each page because a page that forgets is a page that
 * silently serves a signed-out visitor.
 */
import { defineMiddleware } from 'astro:middleware'
import { isOperatorRequest, notFound } from './lib/admin/operators.ts'
import { handlesAuthCode } from './lib/redirect.ts'
import { sessionClient } from './lib/supabase/server.ts'

const GUARDED = /^\/app(\/|$)/
const API = /^\/api\//

/**
 * The operator screens. Not a carrier's pages — the platform's.
 *
 * /app/admin/claims lists claim requests across EVERY carrier: which companies
 * are here, which USDOT numbers strangers are trying to take, and who is
 * trying. The whole subtree is matched rather than the one page, so a second
 * admin screen added later is guarded the day it is created rather than the day
 * somebody remembers.
 *
 * WHY THE GATE IS HERE AND NOT ONLY IN THE PAGE. Both of the refusals below
 * would announce the route: an unauthenticated visitor gets a redirect to
 * /login?next=/app/admin/claims, and a signed-in carrier with no membership
 * gets bounced to /app/setup. A route that does not exist gets neither — Astro
 * matches routes BEFORE middleware runs, so /app/not-a-page never reaches this
 * file and comes back a bare 404. So the only place the gate can refuse without
 * confirming the path is above those two branches, which is where it sits. The
 * page repeats the check for itself; see the note there.
 */
const ADMIN = /^\/app\/admin(\/|$)/

/**
 * Endpoints that authenticate themselves and must NOT require a session.
 *
 * A scheduled job has no signed-in user. Guarding these with the session check
 * meant the digest could never run at all — the scheduler got a 401 every
 * morning, which reads exactly like "a quiet week" for a product whose whole
 * promise is telling you before it bites.
 *
 * A Stripe webhook has no signed-in user either, and behind the session guard it
 * would answer Stripe with a 401 forever: Stripe retries for three days, gives
 * up, and disables the endpoint — after which nothing in this application ever
 * learns that a customer paid, cancelled or lapsed.
 *
 * A Supabase Send Email Hook call has no signed-in user either — it is Supabase
 * asking US to send the confirmation email for somebody who, at signup, does not
 * have an account yet. Behind the session guard it would get a 401 for every
 * auth email forever, and the failure would look like "signup is broken" rather
 * than like a route guard.
 *
 * These carry their own check and refuse to run when it cannot be made. The
 * cron routes compare a shared secret in constant time; /api/stripe verifies an
 * HMAC signature over the raw body (src/lib/billing/stripe.ts); /api/auth
 * verifies a standard-webhooks signature the same way
 * (src/lib/auth/email-hook.ts). None of them defaults to open when its secret is
 * unset.
 */
const SELF_AUTHENTICATING = /^\/api\/(cron|stripe|auth)\//

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
  /**
   * A BODYLESS 404 IS LEFT EXACTLY AS IT IS, header included.
   *
   * That response is what a route which does not exist returns, and the
   * operator gate returns it deliberately so a refusal cannot be told apart
   * from a missing page. A route that does not exist never reaches this
   * middleware — Astro matches first — so it never gets this header, and
   * setting it here would have made the refusal the one 404 on the host
   * carrying an extra header. Only outside production, where the header is set
   * at all, and only ever a hint; it costs nothing to not leak it.
   *
   * There is nothing to index in a 404 with no body either way.
   */
  const bare404 = response.status === 404 && response.body === null
  if (import.meta.env.DEPLOY_ENV !== 'production' && !bare404) {
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
   * under it. A `?code=` on any path other than a route that reads codes itself
   * is rescued rather than dropped, so links already sent still work and a
   * future misconfiguration costs a redirect instead of a lost customer. Scoped
   * to a UUID shape so it cannot swallow some other page's `?code=` parameter.
   *
   * WHICH ROUTES ARE EXEMPT IS NOT A DETAIL — see handlesAuthCode. A password
   * reset link carries a UUID code to /auth/new-password, so without that
   * exemption this rescue would take every reset link, hand it to the callback,
   * and sign the person in at the dashboard with the password they have already
   * forgotten still on the account.
   *
   * THE ADMIN SUBTREE IS EXEMPT, and that is an anti-enumeration rule rather
   * than an auth one. This redirect fires before anybody's identity is known,
   * so without the exemption `/app/admin/claims?code=<uuid>` would answer a
   * stranger with a 303 while `/app/not-a-page?code=<uuid>` answered 404 — the
   * existence of the route, handed over for the price of a query parameter.
   * Nothing is lost: Supabase only ever falls back to the project's Site URL,
   * which is not under /app/admin.
   */
  const strayCode = context.url.searchParams.get('code')
  if (
    strayCode &&
    !handlesAuthCode(pathname) &&
    !ADMIN.test(pathname) &&
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

  /**
   * THE OPERATOR GATE. Positively granted, or a 404.
   *
   * `isOperatorRequest` answers from `ADMIN_OPERATORS` and from nothing else —
   * no membership, no role, no absence of one. Unset or unreadable
   * configuration admits NOBODY, including the owner, which is the direction
   * this has to fail in: a variable nobody set must lock the door, never open
   * it. src/lib/admin/operators.ts has the rest of the reasoning.
   *
   * A MISSING SESSION IS REFUSED THE SAME WAY, and that is the point of putting
   * this above the `if (!user)` branch. Redirecting a signed-out visitor to
   * /login tells him the path is real; this way a stranger probing for
   * /app/admin/anything gets the same bare 404 whether he is signed in, signed
   * out, or somebody else's customer. An operator who is signed out sees a 404
   * too — he signs in at /login first, then comes back, and that is a price
   * worth paying for a screen nobody else may know exists.
   *
   * The email address is only ever matched on a CONFIRMED account, so an
   * address typed at signup cannot stand in for the operator's.
   *
   * NOT PROTECTED BY CLOUDFLARE ACCESS. Dev sits behind Access and production
   * will not; this line is what is left on the real domain.
   */
  if (ADMIN.test(pathname)) {
    const operator =
      !!user &&
      (await isOperatorRequest({
        id: user.id,
        email: user.email,
        emailConfirmed: Boolean(user.email_confirmed_at),
      }))
    if (!operator) return notFound()
  }

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

  // The operator screens are not a carrier's screens: they read nothing scoped
  // to a membership, so an operator who has never set a carrier up must not be
  // marched through onboarding to reach them. The gate above already decided he
  // may be here.
  const carrierId = memberships?.[0]?.carrier_id
  if (!carrierId && pathname !== '/app/setup' && !ADMIN.test(pathname)) {
    return context.redirect('/app/setup')
  }
  context.locals.carrierId = carrierId

  const response = await next()
  // Signed-in pages are per-user. Without this an intermediary could serve one
  // carrier's dashboard to another.
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
