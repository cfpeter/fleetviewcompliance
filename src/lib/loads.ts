/**
 * Loads: the two independent vocabularies, the money, and the lane.
 *
 * The one thing to hold on to while reading this file: `status` and `billing`
 * are NOT two halves of one pipeline. 0009_loads.sql made them separate enums on
 * purpose, and every helper below keeps them separate — separate label lists,
 * separate pill colours, separate setters on the page. The moment one function
 * derives one from the other, "delivered but not invoiced" becomes an error
 * state in the code, and it is the single most normal thing in a small carrier's
 * week.
 *
 * `exception` is a third, orthogonal thing. It sits ALONGSIDE the status. There
 * is deliberately no helper here that turns an exception into a status, because
 * a detained truck is still at_shipper and losing that loses where the truck is.
 *
 * The text/number parsing at the bottom duplicates shapes that also exist in
 * drivers.ts and vehicles.ts. That duplication is deliberate for now and matches
 * the note at the top of drivers.ts: a shared `forms.ts` written on the third
 * caller is a module; written on the first it is a guess. When someone does
 * hoist it, this file's money parsing must NOT go with it — it is not generic,
 * it is specific to an int4 cents column.
 */

export type LoadStatus =
  | 'quoted'
  | 'booked'
  | 'assigned'
  | 'dispatched'
  | 'at_shipper'
  | 'loaded'
  | 'in_transit'
  | 'at_consignee'
  | 'delivered'
  | 'pod_received'

export type LoadException = 'detained' | 'breakdown' | 'late' | 'cancelled' | 'tonu'

export type BillingStatus =
  | 'not_ready'
  | 'ready_to_invoice'
  | 'invoiced'
  | 'submitted_to_factor'
  | 'funded'
  | 'paid'
  | 'closed'
  | 'short_paid'
  | 'in_dispute'
  | 'written_off'

export interface Choice<T extends string> {
  value: T
  label: string
  /** The sentence under the option, where the word alone is ambiguous. */
  help?: string
}

/**
 * Where the truck is. In the order it actually happens, because the select on
 * the load page is read as a timeline even though nothing here enforces one —
 * a load can jump from booked straight to delivered when the owner drove it
 * himself and updated the screen that evening.
 *
 * These strings are the enum labels from 0009_loads.sql, spelled exactly. A typo
 * is not a crash, it is `invalid input value for enum load_status` across the
 * top of a dispatcher's screen at 6am.
 */
export const LOAD_STATUSES: readonly Choice<LoadStatus>[] = [
  { value: 'quoted', label: 'Quoted', help: 'Priced, not committed.' },
  { value: 'booked', label: 'Booked', help: 'Rate confirmation signed. No truck on it yet.' },
  { value: 'assigned', label: 'Assigned', help: 'A driver and equipment are on it.' },
  { value: 'dispatched', label: 'Dispatched', help: 'The driver has been told.' },
  { value: 'at_shipper', label: 'At shipper' },
  { value: 'loaded', label: 'Loaded' },
  { value: 'in_transit', label: 'In transit' },
  { value: 'at_consignee', label: 'At consignee' },
  { value: 'delivered', label: 'Delivered', help: 'Freight is off. Says nothing about billing.' },
  { value: 'pod_received', label: 'POD received', help: 'Signed delivery receipt is in hand.' },
]

/**
 * What is going wrong, while the status keeps saying where the truck is.
 *
 * TONU — truck ordered, not used — is here rather than in the status list for
 * the same reason: it is a thing that happened TO the load, and the load still
 * has a billing life afterwards. It is usually the most collectable $150 on the
 * board and it is the one most often forgotten.
 */
export const LOAD_EXCEPTIONS: readonly Choice<LoadException>[] = [
  { value: 'detained', label: 'Detained', help: 'Sitting past the free hours.' },
  { value: 'breakdown', label: 'Breakdown' },
  { value: 'late', label: 'Late', help: 'Will miss, or has missed, an appointment.' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'tonu', label: 'TONU', help: 'Truck ordered, not used. Usually still billable.' },
]

/**
 * Where the money is. Completely independent of the list above.
 *
 * `submitted_to_factor` and `funded` are two different days and two different
 * amounts — the factor advances a percentage on submission and releases the
 * reserve when the broker pays. Collapsing them is how a carrier loses track of
 * the reserve, which is the part nobody chases.
 */
