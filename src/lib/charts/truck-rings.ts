/**
 * The per-truck ring: what this one unit has a date for, and what it does not.
 *
 * The owner's question is which of his trucks he can send out today. This file
 * answers a narrower one on purpose — WHAT IS ON FILE AND WHAT IS MISSING —
 * and never the one he asked, for the reason written into
 * supabase/migrations/0013_share_links.sql and src/lib/proof/dqf.ts: a packet a
 * carrier produces about himself is structurally untrusted, so this product
 * states dated observations and never prints a verdict. A green circle beside a
 * unit number would be exactly that verdict, drawn in the place it is read
 * fastest and argued with least. tests/truck-rings.test.ts scans this file and
 * both vehicle pages for the words that would amount to one.
 *
 * THIS FILE OWNS NO DEFINITION OF ANYTHING, the same way dq-rings.ts owns none.
 *
 * Two definitions are borrowed whole, and neither of them is re-stated here:
 *
 * 1. WHAT THIS UNIT OWES comes from the rule engine. `rulesFor(subject)` in
 *    src/lib/rules/index.ts already hands a trailer only the rules written with
 *    `subject: 'trailer'`, and `evaluate` already drops anything a rule's
 *    `applies` ruled out. So the denominator is per unit and arrives made.
 *
 * 2. WHERE EACH OBLIGATION STANDS comes from `buildHealth` in ./health.ts —
 *    the same four buckets the dashboard donut is drawn from, in the same
 *    order of severity. The truck ring and the dashboard cannot disagree about
 *    how many things are overdue, because only one of them counts.
 *
 * The colours are dq-rings.ts's, imported rather than re-declared. A driver
 * ring and a truck ring that differ in shape, colour or wording are two
 * designs, and red already means overdue on every other screen in this app.
 */
import type { DeadlineItem } from '../rules/index.ts'
import { type DqRing, type RingSlice, type RingTone, rowLine } from './dq-rings.ts'
import { buildHealth, type HealthKey } from './health.ts'

/**
 * Re-exported, not re-defined.
 *
 * The four tones — act / soon / ok / nodate — are the driver ring's, object for
 * object. Anything that imports them from here gets the identical table, and
 * the test asserts the identity rather than comparing the strings, so a second
 * palette cannot be introduced by copying this one.
 */
export { RING_TONES, RING_TRACK } from './dq-rings.ts'

/** What the vehicles table calls the two kinds. Same strings as `Subject`. */
export type TruckKind = 'power_unit' | 'trailer'

/**
 * Which ring colour each of the dashboard's four buckets draws in.
 *
 * `unknown` — an obligation with no date behind it — is GREY AND ITS OWN ARC.
 * It is never folded into green and it is never dropped. A truck whose annual
 * inspection date nobody typed in must not draw a full green circle: an absent
 * record is a failure, not a pass, and a fleet nobody has entered dates for
 * would otherwise be the most reassuring picture in the app shown to the most
 * exposed carrier on it.
 */
export const TONE_FOR_BUCKET: Record<HealthKey, RingTone> = {
  overdue: 'act',
  soon: 'soon',
  unknown: 'nodate',
  ontrack: 'ok',
}

/**
 * One unit's ring.
 *
 * Extends `DqRing` so the same `Ring.astro` draws it with no second component
 * and no new prop — the arcs, the fraction in the middle and the legend are all
 * computed by dq-rings.ts from these fields.
 */
export interface TruckRing extends DqRing {
  /** Power units and trailers owe different things. See `truckRing`. */
  kind: TruckKind
  /**
   * Real duties with no schedule anybody can compute — the 'Check yourself'
   * rows, like the CHP's terminal visit. NOT in the circle and not in `total`:
   * they are not overdue, not on track, and have no date to be missing. Carried
   * out so the page can declare them instead of quietly shrinking the
   * denominator, which is `buildHealth`'s own reason for returning them.
   */
  noSchedule: number
}

const SLICE_ORDER: readonly { key: HealthKey; label: string }[] = [
  // Worst first from twelve o'clock, and the labels are the driver ring's,
  // word for word. Same order, same words, so an owner who has learned to read
  // one has learned to read the other.
  { key: 'overdue', label: 'to fix' },
  { key: 'soon', label: 'due soon' },
  { key: 'unknown', label: 'no date' },
  { key: 'ontrack', label: 'on file' },
]

/**
 * Build one unit's ring from the rule engine's own output.
 *
 * `kind` is not decoration: it is the filter. A TRAILER HAS NO ENGINE, so it
 * owes no Clean Truck Check, no Form 2290 and no fuel tax, and the catalogue
 * already says so — two rules carry `subject: 'trailer'` against nine for a
 * power unit. Scored against a power unit's list a trailer would sit at 2/9 and
 * draw permanent red on equipment that is entirely in order, which is the same
 * mistake as asking for mileage on a thing with no engine.
 *
 * So the denominator is whatever the engine handed this unit, and the filter
 * here is belt and braces: even if a caller passes the whole fleet's items, a
 * trailer is only ever judged against trailer obligations. There is no
 * per-kind checklist written in this file, because a second checklist is how
 * the two drift apart.
 */
