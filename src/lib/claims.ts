/**
 * Proving that the person typing a USDOT number is the carrier it belongs to.
 *
 * THE HOLE THIS CLOSES. A USDOT number is public, printed on the door of every
 * truck on the interstate, and `carriers.dot_number` is UNIQUE — so before this
 * existed the first account to type a number owned it for good. DOT numbers are
 * sequential. A script could have walked 1..4,000,000 overnight and locked every
 * carrier in the country out of their own record, with no invite mechanism and
 * no transfer path to undo it.
 *
 * The proof we can actually make is small but real: the FMCSA census file
 * carries the carrier's own phone number and, more recently, their email. Send a
 * code there, and whoever reads it is someone the federal record already says is
 * the carrier. It is not identity proof — it is control of the contact point the
 * government has on file, which is the same standard a bank uses for a password
 * reset and considerably better than "typed it first".
 *
 * THE DATA DECIDED THE DESIGN, not the other way round. Measured over California
 * registrations:
 *
 *   DOT band        has email   has phone   has neither
 *   oldest              10%         62%         37%
 *   > 1,000,000         39%         99%          1%
 *   > 2,000,000         52%         98%          0%
 *   > 3,000,000         99%        100%          0%
 *
 * So PHONE is the primary channel and email is the option we offer when it is
 * there. Building this email-first would have worked for the demo and failed for
 * most of the market. And the legacy tail with NEITHER is not a rounding error:
 * those carriers cannot self-verify at all, ever, and they get an honest
 * manual-review path instead of a form that silently refuses them.
 *
 * Everything in this file is pure. The database enforces the same policy in
 * 0021_carrier_claims.sql — that is the enforcement point, and these functions
 * exist so the decisions can be tested as attacks rather than as happy paths,
 * and so the page can say the same numbers the database will apply.
 */

import type { CensusRow } from './fmcsa.ts'
import { toE164 } from './phone.ts'

/**
 * Re-exported rather than moved-and-forgotten.
 *
 * `toE164` now lives in phone.ts because the driver and customer forms need the
 * same definition of "a number we can actually reach" that this flow needed
 * first — and two parsers would be two definitions. It is exported from here so
 * that every existing importer, and the tests that attack it as a filter on
 * census rubbish, keep pointing at one implementation.
 */
export { toE164 }

// ----------------------------------------------------------------- policy

/**
 * The numbers, in one place, with the reason each one is what it is.
 *
 * These are duplicated in 0021_carrier_claims.sql because SQL cannot import
 * TypeScript. The SQL is what actually enforces them — a check that lives only
 * in the page is a check that a direct PostgREST call skips. Change one, change
 * the other; the migration says the same thing in the other direction.
 */
export const CLAIM_POLICY = {
  /** Six digits is what people expect to retype off a phone screen. */
  codeDigits: 6,

  /**
   * Fifteen minutes. Long enough to walk to the office phone and short enough
   * that a code read off a screenshot next week is dead. The window matters more
   * than it looks: it is the real limit on how long an attacker has to spend
   * their five guesses.
   */
  ttlMinutes: 15,

  /**
   * Five. Six digits is a million possibilities, which sounds like a lot and is
   * nothing — an unthrottled script exhausts it in minutes. Five guesses against
   * a million is a 1-in-200,000 chance per claim, and a dead claim after that
   * which must be restarted from a fresh send (and so a fresh rate-limit check).
   * Without this cap, every other control here is decoration.
   */
  maxAttempts: 5,

  /**
   * Sends per USDOT number. This is the one that stops the flow being a machine
   * for texting a stranger at our Twilio expense: whoever the number belongs to,
   * they can be made to receive at most three messages an hour and ten a day,
   * total, from everybody. A real carrier needs two at the very most — one that
   * went to a landline and one to email.
   */
  sendsPerDotHour: 3,
  sendsPerDotDay: 10,

  /**
   * Sends per signed-in user, across all DOT numbers. The per-DOT cap alone
   * would let one account walk the whole census file at three messages per
   * carrier per hour. This is what makes that script pointless.
   */
  sendsPerUserHour: 5,
  sendsPerUserDay: 20,

  /**
   * A minute between sends. Mostly it catches a double-submitted form, which
   * would otherwise burn two of three hourly sends and text the carrier twice.
   */
  resendCooldownSeconds: 60,

  /**
   * How long a manual-review request stays in the queue before it needs
   * re-asking. Every claim gets a horizon; a support request that sits forever
   * is a support request nobody ever closes.
   */
  manualDays: 30,

  /** Manual requests are free to make, so they get their own small ceiling. */
  manualPerUserDay: 5,
} as const

