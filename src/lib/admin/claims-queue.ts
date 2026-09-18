/**
 * Turning rows of `carrier_claims` into the queue an operator reads.
 *
 * Only the manual-review rows. A manual claim is the one kind that carries no
 * code and can never complete itself: the census file has no phone and no email
 * for that carrier — 37% of the oldest registrations — so a person has to look,
 * and until a person looks the request just sits there. src/lib/claims.ts has
 * the measurements; this file has the words the operator reads.
 *
 * EVERYTHING HERE IS PURE. The page decides who may see the queue and fetches
 * it; this file only decides which bucket a row is in and what the row says, so
 * both can be tested without a database and neither can be changed by accident
 * while editing the other.
 *
 * THE QUESTION THIS ANSWERS IS "WHAT NEEDS ME TODAY", the same question every
 * other screen in this product answers. So `waiting` is a bucket of its own,
 * and expired and finished requests are kept where they can be read and not
 * where they can be confused with work.
 */

import { CLAIM_POLICY } from '../claims.ts'

/** A `carrier_claims` row, with the columns the queue is allowed to see.
 *  `code_hash` is deliberately absent — see the select in the page. */
export interface ManualClaimRow {
  id: string
  dot_number: string
  user_id: string
  note: string | null
  created_at: string
  expires_at: string
  verified_at: string | null
  voided_at: string | null
}

/**
 * Three buckets and no more.
 *
 * `waiting`  nobody has answered and there is still time.
 * `expired`  the thirty days ran out with no answer. Nothing happens on its own.
 * `finished` somebody resolved it by hand — verified, or killed.
 */
export type QueueBucket = 'waiting' | 'expired' | 'finished'

export interface QueueItem {
  id: string
  dotNumber: string
  userId: string
  /** The claimant's account email, or null when the profile carries none. */
  email: string | null
  note: string | null
  bucket: QueueBucket
  /** Whole days since the request was made. Never negative. */
  daysWaiting: number
  /** Whole days until it expires; negative once it has. */
  daysLeft: number
  /** "Sep 14, 2026 · asked 3 days ago" */
  askedLine: string
  /** "Oct 14, 2026 · closes in 27 days" */
  closesLine: string
  badge: { label: string; className: string }
}

const DAY = 86_400_000

/**
 * The carrier's day, not UTC.
 *
 * Every customer is in California and these are timestamps, not date-only
 * columns. Rendered in UTC, a request made at 6pm Pacific prints as the NEXT
 * day — which on a support queue means an operator reading "asked Sep 15" for
 * something that reached him on the 14th, and a thirty-day deadline that looks
 * a day further away than it is. Same rule and same zone as
 * src/lib/stops.ts and the date entry on the dashboard.
 */
const ZONE = 'America/Los_Angeles'

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: ZONE,
}

/** Accepts what PostgREST returns (a string) as well as a Date. */
function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function onDate(value: Date | string | null | undefined): string {
  const d = asDate(value)
  return d ? d.toLocaleDateString('en-US', DATE_FORMAT) : 'no date'
}

/**
 * Whole days between two instants, always rounded toward now.
 *
 * TRUNCATION AND NOT FLOOR, and the difference is only visible in the past.
 * Something asked 30 hours ago is "1 day ago", not two — floor gets that right.
 * But a deadline that passed 56 hours ago is 2 days gone, and floor of -2.33 is
 * -3, which prints "closed 3 days ago" for something closed the day before
 * yesterday. Rounding toward now understates in both directions, which is the
 * safe direction for a number an operator acts on.
 */
function wholeDays(fromMs: number, toMs: number): number {
  const days = Math.trunc((toMs - fromMs) / DAY)
  // `Math.trunc` of a small negative is -0, which prints as "0" but is not 0 to
  // anything comparing it. Normalised here so no caller ever has to know.
  return days === 0 ? 0 : days
}

/**
 * WORDS, NEVER "3d". The reader of this screen is the same person the rest of
 * the product is written for, and "29d" is a unit he has to decode. It also
 * costs nothing to spell out.
 */
export function askedPhrase(days: number): string {
  if (days <= 0) return 'asked today'
  if (days === 1) return 'asked yesterday'
  return `asked ${days} days ago`
}

/**
 * `past` is passed separately rather than read off the sign, because a deadline
 * that went twelve hours ago truncates to ZERO days and zero has no sign to
 * read. Without the flag that row prints "closes today" under a badge that says
 * it already ran out — the screen contradicting itself about the only thing it
 * is for. The default covers the plain cases; toQueueItem compares the actual
 * instants and says.
 */
export function closesPhrase(days: number, past: boolean = days < 0): string {
  if (!past) {
    if (days > 1) return `closes in ${days} days`
    if (days === 1) return 'closes tomorrow'
    return 'closes today'
  }
  const ago = Math.abs(days)
  if (ago === 0) return 'closed today'
  if (ago === 1) return 'closed yesterday'
  return `closed ${ago} days ago`
}

