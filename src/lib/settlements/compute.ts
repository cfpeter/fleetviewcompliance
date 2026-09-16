/**
 * Driver settlements: what he is owed, and the arithmetic that says why.
 *
 * THIS IS NOT PAYROLL. Nothing in this file withholds tax, computes FICA, or
 * produces anything a government reads. It produces a SETTLEMENT STATEMENT —
 * the sheet handed to a driver alongside the cheque — and the pages that use it
 * say so on screen. A carrier who mistakes this for payroll is a carrier who
 * stops withholding, so the disclaimer is a feature, not a footnote.
 *
 * UNITS, matching 0016_settlements.sql exactly. Every one of them is an integer:
 *   money          — CENTS                    ($1,850.50 -> 185050)
 *   per-mile rates — MILLS per mile           ($0.585/mi -> 585)
 *   percentages    — BASIS POINTS             (67.5%     -> 6750)
 *   quantities     — THOUSANDTHS of the unit  (1,250 mi  -> 1250000; 7.5 h -> 7500)
 *
 * NO FLOATS ANYWHERE. Not in the parsing, not in the multiplication, not in the
 * rounding. A settlement is a sum of dozens of these and a cent of drift per
 * line is a statement that does not reconcile against a driver's own notebook —
 * which is the one document he trusts more than ours.
 *
 * Money PARSING is not done here. `parseMoneyToCents` in ../loads.ts already
 * splits dollars from cents as strings so no float ever exists, and a second
 * money parser would be a second set of rounding rules. The parsers below exist
 * only for the units that file does not have: mills, basis points and
 * thousandths. They are deliberately modelled on it, down to the `Parsed<T>`
 * result type, which is imported rather than redeclared.
 */

import { formatCents, type Parsed } from '../loads.ts'

// ---------------------------------------------------------------------------
// Vocabulary — these strings are the enum labels in 0016_settlements.sql
// ---------------------------------------------------------------------------

export type PayMethod = 'per_mile' | 'percentage' | 'hourly' | 'flat_per_trip'

export type MileageBasis = 'practical' | 'shortest' | 'hhg' | 'hub'

export type SettlementStatus = 'draft' | 'approved' | 'paid' | 'void'

export type SettlementCategory = 'earning' | 'reimbursement' | 'advance' | 'deduction'

export type SettlementLineKind =
  // earning
  | 'linehaul'
  | 'stop_pay'
  | 'detention'
  | 'layover'
  | 'accessorial'
  | 'bonus'
  | 'other_earning'
  // reimbursement
  | 'toll'
  | 'scale'
  | 'lumper'
  | 'other_reimbursement'
  // advance
  | 'advance'
  // deduction
  | 'escrow'
  | 'insurance'
  | 'eld_fee'
  | 'truck_lease'
  | 'fuel_card'
  | 'other_deduction'

export interface Choice<T extends string> {
  value: T
  label: string
  /** The sentence under the option, where the word alone is ambiguous. */
  help?: string
}

export const PAY_METHODS: readonly Choice<PayMethod>[] = [
  {
    value: 'per_mile',
    label: 'Per mile',
    help: 'Cents per mile. You must say which miles — see the basis below.',
  },
  {
    value: 'percentage',
    label: 'Percentage of the load',
    help: 'A share of what the load pays. You must say what it is a share OF.',
  },
  { value: 'hourly', label: 'Hourly', help: 'Local and drayage work.' },
  {
    value: 'flat_per_trip',
    label: 'Flat per trip or stop',
    help: 'One figure per run, or per stop. Dedicated lanes and stop pay.',
  },
]

/**
 * WHICH BOOK OF MILES. The same physical run is four different numbers, and the
 * gap between the highest and the lowest is routinely 6%.
 *
 * On a driver running 2,500 miles a week at $0.60, 6% is $90 a week. That is
 * the whole argument, and it is never about the rate — both people agreed on
 * the rate. It is about the fact that nobody wrote down which book was meant.
 */
export const MILEAGE_BASES: readonly Choice<MileageBasis>[] = [
  {
    value: 'practical',
    label: 'Practical',
    help: 'The route a truck can legally run. What brokers settle mileage disputes on.',
  },
  {
    value: 'shortest',
    label: 'Shortest',
    help: 'Ignores truck restrictions. Typically 3–6% lower than practical.',
  },
  {
    value: 'hhg',
    label: 'HHG',
    help: 'Household Goods tariff mileage. Still written into older contracts.',
  },
  {
    value: 'hub',
    label: 'Hub (odometer)',
    help: 'What the truck actually turned. Highest of the four — it includes the fuel stop.',
  },
]

