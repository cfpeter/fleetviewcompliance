/**
 * Turning a rule definition plus what we know into a date, or an honest refusal.
 */
import { answerKeyFor } from './answer.ts'
import { addDays, addMonthsClamped, lastDayOfMonth, toUtcMidnight, utcDate } from './dates.ts'
import type { Interval, Outcome, RuleContext, RuleDefinition } from './types.ts'

/**
 * Step by an interval expressed in EITHER months or days.
 *
 * Days are not a convenience. California's terminal inspection cycle is 90 days,
 * and three months is 90, 91 or 92 depending on where it starts — up to two days
 * late. Months clamp backward; days are exact. Both refuse to drift later.
 */
function step(from: Date, interval: Partial<Interval>, sign: 1 | -1): Date {
  if (interval.intervalDays !== undefined) return addDays(from, sign * interval.intervalDays)
  if (interval.intervalMonths !== undefined) {
    return addMonthsClamped(from, sign * interval.intervalMonths)
  }
  return from
}

const hasInterval = (i: Partial<Interval>): boolean =>
  i.intervalDays !== undefined || i.intervalMonths !== undefined

/** Named schedules that are algorithms rather than intervals. */
export type ComputedFn = (ctx: RuleContext) => Outcome

/**
 * A named schedule that can also answer "and when was the one BEFORE today?".
 *
 * `status` needs that second answer to say `overdue`. An interval rule gets it
 * for free by subtracting the interval; an algorithmic schedule has no interval
 * to subtract, so without this hook the MCS-150 rule could only ever report
 * `current`. A carrier who last filed in 2021 would be shown a 2028 date and
 * nothing else — which is the precise trap src/lib/mcs150.ts was written to
 * avoid, reintroduced one layer up.
 *
 * `previous` is optional because some computed schedules genuinely have no
 * earlier occurrence: a record-retention window and a one-off prorated tax
 * deadline each happen once, and inventing a prior cycle for them would be the
 * same sin in the other direction.
 */
export interface ComputedSchedule {
  next: ComputedFn
  /** The most recent occurrence strictly before today, or null if there is none. */
  previous?: (ctx: RuleContext) => Date | null
}

const computed = new Map<string, ComputedSchedule>()

export function registerComputed(name: string, fn: ComputedFn | ComputedSchedule): void {
  computed.set(name, typeof fn === 'function' ? { next: fn } : fn)
}

/**
 * Saturday to Monday, Sunday to Monday, anything else untouched. Mirrors
 * `returnDueOn` in src/lib/ifta/compute.ts exactly; a test pins the two equal.
 */
function rollOffWeekend(on: Date): Date {
  const day = on.getUTCDay()
  if (day === 6) return new Date(on.getTime() + 2 * 86_400_000)
  if (day === 0) return new Date(on.getTime() + 86_400_000)
  return on
}

export function nextDue(rule: RuleDefinition, ctx: RuleContext): Outcome {
  // Applicability first. 'unknown' deliberately proceeds: a rule we cannot rule
  // out is a rule we track, because failing open costs a reminder and failing
  // closed costs a truck.
  const applicable = rule.applies ? rule.applies(ctx) : true
  if (applicable === false) {
    return { kind: 'not_applicable', reason: `${rule.title} does not apply to this record` }
  }

  const today = toUtcMidnight(ctx.today)
  const r = rule.recurrence

  switch (r.type) {
    case 'fixed_calendar': {
      // The next configured month/day at or after today.
      for (let yearOffset = 0; yearOffset <= 1; yearOffset++) {
        const y = today.getUTCFullYear() + yearOffset
        for (const m of [...r.months].sort((a, b) => a - b)) {
          const nominal = r.day === 'last' ? lastDayOfMonth(y, m) : utcDate(y, m, r.day)
          const on = r.rollWeekend ? rollOffWeekend(nominal) : nominal
          if (on >= today) return { kind: 'due', on }
        }
      }
      return { kind: 'unsupported', reason: 'no future occurrence in the configured calendar' }
    }

    case 'anniversary':
    case 'rolling': {
      const anchor = ctx.anchors?.[r.anchor]
      if (!anchor) {
        // The honest answer. We are not going to pick a plausible-looking date.
        return { kind: 'missing_data', needs: [r.anchor] }
      }
      // The anchor is a COMPLETION, so the first occurrence is one interval
      // after it. Step forward until we pass today: a carrier three cycles
      // behind still gets a real next date, and `status` decides whether they
      // are also overdue.
      let on = step(toUtcMidnight(anchor), r, 1)
      let guard = 0
      while (on < today && guard++ < 400) on = step(on, r, 1)
      return { kind: 'due', on }
    }

    case 'expiry': {
      const anchor = ctx.anchors?.[r.anchor]
      if (!anchor) return { kind: 'missing_data', needs: [r.anchor] }

      // The anchor IS the due date. Do NOT add an interval first — that is the
      // bug this type exists to prevent: told "my IRP expires 30 Nov 2026", an
      // interval rule answers 30 Nov 2027 and silently skips the real deadline.
      let on = toUtcMidnight(anchor)
      if (!hasInterval(r)) return { kind: 'due', on }

      let guard = 0
      while (on < today && guard++ < 400) on = step(on, r, 1)
      return { kind: 'due', on }
    }

    case 'computed': {
      const schedule = computed.get(r.fn)
      if (!schedule) {
        return { kind: 'unsupported', reason: `no implementation registered for '${r.fn}'` }
      }
      return schedule.next(ctx)
    }
  }
}

