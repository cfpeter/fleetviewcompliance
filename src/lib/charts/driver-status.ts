/**
 * How one driver's obligations read as a checklist, and how a whole roster
 * reads as one bar.
 *
 * THIS FILE INVENTS NO STATE AND NO COLOUR.
 *
 * The four tones are the ones already on every other screen — `standingPill` in
 * src/lib/rules/index.ts, `TONES` in ./tones.ts, `RING_TONES` in ./dq-rings.ts.
 * Red is act now, amber is a date inside the window, green is dated and further
 * out, grey is "we hold no date". A fifth, blue, is the app's existing
 * `unsupported`: a duty with no schedule anybody can compute, which is not on
 * the urgency scale at all and must not borrow amber to look like it is.
 *
 * WHY THE PILL IS COMPUTED HERE AND NOT IN THE PAGE.
 *
 * "Overdue by N days" is the one number on the driver page that is easy to get
 * backwards, and it has been got backwards three times in this product. Two
 * traps, one on each side of zero:
 *
 *   1. An INTERVAL rule that was missed reports `overdue` while `nextDue` sits
 *      in the FUTURE — the next occurrence after the one that was missed. Count
 *      from `nextDue` and a late annual MVR prints "in 340 days".
 *   2. A ONE-TIME obligation already satisfied reports `current` with a
 *      NEGATIVE `daysUntil` — a road test passed 618 days ago comes back -618.
 *      Compare that to a window with `<= soonDays` alone and it passes, so a
 *      finished item sits in the amber "due soon" pile for the rest of the
 *      driver's employment.
 *
 * So the overdue count is taken from `lastDue` — the date it was actually due —
 * and every comparison against the window is guarded on BOTH sides of zero.
 */

import { daysBetween, toUtcMidnight } from '../rules/dates.ts'
import { DRIVER_ANCHORS } from '../rules/driver-anchors.ts'
import { carrierCeiling } from '../rules/exposure.ts'
import { type DeadlineItem, dueLine, SOON_DAYS } from '../rules/index.ts'
import { penaltyAmount } from '../rules/penalties.ts'
import type { DqRing } from './dq-rings.ts'
import type { Tone } from './tones.ts'

/**
 * act    — red: the date has passed, or the item is not held at all
 * soon   — amber: a real date, inside the window
 * nodate — grey: we hold no date, so we can say nothing
 * ok     — green: dated and further out, or a one-time duty already done
 * read   — blue: a duty with no schedule. Not urgency; a thing to go and read
 */
export type CheckTone = 'act' | 'nodate' | 'soon' | 'ok' | 'read'

/**
 * Pill and icon classes, borrowed verbatim from `standingPill` and from the
 * badges on the printed qualification file. A row that coloured a standing
 * differently from the pill for the same standing one screen away would teach
 * the owner that one of the two screens is lying to him.
 */
export const CHECK_TONES: Record<CheckTone, { pill: string; icon: string }> = {
  act: { pill: 'bg-red-100 text-red-700', icon: 'bg-red-100 text-red-700' },
  nodate: { pill: 'bg-ink-100 text-ink-500', icon: 'bg-ink-100 text-ink-500' },
  soon: { pill: 'bg-amber-100 text-amber-800', icon: 'bg-amber-100 text-amber-800' },
  ok: { pill: 'bg-emerald-100 text-emerald-800', icon: 'bg-emerald-100 text-emerald-800' },
  read: { pill: 'bg-blue-100 text-blue-800', icon: 'bg-blue-100 text-blue-800' },
}

/** Worst first. Grey sits WITH red, for the reason `STANDING_RANK` gives. */
const TONE_ORDER: Record<CheckTone, number> = { act: 0, nodate: 1, soon: 2, ok: 3, read: 4 }

/** Which tone a row draws in. The only place a standing becomes a colour. */
export function toneFor(item: DeadlineItem): CheckTone {
  switch (item.status.standing) {
    case 'overdue':
      return 'act'
    case 'unknown':
      return 'nodate'
    case 'unsupported':
      return 'read'
    case 'not_applicable':
      // Dropped by `evaluate` before it reaches a screen. Green anyway rather
      // than amber, so a row that somehow arrives here never invents urgency.
      return 'ok'
    case 'current': {
      const days = item.daysUntil
      // No next date on a `current` row is a one-time duty already satisfied.
      // It is finished, and printing it as a gap would be wrong on the packet
      // a broker reads.
      if (!item.status.nextDue || days === undefined) return 'ok'
      // BOTH SIDES OF ZERO. A negative count is the past, and the past is not
      // "coming up" — see the note at the top of this file.
      return days >= 0 && days <= SOON_DAYS ? 'soon' : 'ok'
    }
  }
}