export const BILLING_STATUSES: readonly Choice<BillingStatus>[] = [
  { value: 'not_ready', label: 'Not ready', help: 'Paperwork is not complete.' },
  { value: 'ready_to_invoice', label: 'Ready to invoice', help: 'Everything needed is in hand.' },
  { value: 'invoiced', label: 'Invoiced' },
  { value: 'submitted_to_factor', label: 'Sent to factor' },
  { value: 'funded', label: 'Funded', help: 'The factor advanced. The reserve is still out.' },
  { value: 'paid', label: 'Paid' },
  { value: 'closed', label: 'Closed' },
  { value: 'short_paid', label: 'Short paid', help: 'Paid less than invoiced.' },
  { value: 'in_dispute', label: 'In dispute' },
  { value: 'written_off', label: 'Written off' },
]

/**
 * Enum guards.
 *
 * Every one of these exists because PostgREST hands an unrecognised string
 * straight to Postgres, which raises `invalid input value for enum` — a 500 on
 * a page reached by clearing a filter or by a browser replaying an old URL after
 * we rename a value. A guard turns that into "show everything" instead.
 */
export function isLoadStatus(value: string): value is LoadStatus {
  return LOAD_STATUSES.some((s) => s.value === value)
}

export function isLoadException(value: string): value is LoadException {
  return LOAD_EXCEPTIONS.some((s) => s.value === value)
}

export function isBillingStatus(value: string): value is BillingStatus {
  return BILLING_STATUSES.some((s) => s.value === value)
}

function labelOf<T extends string>(list: readonly Choice<T>[], value: string | null): string {
  return list.find((c) => c.value === value)?.label ?? value ?? ''
}

export const loadStatusLabel = (v: string | null): string => labelOf(LOAD_STATUSES, v)
export const billingStatusLabel = (v: string | null): string => labelOf(BILLING_STATUSES, v)
export const exceptionLabel = (v: string | null): string => labelOf(LOAD_EXCEPTIONS, v)

/**
 * Pill colours for where the truck is.
 *
 * Nothing in here is red. Red on this product means "a regulator will fine you",
 * and an operational status is never that — the load moving slowly is not a
 * compliance failure. The exception pill is the thing allowed to be loud, and it
 * is rendered NEXT TO this one rather than replacing it.
 *
 * The returned classes are the shared badge classes from src/styles/global.css,
 * which has five pairs and no more. Several branches therefore hand back the
 * same pair — every stage between booked and delivered is one blue — and that is
 * the intent rather than a shortcut: the WORD in the pill says which stage it is,
 * and a nine-step colour ramp is nine shades nobody can tell apart on a phone in
 * daylight. Colour carries "not started / moving / done" and nothing finer.
 */
export function statusPillClass(status: string | null): string {
  switch (status) {
    case 'quoted':
      return 'badge badge-neutral'
    case 'booked':
      return 'badge badge-info'
    case 'assigned':
    case 'dispatched':
      return 'badge badge-info'
    case 'at_shipper':
    case 'loaded':
    case 'in_transit':
    case 'at_consignee':
      return 'badge badge-info'
    case 'delivered':
    case 'pod_received':
      return 'badge badge-success'
    default:
      return 'badge badge-neutral'
  }
}

/**
 * Pill colours for where the money is.
 *
 * `ready_to_invoice` is amber on purpose and it is the only amber in the list:
 * it is the one state that is nobody's fault and entirely ours to fix, and it is
 * where a small carrier's cash actually gets stuck. Everything downstream of it
 * is waiting on somebody else.
 */
export function billingPillClass(billing: string | null): string {
  switch (billing) {
    case 'not_ready':
      return 'badge badge-neutral'
    case 'ready_to_invoice':
      return 'badge badge-warning'
    case 'invoiced':
      return 'badge badge-info'
    case 'submitted_to_factor':
      return 'badge badge-info'
    case 'funded':
      return 'badge badge-success'
    case 'paid':
      return 'badge badge-success'
    case 'closed':
      return 'badge badge-neutral'
    case 'short_paid':
    case 'in_dispute':
      return 'badge badge-danger'
    case 'written_off':
      return 'badge badge-danger'
    default:
      return 'badge badge-neutral'
  }
}