export const SETTLEMENT_STATUSES: readonly Choice<SettlementStatus>[] = [
  { value: 'draft', label: 'Draft', help: 'Being built. Edit freely.' },
  { value: 'approved', label: 'Approved', help: 'Signed off. Still editable until it is paid.' },
  { value: 'paid', label: 'Paid', help: 'The money moved. Locked — corrections need a revision.' },
  { value: 'void', label: 'Void', help: 'Cancelled. Kept, so it can be pointed at.' },
]

export const SETTLEMENT_CATEGORIES: readonly Choice<SettlementCategory>[] = [
  { value: 'earning', label: 'Earnings', help: 'What the work paid.' },
  {
    value: 'reimbursement',
    label: 'Reimbursements',
    help: 'Money he spent on our behalf and is getting back. Not compensation.',
  },
  { value: 'advance', label: 'Advances', help: 'Money already handed over this period.' },
  { value: 'deduction', label: 'Deductions', help: 'Escrow, insurance, lease, fuel card.' },
]

/**
 * Every line kind, and the category it belongs to.
 *
 * The pairing is duplicated in a CHECK constraint in 0016_settlements.sql. That
 * is on purpose: this table is what the form offers, and the constraint is what
 * catches an import, a psql session, or a page written next year that forgets.
 * An 'escrow' line filed as an earning is $250 of the carrier's money handed to
 * the driver on paper, and it reconciles to nothing.
 */
export const LINE_KINDS: readonly (Choice<SettlementLineKind> & {
  category: SettlementCategory
})[] = [
  { value: 'linehaul', label: 'Linehaul', category: 'earning' },
  { value: 'stop_pay', label: 'Stop pay', category: 'earning' },
  { value: 'detention', label: 'Detention', category: 'earning' },
  { value: 'layover', label: 'Layover', category: 'earning' },
  { value: 'accessorial', label: 'Accessorial', category: 'earning' },
  { value: 'bonus', label: 'Bonus', category: 'earning' },
  { value: 'other_earning', label: 'Other earning', category: 'earning' },

  { value: 'toll', label: 'Tolls', category: 'reimbursement' },
  { value: 'scale', label: 'Scales', category: 'reimbursement' },
  { value: 'lumper', label: 'Lumper', category: 'reimbursement' },
  { value: 'other_reimbursement', label: 'Other reimbursement', category: 'reimbursement' },

  {
    value: 'advance',
    label: 'Advance',
    category: 'advance',
    help: 'Money already paid out this period. It comes off the net.',
  },

  { value: 'escrow', label: 'Escrow', category: 'deduction' },
  { value: 'insurance', label: 'Insurance', category: 'deduction' },
  { value: 'eld_fee', label: 'ELD fee', category: 'deduction' },
  { value: 'truck_lease', label: 'Truck lease', category: 'deduction' },
  { value: 'fuel_card', label: 'Fuel card', category: 'deduction' },
  { value: 'other_deduction', label: 'Other deduction', category: 'deduction' },
]

function labelOf<T extends string>(list: readonly Choice<T>[], value: string | null): string {
  return list.find((c) => c.value === value)?.label ?? value ?? ''
}

export const payMethodLabel = (v: string | null): string => labelOf(PAY_METHODS, v)
export const mileageBasisLabel = (v: string | null): string => labelOf(MILEAGE_BASES, v)
export const settlementStatusLabel = (v: string | null): string => labelOf(SETTLEMENT_STATUSES, v)
export const categoryLabel = (v: string | null): string => labelOf(SETTLEMENT_CATEGORIES, v)
export const lineKindLabel = (v: string | null): string => labelOf(LINE_KINDS, v)

/**
 * Enum guards.
 *
 * PostgREST hands an unrecognised string straight to Postgres, which raises
 * `invalid input value for enum` — a 500 on a page reached by clearing a filter
 * or by a browser replaying an old URL after a value is renamed.
 */
export const isPayMethod = (v: string): v is PayMethod => PAY_METHODS.some((c) => c.value === v)
export const isMileageBasis = (v: string): v is MileageBasis =>
  MILEAGE_BASES.some((c) => c.value === v)
export const isSettlementStatus = (v: string): v is SettlementStatus =>
  SETTLEMENT_STATUSES.some((c) => c.value === v)
export const isLineKind = (v: string): v is SettlementLineKind =>
  LINE_KINDS.some((c) => c.value === v)

/** The category a kind belongs to. NULL for an unknown kind, never a guess. */
export function categoryOfKind(kind: string): SettlementCategory | null {
  return LINE_KINDS.find((k) => k.value === kind)?.category ?? null
}

/**
 * Paid and void are locked; draft and approved are not.
 *
 * `approved` deliberately does NOT lock. An owner who approves on Friday and
 * finds a missing toll receipt on Saturday must be able to add it — forcing a
 * formal revision for a statement nobody has acted on yet trains people to
 * leave everything in draft, which defeats the mechanism entirely. The lock
 * protects a statement the driver has ALREADY BEEN PAID against, which is the
 * only case where a silent edit means the paper in his hand disagrees with the
 * screen. 0016_settlements.sql enforces this with a trigger; this function is
 * what the UI uses to stop offering the buttons.
 */