export interface CheckPill {
  tone: CheckTone
  /** Plain words, the way a person says them. Never "29d". */
  text: string
}

/** The pill on the end of a row: how long, in words. */
export function pillFor(item: DeadlineItem, today: Date): CheckPill {
  const tone = toneFor(item)
  const s = item.status

  if (tone === 'act') {
    // `lastDue`, NOT `nextDue`. See trap 1 at the top of this file.
    const from = s.lastDue ?? s.nextDue
    if (!from) return { tone, text: 'overdue' }
    const late = daysBetween(toUtcMidnight(from), toUtcMidnight(today))
    if (late <= 0) return { tone, text: 'due today' }
    return { tone, text: `overdue ${late} ${late === 1 ? 'day' : 'days'}` }
  }

  if (tone === 'nodate') {
    // TWO WAYS TO KNOW NOTHING, AND THEY DO NOT READ THE SAME.
    //
    // With no date at all there is nothing to count from and nothing to show.
    // With a date, the schedule is one we can work out unaided — the annual MVR
    // counted from the hire date — and what is missing is any record that the
    // last cycle was ever done. Printing "no date on file" over a row whose
    // line beneath it shows a date is the pill arguing with the date under it,
    // and the reader is right to believe neither.
    return { tone, text: s.nextDue ? 'not recorded yet' : 'no date on file' }
  }
  if (tone === 'read') return { tone, text: 'check this yourself' }

  const days = item.daysUntil
  // A one-time duty that is done. It has no date because there is nothing more
  // due, which is the opposite of a date we are waiting for.
  if (!s.nextDue || days === undefined) return { tone, text: 'on file' }
  // See trap 2. A count from the past never becomes a countdown.
  if (days < 0) return { tone, text: 'on file' }
  if (days === 0) return { tone, text: 'due today' }
  if (days === 1) return { tone, text: 'due tomorrow' }
  return { tone, text: `in ${days} days` }
}

/**
 * Which date box on the page answers this row, when one does.
 *
 * `answerKey` first, because the rules engine already worked out which anchor a
 * date typed for this row must be filed under, and a page that guesses instead
 * stores the date perfectly and leaves the rule reporting "no date" forever.
 * The fallback covers rows that are overdue rather than unknown, where there is
 * no `answerKey` but the box to correct is still obvious.
 */
export function anchorForRule(item: DeadlineItem): string | undefined {
  const key = item.status.answerKey
  if (key && DRIVER_ANCHORS.some((a) => a.key === key)) return key
  return DRIVER_ANCHORS.find((a) => a.rules.includes(item.rule.code))?.key
}

export interface ChecklistRow {
  /** The rule code. A stable key, and what the page special-cases on. */
  code: string
  title: string
  citation: string
  tone: CheckTone
  /** The pill words. */
  text: string
  /** The date line, from the one shared renderer in the rules engine. */
  due: string
  /**
   * Is there an actual date behind this row?
   *
   * The pill already says the state in words — "no date on file" — so a second
   * line underneath repeating "no date yet" is a line that costs 16px and says
   * nothing new. Twelve of those on a driver whose file is empty is most of a
   * phone screen spent saying the same thing twelve times. The date line is
   * printed only where there is a date in it.
   */
  hasDate: boolean
  /** The `compliance_records.anchor_key` a date for this row is filed under. */
  anchorKey?: string
  /**
   * THE MOST THIS ROW COULD COST HIM, already worded, or absent.
   *
   * Absent is the normal case and it means "no amount we can stand behind",
   * never "no consequence" — most of the catalogue carries no line-item
   * penalty, and the two rows that park a driver (the medical certificate and
   * the CDL) are among them. Anything printing this must not let a blank read
   * as free.
   *
   * Only on rows that are actually at risk. A price beside a date he still has
   * time to meet turns a reminder into a threat.
   */
  fine?: string
}

export interface DriverChecklist {
  /** Red, grey and amber, worst first. Never folded away. */
  needs: readonly ChecklistRow[]
  /** Green and blue. Safe to fold: there is nothing to do on any of them. */
  settled: readonly ChecklistRow[]
  counts: Record<CheckTone, number>
  total: number
}