/** Amber for "costing us time", red for "costing us the load". */
export function exceptionPillClass(exception: string | null): string {
  switch (exception) {
    case 'detained':
    case 'late':
    case 'tonu':
      return 'badge badge-warning'
    case 'breakdown':
    case 'cancelled':
      return 'badge badge-danger'
    default:
      return 'badge badge-neutral'
  }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * What to call this load on screen.
 *
 * The broker's reference comes FIRST when we have no number of our own, because
 * the dispatcher is holding a rate confirmation with the broker's number printed
 * on it and nothing else. A row labelled "Load —" is a row she cannot match to
 * the paper in her hand, which is the whole reason this product exists.
 *
 * Both columns are nullable in the schema and the create form only insists that
 * ONE of them is filled, so this has to survive either being missing.
 */
export function loadLabel(load: {
  load_number?: string | null
  broker_reference?: string | null
}): string {
  const mine = (load.load_number ?? '').trim()
  if (mine) return mine
  const theirs = (load.broker_reference ?? '').trim()
  if (theirs) return theirs
  // Reachable: a row created before we required one of the two, or by SQL.
  // "Untitled load" beats an empty link the mouse cannot find.
  return 'Untitled load'
}

/**
 * The id of an existing customer whose name is the one she just typed.
 *
 * Both load forms offer a free-text customer box beside the dropdown, because a
 * broker she has never hauled for is the normal case on a load-board booking and
 * sending her to a Customers screen first is how the load ends up on a sticky
 * note. This is what stops that box from creating a second "TQL" every time:
 * match first, insert only on a miss.
 *
 * Case- and whitespace-insensitive, and compared in JavaScript over the
 * carrier's own short list rather than with `.ilike()`, because a name
 * containing a % or an _ is a LIKE pattern to PostgREST and would silently match
 * a different customer. Comparing here also means the rule is testable without a
 * database, which is why it lives in this file rather than in the page.
 */
export function matchCustomerName(
  rows: readonly { id: string; name: string | null }[] | null | undefined,
  typed: string | null,
): string | null {
  const wanted = (typed ?? '').trim().toLowerCase()
  if (!wanted) return null
  const hit = (rows ?? []).find((c) => (c.name ?? '').trim().toLowerCase() === wanted)
  return hit?.id ?? null
}

// ---------------------------------------------------------------------------
// Money — integer cents, never floats
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * The largest value the money columns can hold.
 *
 * `linehaul_cents` and friends are `int` in 0009_loads.sql, which is int4, which
 * tops out at 2,147,483,647 — $21,474,836.47. Above that Postgres raises
 * "integer out of range" and the whole save is lost with a message about a type.
 * Checking it here turns that into a sentence about the number she typed, and
 * in practice only ever fires on a fat-fingered extra zero.
 */
export const MAX_MONEY_CENTS = 2147483647

/**
 * Dollars as typed by a human, to integer cents.
 *
 * THE FLOAT IS THE BUG. `Math.round(Number('1234.55') * 100)` looks correct and
 * is correct for most inputs, but binary floating point represents 1234.55 as
 * 1234.5499999999999 and there exist values where that rounds down a cent. One
 * cent off on a linehaul rate is a rate confirmation that does not match the
 * invoice, which is a broker holding payment for a week over our arithmetic. So
 * the dollars and the cents are pulled apart as STRINGS and multiplied as
 * integers; no float ever exists.
 *
 * More than two decimal places is refused rather than rounded. Rounding silently
 * changes what she typed, on a number that becomes an invoice.
 *
 * `allowNegative` exists for accessorials only: a rate confirmation routinely
 * carries a lumper or an advance as a DEDUCTION, and refusing to store it means
 * the total on our screen never matches the cheque. A negative linehaul is not a
 * thing, so it stays refused there.
 */
export function parseMoneyToCents(
  raw: FormDataEntryValue | string | null,
  opts: { label: string; allowNegative?: boolean },
): Parsed<number | null> {
  // The money input is `inputmode="decimal"`, which on a phone offers a keypad
  // but does not stop a paste of "$1,250.00" from the broker's email.
  const s = String(raw ?? '')
    .replace(/[$,\s]/g, '')
    .trim()
  // A lone '$' or a stray comma lands here as '' and is read as "left blank",
  // which is the right answer: the field already shows a static $ beside it, so
  // a typed one is noise rather than an attempt at a number.
  if (s === '') return { ok: true, value: null }

  // '.50' is fifty cents and every person typing it knows exactly what they
  // mean. Refusing a perfectly clear answer is how a form teaches someone that
  // it is broken, so the missing zero is supplied rather than argued about.
  const normalised = s.replace(/^(-?)\./, '$10.')

  const match = normalised.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/)
  if (!match) {
    // Deliberately names the two shapes that get typed and rejected: three
    // decimals (a per-mile rate pasted in) and a stray letter.
    return {
      ok: false,
      message: `${opts.label} should be an amount like 1850 or 1850.50, or left blank.`,
    }
  }

  const [, sign, whole, frac = ''] = match
  if (sign === '-' && !opts.allowNegative) {
    return { ok: false, message: `${opts.label} cannot be negative.` }
  }

  // padEnd, not padStart: '.5' is fifty cents, not five.
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  if (cents > MAX_MONEY_CENTS) {
    return {
      ok: false,
      message: `${opts.label} is larger than this field can hold — check for an extra zero.`,
    }
  }
  return { ok: true, value: sign === '-' ? -cents : cents }
}