/**
 * How close to the deadline counts as "answer this one first".
 *
 * A manual request lives thirty days. A week is the point where an unanswered
 * one stops being a queue item and starts being a carrier who is about to be
 * told to ask again — which for a carrier with no phone and no email on the
 * federal record means starting the only path he has all over again.
 */
export const CLOSING_SOON_DAYS = 7

/**
 * The badge, which is the first thing read and therefore the thing that has to
 * be right.
 *
 * COLOUR IS NEVER THE SIGNAL ON ITS OWN — every badge here carries a word, and
 * the row prints the day count beside it. Red is "act now": a request about to
 * run out. Amber is "this needs a person, soon": everything else still open.
 * Green is done. Grey is the archive — expired or killed, nothing to do.
 *
 * There is no green for "waiting", ever. An open request is not on track; it is
 * work nobody has done.
 */
export function queueBadge(
  bucket: QueueBucket,
  daysLeft: number,
  verified: boolean,
): { label: string; className: string } {
  if (bucket === 'finished') {
    return verified
      ? { label: 'Given', className: 'badge badge-success' }
      : { label: 'Closed', className: 'badge badge-neutral' }
  }
  if (bucket === 'expired') return { label: 'Ran out', className: 'badge badge-neutral' }
  if (daysLeft <= CLOSING_SOON_DAYS) {
    return { label: 'Closes soon', className: 'badge badge-danger' }
  }
  return { label: 'Waiting', className: 'badge badge-warning' }
}

/**
 * One row, ready to print.
 *
 * `verified_at` and `voided_at` are checked BEFORE the clock, so a request that
 * was answered on its last day reads "Given" rather than "Ran out". The
 * database never sets either one for a manual claim — `complete_carrier_claim`
 * and `void_carrier_claim` both exclude the channel — so a value in them means
 * a person resolved it by hand, which is exactly the thing worth showing.
 */
export function toQueueItem(
  row: ManualClaimRow,
  emails: Map<string, string | null>,
  now: Date,
): QueueItem {
  const created = asDate(row.created_at)
  const expires = asDate(row.expires_at)
  const verified = asDate(row.verified_at)
  const voided = asDate(row.voided_at)
  const nowMs = now.getTime()

  // The clock, read once, so the bucket and the words below cannot disagree
  // about whether the deadline has gone.
  const past = !expires || expires.getTime() <= nowMs
  const bucket: QueueBucket = verified || voided ? 'finished' : past ? 'expired' : 'waiting'

  const daysWaiting = created ? Math.max(0, wholeDays(created.getTime(), nowMs)) : 0
  const daysLeft = expires ? wholeDays(nowMs, expires.getTime()) : 0

  return {
    id: row.id,
    dotNumber: row.dot_number,
    userId: row.user_id,
    email: emails.get(row.user_id) ?? null,
    note: row.note?.trim() ? row.note.trim() : null,
    bucket,
    daysWaiting,
    daysLeft,
    askedLine: `${onDate(created)} · ${askedPhrase(daysWaiting)}`,
    closesLine: `${onDate(expires)} · ${closesPhrase(daysLeft, past)}`,
    badge: queueBadge(bucket, daysLeft, Boolean(verified)),
  }
}

/**
 * The whole queue, newest first.
 *
 * The order comes from the query and is re-applied here so a caller that
 * forgets `order by` still gets the right screen: "most recent first" is the
 * only order that answers "what came in while I was away".
 */
export function buildQueue(
  rows: ManualClaimRow[],
  emails: Map<string, string | null>,
  now: Date,
): QueueItem[] {
  return [...rows]
    .sort((a, b) => (asDate(b.created_at)?.getTime() ?? 0) - (asDate(a.created_at)?.getTime() ?? 0))
    .map((row) => toQueueItem(row, emails, now))
}

export function countBucket(items: QueueItem[], bucket: QueueBucket): number {
  return items.filter((i) => i.bucket === bucket).length
}

/** The `?show=` values, and the one a bad value falls back to. */
export const SHOW_VALUES = ['waiting', 'expired', 'finished', 'all'] as const
export type ShowValue = (typeof SHOW_VALUES)[number]

/**
 * `waiting` is the default, because the question is "what needs me today".
 * Anything unrecognised in the query string lands there too — a filter is not
 * somewhere a stray parameter should be able to hide rows from an operator.
 */
export function parseShow(raw: string | null | undefined): ShowValue {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase()
  return (SHOW_VALUES as readonly string[]).includes(value) ? (value as ShowValue) : 'waiting'
}

export function filterQueue(items: QueueItem[], show: ShowValue): QueueItem[] {
  return show === 'all' ? items : items.filter((i) => i.bucket === show)
}

/** How long a manual request lives, in the one place that already decides it. */
export const MANUAL_DAYS = CLAIM_POLICY.manualDays