export function isLocked(status: string | null | undefined): boolean {
  return status === 'paid' || status === 'void'
}

export function settlementStatusPillClass(status: string | null): string {
  switch (status) {
    case 'draft':
      return 'bg-ink-100 text-ink-500'
    case 'approved':
      return 'bg-blue-100 text-blue-800'
    case 'paid':
      return 'bg-emerald-100 text-emerald-800'
    case 'void':
      // Not red. Red on this product means "a regulator will fine you", and a
      // voided settlement is an ordinary administrative act.
      return 'bg-ink-50 text-ink-300'
    default:
      return 'bg-ink-50 text-ink-300'
  }
}

// ---------------------------------------------------------------------------
// Integer arithmetic
// ---------------------------------------------------------------------------

/**
 * Integer division, rounding halves AWAY FROM ZERO.
 *
 * `Math.round` is the wrong tool and the reason is not obvious: it rounds .5
 * toward POSITIVE INFINITY, so Math.round(2.5) is 3 but Math.round(-2.5) is -2.
 * A percentage split of an accessorial and the identical charge-back of it would
 * round in opposite directions and fail to cancel — one cent that appears from
 * nowhere on a statement and cannot be explained to the driver.
 *
 * The remainder is recovered and corrected rather than trusted, so the result is
 * exact for every input inside the ranges this module deals with (the largest
 * product here is miles-in-thousandths × mills, about 1e11, comfortably inside
 * the 2^53 where integer arithmetic in a double is exact).
 */
export function divRound(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new Error('divRound: denominator must be positive')
  const sign = numerator < 0 ? -1 : 1
  const abs = Math.abs(numerator)
  let q = Math.trunc(abs / denominator)
  let r = abs - q * denominator
  // Self-correcting: if the float division landed a hair on the wrong side, the
  // remainder says so and is put back.
  if (r < 0) {
    q -= 1
    r += denominator
  } else if (r >= denominator) {
    q += 1
    r -= denominator
  }
  return sign * (r * 2 >= denominator ? q + 1 : q)
}

/**
 * Miles × rate.
 *
 * milesMilli is thousandths of a mile, rateMills is thousandths of a dollar per
 * mile, so the product is 10^-6 dollars — 10^-4 cents. Hence the 10,000.
 *
 * 1,000 miles at $0.58 => 1_000_000 × 580 / 10_000 = 58_000 cents = $580.00
 */
export function perMileCents(milesMilli: number, rateMills: number): number {
  return divRound(milesMilli * rateMills, 10_000)
}

/**
 * A share of a basis. basisCents × bp / 10,000.
 *
 * 68% of $2,000.00 => 200_000 × 6_800 / 10_000 = 136_000 cents = $1,360.00
 */
export function percentageCents(basisCents: number, percentBp: number): number {
  return divRound(basisCents * percentBp, 10_000)
}

/**
 * Hours × rate. hoursMilli is thousandths of an hour.
 *
 * 7.5 h at $28.50 => 7_500 × 2_850 / 1_000 = 21_375 cents = $213.75
 */
export function hourlyCents(hoursMilli: number, rateCents: number): number {
  return divRound(hoursMilli * rateCents, 1_000)
}

/**
 * A flat figure × a count. quantityMilli is thousandths so that "three stops"
 * and "half a day" use the same column; whole trips are simply 3_000.
 */
export function flatCents(quantityMilli: number, rateCents: number): number {
  return divRound(quantityMilli * rateCents, 1_000)
}

// ---------------------------------------------------------------------------
// The percentage-of-what problem
// ---------------------------------------------------------------------------

/**
 * What the load paid, split the way a rate confirmation splits it.
 *
 * Shaped to match the columns in 0009_loads.sql so a load row can be handed
 * straight in.
 */
export interface LoadPay {
  linehaulCents: number | null | undefined
  fuelSurchargeCents: number | null | undefined
  accessorialsCents: number | null | undefined
}

/** The two answers a percentage agreement has to carry. */
export interface PercentScope {
  includesFuelSurcharge: boolean
  includesAccessorials: boolean
}

export interface PercentageBasis {
  basisCents: number
  /** The components, named, for printing on the line: ['Linehaul', 'Fuel surcharge']. */
  parts: string[]
}

