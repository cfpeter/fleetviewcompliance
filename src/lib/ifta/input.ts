/**
 * The boundary between what a person types and what the IFTA tables store.
 *
 * src/lib/ifta/compute.ts does the return. This file does the other half of the
 * same promise: nothing reaches those tables as a float, and nothing reaches
 * them rounded in a direction nobody chose. Every function here turns a string
 * off a form — or a row off the rates table — into the exact integer unit
 * 0015_ifta.sql declares:
 *
 *   gallons   — THOUSANDTHS of a gallon (125.400 gal -> 125400)
 *   money     — integer cents (parseMoneyToCents in src/lib/loads.ts)
 *   tax rates — MILLS, thousandths of a dollar ($0.979/gal -> 979)
 *
 * Also here: the quarter arithmetic the pages need that the return itself does
 * not — which quarters to offer, where a quarter ends, how many days are left
 * before the filing deadline, and which of several dated rate rows is the one in
 * force. None of it re-derives anything compute.ts already owns; it composes
 * `quarterStart()` rather than doing month division a second time, because two
 * implementations of "which quarter is this" is two answers on 31 March.
 */

import { todayInCalifornia } from '../drivers.ts'
// The result shape is loads.ts's, deliberately, rather than a third copy of the
// same discriminated union. The note at the top of loads.ts is about its MONEY
// PARSING not being generic — `Parsed<T>` itself is, and every form in the app
// already reads it the same way.
import type { Parsed } from '../loads.ts'
import { quarterStart, type RateRow } from './compute.ts'

// ---------------------------------------------------------------------------
// Jurisdictions
// ---------------------------------------------------------------------------

export interface Jurisdiction {
  code: string
  name: string
  country: 'US' | 'CA'
}

/**
 * The 58 IFTA member jurisdictions, and it is NOT the US state list.
 *
 * Three differences, each of which is a wrong return if it is got wrong:
 *
 *  - Alaska and Hawaii are not IFTA members. No bridge reaches them, so no
 *    apportioned mile is ever run there.
 *  - The District of Columbia is not a member either, which surprises everyone;
 *    miles run in DC are not reported on this return.
 *  - Ten Canadian provinces ARE members. A carrier running Vancouver out of
 *    Blaine owes Alberta and British Columbia on the same form as California,
 *    and a US-states dropdown silently tells him those miles do not count.
 *
 * `US_STATE_CODES` in src/lib/drivers.ts is the list for a driver's LICENCE and
 * is right for that job — 50 states plus DC. Reusing it here would offer AK, HI
 * and DC, which cannot be filed, and would omit every province, which must be.
 */
