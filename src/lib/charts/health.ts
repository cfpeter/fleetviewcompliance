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
 * RANK IS NOT THE HEADLINE. Grey sitting second in that list is about where a
 * row is SORTED and how loudly it is drawn — it is not an instruction to add it
 * into the number in the middle of the ring. The next paragraph is that number,
 * and the two are different questions.
 *
 * WHAT "NEEDS ATTENTION" MEANS, defined once, here, and printed in the middle
 * of the ring: OVERDUE PLUS DUE SOON. Those two and nothing else — a date that
 * has passed, and a date that is about to. Both are things he can pick up the
 * phone about this morning.
 *
 * A MISSING DATE IS NOT IN THAT NUMBER, and the size of the difference is the
 * whole reason. A real fleet on this app reads 141 grey, red and amber rows, of
 * which 119 are grey — items where nobody has typed a date in yet — and 22 are
 * genuinely late or nearly late. "141 need attention" is not a harder version
 * of the truth, it is a different claim: it says 141 documents are in trouble
 * when 22 are, and it says it in the biggest type on the owner's dashboard and
 * on the page a broker opens. An owner who reads it and finds 119 of them are
 * blanks learns that this number is theatre, and then he does not read the 22
 * either.
 *
 * AND GREY IS NOT SOFTENED, HIDDEN, OR FOLDED INTO GREEN. It keeps its own arc,
 * its own count, its own tile, and it is carried on `Health.missing` so every
 * screen can say it in words. A missing date is not a pass and it never draws
 * as one — a fleet whose dates nobody has entered must never render as a clean
 * green circle, which is the most reassuring picture in the app shown to the
 * most exposed carrier on it. It simply stops being counted as a deadline in
 * trouble, because it is not one. It is a question we have not asked him yet.
 *
 * So the ring has two statements under it, not one:
 *
 *   `healthMath`    the addition behind the centre number, and the running
 *                   total that puts needs-attention, missing and on-track back
 *                   together at `total`, so nothing is quietly dropped
 *   `missingLine`   the grey count in plain words, next to the headline
 *
 * The centre number is a COUNT, not a score. The parts sit beside it on the
 * screen as their own numbers and the sentence under it prints the addition,
 * because a number an owner cannot take apart is a number he cannot defend to a
 * broker who quotes it back at him.
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
  /**
   * Overdue + due soon. The number in the hole, and nothing else goes in it.
   *
   * A date nobody has typed in yet is NOT a deadline in trouble, so it is not
   * here — it is on `missing`, which every screen showing this number also has
   * to show. See the note at the top of the file.
   */
  needsAttention: number
  /**
   * No date on file. Grey.
   *
   * Its own field for the same reason it is its own arc: it is never added into
   * `needsAttention`, never added into `onTrack`, and never left off a screen.
   * `needsAttention + missing + onTrack === total`, always, and `healthMath`
   * prints exactly that addition.
   */
  missing: number
  onTrack: number
  /**
   * The window `soon` was measured against, carried so a component can print
   * "45 days" without importing the rules engine. Same field, same reason, as
   * `Runway.soonDays`.
   */
  soonDays: number
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
    // Overdue + due soon. NOT `unknown` — see the note at the top of the file.
    // The one change most likely to be undone by a future edit that reads the
    // ring and thinks the centre number should be the coloured part of it.
    needsAttention: overdue + soon,
    missing: unknown,
    onTrack: ontrack,
    soonDays,
    unschedulable,
  }
}

/** The two buckets the centre number is made of, empty ones dropped. */
export function attentionParts(health: Health): readonly HealthBucket[] {
  return health.buckets.filter((b) => (b.key === 'overdue' || b.key === 'soon') && b.count > 0)
}

/**
 * Everything that is not on track: overdue, missing a date, due soon.
 *
 * NOT the centre number, and it must never be printed as one. This is for the
 * lists that rank records by how much work they carry — "who do I call first" —
 * where a driver with nine blank dates and nothing overdue is absolutely
 * somebody to open, and dropping him because his nine are grey would hide the
 * exact rows the grey arc exists to keep visible.
 */
export function openParts(health: Health): readonly HealthBucket[] {
  return health.buckets.filter((b) => b.key !== 'ontrack' && b.count > 0)
}

/** `openParts` added up: everything with something still to do about it. */
export function openCount(health: Health): number {
  return health.total - health.onTrack
}

