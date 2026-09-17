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
 *
 * WHY EACH WEEK IS SPLIT IN TWO.
 *
 * Height alone says how many, not how urgent. A week holding four renewals due
 * inside `SOON_DAYS` and a week holding four due at the far end of the quarter
 * drew as the same column, so the crunch — the week he has to act on now — was
 * only findable by reading the dates off the list underneath. Each week is
 * therefore counted twice over: `soon` (inside the window) and `later`, and the
 * component stacks amber on green.
 *
 * TWO COLOURS, NOT THREE. There is no red segment on any week here. Red means
 * overdue in this app, an overdue item has no future date to place, and it is
 * already drawn in the block at the left edge. A second urgency threshold — "due
 * in a week is different from due in a month" — would also contradict the single
 * `SOON_DAYS` line the tiles, the health ring and this chart all share, so the
 * split uses that line and only that line.
 */
import type { Standing } from '../rules/compute.ts'
import { SOON_DAYS } from '../rules/index.ts'
import { type Bucket, utcDay, weekBuckets } from './scale.ts'

const MS_DAY = 86_400_000

export interface RunwayItem {
  standing: Standing
  nextDue?: Date
}

export interface RunwayWeek extends Bucket {
  /** Everything placed in this week: `soon + later`. The height of the column. */
  count: number
  /**
   * Due inside `soonDays` — the amber part of the column.
   *
   * Amber sits on TOP of green in the stack, so the urgent part of a heavy week
   * is the part at eye level against the white above the chart.
   */
  soon: number
  /** Dated further out than `soonDays` — the green part, under the amber. */
  later: number
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
  /**
   * Done, with nothing further due — a one-time obligation already satisfied.
   *
   * Counted rather than dropped so that `not_applicable` stays the ONE thing
   * that legitimately vanishes from this chart, and never drawn, because there
   * is no date to place and nothing for him to do. It is the only field here
   * that is not a call on his attention.
   */
  settled: number
  /** Dated, but past the end of the horizon. */
  beyond: number
  /** Real obligations with no computable schedule. Counted so the caption can say so. */
  unschedulable: number
  /** Items actually drawn on the weeks. `soon + later`. */
  scheduled: number
  /** Of the drawn items, the ones due inside `soonDays`. The amber total. */
  soon: number
  /** Of the drawn items, the ones dated further out than that. The green total. */
  later: number
  /**
   * The window `soon` was measured against, carried so the legend can print the
   * number in words instead of importing the rules engine to say "45 days".
   */
  soonDays: number
  /** Count the tallest column represents. Never below 1, so the axis divides. */
  max: number
  /** The busiest week, only when it holds more than one item. */
  peak: RunwayWeek | null
  horizonWeeks: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Is a countdown inside the window? BOTH SIDES OF ZERO, every time.
 *
 * Exported, and a named function rather than one inline comparison, because
 * this is the fourth place in the codebase that has had to ask it and the first
 * three all got it wrong in the same way. The dashboard's due-soon tile, the
 * qualification binder's "Expires soon" pill and the health ring each shipped
 * `days <= SOON_DAYS` on its own — and EVERY NEGATIVE NUMBER PASSES THAT. A
 * pre-employment Clearinghouse query run the week the driver was hired comes
 * back with a countdown like -2040, so twenty things finished years ago sat
 * under a heading reading "Due in 45 days". The window has a near edge as well
 * as a far one.
 *
 * It is deliberately a question about DAYS ALONE, which is why every caller has
 * to settle `standing` first. Days alone cannot answer "is this handled": an
 * overdue ROLLING rule can carry a POSITIVE countdown — last done five months
 * ago, so past due, while the next occurrence computes to sixteen days out — and
 * this function would call that "due soon" quite correctly and be drawing a debt
 * as a plan. In `buildRunway` the `overdue` arm takes those before the loop ever
 * reaches here.
 */
export function isDueSoon(days: number, soonDays = SOON_DAYS): boolean {
  return days >= 0 && days <= soonDays
}

/**
 * Bucket a carrier's deadlines into weeks ahead.
 *
 * `horizonWeeks` defaults to 13 — one quarter, and the widest axis that still
 * gives each column a thumb's width on a 320px screen. Beyond that the columns
 * become stripes and the chart stops being readable at exactly the size it is
 * most often read.
 *
 * `soonDays` is a parameter only so the tests can pin the boundary, exactly as
 * in `buildHealth`; every caller passes the app's one value.
 */
export function buildRunway(
  items: readonly RunwayItem[],
  today: Date,
  horizonWeeks = 13,
  soonDays = SOON_DAYS,
): Runway {
  const weeks: RunwayWeek[] = weekBuckets(today, horizonWeeks).map((b, i, all) => ({
    ...b,
    count: 0,
    soon: 0,
    later: 0,
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
  let settled = 0
  let beyond = 0
  let unschedulable = 0
  let scheduled = 0
  let soonTotal = 0
  let laterTotal = 0

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
    if (item.standing === 'current' && !item.nextDue) {
      // DONE IS NOT UNDATED, and this arm exists only to keep those two apart.
      //
      // A one-time obligation that has been satisfied — the road test, the
      // hire-time MVR — has no next occurrence, so `status` returns no date for
      // it. Without this it would fall into `undated` one line below and be
      // drawn in the block at the left edge of the axis, which this file's own
      // header calls the first thing on the chart. Eighteen finished items
      // would be stacked there beside the real gaps, under a caption reading
      // "have no date yet".
      //
      // Before `status` stopped inventing a due date it was worse: the hire
      // date came back as `nextDue`, landed in the `t < day` arm below, and was
      // counted OVERDUE. The chart that exists so a bad month cannot hide was
      // reporting completed paperwork as past due.
      //
      // `unknown` is checked after this and is unaffected: it never reaches
      // here, because its own arm takes it whether or not it carries a date.
      settled++
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
      // Asked about DAYS, but only after `standing` has already decided — see
      // `isDueSoon`, and note that the `overdue` arm at the top of this loop is
      // what keeps this line from ever seeing a past-due item that happens to
      // have a positive countdown.
      const days = Math.round((t - day.getTime()) / MS_DAY)
      if (isDueSoon(days, soonDays)) {
        w.soon++
        soonTotal++
      } else {
        w.later++
        laterTotal++
      }
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
    settled,
    beyond,
    unschedulable,
    scheduled,
    soon: soonTotal,
    later: laterTotal,
    soonDays,
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
