/**
 * The IFTA quarterly return.
 *
 * The whole calculation in one sentence: you owe each jurisdiction tax on the
 * fuel you BURNED there, and you get credit for the tax you already PAID at the
 * pump there. The difference, jurisdiction by jurisdiction, is the return.
 *
 * Fuel burned is not measured — it is derived. You did not buy fuel in every
 * state you drove through, so the fleet's average miles-per-gallon for the
 * quarter is applied to the miles run in each jurisdiction.
 *
 * UNITS (see 0015_ifta.sql): gallons in thousandths, money in cents, tax rates
 * in mills. No floats anywhere in the arithmetic.
 */

export interface MileRow {
  jurisdiction: string
  miles: number
}

export interface FuelRow {
  jurisdiction: string
  gallonsMilli: number
  /** Bulk fuel from an untaxed tank earns NO credit; claiming it is a classic audit finding. */
  taxPaid: boolean
}

export interface RateRow {
  jurisdiction: string
  rateMills: number
}

export type JurisdictionOutcome =
  | { kind: 'computed'; netCents: number; rateMills: number }
  /**
   * We drove there and have no rate on file.
   *
   * Deliberately NOT zero. A missing rate rendered as "$0.00 owed" is a filing
   * that is quietly short, and short filings are what IFTA audits find. The
   * return cannot be completed until a person supplies the rate.
   */
  | { kind: 'rate_unknown' }

export interface JurisdictionLine {
  jurisdiction: string
  miles: number
  /** Thousandths. Derived from miles and fleet MPG, never measured. */
  taxableGallonsMilli: number
  /** Thousandths. Tax-paid purchases only. */
  purchasedGallonsMilli: number
  /** Positive = we owe them. Negative = credit. */
  outcome: JurisdictionOutcome
}

export interface QuarterlyReturn {
  totalMiles: number
  totalGallonsMilli: number
  /** Hundredths of a mile per gallon, so 6.42 mpg is 642. Zero when undefined. */
  mpgCentis: number
  lines: JurisdictionLine[]
  /** Net across every jurisdiction we could compute. */
  netCents: number
  /** Jurisdictions we drove in but cannot price. The return is INCOMPLETE while this is non-empty. */
  missingRates: string[]
  /**
   * Why the return cannot be filed yet, in plain words. Empty when it can.
   *
   * `complete` used to mean only "every jurisdiction has a rate", which let two
   * far worse states through as finished:
   *
   *   - Fuel recorded but no miles yet. This is the NORMAL order of a real
   *     quarter — receipts arrive continuously, miles come off trip sheets at
   *     the end — and it made every jurisdiction a pure credit. The page
   *     announced a refund, in green, as fact.
   *   - An MPG that rounds to zero. Both inputs present, so neither
   *     single-sided check fired, and every taxable-gallon figure multiplied
   *     out to nothing.
   *
   * A return with no derivable MPG is not a return that owes nothing. It is a
   * return nobody can compute.
   */
  blockers: string[]
  /** True only when every jurisdiction is priced AND the MPG is derivable. */
  complete: boolean
}

/**
 * Fleet average MPG for the quarter, in hundredths.
 *
 * IFTA uses one fleet-wide figure rather than per-truck: the return is filed for
 * the fleet, and per-truck averages would not sum to it.
 */
export function fleetMpgCentis(totalMiles: number, totalGallonsMilli: number): number {
  if (totalGallonsMilli <= 0) return 0
  // miles / (gallonsMilli/1000) * 100, arranged so the division happens last.
  return Math.round((totalMiles * 1000 * 100) / totalGallonsMilli)
}