/**
 * The figure's title: the answer, not the name of the chart.
 *
 * "22 need attention" is a thing an owner can act on before he has finished
 * reading it. "Deadline distribution" is a thing he has to decode first.
 *
 * THE ONE CASE THAT IS NOT ALLOWED TO SAY "NOTHING NEEDS ATTENTION": a carrier
 * on his first week has nothing overdue and nothing due soon, because nobody
 * has typed a date in yet, so `needsAttention` is 0 and every one of his items
 * is grey. "Nothing needs attention" over 119 blanks is the most reassuring
 * sentence in the app shown to the carrier who has told us the least. So when
 * the only thing standing is missing dates, the headline says that instead.
 */
export function healthHeadline(health: Health): string {
  if (health.total === 0) return 'Nothing tracked yet'
  if (health.needsAttention > 0) {
    return `${health.needsAttention} need${health.needsAttention === 1 ? 's' : ''} attention`
  }
  if (health.missing > 0) {
    return `${health.missing} date${health.missing === 1 ? ' is' : 's are'} missing`
  }
  return 'Nothing needs attention'
}

/**
 * The grey count, in words, beside the headline.
 *
 * The tile already prints the number and the arc already draws it. This is the
 * sentence, because a number in a box is a thing an owner scans past and a
 * sentence is a thing he reads — and the one reading this has to produce is "we
 * are missing dates FROM ME", not "some items are grey".
 *
 * Two audiences, one fact. The owner is the person who can fix it, so he is
 * told what to do about it. The broker cannot fix anything and is not being
 * asked to; he is told what the grey does NOT mean, which is the only thing he
 * could get wrong. Neither wording softens it and neither one is optional: this
 * line is rendered wherever `missing > 0`, on both pages.
 */
export function missingLine(health: Health, reader: 'owner' | 'visitor'): string | null {
  const n = health.missing
  if (n === 0) return null
  const dates = n === 1 ? 'date' : 'dates'
  return reader === 'owner'
    ? `We are missing ${n} ${dates} from you. Until we have ${n === 1 ? 'it' : 'them'}, we cannot tell you if ${n === 1 ? 'that item is' : 'those items are'} OK.`
    : `${n} ${dates} ${n === 1 ? 'is' : 'are'} not on file. Not on file is not the same as OK.`
}

/**
 * The arithmetic under the ring, as one sentence, for BOTH pages.
 *
 * One function rather than two pieces of markup, because the owner's dashboard
 * and the broker's page print the same number and a broker quotes it back down
 * the phone. Two hand-written versions of this sentence is how the two screens
 * come to disagree about the same carrier on the same afternoon.
 *
 * It does two jobs. It shows what the centre number is made of — a score is a
 * number you cannot take apart, and this product does not print scores. And it
 * closes the books: the last clause adds needs-attention, missing and on-track
 * back up to `total`, so a reader can see that nothing was quietly left out of
 * the picture. That clause is why `missing` can be lifted out of the headline
 * without disappearing from the page.
 */
export function healthMath(health: Health): string {
  if (health.total === 0) return 'Nothing is tracked yet.'

  const { needsAttention, missing, onTrack, total, soonDays } = health
  const parts = attentionParts(health)
  const said: string[] = []

  if (parts.length > 1) {
    said.push(
      `${parts.map((p) => `${p.count} ${p.label.toLowerCase()}`).join(' + ')} = ${needsAttention} need attention.`,
    )
  } else if (parts.length === 1) {
    // One part adds up to itself, and "9 overdue = 9" reads as a mistake.
    said.push(
      `${needsAttention} need${needsAttention === 1 ? 's' : ''} attention, and ${needsAttention === 1 ? 'it is' : 'they are all'} ${parts[0].label.toLowerCase()}.`,
    )
  } else {
    said.push(`Nothing is overdue and nothing is due in the next ${soonDays} days.`)
  }

  if (missing > 0) {
    said.push(
      `${missing} ${missing === 1 ? 'has' : 'have'} no date on file. We cannot say ${missing === 1 ? 'it is' : 'they are'} OK.`,
    )
  }
  if (onTrack > 0) {
    said.push(`${onTrack} ${onTrack === 1 ? 'is' : 'are'} on track.`)
  }

  // The books, closed. Printed as an addition whenever there is one to print,
  // so the reader checks it rather than trusting it.
  const tally = [needsAttention, missing, onTrack].filter((n) => n > 0)
  said.push(
    tally.length > 1
      ? `${tally.join(' + ')} = ${total} items we track.`
      : `That is every one of the ${total} we track.`,
  )

  return said.join(' ')
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