/**
 * THE SINGLE MOST COMMON SETTLEMENT DISPUTE, computed explicitly.
 *
 * "70% of the load" is three different cheques. A load paying $2,000 linehaul +
 * $400 fuel surcharge + $150 lumper settles at $1,400, $1,680 or $1,785 — a $385
 * spread on ONE load, argued about six weeks later when neither party remembers
 * what was said on the phone.
 *
 * So the two flags are REQUIRED on the agreement (a CHECK constraint, not a
 * default), they are SNAPSHOTTED onto the settlement line, and this function
 * returns the component names so the statement can print "68% of linehaul +
 * fuel surcharge — $2,400.00" instead of a bare percentage.
 *
 * Linehaul is always in. A percentage agreement that excluded linehaul would be
 * a percentage of nothing, and no such deal exists.
 *
 * A NULL fuel surcharge on an included load counts as zero — a load genuinely
 * without a surcharge adds nothing, which is the same reasoning totalRateCents
 * uses. A NULL LINEHAUL is different and is refused upstream: that is a load
 * nobody has priced, and a percentage of it is not $0.00, it is unknown.
 */
export function percentageBasis(load: LoadPay, scope: PercentScope): PercentageBasis {
  const parts = ['Linehaul']
  let basisCents = load.linehaulCents ?? 0

  if (scope.includesFuelSurcharge) {
    basisCents += load.fuelSurchargeCents ?? 0
    parts.push('Fuel surcharge')
  }
  if (scope.includesAccessorials) {
    basisCents += load.accessorialsCents ?? 0
    parts.push('Accessorials')
  }
  return { basisCents, parts }
}

/** 'linehaul + fuel surcharge' — the tail of the sentence printed on the line. */
export function describePercentScope(scope: PercentScope): string {
  const parts = ['linehaul']
  if (scope.includesFuelSurcharge) parts.push('fuel surcharge')
  if (scope.includesAccessorials) parts.push('accessorials')
  return parts.join(' + ')
}

// ---------------------------------------------------------------------------
// Agreements
// ---------------------------------------------------------------------------

/**
 * One pay agreement, in the shape the database stores it.
 *
 * The nullables are not laziness — they are the schema. `mileageBasis` is NULL
 * for every method except per_mile, and the two percent flags are NULL for every
 * method except percentage. The compute below REFUSES rather than defaults when
 * one of them is missing where it is required, which is the whole point.
 */
export interface PayAgreement {
  id?: string
  label: string
  method: PayMethod
  rateMills?: number | null
  percentBp?: number | null
  rateCents?: number | null
  mileageBasis?: MileageBasis | null
  percentIncludesFuelSurcharge?: boolean | null
  percentIncludesAccessorials?: boolean | null
  effectiveOn?: string | null
  endsOn?: string | null
}

/**
 * Was this agreement in force on this day?
 *
 * ISO date strings compared as strings. 'YYYY-MM-DD' sorts lexically in date
 * order, which is the one property that makes string comparison safe here, and
 * it avoids constructing a Date — `new Date('2026-03-01')` is midnight UTC and
 * on a Los Angeles carrier that is the previous afternoon, which has silently
 * moved a rate change a day early before.
 */
export function activeOn(agreement: PayAgreement, isoDate: string): boolean {
  const from = agreement.effectiveOn ?? ''
  const to = agreement.endsOn ?? ''
  if (from && isoDate < from) return false
  if (to && isoDate > to) return false
  return true
}

/**
 * SEVERAL AGREEMENTS AT ONCE IS THE NORMAL CASE.
 *
 * A real driver is per-mile on linehaul AND flat $25 a stop AND hourly for
 * detention. This returns every agreement in force on the day, in the order they
 * were written, and the caller applies all of them.
 */
export function agreementsInForce(
  agreements: readonly PayAgreement[],
  isoDate: string,
): PayAgreement[] {
  return agreements.filter((a) => activeOn(a, isoDate))
}

// ---------------------------------------------------------------------------
// Computing an earning line
// ---------------------------------------------------------------------------

/** What is available to pay on. Only the fields a given method needs are read. */
export interface PayInputs {
  /** Thousandths of a mile, for per_mile. */
  milesMilli?: number | null
  /** Thousandths of an hour, for hourly. */
  hoursMilli?: number | null
  /** Thousandths of a trip or stop, for flat_per_trip. Three stops is 3000. */
  quantityMilli?: number | null
  /** The load, for percentage. */
  load?: LoadPay | null
}

/**
 * A computed line, in the shape the `settlement_lines` columns expect.
 *
 * Every term that explains the number is on the line itself, not read back
 * through the agreement. The agreement WILL be edited — the CPM goes up in
 * April — and a March statement that re-renders through today's agreement
 * silently starts claiming it paid 62 cents when the cheque was written at 58.
 */
export interface ComputedLine {
  category: SettlementCategory
  kind: SettlementLineKind
  description: string
  amountCents: number
  method: PayMethod
  payAgreementId?: string
  quantityMilli: number | null
  rateMills: number | null
  percentBp: number | null
  rateCents: number | null
  basisCents: number | null
  mileageBasis: MileageBasis | null
  percentIncludesFuelSurcharge: boolean | null
  percentIncludesAccessorials: boolean | null
}