// ---------------------------------------------------------------- channels

/**
 * 'phone' rather than 'sms' because the census column is a phone number, and
 * what we eventually do with it (text, or read a code out on a call for the
 * landlines) is a delivery detail. 'manual' is a claim with no code in it at
 * all: a human has to look.
 */
export type ClaimChannel = 'phone' | 'email' | 'manual'

/** A channel we can actually use, with what the claimant is allowed to see. */
export interface ClaimOption {
  channel: 'phone' | 'email'
  /**
   * Where the code really goes. Resolved from the census row on the server and
   * never from a form field — a destination that came off the page is a
   * destination the attacker chose, which turns this whole flow into a way of
   * mailing yourself a code for somebody else's carrier.
   */
  destination: string
  /** What we print. See the masking rules below. */
  mask: string
}

// ----------------------------------------------------------------- masking

/**
 * Bullets, fixed at three, never one per hidden character.
 *
 * Padding the mask to the length of the thing it hides gives the length away,
 * and for an email local part that is a real narrowing: `j•@x.com` says the
 * address is two characters long. Three bullets always, so the mask carries
 * exactly the information we chose to reveal and nothing else.
 */
const BULLETS = '•••'

/**
 * The phone, masked to its last four digits.
 *
 * Four digits of ten leaves a million possibilities, which is enough that the
 * mask cannot be turned back into the number, and it is the amount every bank
 * and airline shows — so the carrier recognises their own line immediately
 * without us publishing it to whoever else is looking at this screen.
 */
export function maskPhone(raw: string | null | undefined): string | null {
  const e164 = toE164(raw)
  if (!e164) return null
  return `(${BULLETS}) ${BULLETS}-${e164.slice(-4)}`
}

/**
 * An email address from the census, or null when it is not one.
 *
 * Deliberately not an RFC-complete parser. This decides whether we are willing
 * to send to a value, so the failure that matters is accepting rubbish, not
 * rejecting an exotic-but-legal address that FMCSA's form would never have taken
 * in the first place.
 */
export function usableEmail(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim()
  if (!text || /\s/.test(text)) return null
  const at = text.indexOf('@')
  // Exactly one '@', something on each side, and a dotted domain.
  if (at < 1 || at !== text.lastIndexOf('@')) return null
  const domain = text.slice(at + 1)
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(domain)) {
    return null
  }
  return text
}

/**
 * The email, masked to one character of the local part plus the whole domain.
 *
 * One character and the domain is enough for the owner to say "yes, that is the
 * office address" and not enough for a stranger to write it down. The domain is
 * shown in full because it is the part that identifies the mailbox to its owner
 * — `d•••@gmail.com` and `d•••@swifttrans.com` are the two answers he needs to
 * tell apart.
 *
 * A one-character local part is the case that breaks the rule: showing the first
 * character there IS showing the local part, so that one gets no character at
 * all. Rare, and the alternative is a mask that reconstructs the value.
 */
export function maskEmail(raw: string | null | undefined): string | null {
  const address = usableEmail(raw)
  if (!address) return null
  const at = address.indexOf('@')
  const local = address.slice(0, at)
  const domain = address.slice(at + 1)
  const head = local.length > 1 ? local[0] : ''
  return `${head}${BULLETS}@${domain}`
}