export function truckRing(
  items: readonly DeadlineItem[],
  kind: TruckKind,
  observedAt: Date,
): TruckRing {
  const mine = items.filter((i) => i.subjectType === kind)
  const health = buildHealth(
    mine.map((i) => ({ standing: i.status.standing, daysUntil: i.daysUntil })),
  )

  const count = (key: HealthKey) => health.buckets.find((b) => b.key === key)?.count ?? 0
  const actNow = count('overdue')
  const noDate = count('unknown')

  return {
    kind,
    onFile: health.onTrack,
    dueSoon: count('soon'),
    // Overdue plus undated, and deliberately NOT `health.needsAttention`, which
    // counts the amber bucket too. This is the driver ring's `attention` — the
    // gaps — and `dueSoon` is carried beside it so the sentence can name both
    // without adding them together.
    attention: actNow + noDate,
    actNow,
    noDate,
    total: health.total,
    noSchedule: health.unschedulable,
    observedAt,
    slices: SLICE_ORDER.map(
      (s): RingSlice => ({ tone: TONE_FOR_BUCKET[s.key], count: count(s.key), label: s.label }),
    ),
  }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** 'truck', 'trailer', or 'unit' when a list holds both. Never 'truck' for a trailer. */
function nounFor(kinds: readonly TruckKind[], n: number): string {
  const trailers = kinds.filter((k) => k === 'trailer').length
  if (trailers === 0) return plural(n, 'truck', 'trucks')
  if (trailers === kinds.length) return plural(n, 'trailer', 'trailers')
  return plural(n, 'unit', 'units')
}

/**
 * The sentence one unit's figure leads with.
 *
 * It labels the answer, not the chart. "2 of 8 items need work" is what he came
 * for; "vehicle compliance" is what the chart would be called, and nobody needs
 * that. It never says the truck may roll and never uses a word that could be
 * read that way — it reports what is on file and what is not, and stops.
 */
export function truckLine(ring: TruckRing): string {
  if (!(ring.total > 0)) return 'Nothing is tracked for this unit yet.'

  if (ring.attention > 0) {
    const what = plural(ring.attention, 'item needs', 'items need')
    return `${ring.attention} of ${ring.total} ${what} work.`
  }
  if (ring.dueSoon > 0) {
    const what = plural(ring.dueSoon, 'is', 'are')
    return `All ${ring.total} items are on file. ${ring.dueSoon} ${what} due soon.`
  }
  return `All ${ring.total} items are on file.`
}

/**
 * Under the ring on the detail page: what the circle counts, in the unit's own
 * terms, so the denominator is never a number he has to take on trust.
 */
export function ringSubtitle(ring: TruckRing): string {
  const noun = ring.kind === 'trailer' ? 'trailer' : 'truck'
  if (!(ring.total > 0)) return `No dated obligation is tracked for this ${noun} yet`
  return `The ${ring.total} ${plural(ring.total, 'deadline', 'deadlines')} we track for this ${noun}`
}

/**
 * Why a trailer's circle is smaller, said once and in the same words on both
 * screens.
 *
 * Without this the owner reads 2/2 beside 8/8 and concludes the trailer is
 * half-entered. The opposite is true, and the reason is physical: the rules a
 * trailer is missing are the ones that need an engine.
 */
export const TRAILER_NOTE =
  'A trailer has no engine, so it owes fewer things: no Clean Truck Check, no Form 2290, no ' +
  'fuel tax. Its circle is smaller because its list is shorter.'

/** The caveat every one of these rings carries. Nobody here has seen the paper. */
export const COVERAGE_NOTE =
  'Counted from the dates you typed in. Nobody here has looked at the truck or the paper.'

/** The duties with no schedule, named rather than silently left out of the circle. */
export function noScheduleNote(ring: TruckRing): string | undefined {
  if (ring.noSchedule <= 0) return undefined
  const what = plural(ring.noSchedule, 'duty has', 'duties have')
  const it = plural(ring.noSchedule, 'it', 'them')
  return `${ring.noSchedule} more ${what} no date anyone can work out, so the circle leaves ${it} out.`
}

/**
 * The sentence above the fleet table. The owner's example, near enough word for
 * word: "3 trucks have something overdue" beats "vehicle compliance".
 *
 * Both gap buckets are named. Saying only "overdue" would hide the trucks whose
 * dates nobody has entered, which is the half he is most exposed on.
 */
export function fleetLine(rings: readonly TruckRing[]): string {
  const n = rings.length
  if (n === 0) return ''

  const kinds = rings.map((r) => r.kind)
  const withGaps = rings.filter((r) => r.attention > 0).length
  if (withGaps > 0) {
    const has = plural(withGaps, 'has', 'have')
    return `${withGaps} of ${n} ${nounFor(kinds, n)} ${has} something overdue or missing a date.`
  }

  const soon = rings.filter((r) => r.dueSoon > 0).length
  if (soon > 0) {
    const has = plural(soon, 'has a date', 'have dates')
    return `No gaps. ${soon} of ${n} ${nounFor(kinds, n)} ${has} coming up.`
  }

  return `No gaps in ${n === 1 ? `this ${nounFor(kinds, 1)}` : `these ${n} ${nounFor(kinds, n)}`}.`
}

/** The line beside a unit number on the fleet table. The driver roster's, reused. */
export { rowLine }