export const IFTA_JURISDICTIONS: readonly Jurisdiction[] = [
  { code: 'AL', name: 'Alabama', country: 'US' },
  { code: 'AZ', name: 'Arizona', country: 'US' },
  { code: 'AR', name: 'Arkansas', country: 'US' },
  { code: 'CA', name: 'California', country: 'US' },
  { code: 'CO', name: 'Colorado', country: 'US' },
  { code: 'CT', name: 'Connecticut', country: 'US' },
  { code: 'DE', name: 'Delaware', country: 'US' },
  { code: 'FL', name: 'Florida', country: 'US' },
  { code: 'GA', name: 'Georgia', country: 'US' },
  { code: 'ID', name: 'Idaho', country: 'US' },
  { code: 'IL', name: 'Illinois', country: 'US' },
  { code: 'IN', name: 'Indiana', country: 'US' },
  { code: 'IA', name: 'Iowa', country: 'US' },
  { code: 'KS', name: 'Kansas', country: 'US' },
  { code: 'KY', name: 'Kentucky', country: 'US' },
  { code: 'LA', name: 'Louisiana', country: 'US' },
  { code: 'ME', name: 'Maine', country: 'US' },
  { code: 'MD', name: 'Maryland', country: 'US' },
  { code: 'MA', name: 'Massachusetts', country: 'US' },
  { code: 'MI', name: 'Michigan', country: 'US' },
  { code: 'MN', name: 'Minnesota', country: 'US' },
  { code: 'MS', name: 'Mississippi', country: 'US' },
  { code: 'MO', name: 'Missouri', country: 'US' },
  { code: 'MT', name: 'Montana', country: 'US' },
  { code: 'NE', name: 'Nebraska', country: 'US' },
  { code: 'NV', name: 'Nevada', country: 'US' },
  { code: 'NH', name: 'New Hampshire', country: 'US' },
  { code: 'NJ', name: 'New Jersey', country: 'US' },
  { code: 'NM', name: 'New Mexico', country: 'US' },
  { code: 'NY', name: 'New York', country: 'US' },
  { code: 'NC', name: 'North Carolina', country: 'US' },
  { code: 'ND', name: 'North Dakota', country: 'US' },
  { code: 'OH', name: 'Ohio', country: 'US' },
  { code: 'OK', name: 'Oklahoma', country: 'US' },
  { code: 'OR', name: 'Oregon', country: 'US' },
  { code: 'PA', name: 'Pennsylvania', country: 'US' },
  { code: 'RI', name: 'Rhode Island', country: 'US' },
  { code: 'SC', name: 'South Carolina', country: 'US' },
  { code: 'SD', name: 'South Dakota', country: 'US' },
  { code: 'TN', name: 'Tennessee', country: 'US' },
  { code: 'TX', name: 'Texas', country: 'US' },
  { code: 'UT', name: 'Utah', country: 'US' },
  { code: 'VT', name: 'Vermont', country: 'US' },
  { code: 'VA', name: 'Virginia', country: 'US' },
  { code: 'WA', name: 'Washington', country: 'US' },
  { code: 'WV', name: 'West Virginia', country: 'US' },
  { code: 'WI', name: 'Wisconsin', country: 'US' },
  { code: 'WY', name: 'Wyoming', country: 'US' },
  { code: 'AB', name: 'Alberta', country: 'CA' },
  { code: 'BC', name: 'British Columbia', country: 'CA' },
  { code: 'MB', name: 'Manitoba', country: 'CA' },
  { code: 'NB', name: 'New Brunswick', country: 'CA' },
  { code: 'NL', name: 'Newfoundland and Labrador', country: 'CA' },
  { code: 'NS', name: 'Nova Scotia', country: 'CA' },
  { code: 'ON', name: 'Ontario', country: 'CA' },
  { code: 'PE', name: 'Prince Edward Island', country: 'CA' },
  { code: 'QC', name: 'Quebec', country: 'CA' },
  { code: 'SK', name: 'Saskatchewan', country: 'CA' },
]

const JURISDICTION_BY_CODE = new Map(IFTA_JURISDICTIONS.map((j) => [j.code, j]))

export function isIftaJurisdiction(code: string): boolean {
  return JURISDICTION_BY_CODE.has(code)
}

/** 'CA' -> 'California'. Unknown codes render as themselves, never as blank. */
export function jurisdictionName(code: string): string {
  return JURISDICTION_BY_CODE.get(code)?.name ?? code
}

/**
 * A jurisdiction code off a `<select>`, upper-cased, or a refusal.
 *
 * `jurisdiction` is plain `text` in 0015_ifta.sql with no check constraint and no
 * foreign key, so Postgres will happily store 'Californa' — and that row then
 * appears as its own line on the return, splitting the state's miles in two and
 * reporting both halves short. The database cannot catch this one; here is the
 * only place it can be caught.
 */
export function parseJurisdiction(
  raw: FormDataEntryValue | string | null,
  opts: { label: string },
): Parsed<string> {
  const code = String(raw ?? '')
    .trim()
    .toUpperCase()
  if (code === '') return { ok: false, message: `Pick a ${opts.label.toLowerCase()}.` }
  if (!isIftaJurisdiction(code)) {
    return {
      ok: false,
      message: `${code} is not an IFTA jurisdiction. Alaska, Hawaii and DC are not members, and their miles are not reported here.`,
    }
  }
  return { ok: true, value: code }
}

// ---------------------------------------------------------------------------
// Gallons — thousandths, never floats
// ---------------------------------------------------------------------------