/**
 * The most recent occurrence STRICTLY BEFORE today — what an overdue item is
 * overdue against.
 *
 * `undefined` means this schedule cannot name an earlier occurrence, and the
 * caller must NOT read that as "nothing was missed". It is the difference
 * between "we checked and you are up to date" and "we cannot check".
 */
function previousDue(rule: RuleDefinition, ctx: RuleContext, next: Date, today: Date) {
  const r = rule.recurrence
  switch (r.type) {
    case 'anniversary':
    case 'rolling':
      // One whole interval back from the next one. Clamping backward matters
      // here too: a 31 March next date must not hand back 3 March.
      return step(next, r, -1)

    case 'expiry':
      // With no interval each date is read off a fresh document, so there is no
      // derivable previous occurrence — and saying `undefined` is the honest
      // answer rather than inventing one.
      return hasInterval(r) ? step(next, r, -1) : undefined

    case 'fixed_calendar': {
      // The latest configured month/day already in the past. Looking back two
      // calendar years covers any month list, including a single-month one
      // asked about on 1 January.
      let best: Date | undefined
      for (let yearOffset = 0; yearOffset >= -1; yearOffset--) {
        const y = today.getUTCFullYear() + yearOffset
        for (const m of r.months) {
          const nominal = r.day === 'last' ? lastDayOfMonth(y, m) : utcDate(y, m, r.day)
          // Rolled here too, or a return due Monday 2 Nov would read as overdue
          // on Sunday 1 Nov — the false accusation the IFTA screen already
          // refuses to make.
          const on = r.rollWeekend ? rollOffWeekend(nominal) : nominal
          if (on < today && (!best || on > best)) best = on
        }
      }
      return best
    }

    case 'computed':
      return computed.get(r.fn)?.previous?.(ctx) ?? undefined
  }
}

/**
 * Was this obligation satisfied for the cycle that has already passed?
 *
 * `nextDue` alone is a trap: a carrier who last filed in 2021 has a perfectly
 * real next date in 2028, and showing only that reads as years of slack to
 * somebody who is delinquent right now.
 */
export type Standing = 'current' | 'overdue' | 'unknown' | 'not_applicable' | 'unsupported'

export interface Status {
  standing: Standing
  /** The next occurrence in the future, when we can compute one. */
  nextDue?: Date
  /** The most recent occurrence already passed — what an overdue item is overdue against. */
  lastDue?: Date
  reason?: string
  needs?: readonly string[]
  /**
   * On an `unknown`: the `compliance_records.anchor_key` a date typed to answer
   * this row must be filed under.
   *
   * Stated here rather than worked out by the page, because the two ways a row
   * can be `unknown` want DIFFERENT keys and the difference is invisible from
   * outside:
   *
   *   - `missing_data` — the schedule itself cannot be computed. The key is the
   *     anchor the schedule wanted, which for a `computed` rule is whatever its
   *     function reads and NOT the rule's own code.
   *   - no last completion — the schedule is known, but whether it was ever done
   *     is not. That fact has no anchor of its own, so it is filed under the
   *     rule code, which is exactly where `evaluate` looks for it.
   *
   * A page that guesses gets a date stored perfectly, shown back on every visit,
   * and a rule that reports "we need a date from you" forever. Nothing throws.
   */
  answerKey?: string
}

