/**
 * Where the fleet stands TODAY, in four buckets, for the ring on the dashboard.
 *
 * The runway next to it answers "when does the next pile land". This answers
 * the other half of the same morning: "how much of my fleet is a problem right
 * now". A list sorted by date can only answer that by being counted, and an
 * owner standing next to a truck does not count forty rows.
 *
 * THE FOUR BUCKETS ARE THE STANDINGS, NOT A NEW VOCABULARY.
 *
 *   red    overdue          act now
 *   grey   missing a date   we have no date to judge this by
 *   amber  due soon         inside SOON_DAYS
 *   green  on track         dated, and further out than that
 *
 * In that order, which is `STANDING_RANK` in src/lib/rules/index.ts: grey sits
 * second, WITH overdue, because not knowing when a medical card expires carries
 * the same exposure as it having expired. The ring may never quietly promote a
 * missing date into the green arc, and it may never drop it — a fleet whose
 * dates nobody has entered would then draw as a clean green circle, which is
 * the most reassuring picture in the app shown to the most exposed carrier on
 * it. Same trap `buildRunway` exists to avoid, one screen further up.
 *
 * WHAT "NEEDS ATTENTION" MEANS, defined once, here, and printed in the middle
 * of the ring: everything that is NOT on track. Overdue plus missing a date
 * plus due soon. Green is the only bucket with nothing for him to do, so it is
 * the only one the number leaves out — and drawing it that way means the
 * coloured part of the ring and the number in the hole are the same fact. If
 * the centre counted only red and grey, the amber arc would be painted as a
 * problem and excluded from the problem count, and the shape would be arguing
 * with the number it is wrapped around.
 *
 * It is a COUNT, not a score. The three parts sit beside it on the screen as
 * their own tappable numbers, and the sentence under the ring prints the
 * addition, because a number an owner cannot take apart is a number he cannot
 * defend to a broker who quotes it back at him.
 */
import type { Standing } from '../rules/compute.ts'
import { SOON_DAYS } from '../rules/index.ts'
import { MIN_VISIBLE_PERCENT } from './scale.ts'
import type { Tone } from './tones.ts'

/** A dashboard filter view, or `null` for the bucket that has nothing to do. */
export type HealthView = 'overdue' | 'unknown' | 'soon' | null

export type HealthKey = 'overdue' | 'unknown' | 'soon' | 'ontrack'

/**
 * One thing with a deadline: a rule's `Status`, or one of the owner's own
 * reminders. Both carry the same standing vocabulary, so both are counted —
 * see below for why leaving reminders out would break the screen.
 */
export interface HealthInput {
  standing: Standing
  /** Days until the next date. Negative when past. Undefined when there is none. */
  daysUntil?: number
}

export interface HealthBucket {
  key: HealthKey
  /** The word printed beside the number. Short: this is read on a phone, in a yard. */
  label: string
  count: number
  tone: Tone
  /** Where tapping it filters to. `null` on `ontrack` — there is nothing to go and see. */
  view: HealthView
}

export interface Health {
  /** Always four, always in rank order, empty ones included. */
  buckets: readonly HealthBucket[]
  /** The four buckets added up. Never the whole list — see `unschedulable`. */
  total: number
  /** Not on track: overdue + missing a date + due soon. The number in the hole. */
  needsAttention: number
  onTrack: number
  /**
   * Real duties with no schedule anyone can compute — the 'Check yourself'
   * rows. NOT a bucket and NOT counted in `total`: they are not overdue, they
   * are not on track, and they have no date to be missing. Returned so the
   * figure can declare them, the way `buildRunway` returns its own.
   */
  unschedulable: number
}

/**
 * Bucket a carrier's obligations.
 *
 * `soonDays` is a parameter only so the tests can pin the boundary; every
 * caller passes the app's one value.
 */
export function buildHealth(items: readonly HealthInput[], soonDays = SOON_DAYS): Health {
  let overdue = 0
  let unknown = 0
  let soon = 0
  let ontrack = 0
  let unschedulable = 0

  for (const item of items) {
    // Dropped before it reaches any screen, but counted nowhere if it ever does.
    if (item.standing === 'not_applicable') continue
    if (item.standing === 'unsupported') {
      unschedulable++
      continue
    }
    if (item.standing === 'overdue') {
      overdue++
      continue
    }
    if (item.standing === 'unknown') {
      // `unknown` lands here even when it still carries a date, exactly as in
      // `buildRunway`. A rule can work out when the next IFTA quarter closes
      // while having no record that the last one was ever filed; counting that
      // as on-track would draw a debt as a plan.
      unknown++
      continue
    }
    // `current` from here. Undated-but-current should not exist; if it ever
    // does it belongs with the far end rather than inventing urgency.
    //
    // A NEGATIVE `daysUntil` IS NOT "COMING UP". It is a one-time obligation
    // already satisfied — a pre-employment Clearinghouse query run the week the
    // driver was hired returns `current` with something like -2040. `<= soonDays`
    // alone is true for that, so twenty finished items sat in the amber arc
    // under a label reading "Due in 45 days". The same shape of bug appeared
    // twice more today: in the qualification binder, where it printed "Expires
    // soon" forever on a clean file, and in the dashboard's own filter. If you
    // are comparing `daysUntil` to a window, ask whether the past passes it.
    const days = item.daysUntil ?? Number.POSITIVE_INFINITY
    if (days >= 0 && days <= soonDays) soon++
    else ontrack++
  }

  const buckets: HealthBucket[] = [
    { key: 'overdue', label: 'Overdue', count: overdue, tone: 'overdue', view: 'overdue' },
    { key: 'unknown', label: 'Missing a date', count: unknown, tone: 'neutral', view: 'unknown' },
    { key: 'soon', label: `Due in ${soonDays} days`, count: soon, tone: 'soon', view: 'soon' },
    { key: 'ontrack', label: 'On track', count: ontrack, tone: 'good', view: null },
  ]

  return {
    buckets,
    total: overdue + unknown + soon + ontrack,
    needsAttention: overdue + unknown + soon,
    onTrack: ontrack,
    unschedulable,
  }
}