/**
 * Which channels this census row actually offers, phone first.
 *
 * Phone leads because the data says so: 98-100% of any carrier registered since
 * DOT 1,000,000 has one, against 39-99% for email. An empty array is the legacy
 * tail — 37% of the oldest records — and it is a real answer, not a failure.
 * Those carriers go to manual review.
 */
export function claimOptions(row: CensusRow | null | undefined): ClaimOption[] {
  const out: ClaimOption[] = []
  const phone = toE164(row?.phone)
  if (phone) out.push({ channel: 'phone', destination: phone, mask: maskPhone(row?.phone) ?? '' })
  const email = usableEmail(row?.email_address)
  if (email) {
    out.push({ channel: 'email', destination: email, mask: maskEmail(row?.email_address) ?? '' })
  }
  return out
}

/** The chosen option, or null. The channel comes off a form, so it is untrusted. */
export function pickOption(options: ClaimOption[], channel: string | null): ClaimOption | null {
  return options.find((o) => o.channel === channel) ?? null
}

// -------------------------------------------------------------------- code

/**
 * Random bytes or an exception — never a fallback.
 *
 * The same rule as proof/token.ts, for the same reason: a `Math.random()`
 * fallback that fires silently in whichever runtime lacks the global produces
 * codes that look identical to good ones and are predictable from a handful of
 * samples. V8's generator has 128 bits of recoverable state; after a few
 * observed codes every past and future one is computable, and this code is the
 * only thing standing between a stranger and somebody's carrier record.
 */
function randomBytes(count: number): Uint8Array {
  const source = globalThis.crypto
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error(
      'crypto.getRandomValues is unavailable; refusing to mint a verification code without a CSPRNG.',
    )
  }
  return source.getRandomValues(new Uint8Array(count))
}

/** 10^6. Written from the policy so the two cannot drift. */
const CODE_SPACE = 10 ** CLAIM_POLICY.codeDigits

/**
 * A fresh six-digit code, uniformly distributed, leading zeros intact.
 *
 * Two things here are not decoration:
 *
 * REJECTION SAMPLING. `random32 % 1000000` is biased, because 2^32 is not a
 * multiple of 10^6: the first 967,296 codes come up very slightly more often
 * than the rest. On its own that is a tiny effect, but it is a free fix and the
 * whole security of a six-digit code is that all million are equally likely.
 *
 * LEADING ZEROS. The code is a STRING throughout — never a number anywhere, not
 * in the hash input, not in the column. `Number('012345')` is 12345, and a code
 * that silently loses its first digit is both unverifiable for the one user in
 * ten it happens to and a tenth of the keyspace gone.
 */
export function newClaimCode(): string {
  // Largest multiple of the code space that fits in 32 bits; anything at or
  // above it is thrown away rather than folded back in.
  const limit = Math.floor(0x1_00_00_00_00 / CODE_SPACE) * CODE_SPACE
  for (;;) {
    const b = randomBytes(4)
    const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
    if (n < limit) return String(n % CODE_SPACE).padStart(CLAIM_POLICY.codeDigits, '0')
  }
}