export function status(rule: RuleDefinition, ctx: RuleContext, lastDone: Date | null): Status {
  const outcome = nextDue(rule, ctx)

  if (outcome.kind === 'not_applicable') {
    return { standing: 'not_applicable', reason: outcome.reason }
  }
  if (outcome.kind === 'unsupported') {
    return { standing: 'unsupported', reason: outcome.reason }
  }
  if (outcome.kind === 'missing_data') {
    // Not knowing is not the same as being fine, and carries the same exposure.
    //
    // The key comes from the OUTCOME, not from the rule's recurrence. A
    // `computed` schedule names no anchor on the rule itself — it reads one
    // inside its function — so deriving the key from the recurrence would send
    // an SPE certificate's expiry to an anchor nothing ever reads.
    return { standing: 'unknown', needs: outcome.needs, answerKey: outcome.needs[0] }
  }

  const today = toUtcMidnight(ctx.today)
  const lastDue = previousDue(rule, ctx, outcome.on, today)

  // An EXPIRY date already behind us is the definition of expired.
  //
  // Restricted to `expiry` rules, and the restriction is the point. For every
  // other shape the anchor is a COMPLETION — "when did you last pull the MVR" —
  // and a completion in the past is exactly what being up to date looks like.
  // Applying this to those would mark a driver whose paperwork is perfect as
  // overdue on the day it was filed.
  //
  // For an expiry the anchor is not a completion at all: it is the date printed
  // on the document. `lastDone` defaults to that same anchor, so the ordinary
  // comparison below asks "was the certificate completed by its own expiry
  // date", which is trivially true and answers CURRENT for a card that lapsed
  // seventeen months ago. The single most enforcement-visible document in the
  // industry could never reach overdue, and the dispatch block that depends on
  // it could never fire.
  if (rule.recurrence.type === 'expiry' && outcome.on < today) {
    return { standing: 'overdue', nextDue: outcome.on, lastDue: lastDue ?? outcome.on }
  }

  if (lastDone === null) {
    return {
      standing: 'unknown',
      nextDue: outcome.on,
      lastDue,
      needs: ['last completion date'],
      // Whether this was ever DONE is a fact with no anchor of its own, so it
      // is filed under the rule code — the same place `evaluate` reads it back.
      answerKey: answerKeyFor(rule),
    }
  }
  if (lastDue && toUtcMidnight(lastDone) < lastDue) {
    return { standing: 'overdue', nextDue: outcome.on, lastDue }
  }

  // A ONE-TIME OBLIGATION THAT IS DONE HAS NO NEXT DATE, so we do not invent one.
  //
  // `nextDue` means what its own comment says: the next occurrence IN THE
  // FUTURE. A one-time obligation anchored to employment — the road test, the
  // hire-time MVR, the pre-employment Clearinghouse query — was due on the day
  // it was due, and for anybody who already works here that day is in the past.
  // It cannot ever have a future occurrence. Returning the hire date as
  // `nextDue` was therefore a date the field promises is ahead of us and is not.
  //
  // `evaluate` turns that into a large NEGATIVE `daysUntil`, and the past then
  // passes every window anybody compares it to. That one invented date has cost
  // the product the same bug in five separate places:
  //
  //   1. twenty finished items in the amber "Due in 45 days" arc
  //   2. "Expires soon" printed forever on a clean qualification binder
  //   3. the dashboard's own filter
  //   4. the runway, where a past `nextDue` was counted OVERDUE, so completed
  //      paperwork was drawn as past due on the chart that exists to stop a bad
  //      month hiding
  //   5. `reachedWindow` in src/lib/notify/select.ts — the one nobody had
  //      caught — where -2040 reaches EVERY lead window and `deservesSms` reads
  //      it as critical, so a road test passed five years ago earns a text
  //      message that breaks through quiet hours
  //
  // The first three were fixed by teaching one more caller to distrust the
  // number, which is what left 4 and 5 standing.
  // This fixes the number. A consumer that skips undated rows, or that defaults
  // a missing `daysUntil` to +Infinity, now gets the right answer without
  // knowing this case exists — which is the only version of this that holds.
  //
  // The two callers that CANNOT be silent about it are the two for which "no
  // date" already means "we need one from you": `dueLine` in ./index.ts and the
  // `undated` arm of src/lib/charts/runway.ts. Both name this case explicitly.
  //
  // Scoped by `lastDue === undefined`, which is precisely the shape this is
  // about: a schedule that cannot name an earlier occurrence, because it has
  // only ever had one. See `registerOneTime` in ./federal-driver.ts for why
  // those deliberately register no `previous` hook. An interval rule always
  // derives a `lastDue` and never reaches here; an `expiry` whose date has
  // passed is already `overdue` above. The standing stays `current` — it is
  // done, there is nothing further due, and green is the bucket with nothing
  // in it for the owner to do.
  if (lastDue === undefined && outcome.on < today) {
    return { standing: 'current' }
  }

  return { standing: 'current', nextDue: outcome.on, lastDue }
}
