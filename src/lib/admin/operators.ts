/**
 * Who is allowed to see the operator screens — and the answer everybody else
 * gets, which is nothing at all.
 *
 * WHAT IS BEHIND THIS. /app/admin/claims lists claim requests across EVERY
 * carrier on the platform: which companies are here, which USDOT numbers
 * strangers are trying to take, and the account email of the person trying. A
 * carrier who reaches that page learns his competitors are customers. That is
 * already bad. The reason this file is written the way it is, though, is the
 * next step nobody should ever be one bug away from: a screen that lists claims
 * is one button away from a screen that GRANTS them, and granting a claim is
 * handing a stranger a carrier's federal number — the exact attack
 * 0021_carrier_claims.sql exists to stop. So access here is decided once, in
 * one place, and it is decided by saying yes rather than by failing to say no.
 *
 * THREE RULES, AND THEY ARE THE WHOLE FILE.
 *
 * 1. POSITIVE GRANT. An operator is somebody named in `ADMIN_OPERATORS`. There
 *    is no "is not a carrier", no "has no membership", no role that happens to
 *    be missing. A check phrased as an absence passes for every new kind of
 *    user somebody adds later, including the anonymous one.
 *
 * 2. FAIL CLOSED. Unset, empty, whitespace, or full of entries in a shape this
 *    parser does not recognise — every one of those yields an EMPTY allowlist,
 *    and an empty allowlist admits nobody. The failure mode of a mistyped
 *    variable is "the owner cannot get in and says so", never "everybody can".
 *    `ADMIN_OPERATORS=*` is not a wildcard here; it is an entry that matches no
 *    user id and no email address, so it means the same as leaving it blank.
 *
 * 3. THE REFUSAL SAYS NOTHING. `notFound()` is byte-for-byte what Astro returns
 *    for a route that does not exist — status 404, no body — because a refusal
 *    that looks different from a missing page tells the person probing that
 *    there is something here worth probing for. See the note on notFound().
 *
 * NOT CLOUDFLARE ACCESS. Dev sits behind Access today and production will not,
 * so Access can never be the thing protecting an admin screen: the day this
 * ships to the real domain, the only gate left is the one in this file. It runs
 * in the Worker, on every request, in both environments.
 */

/** The environment variable that names the operators. One place, one spelling. */
export const OPERATOR_ENV_KEY = 'ADMIN_OPERATORS'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Close enough to an email to be worth comparing, and nothing looser.
 *
 * This is not an RFC parser and must not become one. Its only job is to decide
 * whether an entry in the allowlist is an ADDRESS — so the failure that matters
 * is accepting something that is not one (`*`, `all`, `yes`, a stray comma)
 * and quietly turning it into a rule. Same reasoning as usableEmail() in
 * src/lib/claims.ts, which guards the other direction.
 */