/** Shape only. Says "this could be a code", never "this is the code". */
export function isClaimCode(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^\\d{${CLAIM_POLICY.codeDigits}}$`).test(value)
}

/**
 * What a person typed, cleaned up enough to compare.
 *
 * People paste "123 456" off a text message and type "123-456". Rejecting those
 * is a support ticket, not a security control.
 */
export function normalizeClaimCode(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '')
  return isClaimCode(digits) ? digits : null
}

/**
 * The code, hashed, bound to the claim, and peppered.
 *
 * WHY THE PEPPER IS NOT OPTIONAL. The requirement is that a database leak must
 * not hand over live claims. A plain SHA-256 of a six-digit code fails that
 * completely: an attacker with the table computes all one million digests in
 * well under a second and reads every outstanding code. A salt stored beside the
 * hash changes nothing — it is in the same leak. Only a secret that is NOT in
 * the database can make the stored hash useless on its own, so `CLAIM_CODE_PEPPER`
 * lives as a Worker secret and this function refuses to run without it. That
 * refusal is the same inversion notify/guard.ts uses: an unconfigured
 * environment does nothing, rather than doing something insecure quietly.
 *
 * WHY THE DOT NUMBER AND USER ID ARE IN IT. The digest is then specific to one
 * claim. Without them, a hash observed anywhere — a log line, a support paste, a
 * second leak — could be replayed against a different claim that happens to hold
 * the same code, and two claims out of a million share a code more often than
 * you would like.
 *
 * WHY NOT PBKDF2 OR ARGON. Key stretching buys time against an attacker who has
 * both the table AND the pepper; against a million-item keyspace even 100,000
 * iterations only moves a one-second crack to a few minutes, and it costs that
 * CPU inside a Workers request on every single verification. The code lives
 * fifteen minutes and dies after five guesses. The pepper is the control that
 * matters here; stretching would be theatre with a latency bill.
 */
export async function hashClaimCode(input: {
  pepper: string | undefined
  dotNumber: string
  userId: string
  code: string
}): Promise<string> {
  const pepper = (input.pepper ?? '').trim()
  if (pepper.length < 32) {
    throw new Error(
      'CLAIM_CODE_PEPPER must be set to at least 32 characters. Without it a stored code hash ' +
        'is one million SHA-256 digests away from plaintext, so verification refuses to run.',
    )
  }
  if (!isClaimCode(input.code)) throw new Error('not a verification code')

  // Length-prefixed rather than plain concatenation: joining on ':' alone lets
  // two different (dot, user) pairs produce the same input string if either
  // value could ever contain the separator, and a hash collision here is one
  // claim's code opening another's.
  const parts = [pepper, input.dotNumber, input.userId, input.code]
  const message = parts.map((p) => `${p.length}:${p}`).join('|')

  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Hash comparison that does not leak where the two differ.
 *
 * The timing signal on a 64-character string compare is a few nanoseconds and
 * unobservable across the internet, and the five-attempt cap means an attacker
 * gets five samples per claim rather than the millions any statistical attack
 * needs. This is here because the cost is one loop and the alternative is
 * reasoning about that every time somebody reads the code.
 */
export function hashesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length || a.length === 0) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ------------------------------------------------------------------ expiry

export function claimExpiry(now: Date): Date {
  return new Date(now.getTime() + CLAIM_POLICY.ttlMinutes * 60_000)
}

/** Accepts what PostgREST returns (a string) as well as a Date. */
function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function attemptsLeft(attempts: number): number {
  const used = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0
  return Math.max(0, CLAIM_POLICY.maxAttempts - used)
}

// ------------------------------------------------------------ verification

/** The row as the page and the tests see it. `codeHash` is never sent to a browser. */
export interface ClaimRecord {
  userId: string
  dotNumber: string
  channel: ClaimChannel
  codeHash: string | null
  expiresAt: Date | string
  attempts: number
  verifiedAt: Date | string | null
  voidedAt: Date | string | null
}

export type ClaimVerdict =
  | { state: 'ok' }
  | { state: 'not_yours' }
  | { state: 'used' }
  | { state: 'voided' }
  | { state: 'expired' }
  | { state: 'attempts_exhausted' }
  | { state: 'wrong_code'; attemptsLeft: number }

/**
 * Whether a presented code hash completes this claim.
 *
 * This mirrors `complete_carrier_claim` in 0021 exactly, and the database is
 * still the thing that enforces it — a check that lives only here is a check
 * that a direct PostgREST call walks straight past. It exists in TypeScript so
 * every one of the refusals below can be tested as the attack it is.
 *
 * ORDER IS LOAD-BEARING. Ownership is checked before anything else, so a claim
 * belonging to another user produces the same answer whatever its state: no
 * "expired" versus "wrong code" difference to tell you that somebody else has a
 * live claim on that number. The attempt count is spent on a wrong code and NOT
 * on an expired or already-completed one, because burning attempts for reasons
 * the user cannot act on just makes them restart twice.
 */
export function verifyClaim(
  claim: ClaimRecord,
  presented: { userId: string; codeHash: string; now: Date },
): ClaimVerdict {
  if (claim.userId !== presented.userId) return { state: 'not_yours' }
  if (asDate(claim.voidedAt)) return { state: 'voided' }
  if (asDate(claim.verifiedAt)) return { state: 'used' }
  if (claim.channel === 'manual' || !claim.codeHash) return { state: 'voided' }

  const expires = asDate(claim.expiresAt)
  if (!expires || expires.getTime() <= presented.now.getTime()) return { state: 'expired' }

  if (attemptsLeft(claim.attempts) <= 0) return { state: 'attempts_exhausted' }

  if (!hashesMatch(claim.codeHash, presented.codeHash)) {
    return { state: 'wrong_code', attemptsLeft: attemptsLeft(claim.attempts + 1) }
  }
  return { state: 'ok' }
}

// ------------------------------------------------------------- rate limits

export interface ClaimSendCounts {
  /** Code sends for this DOT number by anybody, in the last hour and day. */
  dotLastHour: number
  dotLastDay: number
  /** Code sends by this user against any DOT number, in the last hour and day. */
  userLastHour: number
  userLastDay: number
  /** Null when this user has never sent one. */
  secondsSinceUserLastSend: number | null
}

export type RateReason = 'cooldown' | 'dot_hour' | 'dot_day' | 'user_hour' | 'user_day'
export type RateVerdict = { allow: true } | { allow: false; reason: RateReason }

/**
 * Whether another code may go out.
 *
 * Counted over claims that were HANDED TO A PROVIDER, including ones later
 * voided because the send failed. A void that refunded the budget would be an
 * unlimited-SMS machine: start a claim, void it, repeat, and a stranger's phone
 * rings all night on our bill. The refusal to refund is the point — see
 * `void_carrier_claim` in 0021, which kills the claim and touches no counter.
 */
export function rateVerdict(counts: ClaimSendCounts): RateVerdict {
  const since = counts.secondsSinceUserLastSend
  if (since !== null && since < CLAIM_POLICY.resendCooldownSeconds) {
    return { allow: false, reason: 'cooldown' }
  }
  // Per-DOT first: it is the limit that protects a person who never asked to be
  // involved, and the one whose message should mention the carrier, not the user.
  if (counts.dotLastHour >= CLAIM_POLICY.sendsPerDotHour) {
    return { allow: false, reason: 'dot_hour' }
  }
  if (counts.dotLastDay >= CLAIM_POLICY.sendsPerDotDay) return { allow: false, reason: 'dot_day' }
  if (counts.userLastHour >= CLAIM_POLICY.sendsPerUserHour) {
    return { allow: false, reason: 'user_hour' }
  }
  if (counts.userLastDay >= CLAIM_POLICY.sendsPerUserDay) {
    return { allow: false, reason: 'user_day' }
  }
  return { allow: true }
}

// --------------------------------------------------------------- the words

/**
 * What the code message says.
 *
 * This message goes, by design, to somebody who did not necessarily ask for it —
 * that is the whole mechanism — so it has to explain itself in one line and say
 * plainly that ignoring it is safe. A bare "your code is 123456" arriving on a
 * dispatcher's phone at 9pm reads like a compromise in progress.
 *
 * It names the USDOT number, which is public, and nothing else about the
 * carrier. It never says who is claiming it.
 */
export function claimMessage(dotNumber: string, code: string): { subject: string; body: string } {
  return {
    subject: `Your code for USDOT ${dotNumber}`,
    body:
      `${code} is the code to confirm you control USDOT ${dotNumber} on FleetView Compliance. ` +
      `It expires in ${CLAIM_POLICY.ttlMinutes} minutes. ` +
      'If you did not ask for this, ignore it — the code alone does nothing.',
  }
}
