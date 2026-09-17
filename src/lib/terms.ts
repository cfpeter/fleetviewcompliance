/**
 * Clickwrap: the sentence a customer ticks, and the record that they did.
 *
 * The schema and the reasoning behind it are in
 * supabase/migrations/0025_terms_acceptance.sql. This file holds the two halves
 * the database cannot: what the customer was actually shown, and how the
 * request's own facts (address, browser) are read out of a Cloudflare request.
 *
 * Everything here except recordTermsAcceptance() is pure, so the parts that
 * decide what counts as agreement can be tested without a browser, a session or
 * a database.
 */

import { EFFECTIVE_DATE } from './legal.ts'

// ---------------------------------------------------------------- version

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

/**
 * Turn the date the documents print — '16 September 2026' — into the version
 * string stored against an acceptance: '2026-09-16'.
 *
 * ISO rather than the printed form because the stored value is compared,
 * ordered and read back years later by somebody who was not here. '16 September
 * 2026' sorts before '2 January 2027' as text, and a version that sorts wrongly
 * is a version that answers "which one is newer" wrongly.
 *
 * NEVER THROWS, and that matters more than the parsing. This runs on the signup
 * path. An unrecognised date falls back to the string as written, which is
 * still a perfectly good version identifier — it is unique per revision, which
 * is the only property the schema needs. Refusing to record an acceptance
 * because a human typed the month in Spanish would be the worst possible trade.
 */
