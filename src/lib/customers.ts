/**
 * Customers: brokers and shippers.
 *
 * Two jobs live here. The first is the ordinary one — the row shape, the form
 * parsing, the search filter — and it duplicates shapes that also exist in
 * drivers.ts, vehicles.ts and loads.ts for the reason those files already state:
 * a shared `forms.ts` written on the fourth caller is a module, written on the
 * first it is a guess.
 *
 * The second job is the interesting one. `federalCheck()` below asks the public
 * FMCSA record whether this broker's operating authority is actually active,
 * and every line of it exists to keep one specific lie off the screen: "we could
 * not check" must never be rendered as "they look fine". A small carrier hauling
 * for a broker whose authority is revoked can lose the whole invoice, and the
 * only thing worse than not telling him is telling him we looked when we did
 * not.
 *
 * Display helpers for the loads themselves are imported from loads.ts rather
 * than re-written here. Status pill colours copied into a second file drift
 * apart within a month, and then the same load is blue on one screen and green
 * on another.
 */

import {
  type AuthorityRow,
  type CensusRow,
  type FederalResult,
  lookupAuthority,
  lookupCarrier,
  normalizeDot,
} from './fmcsa.ts'

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * The columns the customer screens read, written out rather than inferred.
 *
 * `select('*')` off an untyped Supabase client hands back `any`, and then a typo
 * in a column name renders as `undefined` — a blank cell that looks exactly like
 * a field nobody filled in, rather than like the bug it is.
 */
export interface CustomerRow {
  id: string
  name: string
  mc_number: string | null
  dot_number: string | null
  contact_name: string | null
  phone: string | null
  email: string | null
  billing_email: string | null
  billing_address: string | null
  /** NULL means "they never told us", NEVER "they pay on delivery". */
  days_to_pay: number | null
  notes: string | null
}