/**
 * One row per rule the engine tracked for this driver.
 *
 * The incoming order is `compareDeadlines` — overdue, then no date, then
 * soonest first — and the sort below only partitions by tone, so that ordering
 * survives inside each group. A sort that re-ordered by title would put a card
 * expiring on Friday under one expiring next spring.
 */
export function buildDriverChecklist(items: readonly DeadlineItem[], today: Date): DriverChecklist {
  const rows: ChecklistRow[] = items
    .filter((i) => i.status.standing !== 'not_applicable')
    .map((i) => {
      const pill = pillFor(i, today)
      // `act` is overdue and `nodate` is a date nobody has typed — the same two
      // standings `exposure()` counts as at risk, said in this file's own
      // vocabulary. `soon` is deliberately not one of them.
      const atRisk = pill.tone === 'act' || pill.tone === 'nodate'
      const mine = atRisk ? carrierCeiling(i.rule.penalty) : null
      return {
        code: i.rule.code,
        title: i.rule.title,
        citation: i.rule.citation,
        tone: pill.tone,
        text: pill.text,
        due: dueLine(i),
        hasDate: Boolean(i.status.nextDue || i.status.lastDue),
        anchorKey: anchorForRule(i),
        fine: mine ? penaltyAmount(mine) : undefined,
      }
    })
    .sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone])

  const counts: Record<CheckTone, number> = { act: 0, nodate: 0, soon: 0, ok: 0, read: 0 }
  for (const r of rows) counts[r.tone]++

  return {
    needs: rows.filter((r) => r.tone === 'act' || r.tone === 'nodate' || r.tone === 'soon'),
    settled: rows.filter((r) => r.tone === 'ok' || r.tone === 'read'),
    counts,
    total: rows.length,
  }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/**
 * The sentence the checklist leads with: the answer, not the name of the list.
 *
 * It never grades the driver. It says how many things are waiting and what kind
 * of waiting they are, and stops there.
 */
export function checklistLine(c: DriverChecklist): string {
  if (c.total === 0) return 'Nothing is tracked for this driver yet.'
  if (c.needs.length === 0) return 'Nothing needs you today.'

  const parts: string[] = []
  if (c.counts.act > 0) parts.push(`${c.counts.act} overdue`)
  if (c.counts.nodate > 0) parts.push(`${c.counts.nodate} with no date`)
  if (c.counts.soon > 0) parts.push(`${c.counts.soon} due soon`)

  const n = c.needs.length
  return `${n} of ${c.total} ${plural(n, 'deadline needs', 'deadlines need')} you: ${parts.join(', ')}.`
}

/* -------------------------------------------------------------- the roster */

export interface RosterSegment {
  key: CheckTone
  label: string
  count: number
  tone: Tone
}

/**
 * The roster bar: every driver counted ONCE, by the worst thing in his file.
 *
 * The four buckets are the ring's own, and the order is severity order — the
 * same one `buildHealth` uses on the dashboard: red, then grey, then amber,
 * then green. Grey sits second rather than last because not knowing when a
 * medical card expires carries the same exposure as it having expired, and a
 * bar that put "no date" beside "on file" would draw a fleet nobody has typed
 * a date for as a nearly clean bar.
 *
 * The words are the ones the ring legend already prints on the same screen, so
 * a segment and the rings beneath it say the same thing.
 */
export function rosterBar(rings: readonly DqRing[]): {
  segments: readonly RosterSegment[]
  total: number
} {
  let act = 0
  let nodate = 0
  let soon = 0
  let ok = 0

  for (const r of rings) {
    // Worst wins, in the rank `STATE_RANK` gives: expired or not held, then a
    // date we do not hold, then a date coming up.
    if (r.actNow > 0) act++
    else if (r.noDate > 0) nodate++
    else if (r.dueSoon > 0) soon++
    else ok++
  }

  return {
    segments: [
      { key: 'act', label: 'with something to fix', count: act, tone: 'overdue' },
      { key: 'nodate', label: 'missing a date', count: nodate, tone: 'neutral' },
      { key: 'soon', label: 'with a date coming up', count: soon, tone: 'soon' },
      { key: 'ok', label: 'with every item on file', count: ok, tone: 'good' },
    ],
    total: rings.length,
  }
}