const EMAIL = /^[^\s@<>"'\\]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/

export interface OperatorAllowlist {
  /** Supabase user ids, lower-cased. The strong form. */
  ids: string[]
  /** Account email addresses, lower-cased. Only ever matched on a CONFIRMED address. */
  emails: string[]
}

/** Whether an allowlist can let anybody in at all. */
export function isEmptyAllowlist(list: OperatorAllowlist): boolean {
  return list.ids.length === 0 && list.emails.length === 0
}

/**
 * The allowlist, read out of one string.
 *
 * Separated by commas, semicolons or whitespace, so a value pasted out of a
 * spreadsheet, a shell or a wrangler secret all parse the same.
 *
 * ANYTHING THAT IS NEITHER A USER ID NOR AN EMAIL IS DROPPED, silently and on
 * purpose. The alternative — keeping unrecognised entries and comparing them —
 * is how `*` becomes a wildcard, and a wildcard in this variable is every
 * carrier on the platform reading every other carrier's claims. Dropping is
 * also what makes a typo fail in the safe direction: a misspelled address
 * matches nobody, and the operator finds out because HE cannot get in.
 */
export function parseOperators(raw: string | null | undefined): OperatorAllowlist {
  const ids: string[] = []
  const emails: string[] = []

  for (const piece of String(raw ?? '').split(/[\s,;]+/)) {
    const entry = piece.trim().toLowerCase()
    if (!entry) continue
    if (UUID.test(entry)) {
      if (!ids.includes(entry)) ids.push(entry)
      continue
    }
    if (EMAIL.test(entry)) {
      if (!emails.includes(entry)) emails.push(entry)
    }
    // Neither shape. Not an error and not a match — see the note above.
  }

  return { ids, emails }
}

/**
 * The signed-in person, as much of them as the gate is allowed to care about.
 *
 * `emailConfirmed` is not decoration. An address is something a person types at
 * signup, so matching the allowlist against an UNCONFIRMED one would mean
 * anybody who can spell the owner's address gets the owner's screens until the
 * moment he notices. Confirmed means Supabase watched a link come back from
 * that mailbox. A user id needs none of this, which is why it is the form to
 * prefer.
 */
export interface OperatorIdentity {
  id?: string | null
  email?: string | null
  emailConfirmed?: boolean
}

/**
 * Whether this person is an operator. Pure, so the refusals can be tested as
 * the attacks they are rather than as a happy path.
 */
export function isOperator(
  identity: OperatorIdentity | null | undefined,
  raw: string | null | undefined,
): boolean {
  const list = parseOperators(raw)
  // No configuration means no operators. This line is the whole of rule 2, and
  // it comes first so that nothing below it can ever be reached with an empty
  // list and a clever input.
  if (isEmptyAllowlist(list)) return false
  if (!identity) return false

  const id = typeof identity.id === 'string' ? identity.id.trim().toLowerCase() : ''
  if (id && list.ids.includes(id)) return true

  const email = typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : ''
  // An empty address must never match an empty allowlist entry — and it cannot,
  // because parseOperators drops those, but a signed-in user with no address on
  // the account is refused here rather than left to that second fact.
  if (!email) return false
  if (identity.emailConfirmed !== true) return false

  return list.emails.includes(email)
}

/**
 * The answer a non-operator gets: exactly what an unknown route returns.
 *
 * WHY IT IS THIS AND NOT A 403. Astro matches a route BEFORE middleware runs —
 * `/app/does-not-exist` never reaches the guard and comes back as
 * `new Response(null, { status: 404 })` with no body and no headers. A refusal
 * that differs from that in any visible way is a confirmation: "403" or a
 * styled "you are not allowed" page tells the reader that the path he guessed
 * is real, which is the one fact this screen most wants kept. A bodyless 404 is
 * returned here so the two are the same response.
 *
 * Astro re-routes any 404 with a null body through its error handler; with no
 * 404.astro in this project that handler produces the same bodyless 404 and
 * merges this one's (empty) headers into it. Adding a src/pages/404.astro later
 * changes BOTH sides together, which is why this is a status and never a page.
 */
export function notFound(): Response {
  return new Response(null, { status: 404 })
}

/**
 * The Worker environment, read the one way that does not compile secrets into
 * the bundle.
 *
 * `import.meta.env` INDEXED BY A VARIABLE IS FORBIDDEN, here and everywhere —
 * Vite replaces the whole expression, so a computed key makes it inline an
 * object holding every value the build machine's .env carried. That is not
 * hypothetical: it shipped CLAIM_CODE_PEPPER and SUPABASE_SECRET_KEY into
 * dist/ once already, and tests/env-inlining.test.ts now scans for it. The
 * shape below is the one from src/lib/billing/config.ts and the digest route:
 * `cloudflare:workers` first, `process.env` second, neither of which Vite
 * touches.
 *
 * Outside the Worker runtime the dynamic import throws and `process.env` is the
 * whole story — which is also why a dev value has to live in `.dev.vars` rather
 * than `.env` to be visible to a page.
 */
export async function adminEnv(): Promise<(key: string) => string | undefined> {
  let workerEnv: Record<string, string> = {}
  try {
    workerEnv = (await import('cloudflare:workers')).env as unknown as Record<string, string>
  } catch {
    // Not the Worker runtime — plain Node, where process.env is the whole story.
  }
  const processEnv: Record<string, string | undefined> =
    typeof process !== 'undefined' && process.env ? process.env : {}
  return (key: string) => workerEnv[key] ?? processEnv[key]
}

/**
 * The gate, environment read included. One await, one boolean, no exceptions.
 *
 * The catch is not tidiness. If reading the environment throws for any reason —
 * a runtime without the module, a binding that is not what it claims — the
 * answer is NO. An unreadable configuration is an unconfigured one, and an
 * unconfigured one admits nobody.
 */
export async function isOperatorRequest(identity: OperatorIdentity | null | undefined) {
  try {
    const env = await adminEnv()
    return isOperator(identity, env(OPERATOR_ENV_KEY))
  } catch {
    return false
  }
}