export type EarningOutcome =
  | { kind: 'computed'; line: ComputedLine }
  /** Nothing to pay on: zero miles, no hours, no load. Not an error. */
  | { kind: 'no_input' }
  /**
   * The agreement cannot be applied as written.
   *
   * Deliberately NOT a zero line, and this is the same discipline the IFTA
   * return uses for a missing tax rate. A per-mile agreement with no mileage
   * basis, or a percentage with no stated scope, rendered as "$0.00" is a
   * statement that is quietly short — and a short statement is one the driver
   * finds, not us. It has to surface as a sentence somebody has to act on.
   */
  | { kind: 'incomplete'; reason: string }

/**
 * One agreement applied to one period's inputs.
 *
 * `kind` is chosen from the method rather than asked for: a per-mile or
 * percentage agreement produces linehaul pay, an hourly one produces hourly
 * earnings, and a flat one is stop pay or trip pay. The caller can override the
 * description; the CATEGORY is always 'earning', because an agreement cannot
 * produce a deduction.
 */
export function computeEarning(agreement: PayAgreement, inputs: PayInputs): EarningOutcome {
  const base = {
    category: 'earning' as const,
    method: agreement.method,
    payAgreementId: agreement.id,
    quantityMilli: null as number | null,
    rateMills: null as number | null,
    percentBp: null as number | null,
    rateCents: null as number | null,
    basisCents: null as number | null,
    mileageBasis: null as MileageBasis | null,
    percentIncludesFuelSurcharge: null as boolean | null,
    percentIncludesAccessorials: null as boolean | null,
  }

  if (agreement.method === 'per_mile') {
    const rateMills = agreement.rateMills
    if (rateMills === null || rateMills === undefined) {
      return { kind: 'incomplete', reason: `"${agreement.label}" has no rate per mile.` }
    }
    // THE BASIS IS NEVER DEFAULTED. Not to 'practical', not to anything. An
    // unlabelled CPM is the argument this whole module exists to prevent, and a
    // default is an unlabelled CPM wearing a label somebody else chose.
    const basis = agreement.mileageBasis
    if (!basis) {
      return {
        kind: 'incomplete',
        reason: `"${agreement.label}" does not say which miles it pays on. Set the mileage basis before settling.`,
      }
    }
    const milesMilli = inputs.milesMilli ?? 0
    if (milesMilli <= 0) return { kind: 'no_input' }

    return {
      kind: 'computed',
      line: {
        ...base,
        kind: 'linehaul',
        description: `${agreement.label} — ${formatQuantity(milesMilli)} mi × ${formatRateMills(rateMills)}/mi (${mileageBasisLabel(basis).toLowerCase()} miles)`,
        amountCents: perMileCents(milesMilli, rateMills),
        quantityMilli: milesMilli,
        rateMills,
        mileageBasis: basis,
      },
    }
  }

  if (agreement.method === 'percentage') {
    const percentBp = agreement.percentBp
    if (percentBp === null || percentBp === undefined) {
      return { kind: 'incomplete', reason: `"${agreement.label}" has no percentage.` }
    }
    const fsc = agreement.percentIncludesFuelSurcharge
    const acc = agreement.percentIncludesAccessorials
    // Both flags, explicitly. `?? false` here would be the exact bug the CHECK
    // constraint exists to stop, reintroduced one layer up.
    if (fsc === null || fsc === undefined || acc === null || acc === undefined) {
      return {
        kind: 'incomplete',
        reason: `"${agreement.label}" does not say whether fuel surcharge and accessorials are included. That is the most common settlement dispute there is — set it before settling.`,
      }
    }
    const load = inputs.load
    if (!load) return { kind: 'no_input' }
    // An unpriced load is not a $0.00 load. Rendering it as zero says "this run
    // paid nothing" when the truth is "nobody has typed the rate yet", and those
    // two go to completely different people.
    if (load.linehaulCents === null || load.linehaulCents === undefined) {
      return {
        kind: 'incomplete',
        reason: `"${agreement.label}" pays a share of the load, and the load has no linehaul rate on it yet.`,
      }
    }

    const scope = { includesFuelSurcharge: fsc, includesAccessorials: acc }
    const { basisCents } = percentageBasis(load, scope)

    return {
      kind: 'computed',
      line: {
        ...base,
        kind: 'linehaul',
        description: `${agreement.label} — ${formatPercentBp(percentBp)} of ${describePercentScope(scope)} (${formatCents(basisCents)})`,
        amountCents: percentageCents(basisCents, percentBp),
        percentBp,
        basisCents,
        percentIncludesFuelSurcharge: fsc,
        percentIncludesAccessorials: acc,
      },
    }
  }

  if (agreement.method === 'hourly') {
    const rateCents = agreement.rateCents
    if (rateCents === null || rateCents === undefined) {
      return { kind: 'incomplete', reason: `"${agreement.label}" has no hourly rate.` }
    }
    const hoursMilli = inputs.hoursMilli ?? 0
    if (hoursMilli <= 0) return { kind: 'no_input' }

    return {
      kind: 'computed',
      line: {
        ...base,
        kind: 'other_earning',
        description: `${agreement.label} — ${formatQuantity(hoursMilli)} h × ${formatCents(rateCents)}/h`,
        amountCents: hourlyCents(hoursMilli, rateCents),
        quantityMilli: hoursMilli,
        rateCents,
      },
    }
  }

  // flat_per_trip
  const rateCents = agreement.rateCents
  if (rateCents === null || rateCents === undefined) {
    return { kind: 'incomplete', reason: `"${agreement.label}" has no flat rate.` }
  }
  const quantityMilli = inputs.quantityMilli ?? 0
  if (quantityMilli <= 0) return { kind: 'no_input' }

  return {
    kind: 'computed',
    line: {
      ...base,
      kind: 'stop_pay',
      description: `${agreement.label} — ${formatQuantity(quantityMilli)} × ${formatCents(rateCents)}`,
      amountCents: flatCents(quantityMilli, rateCents),
      quantityMilli,
      rateCents,
    },
  }
}