/** One row of the recent-loads list on the customer page. */
export interface CustomerLoadRow {
  id: string
  load_number: string | null
  broker_reference: string | null
  status: string
  exception: string | null
  billing: string
  linehaul_cents: number | null
  fuel_surcharge_cents: number | null
  accessorials_cents: number | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * Trimmed text, or NULL.
 *
 * '' must not reach the database. An empty `mc_number` is not the same fact as
 * "we do not have their MC number": it is a VALUE, it matches `ilike '%%'`, and
 * — the part that actually bites — `federalCheck()` below would treat it as a
 * docket number we hold and offer to look it up.
 */
export function textOrNull(raw: FormDataEntryValue | null): string | null {
  const s = String(raw ?? '').trim()
  return s === '' ? null : s
}

/**
 * A docket number, uppercased, otherwise exactly as typed.
 *
 * Deliberately NOT stripped down to digits. MC, MX and FF are three different
 * kinds of authority — motor carrier, Mexican cross-border, freight forwarder —
 * and throwing the prefix away loses which one this broker holds. Uppercasing is
 * safe because no docket number has ever been case-sensitive, and it stops
 * 'mc123456' and 'MC123456' sorting as two different brokers.
 */
export function docketOrNull(raw: FormDataEntryValue | null): string | null {
  return textOrNull(raw)?.toUpperCase() ?? null
}

/**
 * A USDOT number, normalised to bare digits, or an error.
 *
 * Normalising on the way IN rather than on the way out is the whole point. This
 * box gets 'USDOT 1234567' and '1,234,567' pasted straight off a rate
 * confirmation, and if we store that, every later reader — the federal lookup,
 * the search box, a future join — has to re-guess what a DOT number looks like.
 * One of them will guess differently.
 *
 * `normalizeDot` returning null means the digits could not be a DOT number at
 * all (none, or more than eight). That is worth refusing rather than storing,
 * because a stored non-number silently becomes a lookup that always fails.
 */
export function parseDotNumber(raw: FormDataEntryValue | null): Parsed<string | null> {
  const s = String(raw ?? '').trim()
  if (s === '') return { ok: true, value: null }
  const dot = normalizeDot(s)
  if (!dot) {
    return {
      ok: false,
      message:
        'A USDOT number is between one and eight digits. Leave it blank if you do not have it.',
    }
  }
  return { ok: true, value: dot }
}

/**
 * Payment terms in days, or NULL.
 *
 * Blank has to come back as NULL and never 0, and here that is not a tidiness
 * argument. 0 means "pays on delivery", which is the best terms in this
 * industry; a broker who never told us their terms would sort to the top of the
 * list as the best payer we have. The upper bound is a year because the only
 * numbers above it are typos — somebody putting a date in a days box.
 */
export function parseDaysToPay(raw: FormDataEntryValue | null): Parsed<number | null> {
  const s = String(raw ?? '')
    .trim()
    .replaceAll(',', '')
  if (s === '') return { ok: true, value: null }
  if (!/^\d+$/.test(s)) {
    return { ok: false, message: 'Days to pay should be a whole number of days, or left blank.' }
  }
  const n = Number(s)
  if (n > 365) {
    return {
      ok: false,
      message: 'Days to pay should be 365 or fewer. Anything above that is a typo.',
    }
  }
  return { ok: true, value: n }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Build the PostgREST `or=` filter for the customer list.
 *
 * The character strip is not cosmetic. `or=` is a comma-separated list parsed as
 * SYNTAX, so typing "Acme Logistics, Inc" does not search for that name — the
 * comma becomes a filter separator and the request comes back a 400, rendering
 * as an empty page that reads "we have no such customer". `%` and `_` are LIKE
 * wildcards, so a stray `%` would match the whole book.
 *
 * But stripping alone is a trap of its own, and this is the part worth reading
 * twice. Company names are FULL of commas and periods — "Acme Logistics, Inc."
 * is the normal shape of a broker's legal name, and it is exactly what gets
 * pasted in here off a rate confirmation. Strip the comma and the phrase becomes
 * 'Acme Logistics  Inc', which `ilike` will never match against the stored name
 * that still HAS the comma. The search would look like it worked and quietly
 * find nothing, for the single most likely thing anyone types into it.
 *
 * So a multi-word term also goes out as an every-word AND. That matches through
 * any punctuation we removed, and it matches regardless of word order, which is
 * how a dispatcher types a name she half-remembers.
 *
 * The digits-only variant is what makes the docket number findable from either
 * end. Stored 'MC123456' is already found by typing '123456' because ilike is a
 * substring match — but the reverse is not true, and typing the number exactly
 * as it is printed on the rate confirmation is precisely what she does.
 */
export function searchFilter(term: string): string | null {
  const safe = term
    .replace(/[,()%_*\\"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!safe) return null

  const parts = [`name.ilike.%${safe}%`, `mc_number.ilike.%${safe}%`]

  const words = safe.split(' ').filter(Boolean)
  if (words.length > 1) {
    // Nested and() inside or= is PostgREST's own syntax, not string trickery —
    // the drivers roster already relies on it for "surname first" searches.
    parts.push(`and(${words.map((w) => `name.ilike.%${w}%`).join(',')})`)
  }

  const digits = safe.replace(/\D/g, '')
  if (digits && digits !== safe) parts.push(`mc_number.ilike.%${digits}%`)

  return parts.join(',')
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * A timestamptz rendered in the carrier's own day.
 *
 * Note this is NOT the same rule as formatDate() in drivers.ts, and the
 * difference is the bug. A `date` column has no zone and must be formatted in
 * UTC or it shifts a day earlier; a `timestamptz` like loads.created_at is a
 * real instant, so formatting it in UTC dates a load booked at 6pm on Tuesday as
 * Wednesday. Both mistakes look like an off-by-one nobody can reproduce before
 * five o'clock.
 */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Los_Angeles',
  })
}

// ---------------------------------------------------------------------------
// The federal authority check
// ---------------------------------------------------------------------------

/**
 * What the carrier census said. Three outcomes, kept apart on purpose — see the
 * comment on FederalResult in fmcsa.ts, which makes the same argument at length.
 */
export type CensusView = { state: 'row'; row: CensusRow } | { state: 'none' } | { state: 'error' }

/**
 * The whole federal answer for one customer.
 *
 * `mc_only` is not a failure and not an absence — it is us admitting we cannot
 * ask. The public authority file is keyed by USDOT number, and `lookupAuthority`
 * takes one; we hold a docket number for this broker and nothing to query with.
 * Rendering that as "no authority record came back" would be a fourth flavour of
 * the same lie this module exists to prevent, so it gets its own state and its
 * own sentence on screen.
 */
export type FederalCheck =
  | { state: 'mc_only'; mc: string }
  | { state: 'checked'; dot: string; authority: FederalResult<AuthorityRow>; census: CensusView }

/**
 * Give up on the federal record before the page gives up on the customer.
 *
 * `soda()` in fmcsa.ts already aborts at 8 seconds, which bounds the worst case
 * but does not make it acceptable: this lookup hangs the server render of a page
 * whose actual job — showing the broker's phone number and payment terms — needs
 * no network at all. Eight seconds of blank screen to find out we learned
 * nothing is worse than four.
 *
 * The losing promise is NOT left dangling as an unhandled rejection: Promise
 * .race attaches its own handlers to it, so a later failure is absorbed by an
 * already-settled race rather than crashing the worker.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The census lookup, with its failure turned into a value.
 *
 * `lookupCarrier` throws on a dead endpoint and returns null for "no such
 * carrier", and those two must not collapse into one another. Null genuinely
 * means the federal carrier census has no entry — which is unremarkable for a
 * broker, since brokers are not carriers — while a throw means we know nothing.
 */
async function censusView(dot: string): Promise<CensusView> {
  try {
    const row = await lookupCarrier(dot)
    return row ? { state: 'row', row } : { state: 'none' }
  } catch {
    return { state: 'error' }
  }
}

/**
 * Ask the public federal record about this customer.
 *
 * Never throws and never rejects. A broker page that 500s because a government
 * Socrata endpoint is having a bad morning is a page that taught its user to
 * stop trusting the product, over a feature that is a bonus.
 *
 * Both lookups go out together — one round trip of wall time, not two — and
 * neither can damage the other: `lookupAuthority` reports its own failure as a
 * state and `censusView` catches, so `Promise.all` here has nothing left to
 * reject on.
 */
export async function federalCheck(
  dotNumber: string | null,
  mcNumber: string | null,
  deadlineMs = 4500,
): Promise<FederalCheck> {
  const dot = dotNumber ? normalizeDot(dotNumber) : null

  // Reached when we hold a docket number and no DOT number, and also when a DOT
  // number stored before parseDotNumber existed turns out to be unreadable. Both
  // mean the same thing to the reader: we did not look.
  if (!dot) return { state: 'mc_only', mc: mcNumber ?? '' }

  const [authority, census] = await Promise.all([
    withDeadline<FederalResult<AuthorityRow>>(
      lookupAuthority(dot),
      deadlineMs,
      // A timeout IS an error here, not an empty result, and the message says so
      // in the words the page will show. The one thing it must not become is
      // `{ state: 'empty' }`, which on screen reads as "the federal file has
      // nothing on them" — a statement of fact we have not earned.
      { state: 'error', message: 'timed out' },
    ),
    withDeadline<CensusView>(censusView(dot), deadlineMs, { state: 'error' }),
  ])

  return { state: 'checked', dot, authority, census }
}

/**
 * Colour for one docket's authority status.
 *
 * Active is the ONLY green. Everything else — Pending, Inactive, Withdrawn, and
 * any status string FMCSA adds after this was written — is amber or red, because
 * the default case here is "we do not recognise this word" and the safe way to
 * render a word we do not recognise is not as reassurance.
 */
export function authorityPillClass(status: string | undefined): string {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'active':
      return 'bg-emerald-100 text-emerald-800'
    case 'inactive':
    case 'revoked':
    case 'withdrawn':
      return 'bg-red-100 text-red-700'
    default:
      return 'bg-amber-100 text-amber-800'
  }
}

/**
 * True when the federal record says at least one docket is Active.
 *
 * Used only to decide whether to raise a warning banner, and it is written as
 * "is any active" rather than "is any inactive" on purpose: a customer with one
 * revoked docket and one live one is still able to broker freight, and shouting
 * about the dead one would train the owner to ignore the banner by Thursday.
 */
export function hasActiveAuthority(rows: readonly AuthorityRow[]): boolean {
  return rows.some((r) => (r.op_auth_status ?? '').trim().toLowerCase() === 'active')
}