/**
 * 100,000 gallons on one receipt.
 *
 * `gallons_milli` is `bigint`, so the column is in no danger; this ceiling is a
 * typo catcher, not a storage limit. A truck's saddle tanks hold ~300 gallons
 * and a full tanker delivery into a bulk tank is ~8,000, so anything past this
 * is a stray digit — and a stray digit in GALLONS is the worst single typo on
 * these screens: it inflates fleet MPG, which shrinks the taxable gallons
 * computed for EVERY jurisdiction at once, which under-reports the whole return
 * rather than one line of it.
 */
export const MAX_GALLONS_MILLI = 100_000_000

/**
 * Gallons as printed on a pump receipt, to thousandths of a gallon.
 *
 * THE PAD IS THE BUG, and it is `padEnd`, never `padStart`. '125.4' has a
 * fractional part of '4', which is four TENTHS — 400 thousandths. Padded from
 * the left it becomes 004 and the row stores 125.004 gallons: a 0.4-gallon
 * receipt line silently short by 396 thousandths, every time, on the number the
 * entire return is derived from. The same mistake in the money parser costs a
 * cent; here it costs the MPG that prices all fifty-eight lines.
 *
 * THE FLOAT IS THE OTHER BUG. `Math.round(Number(s) * 1000)` is right for most
 * inputs and wrong for some, and 0015_ifta.sql is explicit that a quarter is a
 * sum of hundreds of these. So the whole and fractional parts are pulled apart
 * as STRINGS and combined as integers; no float is ever constructed.
 *
 * More than three decimals is refused rather than rounded, for the same reason
 * the money parser refuses three: rounding silently changes what she typed on a
 * number that becomes a tax filing. The shape that lands here is a per-gallon
 * PRICE pasted into the gallons box ('4.2599'), and it deserves a sentence, not
 * a quiet 4.260.
 */
export function parseGallonsToMilli(
  raw: FormDataEntryValue | string | null,
  opts: { label: string },
): Parsed<number> {
  // A receipt pasted whole often carries its unit: '125.400 GAL'. Stripped as a
  // trailing token only — a blanket replace of 'gal' would turn the junk
  // '12gal5' into a confident 125.
  let s = String(raw ?? '')
    .trim()
    .replace(/\s*gal(?:s|lon|lons)?\.?$/i, '')
    .replace(/\s+/g, '')

  if (s === '') {
    return { ok: false, message: `${opts.label} are required — the receipt prints them.` }
  }

  // Note what is NOT stripped: a dollar sign. The gallons box and the total-cost
  // box sit beside each other on the fuel form, and '$125.40' in this one means
  // the two got swapped. Stripping the '$' would store the dollars as gallons
  // and quietly ruin the quarter's MPG; letting it fall through to the refusal
  // below puts the mistake on screen while she is still looking at the receipt.
  if (s.includes(',')) {
    // Commas are a thousands separator here and nothing else. '12,5' typed as a
    // European decimal would otherwise strip to '125' — a ten-times error in the
    // one figure that prices every jurisdiction.
    if (!/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
      return {
        ok: false,
        message: `${opts.label} has a comma in an odd place — write it as 1250.5 or 1,250.500.`,
      }
    }
    s = s.replace(/,/g, '')
  }

  // '.5' is half a gallon and the person typing it knows exactly what they mean.
  const normalised = s.replace(/^(-?)\./, '$10.')

  // Caught before the general refusal so the message can name the real cause.
  if (/^-?\d+\.\d{4,}$/.test(normalised)) {
    return {
      ok: false,
      message: `${opts.label} are kept to three decimals, as the pump prints them. Check this is not the price per gallon.`,
    }
  }

  const match = normalised.match(/^(-?)(\d+)(?:\.(\d{1,3}))?$/)
  if (!match) {
    return {
      ok: false,
      message: `${opts.label} should be a number like 125.4 or 125.400 — no dollar sign, that is the cost box.`,
    }
  }

  const [, sign, whole, frac = ''] = match
  if (sign === '-') {
    // The check constraint is `gallons_milli > 0`, so Postgres would refuse this
    // too — with a sentence naming a constraint, after losing everything else
    // she typed into the form.
    return { ok: false, message: `${opts.label} cannot be negative.` }
  }

  // padEnd. See the note above; this single character is the whole function.
  const milli = Number(whole) * 1000 + Number(frac.padEnd(3, '0'))

  if (milli === 0) {
    return {
      ok: false,
      message: `A purchase of zero ${opts.label.toLowerCase()} is not a purchase — leave the receipt out, or type what it says.`,
    }
  }
  if (milli > MAX_GALLONS_MILLI) {
    return {
      ok: false,
      message: `${opts.label} are larger than a tanker delivery — check for an extra zero.`,
    }
  }
  return { ok: true, value: milli }
}