export interface EarningsResult {
  lines: ComputedLine[]
  /**
   * Agreements that could not be applied, as sentences to put in front of a
   * person. The settlement is INCOMPLETE while this is non-empty — same contract
   * as the IFTA return's `missingRates`.
   */
  problems: string[]
}

/** Every agreement in force, applied. Several at once is the normal case. */
export function computeEarnings(
  agreements: readonly PayAgreement[],
  inputs: PayInputs,
): EarningsResult {
  const lines: ComputedLine[] = []
  const problems: string[] = []
  for (const agreement of agreements) {
    const outcome = computeEarning(agreement, inputs)
    if (outcome.kind === 'computed') lines.push(outcome.line)
    else if (outcome.kind === 'incomplete') problems.push(outcome.reason)
  }
  return { lines, problems }
}

// ---------------------------------------------------------------------------
// The statement total
// ---------------------------------------------------------------------------

/** The stored shape of a line, as far as the total is concerned. */
export interface TotalLine {
  category: SettlementCategory
  amountCents: number
}

export interface SettlementTotals {
  earningsCents: number
  reimbursementsCents: number
  /** Negative or zero. */
  advancesCents: number
  /** Negative or zero. */
  deductionsCents: number
  /** What goes on the cheque. */
  netCents: number
}

/**
 * THE SIGN IS IN THE DATA, NOT IN THIS FUNCTION.
 *
 * Advances and deductions are stored NEGATIVE (a CHECK constraint in
 * 0016_settlements.sql enforces it), so the net is a plain sum with no flipping
 * anywhere. That is the entire reason for the convention: every sign flip in
 * application code is a place where one caller forgets, and a $250 escrow
 * deduction that gets ADDED is a $500 error on a statement — and it looks
 * plausible, which is why it survives to the cheque.
 *
 * The four subtotals are reported separately because the statement prints them
 * separately, and because "he grossed $3,200 and took home $1,900" is the
 * sentence a driver actually checks.
 */
export function settlementTotals(lines: readonly TotalLine[]): SettlementTotals {
  const sum = (category: SettlementCategory) =>
    lines.filter((l) => l.category === category).reduce((n, l) => n + l.amountCents, 0)

  const earningsCents = sum('earning')
  const reimbursementsCents = sum('reimbursement')
  const advancesCents = sum('advance')
  const deductionsCents = sum('deduction')

  return {
    earningsCents,
    reimbursementsCents,
    advancesCents,
    deductionsCents,
    netCents: earningsCents + reimbursementsCents + advancesCents + deductionsCents,
  }
}

/**
 * A positive figure the user typed, turned into the signed value the column
 * stores. THE ONE PLACE this conversion happens.
 *
 * Nobody types "-250" into a deduction box, and a form that demanded it would
 * collect a positive number from somebody eventually. So the form asks for an
 * amount, the category says which direction it goes, and this is the only
 * function that knows. Math.abs first, so a user who DID type the minus sign
 * does not get a deduction that pays him.
 */
export function signedAmount(category: SettlementCategory, cents: number): number {
  const abs = Math.abs(cents)
  return category === 'advance' || category === 'deduction' ? -abs : abs
}

// ---------------------------------------------------------------------------
// Parsing — the units ../loads.ts does not cover
// ---------------------------------------------------------------------------

/**
 * A rate per mile, typed as dollars, into MILLS.
 *
 * Three decimal places, not two, and that is the only reason this is not
 * `parseMoneyToCents`. Real CPM is negotiated in half-cents — $0.585 — and a
 * parser that rounds it to 58 or 59 is $12.50 a week wrong on a 2,500-mile
 * driver. `parseMoneyToCents` correctly refuses three decimals because its
 * column is cents; this one's column is mills.
 *
 * Same technique: the whole part and the fraction are pulled apart as STRINGS
 * and multiplied as integers, so no float ever exists. Never negative — there is
 * no such thing as a negative rate per mile.
 */
