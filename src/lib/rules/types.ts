/**
 * The rule engine's vocabulary.
 *
 * A rule is DATA, not code. Adding California cost us rule rows; adding Arizona
 * must cost rule rows too. Anything that can only be expressed by writing a new
 * function is a design failure to be fixed here, not worked around per-state.
 */

import type { Penalty } from './penalties.ts'

export type Jurisdiction = 'federal' | 'CA'

/** What connection to a jurisdiction a rule needs. See `RuleDefinition.nexus`. */
export type Nexus = 'universal' | 'based' | 'operates' | 'employs'

/** What the obligation attaches to. */
// 'employee' is distinct from 'driver': harassment-prevention training, the SB
// 553 workplace-violence plan and reasonable-suspicion supervisor training all
// attach to named non-driving staff — dispatchers, mechanics, the office. Filing
// them under 'driver' loses per-person tracking for everyone who is not one.
export type Subject = 'carrier' | 'driver' | 'employee' | 'power_unit' | 'trailer' | 'terminal'

/**
 * The result of asking "when is this next due?"
 *
 * Deliberately NOT `Date | null`. Null collapses four different situations into
 * one, and three of them need different words in front of an owner:
 *
 *   due            we know the date
 *   not_applicable this rule does not apply to you, and here is why
 *   unsupported    you owe this, and we will not invent when — go and look
 *   missing_data   we need a fact you have not given us yet
 *
 * `missing_data` sorts WITH overdue, never with current. If we do not know when
 * a driver's medical card expires, his exposure is identical to it having
 * expired, and showing him as fine is the single most damaging thing we can do.
 */
export type Outcome =
  | { kind: 'due'; on: Date }
  | { kind: 'not_applicable'; reason: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'missing_data'; needs: readonly string[] }

/**
 * How long between occurrences. Exactly one unit, never both.
 *
 * Days are not a rounding convenience — they are the only correct unit for
 * several real rules. California's terminal inspection cycle is 90 DAYS, and
 * `intervalMonths: 3` is 90, 91 or 92 days depending on the month it starts in,
 * which is up to two days LATE. `dates.ts` refuses to move a deadline later, and
 * so does this.
 */
export type Interval =
  | { intervalMonths: number; intervalDays?: never }
  | { intervalDays: number; intervalMonths?: never }

/** The shapes every obligation in the catalogue actually takes. */
export type Recurrence =
  /**
   * A date fixed in the calendar, the same for everyone.
   * IFTA quarters, the OSHA 300A posting window, DOORS on 1 March.
   */
  | {
      type: 'fixed_calendar'
      months: readonly number[]
      day: number | 'last'
      /**
       * Move a date that lands on a Saturday or Sunday to the Monday after.
       *
       * Opt-in, per rule, because it is a statutory fact and not a convenience:
       * IFTA returns due on a weekend are due the next business day, so the
       * catalogue saying "31 Oct" while the IFTA screen said "2 Nov" was the
       * same return with two dates on two screens. Weekends only — public
       * holidays would need a calendar per jurisdiction, and being a day early
       * on a holiday is the safe direction.
       */
      rollWeekend?: boolean
    }
  /**
   * An interval measured from a per-entity anchor date.
   * IRP's assigned month, the MCP term, a TRU's fee anniversary, Form 2290 from
   * the month of first use.
   */
  | ({ type: 'anniversary'; anchor: string } & Interval)
  /**
   * An interval measured from the LAST TIME IT WAS DONE — "at least once every
   * 12 months", not "every January". The annual MVR review, the Clearinghouse
   * annual query on a rolling 365 days.
   */
  | ({ type: 'rolling'; anchor: string } & Interval)
  /**
   * The anchor IS the due date, read off the document itself.
   *
   * This exists because an interval on the rule row cannot express a duration
   * chosen per-record. A medical examiner may certify a driver for any period
   * UP TO 24 months, and 3-month and 1-year certificates are routine — the
   * printed expiry governs, not the statutory maximum. Encoding 24 months as a
   * constant makes the engine up to 21 months too generous on the single most
   * enforcement-visible document in the industry.
   *
   * It also fixes the natural UI question. Asking an owner "when does your IRP
   * expire?" yields a FUTURE date, and an interval rule would step straight
   * past it to the cycle after.
   *
   * `interval` is optional: supply it when the thing renews on a known cycle
   * after that date, omit it when each new date is read off a new document.
   */
  | ({ type: 'expiry'; anchor: string } & Partial<Interval>)
  /**
   * Derived by a named function because the schedule is an algorithm, not an
   * interval. MCS-150 reads the digits of the USDOT number; Clean Truck Check
   * reads the VIN. The function name is data; the function is registered code.
   */
  | { type: 'computed'; fn: string }

/**
 * Facts a rule may consult. Every field is optional and `undefined` means
 * UNKNOWN, never "no" — see `applies` below.
 */
