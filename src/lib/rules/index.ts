/**
 * The whole catalogue, and the one function the app calls.
 */

import { answerKeyFor } from './answer.ts'
import { californiaRules } from './california.ts'
import { type Standing, type Status, status } from './compute.ts'
import { daysBetween, toUtcMidnight } from './dates.ts'
import { federalCarrierRules } from './federal-carrier.ts'
import { federalDriverRules } from './federal-driver.ts'
import type { RuleContext, RuleDefinition, Subject } from './types.ts'

export const allRules: readonly RuleDefinition[] = [
  ...federalDriverRules,
  ...federalCarrierRules,
  ...californiaRules,
]

export function rulesFor(subject: Subject): readonly RuleDefinition[] {
  return allRules.filter((r) => r.subject === subject)
}

export function ruleByCode(code: string): RuleDefinition | undefined {
  return allRules.find((r) => r.code === code)
}

/** One line on the dashboard. */
export interface DeadlineItem {
  rule: RuleDefinition
  /** Which record this is about, for the link and the label. */
  subjectType: Subject
  subjectId: string | null
  subjectLabel: string
  status: Status
  /** Negative when overdue. Undefined when there is no date at all. */
  daysUntil?: number
}

/**
 * Sort order, and it is the whole product in one function.
 *
 * `unknown` sits WITH overdue rather than at the bottom, because not knowing
 * when a medical card expires carries the same exposure as it having expired.
 * Sorting it below "current" would bury exactly the rows the owner most needs
 * to fix, and would quietly reward never entering data.
 */
const STANDING_RANK: Record<Standing, number> = {
  overdue: 0,
  unknown: 1,
  current: 2,
  unsupported: 3,
  not_applicable: 4,
}

export function compareDeadlines(a: DeadlineItem, b: DeadlineItem): number {
  const rank = STANDING_RANK[a.status.standing] - STANDING_RANK[b.status.standing]
  if (rank !== 0) return rank

  // Within a standing, soonest first. Rows with no date sort last among their
  // peers rather than first — an item we cannot date is not more urgent than a
  // dated one in the same bucket.
  const ad = a.daysUntil ?? Number.POSITIVE_INFINITY
  const bd = b.daysUntil ?? Number.POSITIVE_INFINITY
  if (ad !== bd) return ad - bd

  return a.subjectLabel.localeCompare(b.subjectLabel)
}

/** A thing the rules are evaluated against. */
export interface EvaluationSubject {
  type: Subject
  id: string | null
  label: string
  context: Omit<RuleContext, 'today'>
  /** When each anchor last happened, by anchor key. */
  anchors: Readonly<Record<string, Date | undefined>>
  /** When the obligation was last satisfied, by rule code. */
  lastDone?: Readonly<Record<string, Date | undefined>>
}

/**
 * Can this rule's jurisdiction reach this carrier at all?
 *
 * Only ever answers "definitely not". Everything else — an unknown state, a
 * rule that reaches whoever drives through, a rule that follows an employee —
 * falls through and keeps being tracked, because failing open costs a reminder
 * and failing closed costs a truck.
 *
 * `universal` is the one that must never be gated: IFTA and IRP carry a `CA`
 * tag naming the authority a California carrier files WITH, not a limit on who
 * owes them. Gating those would quietly delete a real filing obligation from an
 * out-of-state carrier.
 */
function nexusExcludes(rule: RuleDefinition, ctx: RuleContext): boolean {
  if (rule.jurisdiction === 'federal') return false
  if ((rule.nexus ?? 'universal') !== 'based') return false

  const state = ctx.registrationState?.trim().toUpperCase()
  // Unknown state means we cannot rule anything out, so we do not.
  if (!state) return false
  return state !== rule.jurisdiction.toUpperCase()
}

export function evaluate(subjects: readonly EvaluationSubject[], today: Date): DeadlineItem[] {
  const items: DeadlineItem[] = []
  const day0 = toUtcMidnight(today)

  for (const subject of subjects) {
    for (const rule of rulesFor(subject.type)) {
      const ctx: RuleContext = { ...subject.context, today: day0, anchors: subject.anchors }

      // THE STATE GATE. See `RuleDefinition.nexus`.
      //
      // Before this, `registrationState` was loaded out of the carrier's FMCSA
      // record, put on the context, and read by nothing — so all fifteen
      // California rules applied to every carrier in the country. Applied
      // BEFORE `rule.applies` because a rule that cannot reach this carrier at
      // all should not get to answer 'unknown' about facts we do hold.
      if (nexusExcludes(rule, ctx)) continue

      // `lastDone` defaults to the anchor itself. For most rules the anchor IS
      // the completion — "when did you last pull the MVR" — and requiring a
      // second identical field would be a second chance to disagree with itself.
      //
      // A `computed` rule has no anchor name to fall back on: its schedule comes
      // from an algorithm, not from a date the carrier gave us. Its completion
      // is therefore stored under the RULE CODE. Without this the MCS-150 row
      // computes a perfectly correct date and still reports "not sure", even
      // though the federal record told us at signup exactly when they last filed.
      // `answerKeyFor` IS this ternary, named and exported. A screen that wants
      // to write one of these dates has to make the same decision, and reading
      // it from the same function is what stops the two from drifting.
      const lastDone = subject.lastDone?.[rule.code] ?? subject.anchors[answerKeyFor(rule)] ?? null

      const s = status(rule, ctx, lastDone)

      // Not-applicable rows are dropped rather than shown greyed out. A list
      // that includes every rule that does NOT apply to you is a list nobody
      // reads to the bottom of.
      if (s.standing === 'not_applicable') continue

      items.push({
        rule,
        subjectType: subject.type,
        subjectId: subject.id,
        subjectLabel: subject.label,
        status: s,
        daysUntil: s.nextDue ? daysBetween(day0, s.nextDue) : undefined,
      })
    }
  }

  return items.sort(compareDeadlines)
}

