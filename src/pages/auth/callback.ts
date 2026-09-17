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
import { recordTermsAcceptance } from '../../lib/terms.ts'

export const GET: APIRoute = async ({ url, cookies, request, redirect }) => {
  /**
   * A RESET LINK IS NOT A SIGN-IN LINK, and this route must never treat one as
   * the other.
   *
   * Password recovery has its own route — /auth/new-password — and that route
   * deliberately does not exchange the code until a new password has been
   * typed, so that opening the link cannot by itself leave a live session on
   * the browser. Exchanging it HERE would hand out exactly the session that
   * route refuses to create, and drop the customer on the dashboard with the
   * password they came to change still on the account.
   *
   * It should not arrive here at all: resetPasswordForEmail points at the other
   * route. This catches the two ways it could anyway — a Supabase email
   * template edited to point at the callback, and an operator adding
   * `type=recovery` to the redirect — by handing the whole query string on
   * untouched. Checked before anything else, so no branch below can spend it.
   */
  if (url.searchParams.get('type') === 'recovery') {
    return redirect(`/auth/new-password${url.search}`, 303)
  }

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

  // THE AGREEMENT, and why it is written here at all.
  //
  // With email confirmation switched ON, signUp returns no session, so the
  // signup handler in login.astro has no authenticated identity to write
  // against and records nothing. The tick is still mandatory and still refused
  // server-side, so no account can exist without one — but the evidence row
  // would be missing, which is the whole point of collecting it.
  //
  // ONLY WHEN THERE IS NO ROW AT ALL. This route serves one thing: confirming a
  // new account. Password reset now exists and is deliberately kept off this
  // route, which is what the branch at the top of this handler enforces — but
  // the guard below is what makes that a routing choice rather than a
  // load-bearing one, and it still stands for the magic link or the second
  // confirmation path somebody adds next. Writing an acceptance for somebody
  // who ticked nothing that day is fabricated evidence — worse than no evidence,
  // because it would be produced in a dispute as though it were real. Checking
  // first means a returning user writes nothing, whatever brought them here.
  //
  // Re-acceptance after the documents change is a separate gate with its own
  // screen, not this route. A failure is logged and never shown: they are
  // signed in, and there is nothing useful to abort.
  const { data: who } = await supabase.auth.getUser()
  if (who?.user) {
    const { data: already, error: readError } = await supabase
      .from('terms_acceptances')
      .select('user_id')
      .eq('user_id', who.user.id)
      .limit(1)
    // A read that FAILED is not "no row". Treating them alike would write a
    // second row on every confirmation whenever the select was unhappy.
    if (!readError && (already ?? []).length === 0) {
      const accepted = await recordTermsAcceptance(supabase, request.headers)
      if (accepted.error) console.error('terms acceptance not recorded:', accepted.error)
    }
  }

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