/**
 * What one receipt worked out to per gallon, in MILLS — the same unit the tax
 * rates are kept in, so the two read side by side.
 *
 * This is a cross-check, not a stored value, and it is the cheapest one on the
 * fuel screen: a gallons figure mistyped by a factor of ten shows up here as
 * $0.40 or $40.000 a gallon, which is obvious at a glance in a way that "1254.0
 * gallons" in a long list is not. Integer throughout —
 * cents x 10,000 / thousandths is dollars-per-gallon in thousandths — because a
 * float here would print $3.999 for a receipt that says $4.00.
 *
 * NULL when either side is missing or zero: a receipt with no total is a normal
 * row (the gallons are what the return needs), and a division by zero gallons
 * would render Infinity in a money column.
 */
export function pricePerGallonMills(
  totalCents: number | null | undefined,
  gallonsMilli: number | null | undefined,
): number | null {
  if (!totalCents || !gallonsMilli || gallonsMilli <= 0) return null
  return Math.round((totalCents * 10_000) / gallonsMilli)
}

/**
 * The largest mileage one truck can plausibly run in one jurisdiction in one
 * quarter. `miles` is int4, so this is again a typo catcher rather than a limit:
 * ninety days at an illegal 2,750 miles a day. An extra zero here over-reports
 * one jurisdiction and, because the miles feed the taxable-gallon split, quietly
 * under-reports every other one.
 */
export const MAX_QUARTER_MILES = 1_000_000

/**
 * Whole miles for one jurisdiction, or null for a box left alone.
 *
 * ZERO IS A REAL ANSWER and is not the same as blank. Re-entering a jurisdiction
 * corrects it through the unique constraint, so typing 0 over a mistaken 4,000
 * is how that row is taken back down to nothing; blank means "I did not touch
 * this row" and must leave the stored figure exactly where it is.
 */
export function parseMiles(
  raw: FormDataEntryValue | string | null,
  opts: { label: string },
): Parsed<number | null> {
  // An owner types 12,450 off a trip sheet, and `Number('12,450')` is NaN.
  const s = String(raw ?? '')
    .trim()
    .replace(/[,\s]/g, '')
  if (s === '') return { ok: true, value: null }

  // Whole miles only. A decimal here is a trip-sheet odometer reading pasted in
  // by mistake, and rounding it would hide that.
  if (!/^-?\d+$/.test(s)) {
    return { ok: false, message: `${opts.label} should be whole miles, like 4820, or left blank.` }
  }
  const n = Number(s)
  if (n < 0) return { ok: false, message: `${opts.label} cannot be negative.` }
  if (n > MAX_QUARTER_MILES) {
    return {
      ok: false,
      message: `${opts.label} is more than a truck can run in a quarter — check for an extra zero.`,
    }
  }
  return { ok: true, value: n }
}

// ---------------------------------------------------------------------------
// Quarters
// ---------------------------------------------------------------------------

/** A `date` column's shape, and an `<input type="date">`'s: 'YYYY-MM-DD'. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Today, as UTC midnight of the CARRIER's day.
 *
 * Not `new Date()`. Every date function in compute.ts reads UTC fields, and
 * after 5pm Pacific on 31 December the UTC date is already 1 January — so a
 * plain `new Date()` would open this section on Q1 of next year and print next
 * April's deadline, on the evening a Q4 return is being worked on. Going through
 * the carrier's own day first is what stops that.
 */