export function quarterlyReturn(args: {
  miles: readonly MileRow[]
  fuel: readonly FuelRow[]
  rates: readonly RateRow[]
}): QuarterlyReturn {
  const totalMiles = args.miles.reduce((n, r) => n + r.miles, 0)
  // EVERY gallon counts toward MPG, taxed or not — the engine burned it either
  // way. Only the CREDIT side cares whether tax was paid.
  const totalGallonsMilli = args.fuel.reduce((n, r) => n + r.gallonsMilli, 0)
  const mpgCentis = fleetMpgCentis(totalMiles, totalGallonsMilli)

  const rateBy = new Map(args.rates.map((r) => [r.jurisdiction, r.rateMills]))

  const jurisdictions = new Set<string>([
    ...args.miles.map((m) => m.jurisdiction),
    ...args.fuel.map((f) => f.jurisdiction),
  ])

  const lines: JurisdictionLine[] = []
  const missingRates: string[] = []
  let netCents = 0

  for (const j of [...jurisdictions].sort()) {
    const miles = args.miles.filter((m) => m.jurisdiction === j).reduce((n, m) => n + m.miles, 0)

    const purchasedGallonsMilli = args.fuel
      .filter((f) => f.jurisdiction === j && f.taxPaid)
      .reduce((n, f) => n + f.gallonsMilli, 0)

    // Gallons burned here = miles here / fleet MPG.
    const taxableGallonsMilli =
      mpgCentis > 0 ? Math.round((miles * 100 * 1000) / mpgCentis) : 0

    const rateMills = rateBy.get(j)
    if (rateMills === undefined) {
      missingRates.push(j)
      lines.push({
        jurisdiction: j,
        miles,
        taxableGallonsMilli,
        purchasedGallonsMilli,
        outcome: { kind: 'rate_unknown' },
      })
      continue
    }

    // net = (burned - purchased) gallons x rate.
    // gallonsMilli x rateMills = millionths of a dollar; /10000 = cents.
    const netGallonsMilli = taxableGallonsMilli - purchasedGallonsMilli
    const cents = Math.round((netGallonsMilli * rateMills) / 10_000)

    netCents += cents
    lines.push({
      jurisdiction: j,
      miles,
      taxableGallonsMilli,
      purchasedGallonsMilli,
      outcome: { kind: 'computed', netCents: cents, rateMills },
    })
  }

  const blockers: string[] = []
  if (totalMiles > 0 && totalGallonsMilli === 0) {
    blockers.push(
      'Miles are recorded but no fuel is. Every jurisdiction would price at nothing, ' +
        'which files short.',
    )
  }
  if (totalGallonsMilli > 0 && totalMiles === 0) {
    blockers.push(
      'Fuel is recorded but no miles are. Every jurisdiction would come out as a pure ' +
        'credit, and the return would claim money back that is not owed.',
    )
  }
  if (totalMiles > 0 && totalGallonsMilli > 0 && mpgCentis === 0) {
    blockers.push(
      'The miles and gallons on file give a fleet average that rounds to zero, so no ' +
        'taxable gallons can be derived. Usually a gallons figure is in the wrong unit.',
    )
  }
  if (missingRates.length > 0) {
    blockers.push(
      `No tax rate on file for ${missingRates.join(', ')}. Those miles are known; the tax ` +
        'on them is not.',
    )
  }

  return {
    totalMiles,
    totalGallonsMilli,
    mpgCentis,
    lines,
    netCents,
    missingRates,
    blockers,
    complete: blockers.length === 0,
  }
}

/** The quarter a date falls in, as its first day. */
export function quarterStart(d: Date): Date {
  const q = Math.floor(d.getUTCMonth() / 3)
  return new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1))
}

/**
 * When the return for a quarter is due: the last day of the month following it.
 *
 * Apr 30, Jul 31, Oct 31, Jan 31. Required EVEN WITH ZERO TAX OWED and even if
 * the truck never left the state — a nil return is still a return, and the
 * penalty for not filing is $50 or 10% of the tax due, whichever is greater.
 */
export function returnDueOn(periodStart: Date): Date {
  const y = periodStart.getUTCFullYear()
  const m = periodStart.getUTCMonth()
  // Quarter ends at m+2; the return is due the last day of m+3.
  const nominal = new Date(Date.UTC(y, m + 4, 0))

  // Rolled to the next business day, because two of the next four deadlines
  // fall on a weekend: 31 Oct 2026 is a Saturday and 31 Jan 2027 a Sunday.
  //
  // Without this the page called a return OVERDUE on a day it was not late —
  // and a false accusation is the fastest way to teach somebody that the
  // warnings here are noise, after which the true ones are gone too.
  //
  // Weekends only. Public holidays would need a calendar per jurisdiction, and
  // being a day EARLY on a holiday is the safe direction; being a day late is
  // not.
  const day = nominal.getUTCDay()
  if (day === 6) return new Date(nominal.getTime() + 2 * 86_400_000) // Sat -> Mon
  if (day === 0) return new Date(nominal.getTime() + 86_400_000) // Sun -> Mon
  return nominal
}

export function quarterLabel(periodStart: Date): string {
  const q = Math.floor(periodStart.getUTCMonth() / 3) + 1
  return `Q${q} ${periodStart.getUTCFullYear()}`
}

/** Display helpers. Thousandths and mills are storage units, not reading units. */
export const gallons = (milli: number) => (milli / 1000).toFixed(3)
export const mpg = (centis: number) => (centis / 100).toFixed(2)
export const rate = (mills: number) => `$${(mills / 1000).toFixed(3)}`
