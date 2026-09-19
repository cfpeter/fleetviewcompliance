/**
 * Minting a driver link, and reading back what he sent.
 *
 * The credential itself is `src/lib/proof/token.ts`, unchanged — 32 CSPRNG
 * bytes, base64url, and a thrown error rather than a weak fallback. Nothing in
 * that file is proof-specific and a second generator would be a second thing to
 * get wrong.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isStorableDate } from '../anchors/plan.ts'
import { hashProofToken, newProofToken } from '../proof/token.ts'
import { type AskKey, askByKey, sameAsk } from './asks.ts'

// ---------------------------------------------------------------- the clock

/**
 * How long a link lives.
 *
 * THREE DAYS, and the number was learned the hard way. The predecessor's first
 * instinct was thirty minutes, which is wrong for this audience in a way that
 * costs the exact phone call the feature exists to prevent: a driver reads the
 * message at a fuel stop four hours later, finds a dead link, and rings the
 * office. Three days spans a weekend and a long run.
 */
export const DEFAULT_EXPIRY_HOURS = 72
/** A zero would mint links that are already dead. */
export const MIN_EXPIRY_HOURS = 1
/**
 * Thirty days, matching `driver_links_expiry_sane` in 0034.
 *
 * A ceiling exists at all because this is a bearer token for an unauthenticated
 * write. "Never expires" is not an option a tired owner should be able to pick
 * at six in the morning, and a link that outlives the job is a credential
 * sitting in a forwarded message thread.
 */
export const MAX_EXPIRY_HOURS = 720