/** The parts the centre number is made of, empty ones dropped. */
export function attentionParts(health: Health): readonly HealthBucket[] {
  return health.buckets.filter((b) => b.key !== 'ontrack' && b.count > 0)
}

/**
 * The figure's title: the answer, not the name of the chart.
 *
 * "21 need attention" is a thing an owner can act on before he has finished
 * reading it. "Deadline distribution" is a thing he has to decode first.
 */
export function healthHeadline(health: Health): string {
  if (health.total === 0) return 'Nothing tracked yet'
  if (health.needsAttention === 0) return 'Nothing needs attention'
  return `${health.needsAttention} need${health.needsAttention === 1 ? 's' : ''} attention`
}

// ----------------------------------------------------------------- the ring

export interface DonutSlice {
  key: HealthKey
  label: string
  tone: Tone
  count: number
  /** Share of the ring, 0-100. The live slices sum to exactly 100. */
  percent: number
  /** Where the arc starts, 0-100, clockwise from twelve o'clock. */
  offset: number
}

/**
 * Lay the buckets out around the ring.
 *
 * Two rules, and both are the same rule the bar charts follow:
 *
 * 1. A bucket with nothing in it draws nothing. A zero-width arc is not a
 *    finding, and four hairlines of every colour on every screen would make the
 *    colours mean nothing.
 *
 * 2. A bucket with something in it is never an invisible sliver.
 *    `MIN_VISIBLE_PERCENT` is the floor, same constant as `widthPercent`, for
 *    the same reason: one expired medical card in a fleet of four hundred
 *    deadlines is 0.25% of the ring — a sub-pixel the browser rounds away — and
 *    "a little" against "none" is the entire question the ring is being asked.
 *
 * The width the floor takes is repaid by the slices that are ABOVE the floor,
 * in proportion, so the ring still closes at exactly 100 and no real slice is
 * pushed back under the floor to pay for another one.
 */
export function donutSlices(health: Health): DonutSlice[] {
  const live = health.buckets.filter((b) => b.count > 0)
  if (live.length === 0 || health.total <= 0) return []

  const raw = live.map((b) => (b.count / health.total) * 100)
  const floored = raw.map((p) => Math.max(MIN_VISIBLE_PERCENT, p))
  const excess = floored.reduce((n, p) => n + p, 0) - 100

  let percents = floored
  if (excess > 1e-9) {
    // Only the slices that were NOT floored can give width back; taking it from
    // a floored one would undo rule 2 on the exact slice it exists to protect.
    const room = floored.reduce(
      (n, p, i) => n + (raw[i] > MIN_VISIBLE_PERCENT ? p - MIN_VISIBLE_PERCENT : 0),
      0,
    )
    percents =
      room > 1e-9
        ? floored.map((p, i) =>
            raw[i] > MIN_VISIBLE_PERCENT ? p - excess * ((p - MIN_VISIBLE_PERCENT) / room) : p,
          )
        : // Unreachable with four buckets — four floors is 6% of a ring that has
          // to add to 100 — but a ring that does not close is a drawing bug, so
          // the fallback scales everything rather than trusting the arithmetic.
          floored.map((p) => (p / (excess + 100)) * 100)
  }

  let offset = 0
  return live.map((b, i) => {
    // The last arc is measured back from 100 rather than added forward, so
    // floating point cannot leave a hairline gap at twelve o'clock that reads
    // as a fifth, unlabelled bucket.
    const percent = i === live.length - 1 ? 100 - offset : percents[i]
    const slice: DonutSlice = {
      key: b.key,
      label: b.label,
      tone: b.tone,
      count: b.count,
      percent,
      offset,
    }
    offset += percent
    return slice
  })
}

/**
 * Ring colours, as SVG strokes.
 *
 * These belong in `tones.ts` beside the `bar` and `swatch` classes and are not
 * there because that file was held by another agent while this was written.
 * Fold them in: same five keys, one more field on `ToneStyle`.
 *
 * `neutral` is a SOLID grey arc here, not the hatched `UNKNOWN_SLOT` the bar
 * charts give an absent value. On a bar chart the hatch says "there is no
 * measurement here". On a ring, an unfilled gap says "the total is smaller than
 * you think" — the missing dates would read as nothing at all, which is the one
 * reading this chart must never allow. Grey is drawn, counted, and never green.
 */
export const DONUT_STROKE: Record<Tone, string> = {
  brand: 'stroke-brand-500',
  overdue: 'stroke-red-500',
  soon: 'stroke-amber-500',
  good: 'stroke-emerald-500',
  neutral: 'stroke-ink-300',
}