export function versionFromEffectiveDate(raw: string | null | undefined): string {
  const s = (raw ?? '').trim()
  const m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(s)
  if (!m) return s

  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1
  if (month === 0) return s

  const day = Number(m[1])
  if (day < 1 || day > 31) return s

  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * The version of the Terms and the Privacy Policy in force right now.
 *
 * DERIVED, never typed. src/lib/legal.ts owns EFFECTIVE_DATE and both documents
 * print it at the top of the page; a second copy of that date here would be a
 * second date to get wrong, and the one that goes wrong is always the one in
 * the evidence table rather than the one on the page a customer can see.
 *
 * Revising the documents is therefore one edit — EFFECTIVE_DATE — and this
 * follows. What happens to people who accepted the older version is a product
 * decision and is sketched at the foot of this file.
 */
export const TERMS_VERSION = versionFromEffectiveDate(EFFECTIVE_DATE)

// ---------------------------------------------------------------- the assent

/**
 * The checkbox, in pieces, because it has two links inside it.
 *
 * This is the single source of the wording. The markup on /login renders these
 * fields, and ASSENT_TEXT below joins the same fields into the sentence that
 * gets hashed — so what is stored as evidence is what was on the screen, and it
 * cannot drift by somebody editing the page and not the constant.
 *
 * THE WORDING IS DELIBERATELY SHORT. These customers run small fleets in Los
 * Angeles and many of them do not read English easily. 'I agree to the Terms
 * and the Privacy Policy.' is eight words, every one of them common, and it
 * still says the two things that make it an agreement: that the person agrees,
 * and to exactly which two documents. Both are links, so nobody has to go
 * looking. No 'by continuing you acknowledge', no 'hereby', no paragraph — a
 * sentence somebody cannot read is not consent, whatever it says.
 */
export const ASSENT = {
  lead: 'I agree to the',
  terms: 'Terms',
  join: 'and the',
  privacy: 'Privacy Policy',
  stop: '.',
  termsHref: '/terms',
  privacyHref: '/privacy',
} as const

/** The sentence, exactly as the page reads it out loud. */
export const ASSENT_TEXT =
  `${ASSENT.lead} ${ASSENT.terms} ${ASSENT.join} ${ASSENT.privacy}${ASSENT.stop}` as const

// ---------------------------------------------------------------- the tick

/**
 * Did the box get ticked?
 *
 * An unticked checkbox sends NOTHING — the field is simply absent from the form
 * data — so the common case arrives here as `null` and the answer is no. That is
 * the whole reason this is a function rather than a truthiness check on the
 * form value: `Boolean(form.get('terms'))` is also false for the string 'no',
 * and reasoning about which one you are looking at is how a gate ends up open.
 *
 * The values accepted are the ones a browser can actually produce for the input
 * in the markup: 'yes' from its value attribute, 'on' if the attribute is ever
 * dropped. 'true' and '1' are there for a future JSON caller.
 */
export function ticked(raw: FormDataEntryValue | null | undefined): boolean {
  if (typeof raw !== 'string') return false
  const v = raw.trim().toLowerCase()
  return v === 'yes' || v === 'on' || v === 'true' || v === '1'
}

// ---------------------------------------------------------------- the digest

/**
 * Everything the acceptance was made of, in a fixed order, one per line.
 *
 * Order and separator are part of the format: two different assents must never
 * produce the same string. Newline is safe here because none of the four parts
 * can contain one.
 */
export function assentCanonical(version: string = TERMS_VERSION): string {
  return [version, ASSENT.termsHref, ASSENT.privacyHref, ASSENT_TEXT].join('\n')
}

/**
 * SHA-256 of the above, lower-case hex.
 *
 * What this is for is argued out in the migration: it pins the INTERFACE — the
 * exact sentence, the two links, the version — which is what a clickwrap
 * dispute actually turns on. The documents themselves are pinned by the version
 * string plus the repository at that date.
 *
 * Returns null rather than throwing if Web Crypto is unavailable. A signup must
 * not fail because a corroborating hash could not be computed, and the column
 * is nullable for exactly this case.
 */
export async function assentDigest(version: string = TERMS_VERSION): Promise<string | null> {
  try {
    const bytes = new TextEncoder().encode(assentCanonical(version))
    const buf = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return null
  }
}

// ------------------------------------------------------- reading the request

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const IPV6 = /^[0-9a-f:.]{2,45}$/i

/**
 * The client's IP address, or null.
 *
 * CF-CONNECTING-IP AND NOTHING ELSE. Cloudflare sets that header itself on
 * every request that reaches a Worker, overwriting whatever the client sent, so
 * it is the one address in the request that a visitor cannot choose.
 * X-Forwarded-For is a list the client can prepend to, and reading it — even as
 * a fallback — means the address in an evidence table is a value the person
 * being evidenced typed. That is worse than having no address at all.
 *
 * NULL IS A CORRECT ANSWER. In `astro dev` there is no Cloudflare in front of
 * the Worker and the header is absent; the same is true of any request that
 * somehow reaches the origin directly. An empty column says "we do not know",
 * which is true. A stand-in — 127.0.0.1, '0.0.0.0', 'unknown' — would be a
 * fabricated exhibit in the one table whose entire purpose is being believed.
 *
 * Shape-checked here as well as in the database, so a malformed header is a
 * null on the way in rather than an error on the way down.
 */
export function clientIp(headers: Headers): string | null {
  const raw = (headers.get('cf-connecting-ip') ?? '').trim()
  if (!raw) return null

  const v4 = IPV4.exec(raw)
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255) ? raw : null

  // Anything else must at least look like IPv6: hex, colons, and the dots of an
  // embedded v4 tail such as ::ffff:203.0.113.9.
  if (raw.includes(':') && IPV6.test(raw)) return raw

  return null
}

/** The column's limit, kept here so the truncation and the constraint agree. */
export const USER_AGENT_MAX = 1000