export const EXPIRY_CHOICES: readonly { hours: number; label: string }[] = [
  { hours: 24, label: '1 day' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
]

/**
 * Clamped HERE, inside the module that mints, and not only at the call sites.
 *
 * The predecessor clamped in its two callers and left `mintDriverLink` trusting
 * its argument — so its own migration's claim that the ceiling was enforced in
 * the database was untrue of the row that mattered. A third caller would have
 * walked straight past it.
 */
export function clampExpiryHours(raw: unknown): number {
  const hours = Number(raw)
  if (!Number.isFinite(hours)) return DEFAULT_EXPIRY_HOURS
  const whole = Math.round(hours)
  if (whole < MIN_EXPIRY_HOURS) return MIN_EXPIRY_HOURS
  if (whole > MAX_EXPIRY_HOURS) return MAX_EXPIRY_HOURS
  return whole
}

// ---------------------------------------------------------------- the dates

/**
 * A date a driver could plausibly be reading off a card.
 *
 * Nobody renews a medical certificate to a date ten years out, and nothing a
 * driver photographs today expired in the last decade. The window is not
 * security — the owner checks the card before accepting — it is a typo net, and
 * the typo it catches is the year.
 */
const MAX_YEARS_AHEAD = 10
const MAX_YEARS_BEHIND = 5

export type DateCheck = { ok: true; value: string | null } | { ok: false; message: string }

export function readAskDate(raw: unknown, today: Date): DateCheck {
  const value = String(raw ?? '').trim()
  // Blank means "not this one". Every box on this form starts empty and a
  // driver sending one date out of three is the normal case, not an error.
  if (value === '') return { ok: true, value: null }
  if (!isStorableDate(value)) {
    return { ok: false, message: 'Check the date — use the date printed on the card.' }
  }
  const year = Number(value.slice(0, 4))
  const now = today.getUTCFullYear()
  if (year > now + MAX_YEARS_AHEAD || year < now - MAX_YEARS_BEHIND) {
    return { ok: false, message: 'Check the year — that does not look right.' }
  }
  return { ok: true, value }
}

// ---------------------------------------------------------------- the caller

/**
 * Who sent it, as much as we are willing to keep.
 *
 * A SALTED digest of the address, never the address. It answers "did these two
 * submissions come from the same place", which is the question that matters when
 * an owner asks whether a claim was really his driver. It cannot answer "where
 * is this driver tonight", which is a question a compliance product has no
 * business being able to answer about a person.
 *
 * `cf-connecting-ip` and nothing else. See the note in src/lib/terms.ts: an
 * X-Forwarded-For is written by whoever is in front of us and can say anything.
 */
export async function callerHash(headers: Headers, salt: string): Promise<string | null> {
  const ip = headers.get('cf-connecting-ip')?.trim()
  if (!ip || !salt) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${ip}`))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

// ---------------------------------------------------------------- the minting

export interface MintArgs {
  supabase: SupabaseClient
  carrierId: string
  driverId: string
  asks: AskKey[]
  hours: number
  userId: string | null
  sentTo: string | null
  channel: 'email' | 'sms' | 'copied'
}

export type MintResult =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; message: string }

/**
 * A fresh link, and the retirement of any it replaces.
 *
 * THE SUPERSEDE IS NOT TIDINESS. Pressing "Ask the driver" twice, or making a
 * new link after he says he never got the first, used to leave both alive. The
 * owner then has several outstanding links for one driver and no way to tell
 * which one he used — and every extra live link is another bearer token for an
 * unauthenticated write sitting in a message thread.
 *
 * Only links asking for the SAME things are retired. A link asking for a medical
 * card and a link asking for a licence are two different errands.
 */
export async function mintDriverLink(args: MintArgs): Promise<MintResult> {
  if (args.asks.length === 0) return { ok: false, message: 'Pick at least one thing to ask for.' }

  const hours = clampExpiryHours(args.hours)
  const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString()

  // Retire first. A failure here means an extra live link, which is worse than
  // a failed mint, so it is checked rather than swallowed.
  const { data: live, error: readError } = await args.supabase
    .from('driver_links')
    .select('id, asks')
    .eq('driver_id', args.driverId)
    .is('used_at', null)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
  if (readError) return { ok: false, message: 'We could not make that link. Try again.' }

  const replaced = (live ?? [])
    .filter((r) => sameAsk((r.asks as string[]) ?? [], args.asks))
    .map((r) => String(r.id))
  if (replaced.length > 0) {
    const { error } = await args.supabase
      .from('driver_links')
      .update({ revoked_at: new Date().toISOString() })
      .in('id', replaced)
    if (error) return { ok: false, message: 'We could not make that link. Try again.' }
  }

  const token = newProofToken()
  const { error } = await args.supabase.from('driver_links').insert({
    // Supplied, never filtered on. RLS checks the value on the way in but does
    // not fill it, and the trigger in 0034 separately refuses a driver from
    // another carrier — so a tampered id fails at the database, not on trust.
    carrier_id: args.carrierId,
    driver_id: args.driverId,
    token_hash: await hashProofToken(token),
    asks: args.asks,
    expires_at: expiresAt,
    sent_to: args.sentTo,
    channel: args.channel,
    created_by: args.userId,
  })
  if (error) return { ok: false, message: 'We could not make that link. Try again.' }

  // The raw token goes back to the caller and is never stored. It exists in the
  // link the owner sends and nowhere else.
  return { ok: true, token, expiresAt }
}

/** The address a link is opened at. Built from the request, never from a header. */
export function driverLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/u/${token}`
}

// ---------------------------------------------------------------- the message

/**
 * What the driver reads before he taps anything.
 *
 * THE CARRIER IS NAMED HERE AND NOWHERE ELSE. The page itself does not say which
 * company this is — it is a URL that gets forwarded and screenshotted. The
 * message is the part that arrived from a number or an address he recognises, so
 * the message is where the company name belongs.
 */
export function driverLinkMessage(args: {
  carrierName: string
  firstName: string | null
  url: string
}): string {
  const who = args.firstName ? `${args.firstName}, ` : ''
  return (
    `FleetView: ${who}${args.carrierName} needs you to send in a couple of details. ` +
    `Open this link (it expires): ${args.url}`
  )
}

/** The same thing for an inbox, where a subject line is expected. */
export function driverLinkSubject(carrierName: string): string {
  return `${carrierName} needs a couple of details from you`
}

/** Whether an ask key survived the catalogue. Kept beside the minting so the
 *  page and the database agree on one vocabulary. */
export const isAsk = (value: unknown): boolean => askByKey(value) !== null

/**
 * Where a driver's photograph sits while it waits for the owner.
 *
 * NO TENANT SEGMENT, unlike `newStorageKey`. That one builds
 * `documents/<carrierId>/<random>.<ext>` so an object can be traced to a tenant
 * during an incident — which is right for a document, and wrong here, because
 * the page writing this key is anonymous and has no business learning a carrier
 * id it does not otherwise need. The index is the `driver_submissions` row,
 * which holds the carrier, the driver and the keys together behind RLS.
 *
 * Nothing about the object is guessable: the whole name is random, and the
 * bucket is reachable only through our own routes.
 */
export function newSubmissionKey(ext: string): string {
  const raw = crypto.getRandomValues(new Uint8Array(16))
  const random = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `driver-submissions/${random}.${ext}`
}