export function parseRateToMills(
  raw: FormDataEntryValue | string | null,
  opts: { label: string },
): Parsed<number | null> {
  const s = String(raw ?? '')
    .replace(/[$,\s]/g, '')
    .trim()
  if (s === '') return { ok: true, value: null }

  // '.58' is fifty-eight cents a mile and everyone typing it knows what they
  // mean. Supplying the zero beats arguing with a perfectly clear answer.
  const normalised = s.replace(/^\./, '0.')
  const match = normalised.match(/^(\d+)(?:\.(\d{1,3}))?$/)
  if (!match) {
    return {
      ok: false,
      message: `${opts.label} should be a rate like 0.58 or 0.585.`,
    }
  }
  const [, whole, frac = ''] = match
  // padEnd, not padStart: '.5' is fifty cents a mile, not half a mill.
  const mills = Number(whole) * 1000 + Number(frac.padEnd(3, '0'))
  if (mills <= 0) return { ok: false, message: `${opts.label} has to be more than zero.` }
  // int4 in the column, but the real ceiling is common sense: $100/mi is a typo.
  if (mills > 100_000) {
    return { ok: false, message: `${opts.label} is over $100 a mile — check the decimal point.` }
  }
  return { ok: true, value: mills }
}

/**
 * A percentage, typed as a percentage, into BASIS POINTS.
 *
 * Two decimals, because lease agreements really do say 67.5%. Accepts a typed
 * '%' because people type it. Capped at 100: '750' meaning 75% is a typo every
 * single time it appears, and paying a driver 750% of the load is not a number
 * anyone should be able to save by accident.
 */
export function parsePercentToBp(
  raw: FormDataEntryValue | string | null,
  opts: { label: string },
): Parsed<number | null> {
  const s = String(raw ?? '')
    .replace(/[%,\s]/g, '')
    .trim()
  if (s === '') return { ok: true, value: null }

  const normalised = s.replace(/^\./, '0.')
  const match = normalised.match(/^(\d+)(?:\.(\d{1,2}))?$/)
  if (!match) {
    return { ok: false, message: `${opts.label} should be a percentage like 68 or 67.5.` }
  }
  const [, whole, frac = ''] = match
  const bp = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  if (bp <= 0) return { ok: false, message: `${opts.label} has to be more than zero.` }
  if (bp > 10_000) {
    return {
      ok: false,
      message: `${opts.label} cannot be more than 100% — 68 means 68%, not 6800.`,
    }
  }
  return { ok: true, value: bp }
}

/**
 * A quantity — miles, hours, stops — into THOUSANDTHS.
 *
 * Thousandths rather than whole numbers because hours are typed as 7.5 and
 * mileage from a routing engine occasionally carries a decimal. Whole miles are
 * simply 1250 -> 1_250_000, and nothing about that is lossy.
 */