export interface RuleContext {
  today: Date
  dotNumber?: string
  /** 'A' interstate, 'B'/'C' intrastate. */
  carrierOperation?: string
  hazmat?: boolean
  gvwrLbs?: number
  modelYear?: number
  cdl?: boolean
  /** Dates the carrier has given us, keyed by anchor name. */
  anchors?: Readonly<Record<string, Date | undefined>>

  // --- facts that let a rule say "no" instead of "I don't know" ---
  //
  // Every one of these is optional and undefined still means UNKNOWN. They
  // exist because a rule that can only ever answer true or 'unknown' produces
  // permanent noise: the SPE-certificate rule would ask every driver for a date
  // when under 1% of drivers hold one. That is the pressure under which someone
  // eventually hard-codes `false`, which is the failure fail-open exists to
  // prevent. Better to carry the fact.
  forHire?: boolean
  fleetSize?: number
  employeeCount?: number
  usesEld?: boolean
  /** Driver-side facts. */
  insulinTreated?: boolean
  intracityZoneOnly?: boolean
  alternativeVisionStandard?: boolean
  holdsSpeCertificate?: boolean
  isReasonableSuspicionSupervisor?: boolean
  /** Vehicle-side facts. */
  vin?: string
  fuelType?: string
  hasObd?: boolean
  registrationState?: string
}

/**
 * WHAT A LAPSE ACTUALLY STOPS. See `RuleDefinition.impact`.
 *
 * Six words, in descending order of consequence. They are deliberately about
 * the EFFECT on the business, not about the regulation: an owner reading a red
 * row needs to know whether he still has a company this morning, not which
 * subpart he is in.
 *
 *   company  the whole operation stops — no truck can legally move, or the
 *            right to operate is gone
 *   driver   this one person cannot drive; the rest of the fleet keeps earning
 *   truck    this one unit cannot roll; the other units keep earning
 *   money    it costs money on a date, or a broker sees a mark, and the truck
 *            keeps rolling
 *   audit    nothing happens on the day. It is found later, by an auditor, an
 *            insurer or a lawyer — and then all of it is found at once
 *   record   a retention floor, not a deadline. The date is the FIRST day the
 *            record may be destroyed; destroying it early is the violation
 *
 * `driver` ranks above `truck` because a stopped driver is a person who cannot
 * earn while a stopped truck can often be swapped, and because the driver-side
 * rows here are 49 CFR 391.11(b)(4)-(5) findings, which are ACUTE and a
 * single-occurrence automatic failure in a new-entrant safety audit.
 *
 * `audit` and `record` are SEPARATE values, where docs/product/DATE-PRIORITY.md
 * § 3.2 sketched one combined `record`. That document's own § 3.7 asks for the
 * six retention rows to be lifted out of the deadline list into a "Paper you
 * must keep" section, and one value cannot both carry that and carry the
 * tier-4 audit findings. Its tiers 4 and 5 are already two tiers.
 */
export type Impact = 'company' | 'driver' | 'truck' | 'money' | 'audit' | 'record'

/** The plain sentence for an `Impact`. Written to be printed, not decoded. */
export const IMPACT_LABEL: Record<Impact, string> = {
  company: 'The whole company stops',
  driver: 'This driver cannot drive',
  truck: 'This truck cannot roll',
  money: 'It costs money',
  audit: 'Found later in an audit',
  record: 'Paper you must keep',
}

/**
 * Whether a rule applies. Three states, not two.
 *
 * `'unknown'` exists because the honest answer to "does the annual inspection
 * apply to this truck?" when we do not know its weight is not "no". Rules fail
 * OPEN: an unknown-weight truck is treated as fully regulated, because the cost
 * of one unnecessary reminder is a moment of the owner's time and the cost of
 * one missed inspection is the truck.
 */
export type Applicability = true | false | 'unknown'