/**
 * The browser string, or null.
 *
 * THE LENGTH CAP IS LOAD-BEARING. The column refuses anything over
 * USER_AGENT_MAX, so an over-long header without this would not be truncated —
 * it would raise, and the signup that was trying to record its own acceptance
 * would fail on a string the visitor chose. Cutting it here is what keeps a
 * header the customer does not control from costing them an account.
 *
 * THE CONTROL-CHARACTER STRIP IS NOT DECORATION EITHER, and this was measured
 * rather than assumed. `new Headers()` refuses only NUL, CR and LF; ESC, BEL and
 * DEL all pass through untouched, so a real request can genuinely carry an
 * escape sequence in this header. The string is read back one day in a terminal,
 * a support ticket or a court exhibit, and an escape sequence rewrites what the
 * person reading it sees — in the one table whose entire value is being read and
 * believed.
 */
export function clientUserAgent(headers: Headers): string | null {
  const raw = (headers.get('user-agent') ?? '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening them is the point
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
  if (!raw) return null
  return raw.length > USER_AGENT_MAX ? raw.slice(0, USER_AGENT_MAX) : raw
}

// ------------------------------------------------------------- recording it

export interface AcceptanceResult {
  /** True when the database holds an acceptance for this user at this version. */
  recorded: boolean
  /** The acceptance instant, from the server clock. Null if nothing was written. */
  acceptedAt: string | null
  /** Set only when the call failed. For a log line, never for a customer. */
  error: string | null
}

/**
 * Write the acceptance.
 *
 * Deliberately returns a result instead of throwing. By the time this is
 * called the account already exists, so there is nothing useful to abort — a
 * throw here would show a customer an error for something that already
 * succeeded, and would still leave the row unwritten. What the caller should do
 * with a failure is log it; the call is idempotent per (user, version), so a
 * later call repairs it without moving the recorded instant.
 *
 * The user id and the timestamp are NOT passed and cannot be: the function
 * takes neither. See the migration.
 */
export async function recordTermsAcceptance(
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult> },
  headers: Headers,
  version: string = TERMS_VERSION,
): Promise<AcceptanceResult> {
  const { data, error } = await supabase.rpc('record_terms_acceptance', {
    p_document_version: version,
    p_assent_digest: await assentDigest(version),
    p_ip: clientIp(headers),
    p_user_agent: clientUserAgent(headers),
  })

  if (error) return { recorded: false, acceptedAt: null, error: error.message }
  return { recorded: true, acceptedAt: (data as string | null) ?? null, error: null }
}

/**
 * Structural typing rather than importing SupabaseClient, so the recording call
 * can be tested with a stub and so this module does not drag the Supabase
 * client into anything that only wants the pure half.
 */
interface RpcResult {
  data: unknown
  error: { message: string } | null
}

/**
 * WHEN THE DOCUMENTS CHANGE — the sketch, so the schema above does not have to
 * move when it happens. Nothing here is built.
 *
 * Changing EFFECTIVE_DATE in legal.ts changes TERMS_VERSION, and from that
 * moment every existing customer has a row for the OLD version and none for the
 * new one. That is already correct, and it is the reason the unique index is on
 * (user_id, document_version) rather than on user_id alone: the old row is the
 * evidence for everything that happened while the old version was current and
 * must not be touched, and the new one sits beside it.
 *
 * What would have to be added is the gate, which is three pieces:
 *
 *   1. A read. `select 1 from terms_acceptances where document_version = $1`,
 *      under the existing select-self policy, so it needs no new grant.
 *   2. A screen — /app/terms-changed — showing what changed, the same checkbox,
 *      and a POST that calls recordTermsAcceptance() unchanged. The function
 *      already writes whatever version it is handed.
 *   3. A check in src/middleware.ts beside the carrier check, redirecting there
 *      when the row is missing, with the same `pathname !== ...` escape the
 *      carrier redirect uses so the screen itself is reachable.
 *
 * The one judgement call is what an ordinary change means. A wholesale rewrite
 * should block the app until re-accepted; a corrected typo should not, or every
 * customer is stopped at a door for nothing. That argues for splitting the
 * version from a MATERIAL flag in legal.ts — the version always moves, the gate
 * only fires when the revision was material — rather than for anything in the
 * schema, which stays as it is either way.
 */