export function parseQuantityToMilli(
  raw: FormDataEntryValue | string | null,
  opts: { label: string; max?: number },
): Parsed<number | null> {
  const s = String(raw ?? '')
    .replace(/[,\s]/g, '')
    .trim()
  if (s === '') return { ok: true, value: null }

  const normalised = s.replace(/^\./, '0.')
  const match = normalised.match(/^(\d+)(?:\.(\d{1,3}))?$/)
  if (!match) {
    return { ok: false, message: `${opts.label} should be a number like 1250 or 7.5.` }
  }
  const [, whole, frac = ''] = match
  const milli = Number(whole) * 1000 + Number(frac.padEnd(3, '0'))
  const max = opts.max ?? 1_000_000_000
  if (milli > max) {
    return {
      ok: false,
      message: `${opts.label} is larger than this field can hold — check for an extra zero.`,
    }
  }
  return { ok: true, value: milli }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Thousandths back into a readable number: 1_250_000 -> '1,250', 7_500 -> '7.5'.
 *
 * Trailing zeros are dropped because '1,250.000 mi' reads as false precision on
 * a figure that came off a routing engine as a whole number. Built by integer
 * division for the same reason everything else here is.
 */
export function formatQuantity(milli: number | null | undefined): string {
  if (milli === null || milli === undefined || !Number.isFinite(milli)) return '—'
  const negative = milli < 0
  const abs = Math.abs(Math.trunc(milli))
  const whole = Math.trunc(abs / 1000).toLocaleString('en-US')
  const frac = String(abs % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/** Mills back into '$0.585' or '$0.58'. Never '$0.5800000001'. */
export function formatRateMills(mills: number | null | undefined): string {
  if (mills === null || mills === undefined || !Number.isFinite(mills)) return '—'
  const abs = Math.abs(Math.trunc(mills))
  const whole = Math.trunc(abs / 1000).toLocaleString('en-US')
  const frac = String(abs % 1000).padStart(3, '0')
  // A round half-cent keeps its third digit ('0.585'); a plain cent drops it
  // ('0.58'), because '$0.580/mi' looks like a system talking to itself.
  const trimmed = frac.endsWith('0') ? frac.slice(0, 2) : frac
  return `${mills < 0 ? '-' : ''}$${whole}.${trimmed}`
}

/** Basis points back into '68%' or '67.5%'. */
export function formatPercentBp(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return '—'
  const abs = Math.abs(Math.trunc(bp))
  const whole = Math.trunc(abs / 100)
  const frac = String(abs % 100)
    .padStart(2, '0')
    .replace(/0+$/, '')
  return `${bp < 0 ? '-' : ''}${whole}${frac ? `.${frac}` : ''}%`
}

/**
 * Mills back into an input's value: '0.58', '0.585', '' for nothing.
 *
 * Trailing zeros are dropped, so a 58-cent rate comes back into the box as
 * '0.58' and not '0.580'. The three-decimal form survives a round trip through
 * parseRateToMills either way, but '0.580' in a text box gets half-selected by a
 * thumb on a phone and saved as '0.58 0'.
 */
export function millsToInput(mills: number | null | undefined): string {
  if (mills === null || mills === undefined || !Number.isFinite(mills)) return ''
  const abs = Math.abs(Math.trunc(mills))
  const frac = String(abs % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '')
  return `${Math.trunc(abs / 1000)}${frac ? `.${frac}` : ''}`
}

/** Basis points back into an input's value: '67.5', '' for nothing. */
export function bpToInput(bp: number | null | undefined): string {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return ''
  const abs = Math.abs(Math.trunc(bp))
  const frac = String(abs % 100)
    .padStart(2, '0')
    .replace(/0+$/, '')
  return `${Math.trunc(abs / 100)}${frac ? `.${frac}` : ''}`
}

/** Thousandths back into an input's value. */
export function milliToInput(milli: number | null | undefined): string {
  if (milli === null || milli === undefined || !Number.isFinite(milli)) return ''
  const abs = Math.abs(Math.trunc(milli))
  const frac = String(abs % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '')
  return `${Math.trunc(abs / 1000)}${frac ? `.${frac}` : ''}`
}

/**
 * The rate on an agreement, in one string, whatever the method.
 *
 * Exists so a list of four agreements in four methods renders as one column
 * rather than four conditional branches copied across three pages.
 */
export function rateSummary(agreement: PayAgreement): string {
  switch (agreement.method) {
    case 'per_mile':
      return agreement.rateMills == null ? '—' : `${formatRateMills(agreement.rateMills)}/mi`
    case 'percentage':
      return agreement.percentBp == null ? '—' : formatPercentBp(agreement.percentBp)
    case 'hourly':
      return agreement.rateCents == null ? '—' : `${formatCents(agreement.rateCents)}/h`
    default:
      return agreement.rateCents == null ? '—' : formatCents(agreement.rateCents)
  }
}

/**
 * The terms that settle an argument, in one string, or '' when the method has
 * none. Rendered beneath the rate everywhere an agreement or a line is shown.
 *
 * Returns '' rather than something reassuring when a required term is missing:
 * the pages render a visible warning in that case, and a helper that quietly
 * said "practical miles" would be the unlabelled CPM all over again.
 */
export function termsSummary(agreement: PayAgreement): string {
  if (agreement.method === 'per_mile') {
    return agreement.mileageBasis ? `${mileageBasisLabel(agreement.mileageBasis)} miles` : ''
  }
  if (agreement.method === 'percentage') {
    const fsc = agreement.percentIncludesFuelSurcharge
    const acc = agreement.percentIncludesAccessorials
    if (fsc === null || fsc === undefined || acc === null || acc === undefined) return ''
    return `of ${describePercentScope({ includesFuelSurcharge: fsc, includesAccessorials: acc })}`
  }
  return ''
}

/**
 * Is this agreement missing a term that makes it unusable?
 *
 * The pages call this to put a warning chip next to the row. A per-mile
 * agreement with no basis and a percentage with no scope both LOOK complete —
 * they have a rate, and a rate is what people check.
 */
export function missingTerms(agreement: PayAgreement): string | null {
  if (agreement.method === 'per_mile' && !agreement.mileageBasis) {
    return 'No mileage basis. This rate cannot be settled until it says which miles.'
  }
  if (
    agreement.method === 'percentage' &&
    (agreement.percentIncludesFuelSurcharge === null ||
      agreement.percentIncludesFuelSurcharge === undefined ||
      agreement.percentIncludesAccessorials === null ||
      agreement.percentIncludesAccessorials === undefined)
  ) {
    return 'Does not say what the percentage is of. This is the most common settlement dispute.'
  }
  return null
}