export function carrierToday(): Date {
  return new Date(`${todayInCalifornia()}T00:00:00Z`)
}

/** The quarter after this one, as its first day. */
export function nextQuarterStart(periodStart: Date): Date {
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 3, 1))
}

/**
 * The quarter containing `d`, then the ones before it, newest first.
 *
 * Built by stepping back three months at a time from a quarter start, and handed
 * through `quarterStart()` each time rather than trusted — Date.UTC normalises
 * a negative month into the previous year, and this is the one place a quarter
 * list could silently produce 2026-00-01.
 */
export function recentQuarters(d: Date, count: number): Date[] {
  const first = quarterStart(d)
  const out: Date[] = []
  for (let i = 0; i < count; i++) {
    out.push(
      quarterStart(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - i * 3, 1))),
    )
  }
  return out
}

/**
 * The quarter a `?q=` parameter asks for, snapped to its first day.
 *
 * Three failures this prevents, all reached by an edited or stale URL:
 *  - '?q=banana' handed to `.eq('period_start', …)` is not an empty result, it
 *    is `invalid input syntax for type date` across the top of the page.
 *  - '?q=2026-08-15' is a real date in the middle of Q3. Queried literally it
 *    matches no `period_start` row at all, and the page would render an empty
 *    quarter — which on a filing screen reads as "you ran nothing", the single
 *    most expensive wrong answer this section can give.
 *  - A missing parameter is the normal case, not an error: the section opens on
 *    the quarter being lived in.
 */
