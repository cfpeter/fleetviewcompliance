/**
 * The rule engine's vocabulary.
 *
 * A rule is DATA, not code. Adding California cost us rule rows; adding Arizona
 * must cost rule rows too. Anything that can only be expressed by writing a new
 * function is a design failure to be fixed here, not worked around per-state.
 */

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
  | { type: 'fixed_calendar'; months: readonly number[]; day: number | 'last' }
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