export interface RuleDefinition {
  /** Stable machine name. Never renamed — stored on deadline rows. */
  code: string
  title: string
  jurisdiction: Jurisdiction
  subject: Subject
  /** The legal citation, shown in the UI so the owner can check us. */
  citation: string
  /** Deep link to the primary source. For a human to click, never to fetch. */
  sourceUrl: string
  recurrence: Recurrence
  /** Days before the due date at which to warn. Negative values are overdue nudges. */
  warningDays: readonly number[]
  /** What document proves it was done. */
  evidence: string
  /** What happens if it is missed — shown on overdue items. */
  consequence: string
  /**
   * THE MONEY, SEPARATELY FROM THE SENTENCE ABOUT IT.
   *
   * `consequence` says what happens and is often the more important half — an
   * expired medical card parks a driver, and the catalogue records that as an
   * ACUTE finding with no dollar amount at all, because there is not one. This
   * field is only for amounts verified against 49 CFR 386 Appendix B, and it
   * exists so that something can ADD THEM UP and so that each one carries the
   * date it took effect.
   *
   * OPTIONAL, AND ABSENT IS THE NORMAL CASE. Most rules in this catalogue have
   * no line-item penalty; see src/lib/rules/penalties.ts for the four figures
   * that appear in prose and are deliberately not encoded here. Anything
   * summing exposure must report an absent penalty as "no figure we can stand
   * behind" and never as zero — a fleet whose overdue rows all lack an amount
   * would otherwise be told it has nothing at stake.
   *
   * An array because one obligation can carry different amounts for different
   * people: $19,246 for the employer at (a)(3), $4,812 for the driver at (a)(4).
   */
  penalty?: readonly Penalty[]
  /**
   * WHAT A LAPSE STOPS. Required on every rule, with no default.
   *
   * THE BUG THIS EXISTS TO FIX. `compareDeadlines` sorted on standing and then
   * on days late, so inside the Overdue section an ELD back-up retention row
   * 90 days past sat above a medical certificate that expired yesterday. Both
   * are red, both say a number of days, and the one that stops a man driving
   * was below the one that says when he may shred a file.
   *
   * It is a SORT KEY, never a filter and never a standing. An overdue row can
   * never sort below a green one because of it — see `compareDeadlines`.
   *
   * No default, deliberately. An optional field with a fallback means a rule
   * added next year sorts wherever the fallback happens to put it, silently,
   * and the failure is invisible: the row still renders, still shows the right
   * date, and is simply in the wrong place. The type system asking the question
   * once, at the moment the rule is written, is the whole protection.
   *
   * Ranked by docs/product/DATE-PRIORITY.md § 2, whose tiers map: tier 1 →
   * `company`, tier 2 → `driver` or `truck`, tier 3 → `money`, tier 4 →
   * `audit`, tier 5 → `record`. Where that document disagrees with a row's own
   * `consequence` sentence (its § 5), the document wins and the row says so.
   *
   * ONE THING IT CANNOT SAY. This is static data on the rule, so it cannot vary
   * with the carrier. The two hazmat rows are tier 3 for a carrier who does not
   * haul hazmat and tier 1 for one who does, and only a context-aware value
   * could carry that. They are ranked as the tier table ranks them, and each
   * row records the caveat.
   */
  impact: Impact
  /** Defaults to always-applicable when omitted. */
  applies?: (ctx: RuleContext) => Applicability
  /**
   * The longest term the law permits for this obligation, where one exists.
   *
   * Separate from `recurrence` on purpose. The medical certificate SCHEDULE is
   * whatever expiry the examiner printed on the card; the CEILING is 24 months,
   * or 12 for an insulin-treated, intracity-zone or alternative-vision driver.
   * Those are different facts: the first says when to remind, the second says
   * when a document is not valid at all.
   *
   * A card printed 24 months out for an insulin-treated driver is not a late
   * reminder, it is an invalid certificate — and only this field can catch it.
   */
  maxTermMonths?: number

  /**
   * What connection to `jurisdiction` this rule needs before it applies.
   *
   * THE BUG THIS EXISTS TO FIX. `RuleContext` carried the carrier's state in
   * TWO fields and not one rule read either of them, so every California rule
   * applied to every carrier in every state: a Texas carrier was shown the
   * California Motor Carrier Permit and CVRA weight decals as real obligations.
   * Wrong output from a compliance product is the only failure that matters
   * here, and it also blocked adding a second state — you cannot add Arizona
   * until the engine can tell an Arizonan from a Californian.
   *
   * Four values, because "is this a California rule" turned out to be four
   * different questions wearing one label:
   *
   * - `universal` — the jurisdiction tag names the ADMINISTERING AUTHORITY, not
   *   who owes it. IFTA and IRP are multi-jurisdiction agreements covering 48
   *   states and 10 Canadian provinces; they are filed as `CA` here only
   *   because CDTFA and California DMV are where a California-based carrier
   *   files them. Gating these on the carrier's state would DELETE a real
   *   filing obligation, with penalties, from an out-of-state carrier — the
   *   same class of error in the opposite direction, and a worse one.
   *
   * - `based` — the carrier must be registered in the state. A Motor Carrier
   *   Permit is Veh. Code 34500; a Texas carrier does not hold one and never
   *   will. This is the only value that can positively rule a rule OUT.
   *
   * - `operates` — reaches anyone driving in the state, wherever they are
   *   based. CARB's Clean Truck Check applies to any vehicle operating in
   *   California. We do not know where a carrier's trucks run, so these stay
   *   `unknown` and keep being tracked.
   *
   * - `employs` — reaches an employer with staff in the state. SB 1343 and SB
   *   553 follow the employee, not the yard, and a Texas company with a
   *   California dispatcher owes both. Also unknowable from what we hold.
   *
   * Omitted means `universal`, which is right for every federal rule.
   *
   * NOT LEGAL ADVICE AND NOT REVIEWED. These classifications were made from
   * each rule's own citation and are the kind of judgement a qualified person
   * has to confirm before a carrier relies on it.
   */
  nexus?: Nexus

  /** Set when a person with the relevant qualification has checked this entry. */
  verifiedBy?: string
  verifiedOn?: string
}