export function periodFromParam(raw: string | null, today: Date): Date {
  if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00Z`)
    // The round trip is the real check, and it is not belt-and-braces: contrary
    // to what the ISO format promises, `new Date('2026-02-30T00:00:00Z')` does
    // not fail — V8 rolls it forward to 2 March. A NaN check alone therefore
    // accepts impossible days and lands on whichever quarter the rollover
    // happens to reach, which for '2026-03-32' is the NEXT quarter. Comparing
    // the parsed day back to the string is what refuses a date that never was.
    if (!Number.isNaN(parsed.getTime()) && isoDay(parsed) === raw) return quarterStart(parsed)
  }
  return quarterStart(today)
}

/**
 * Whole days from `today` until `due`, negative once the deadline has passed.
 *
 * Both sides are UTC midnights — `returnDueOn()` returns one and `carrierToday()`
 * makes one — so this is exact integer division with no daylight-saving hour to
 * lose. Doing it on local Dates instead would put a 23-hour day into the March
 * count and round "due tomorrow" down to "due today".
 */
export function daysUntil(due: Date, today: Date): number {
  return Math.round((due.getTime() - today.getTime()) / 86_400_000)
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** A row as it comes off `ifta_rates`. */
export interface RateSourceRow {
  jurisdiction: string
  fuel_type: string
  period_start: string
  rate_mills: number
}

/**
 * Diesel. The only fuel this product prices.
 *
 * `fuel_purchases` has no fuel_type column, so every gallon recorded here is
 * implicitly diesel — which is right for a small California carrier and wrong
 * the day a reefer's gasoline pickup is typed in. `ifta_rates` IS keyed by fuel
 * type, so the filter has to be applied somewhere; applied here it means a
 * gasoline rate row added later cannot silently become "the latest rate" for a
 * jurisdiction and price the whole return at the wrong number.
 */
export const FUEL_TYPE = 'diesel'

/**
 * The rate in force for each jurisdiction in a given quarter.
 *
 * `ifta_rates` is effective-dated: its primary key is (jurisdiction, fuel_type,
 * period_start) and rates change quarterly, so a jurisdiction accumulates one
 * row per change and the one that applies is the LATEST row starting on or
 * before the quarter being filed. The seeded CA row starts 2026-07-01 and is
 * therefore the rate for Q3 2026 and every quarter after it — not for Q2 2026,
 * where CA correctly has no rate at all.
 *
 * Picking the latest is done here rather than in the query because PostgREST has
 * no DISTINCT ON, and doing it in the page would make it untestable. Getting it
 * wrong in the other direction — taking the FIRST row, or any row — prices a
 * quarter at a superseded rate, which is a return that is short by exactly the
 * rate change and reconciles against nothing.
 *
 * A jurisdiction with no qualifying row is deliberately ABSENT from the result
 * rather than present with a zero: `quarterlyReturn()` reads a missing entry as
 * `rate_unknown` and refuses to complete the return. A zero here would be a
 * silent $0.00 owed for a state the truck drove through.
 */
export function effectiveRates(
  rows: readonly RateSourceRow[],
  periodStart: Date,
  fuelType: string = FUEL_TYPE,
): RateRow[] {
  const asOf = isoDay(periodStart)
  const best = new Map<string, RateSourceRow>()

  for (const row of rows) {
    if (row.fuel_type !== fuelType) continue
    // ISO dates compare correctly as strings, which avoids parsing a date only
    // to compare it. 'YYYY-MM-DD' is lexicographically ordered by design.
    if (row.period_start > asOf) continue
    const held = best.get(row.jurisdiction)
    if (!held || row.period_start > held.period_start) best.set(row.jurisdiction, row)
  }

  return [...best.values()]
    .map((r) => ({ jurisdiction: r.jurisdiction, rateMills: r.rate_mills }))
    .sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction))
}

/**
 * Whether a single receipt looks physically possible.
 *
 * The page already computes $/gal as a cross-check and already warns when the
 * FLEET average MPG is absurd. Neither points at the receipt that caused it, and
 * the fleet warning only fires once the quarter is wrong as a whole — by which
 * point the office manager has to audit every row by eye to find the one.
 *
 * Found by entering real data: a row reading 1,332.000 gallons for $787.00 sat
 * in the list with no comment. A tractor's tanks hold 120-300 gallons; 1,332 in
 * one purchase is not a big fill, it is the gallons and dollars boxes swapped.
 * That single row dragged the whole quarter's MPG to 0.48 and would have priced
 * every jurisdiction wrong.
 *
 * These are ADVISORY. They never block a save — a reefer fill, a bulk delivery
 * into a yard tank, or a genuinely strange price all exist — but the row says so
 * rather than leaving the arithmetic to be discovered at the return.
 */
export interface Implausibility {
  what: 'gallons' | 'price'
  message: string
}

/** A tractor's saddle tanks. Above this is a bulk delivery or a typo. */
const MAX_SINGLE_FILL_GALLONS = 400
/** Diesel has not been near either of these in decades. */
const MIN_SENSIBLE_PRICE_MILLS = 1_000 // $1.00
const MAX_SENSIBLE_PRICE_MILLS = 12_000 // $12.00

export function implausible(
  gallonsMilli: number,
  totalCents: number | null | undefined,
): Implausibility[] {
  const out: Implausibility[] = []

  if (gallonsMilli > MAX_SINGLE_FILL_GALLONS * 1000) {
    out.push({
      what: 'gallons',
      message:
        `${(gallonsMilli / 1000).toFixed(0)} gallons in one purchase. A tractor holds ` +
        `120–300. Check the gallons and cost boxes were not swapped — if this really is ` +
        `a bulk delivery into a yard tank, untick "tax paid" as well.`,
    })
  }

  const price = pricePerGallonMills(totalCents ?? null, gallonsMilli)
  if (price !== null && price > 0) {
    if (price < MIN_SENSIBLE_PRICE_MILLS) {
      out.push({
        what: 'price',
        message:
          `That works out to $${(price / 1000).toFixed(3)} a gallon. Diesel has not been ` +
          `that cheap in decades — usually it means the gallons figure is too large.`,
      })
    } else if (price > MAX_SENSIBLE_PRICE_MILLS) {
      out.push({
        what: 'price',
        message:
          `That works out to $${(price / 1000).toFixed(2)} a gallon, which is far above ` +
          `pump price — usually it means the gallons figure is too small.`,
      })
    }
  }

  return out
}