/**
 * How a standing renders. Matches the token vocabulary in docs/stack.md.
 *
 * AMBER MEANS TIME, AND ONLY TIME.
 *
 * It used to mean two unrelated things at once: "a deadline is approaching" on
 * the dashboard's 45-day section, and "we cannot put a date on this, go and look
 * at it yourself" here. Those sat directly above one another on the page in the
 * same colour, so the eye read a standing advisory about brake-inspector
 * paperwork as being as time-critical as a medical card expiring next month.
 *
 * `unsupported` is not on the urgency scale at all — it is a duty with no
 * schedule, and it will still be here next year. Blue says "this is for you to
 * read" without claiming a clock is running.
 */
export function standingPill(standing: Standing): { label: string; className: string } {
  switch (standing) {
    case 'overdue':
      return { label: 'Overdue', className: 'bg-red-100 text-red-700' }
    case 'unknown':
      return { label: 'Not sure', className: 'bg-ink-100 text-ink-500' }
    case 'current':
      return { label: 'Current', className: 'bg-emerald-100 text-emerald-800' }
    case 'unsupported':
      return { label: 'Check yourself', className: 'bg-brand-500/10 text-brand-700' }
    case 'not_applicable':
      return { label: 'Not applicable', className: 'bg-ink-50 text-ink-300' }
  }
}

const DUE_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
}

/** UTC, always. Every date in this engine is a UTC midnight, and rendering one
 *  in the reader's zone moves half the year's deadlines back a day. */
const onDate = (d?: Date) => (d ? d.toLocaleDateString('en-US', DUE_FORMAT) : '—')

const countdown = (days: number) => {
  if (days < 0) return `${Math.abs(days)} days ago`
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${days} days`
}

/**
 * The date line under the pill — and the sentence it must never say.
 *
 * `unknown` used to fall through to the same `date · countdown` as `current`, so
 * a row whose pill read "Not sure" still printed a flat "in 45 days", while the
 * tile directly above it read "Due in 45 days: 0" — the soon bucket takes only
 * `current`. A counter and a countdown contradicting each other in one glance,
 * on the screen whose entire job is trust.
 *
 * THE BUCKET IS RIGHT AND STAYS RIGHT. An `unknown` that still carries a date is
 * a schedule we can work out unaided — IFTA's quarter end, the MCS-150 formula —
 * with no record that the previous cycle was ever done. The date is real; the
 * SLACK is the invention. He may be late on the cycle before this one right now,
 * which is the whole reason these rank with overdue rather than below current.
 * So the countdown is the part that goes: it is the only part that was false.
 *
 * Deliberately not "our estimate". Oct 31 is not a guess — it is the statutory
 * quarter end — and calling it one would replace a false countdown with a false
 * date. What is unverified is the PREVIOUS cycle, so that is what we print: the
 * line says plainly that we hold no record of the last one, rather than leaving
 * the reader to unpack a condition ("if nothing was missed") and work out for
 * himself which half of it we are unsure about.
 *
 * An `unknown` with NO date is the `missing_data` half: nothing to count from at
 * all. That rendered "— · no date", which reads as a broken cell rather than as
 * a question waiting on him.
 */
export function dueLine(item: { status: Status; daysUntil?: number }): string {
  const s = item.status
  if (s.standing === 'overdue') return `was due ${onDate(s.lastDue ?? s.nextDue)}`
  if (!s.nextDue) return 'no date yet'
  if (s.standing === 'unknown') return `${onDate(s.nextDue)} · we have no record of the last one`
  // The countdown is reserved for `current`, where the date is known AND the
  // last cycle is known to have been done. Nothing else earns a number.
  return item.daysUntil === undefined
    ? onDate(s.nextDue)
    : `${onDate(s.nextDue)} · ${countdown(item.daysUntil)}`
}

/** Due within this many days counts as "coming up" on the dashboard. */
export const SOON_DAYS = 45
