/**
 * The compliance runway: where the next ninety days get heavy.
 *
 * The dashboard already answers "what is wrong right now". It cannot answer the
 * question an owner asks in the same breath — "and when does the next pile
 * land" — because that answer is a shape, and a list sorted by date is a shape
 * you can only see by reading forty rows and holding them in your head. Four
 * renewals falling in the same week in November is a bad week whether or not
 * any single one of them is alarming on its own, and it is invisible until it
 * is drawn.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID.
 *
 * A timeline of upcoming dates can only plot items that HAVE a date. An overdue
 * medical card has no future date. Neither does one whose expiry nobody has
 * entered — and on day one that is most of them. Draw only the future and a
 * carrier with eleven expired documents and thirty undated ones gets a calm,
 * nearly empty runway: the single most reassuring screen in the app, shown to
 * the single most exposed carrier on it.
 *
 * So the unplaceable items are counted, returned alongside the weeks, and the
 * component renders them as a block at the left edge of the same axis. They are
 * not a footnote to the chart. They are the first thing on it.
 */
import type { Standing } from '../rules/compute.ts'
import { type Bucket, utcDay, weekBuckets } from './scale.ts'

export interface RunwayItem {
  standing: Standing
  nextDue?: Date
}

export interface RunwayWeek extends Bucket {
  count: number
  /** Set on the first week of each new month, so the axis can be labelled. */
  monthLabel: string | null
  isCurrent: boolean
}

export interface Runway {
  weeks: RunwayWeek[]
  /** Past due. No future date to place, and the reason he opened the app. */
  overdue: number
  /** No date at all — same exposure as overdue, per the ranking in rules/index.ts. */
  undated: number
  /** Dated, but past the end of the horizon. */
  beyond: number
  /** Real obligations with no computable schedule. Counted so the caption can say so. */
  unschedulable: number
  /** Items actually drawn on the weeks. */
  scheduled: number
  /** Count the tallest column represents. Never below 1, so the axis divides. */
  max: number
  /** The busiest week, only when it holds more than one item. */
  peak: RunwayWeek | null
  horizonWeeks: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Bucket a carrier's deadlines into weeks ahead.
 *
 * `horizonWeeks` defaults to 13 — one quarter, and the widest axis that still
 * gives each column a thumb's width on a 320px screen. Beyond that the columns
 * become stripes and the chart stops being readable at exactly the size it is
 * most often read.
 */
export function buildRunway(items: readonly RunwayItem[], today: Date, horizonWeeks = 13): Runway {
  const weeks: RunwayWeek[] = weekBuckets(today, horizonWeeks).map((b, i, all) => ({
    ...b,
    count: 0,
    monthLabel:
      i === 0 || b.start.getUTCMonth() !== all[i - 1].start.getUTCMonth()
        ? MONTHS[b.start.getUTCMonth()]
        : null,
    isCurrent: i === 0,
  }))

  const day = utcDay(today)
  const horizonEnd = weeks.length > 0 ? weeks[weeks.length - 1].end.getTime() : day.getTime()

  let overdue = 0
  let undated = 0
  let beyond = 0
  let unschedulable = 0
  let scheduled = 0

  for (const item of items) {
    if (item.standing === 'not_applicable') continue
    if (item.standing === 'unsupported') {
      unschedulable++
      continue
    }
    if (item.standing === 'overdue') {
      overdue++
      continue
    }
    if (item.standing === 'unknown' || !item.nextDue) {
      // `unknown` lands here even when it carries a nextDue, and that is
      // deliberate. A rule can compute when the next inspection is owed while
      // having no idea whether the last one ever happened; plotting that date
      // on the runway would draw an obligation as handled-and-scheduled on the
      // strength of a date we derived rather than one he gave us.
      undated++
      continue
    }
    const t = utcDay(item.nextDue).getTime()
    if (t < day.getTime()) {
      // A future-dated standing with a past date should not exist, but if the
      // engine ever produces one it is counted as a problem rather than
      // dropped. A silently discarded deadline is the worst outcome available.
      overdue++
      continue
    }
    if (t >= horizonEnd) {
      beyond++
      continue
    }
    const w = weeks.find((b) => t >= b.start.getTime() && t < b.end.getTime())
    if (w) {
      w.count++
      scheduled++
    } else {
      beyond++
    }
  }

  const maxCount = weeks.reduce((m, w) => Math.max(m, w.count), 0)
  const peakWeek = weeks.find((w) => w.count === maxCount)

  return {
    weeks,
    overdue,
    undated,
    beyond,
    unschedulable,
    scheduled,
    // Floored at 3, and the floor is a readability decision rather than an
    // arithmetic one. Scaled to a maximum of 1, the single renewal a quiet
    // carrier has all quarter draws as a full-height column — the tallest thing
    // this chart can produce, shown to the fleet with the least to do. Height
    // has to encode "how heavy", so the lightest real week must look light.
    // Every column prints its own count above it, so nothing is hidden by this.
    max: Math.max(3, maxCount),
    // One item in one week is not a "heaviest week", it is a Tuesday. Claiming
    // it is teaches him to ignore the sentence when it eventually matters.
    peak: maxCount >= 2 && peakWeek ? peakWeek : null,
    horizonWeeks,
  }
}

/** 'Oct 12–18' — the span a week covers, as a person would write it. */
export function weekRangeLabel(week: Bucket): string {
  const start = week.start
  const end = new Date(week.end.getTime() - 86_400_000)
  const a = `${MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}`
  const b =
    start.getUTCMonth() === end.getUTCMonth()
      ? `${end.getUTCDate()}`
      : `${MONTHS[end.getUTCMonth()]} ${end.getUTCDate()}`
  return `${a}–${b}`
}