/**
 * Integer cents to "$1,250.00", or the em dash for "we do not know".
 *
 * Built by integer division rather than `cents / 100`, for the same reason the
 * parser avoids floats: this string is read next to a rate confirmation and
 * compared digit by digit.
 *
 * NULL renders as '—' and never as '$0.00'. A load we have not priced yet and a
 * load that genuinely pays nothing are different facts, and on a board of forty
 * loads the difference is whether anyone chases it.
 */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—'
  const negative = cents < 0
  const abs = Math.abs(Math.trunc(cents))
  const whole = Math.trunc(abs / 100).toLocaleString('en-US')
  const frac = String(abs % 100).padStart(2, '0')
  return `${negative ? '-' : ''}$${whole}.${frac}`
}

/**
 * Integer cents back into a money input's value: '1250.00', or ''.
 *
 * No thousands separators. The separator survives a round trip through the
 * parser above, but it also gets selected and half-deleted by a thumb on a
 * phone, and "1,2500" is a number nobody meant.
 */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return ''
  const negative = cents < 0
  const abs = Math.abs(Math.trunc(cents))
  return `${negative ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/**
 * What the load pays, all in.
 *
 * NULL when NOTHING has been priced, and a number as soon as ANY one component
 * has. Treating a NULL component as zero inside a priced load is right — a load
 * with no fuel surcharge really does add nothing — but treating an entirely
 * unpriced load as $0.00 is a lie that reads as "this load pays nothing" instead
 * of "nobody has typed the rate yet". Those go to different people.
 *
 * Every term is integer cents, so the sum is exact. This is the number that gets
 * compared against the cheque.
 */
export function totalRateCents(load: {
  linehaul_cents?: number | null
  fuel_surcharge_cents?: number | null
  accessorials_cents?: number | null
}): number | null {
  const parts = [load.linehaul_cents, load.fuel_surcharge_cents, load.accessorials_cents]
  if (parts.every((p) => p === null || p === undefined)) return null
  return parts.reduce<number>((sum, p) => sum + (p ?? 0), 0)
}

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

export interface StopForLane {
  sequence: number
  city?: string | null
  state?: string | null
}

export interface Lane {
  /** First stop, as 'Fontana, CA'. NULL when there is no usable first stop. */
  origin: string | null
  /** Last stop. NULL while the load has only one stop on it. */
  destination: string | null
}

function placeOf(stop: StopForLane | undefined): string | null {
  if (!stop) return null
  const city = (stop.city ?? '').trim()
  const state = (stop.state ?? '').trim().toUpperCase()
  // A stop typed as state-only still tells a dispatcher something ("somewhere in
  // Arizona"), and rendering nothing for it looks like the stop is missing.
  if (city && state) return `${city}, ${state}`
  return city || state || null
}

/**
 * Pickup city → delivery city, derived from the stop list.
 *
 * FIRST and LAST BY SEQUENCE, never "the first row typed 'pickup' and the last
 * typed 'delivery'". 0009_loads.sql has six stop types, and a drop-and-hook
 * relay has neither a 'pickup' nor a 'delivery' row on it — filtering by type
 * renders that load with a blank lane, which reads as missing data on a load
 * whose stops are fully entered.
 *
 * The sort is done here rather than trusted from the query, because this runs on
 * an embedded PostgREST result whose ordering is not guaranteed unless the
 * caller remembers to ask, and "unless the caller remembers" is not a property
 * worth having in the column a dispatcher scans fastest.
 *
 * One stop gives an origin and no destination. That is the honest answer while
 * she is still typing the load in, and it is why this returns two fields rather
 * than one pre-joined 'A → B' string.
 */
export function laneFromStops(stops: readonly StopForLane[] | null | undefined): Lane {
  const rows = [...(stops ?? [])].sort((a, b) => a.sequence - b.sequence)
  if (rows.length === 0) return { origin: null, destination: null }
  return {
    origin: placeOf(rows[0]),
    destination: rows.length > 1 ? placeOf(rows[rows.length - 1]) : null,
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * A PostgREST `or=` filter matching BOTH reference numbers.
 *
 * Both, always, and not as a preference. Our load number and the broker's live
 * in two columns and the dispatcher does not know or care which one is printed
 * on the sheet she is holding — she types the digits she can see. A search that
 * only covered `load_number` returns nothing for two thirds of the paper in the
 * office, and the conclusion she draws is that the load was never entered.
 *
 * The character strip is not cosmetic: `or=` is a comma-separated list parsed as
 * SYNTAX, so a comma or a bracket in the box becomes extra filters and a 400
 * rather than a search, and `%` / `_` are LIKE wildcards that would match the
 * entire board. None of them appear in a real reference number.
 */
export function referenceSearchFilter(term: string): string | null {
  const safe = term.replace(/[,()%_*\\"]/g, ' ').trim()
  if (!safe) return null
  return `load_number.ilike.%${safe}%,broker_reference.ilike.%${safe}%`
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

/**
 * Trimmed text, or NULL.
 *
 * '' must never reach the database. An empty `broker_reference` is not the same
 * fact as "the rate con had no reference": it is a VALUE, it sorts, it matches
 * `ilike '%%'`, and on screen it reads as answered.
 */
export function textOrNull(raw: FormDataEntryValue | null): string | null {
  const s = String(raw ?? '').trim()
  return s === '' ? null : s
}

/**
 * An optional whole number — weight, pieces, free hours.
 *
 * Blank comes back as NULL and never 0, because `Number('')` is 0 and a 0 in
 * `free_hours_pickup` is the opposite of not knowing: it claims the detention
 * clock starts on arrival, which is a claim we would happily bill on and then
 * lose. Commas are stripped because an owner types 42,000 and `Number('42,000')`
 * is NaN.
 */
export function parseOptionalInt(
  raw: FormDataEntryValue | null,
  opts: { label: string; min: number; max: number },
): Parsed<number | null> {
  const s = String(raw ?? '')
    .trim()
    .replaceAll(',', '')
  if (s === '') return { ok: true, value: null }
  if (!/^-?\d+$/.test(s)) {
    return { ok: false, message: `${opts.label} should be digits only, or left blank.` }
  }
  const n = Number(s)
  if (n < opts.min || n > opts.max) {
    return {
      ok: false,
      message: `${opts.label} should be between ${opts.min.toLocaleString('en-US')} and ${opts.max.toLocaleString('en-US')}, or left blank.`,
    }
  }
  return { ok: true, value: n }
}

/**
 * Equipment types offered as SUGGESTIONS, in a `<datalist>`, not a `<select>`.
 *
 * A closed list guarantees a wrong box the first time a conestoga or a
 * curtain-side walks in, and the dispatcher then picks the nearest lie — which
 * is worse than free text, because it looks authoritative. A datalist is plain
 * HTML with no script behind it, so this stays a zero-JavaScript page.
 */
export const EQUIPMENT_TYPES: readonly string[] = [
  'Dry van 53',
  'Reefer 53',
  'Flatbed 48',
  'Step deck',
  'Power only',
  'Box truck',
  'Hotshot',
  'Conestoga',
  'Tanker',
]
