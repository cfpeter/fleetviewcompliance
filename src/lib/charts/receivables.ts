/**
 * What you are owed, how long it has been sitting there, and whether a customer
 * pays the way they said they would.
 *
 * THE DATE EVERY BAND IS AGED FROM IS NAMED ON SCREEN, AND IT IS NOT ALWAYS THE
 * SAME DATE. 0009_loads.sql gave a load exactly one moment in time —
 * `created_at`, the day it was entered — and nothing else. 0029 adds
 * `invoiced_on` and `paid_on`. So a load is aged from its invoice date when
 * somebody recorded one, and from the day it was entered when nobody did, which
 * means one chart can hold both kinds of row at once.
 *
 * That mixture is reported rather than smoothed over: `agedFromInvoice` and
 * `agedFromEntry` come back on every result and `agingSource()` turns them into
 * the sentence the page has to print. An owner who reads "more than 90 days"
 * off this screen and says it down the phone to a broker whose invoice went out
 * three weeks ago has been handed an argument he loses, by us — and a load aged
 * from the day it was ENTERED is always older than the invoice behind it.
 *
 * THE COLUMNS MAY NOT BE THERE. 0029 is written but applied deliberately, so
 * every function here treats `invoiced_on` and `paid_on` as optional and absent
 * by default. With the migration unapplied nothing changes: every load ages
 * from its entry date exactly as before, and the measured pay speed renders as
 * the absence it is.
 *
 * WHICH LOADS COUNT. The `waiting` stage from `FUNNEL_STAGES` — invoiced, with
 * the factor, funded — imported rather than spelled out again, so this file and
 * the money funnel on /app/loads can never disagree about what "still out"
 * means. Short-paid and disputed money is owed too, and it is returned
 * SEPARATELY rather than folded into a band: it needs a phone call, not a wait.
 *
 * MONEY IS INTEGER CENTS AND NO FLOAT EXISTS HERE. Every band total is integer
 * addition of `totalRateCents` figures. The only division anywhere near this is
 * `widthPercent` inside the chart component, which produces a CSS width and
 * never a figure anybody reads.
 *
 * `null` IS NOT ZERO, here as everywhere. A band holding four loads nobody has
 * priced draws as an absence with the words for it, never as $0.00 — an
 * unpriced load is not a zero-dollar load, and the two go to different people.
 */
import { formatCents } from '../loads.ts'
import { daysSinceBooked, FUNNEL_STAGES } from './funnel.ts'
import { bookedDay, classifyLoad, type RevenueLoad } from './revenue.ts'
import type { Value } from './scale.ts'
import type { Tone } from './tones.ts'

/**
 * A load, plus the two dates 0029_load_invoice_dates.sql adds.
 *
 * Both are OPTIONAL on the type, not merely nullable, and that is load-bearing:
 * until the migration is applied the columns do not exist, the page cannot
 * select them, and every row arrives here with the properties simply absent.
 * `undefined` and `null` both mean "no date recorded" to everything below.
 */
export interface DatedLoad extends RevenueLoad {
  /** The day the invoice went out, as a `date` column reads: 'YYYY-MM-DD'. */
  invoiced_on?: string | null
  /** The day the money arrived. */
  paid_on?: string | null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A stored `date` as UTC midnight of that calendar day, or `null`.
 *
 * NO TIMEZONE CONVERSION, deliberately. A `date` column has no zone — "the
 * invoice went out on the 3rd" is already a calendar day — so shifting it into
 * the carrier's zone the way a timestamptz has to be shifted would move it to
 * the 2nd. That is the off-by-one that makes a net-30 broker read as net-31.
 */
function calendarDay(value: string | null | undefined): Date | null {
  if (!value) return null
  const day = value.slice(0, 10)
  if (!ISO_DATE.test(day)) return null
  const d = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Whole days from one stored date to another, or `null` if either is unreadable.
 *
 * Both sides are UTC midnights, so the difference is an exact multiple of a day
 * and no float creeps in. A NEGATIVE result is returned as it is rather than
 * clamped: money arriving before the invoice that asked for it is a typo, and
 * the caller counts it as unreadable rather than averaging it into an answer.
 */
export function daysBetweenDates(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
): number | null {
  const from = calendarDay(fromIso)
  const to = calendarDay(toIso)
  if (!from || !to) return null
  return Math.round((to.getTime() - from.getTime()) / 86_400_000)
}

/**
 * Whole days from a stored `date` to today, in the carrier's own calendar.
 *
 * `bookedDay` is what turns "now" into the calendar day it is in the yard —
 * the same function `daysSinceBooked` uses, so an invoice-aged load and an
 * entry-aged load on one chart are measured against the same today.
 */
function daysSinceDate(
  iso: string | null | undefined,
  today: Date,
  timeZone?: string,
): number | null {
  const from = calendarDay(iso)
  const now = bookedDay(today.toISOString(), timeZone)
  if (!from || !now) return null
  return Math.round((now.getTime() - from.getTime()) / 86_400_000)
}

/**
 * The billing states that mean the money is out with somebody else.
 *
 * Taken off the funnel's own stage rather than written out again. If a later
 * migration adds a billing state, it is added there once.
 */
export const WAITING_BILLING: readonly string[] =
  FUNNEL_STAGES.find((s) => s.key === 'waiting')?.billing ?? []

/** Owed, and contested. Spelled as the `billing_status` enum spells them. */
export const DISPUTED_BILLING: readonly string[] = ['short_paid', 'in_dispute']

export type AgeBandKey = 'to30' | 'to60' | 'to90' | 'over90'

export interface AgeBand {
  key: AgeBandKey
  /** Plain words, read by owners who are not fluent in English. */
  label: string
  tone: Tone
  /** Inclusive lower bound, in whole days since the load was entered. */
  from: number
  /** Inclusive upper bound, or `null` for the open-ended band. */
  to: number | null
}

/**
 * The four bands every accountant in the industry uses, and the colours this
 * app uses everywhere else.
 *
 * Blue for the first band because money out with a broker on ordinary terms is
 * not "on track" and it is not a problem either — it is simply out, which is
 * exactly what blue means on the money funnel. Amber at 31 days, because a net
 * 30 has then been missed. Red from 61, because sixty days is where a small
 * carrier's fuel and payroll actually break, and red in this app means act now.
 * The last two bands share the colour and are told apart by their words and
 * their figures, which is the rule: colour carries the urgency and nothing finer.
 */
export const AGE_BANDS: readonly AgeBand[] = [
  { key: 'to30', label: '30 days or less', tone: 'brand', from: 0, to: 30 },
  { key: 'to60', label: '31 to 60 days', tone: 'soon', from: 31, to: 60 },
  { key: 'to90', label: '61 to 90 days', tone: 'overdue', from: 61, to: 90 },
  { key: 'over90', label: 'More than 90 days', tone: 'overdue', from: 91, to: null },
]

/** Where the phone call starts. Exported so the page prints the number used. */
export const CHASE_AFTER_DAYS = 60

export interface AgingBand extends AgeBand {
  /** Exact integer cents across the priced loads in this band. */
  cents: number
  loads: number
  /** Loads in this band with no rate typed. Their dollars are unknown, not zero. */
  unpricedLoads: number
  /**
   * What the bar draws. `cents` when anything here is priced; `null` when the
   * band HAS loads and not one carries a rate; a real, known `0` when the band
   * is genuinely empty.
   */
  value: Value
  /** The exact figure, or the words for the absence. */
  display: string
}

export interface Aging {
  /** All four bands, always, oldest last. An empty band is a fact. */
  bands: AgingBand[]
  /** Exact integer cents across every priced load in the bands. */
  totalCents: number
  countedLoads: number
  unpricedLoads: number
  /** Loads that are out but carry no readable entry date. In no band. */
  undatedLoads: number
  /** Their money, which is therefore in no band either. */
  undatedCents: number
  /** Whole days since the oldest load still out was entered. */
  oldestDays: number | null
  /** Money past the chase line. The figure worth a phone call today. */
  chaseCents: number
  /**
   * The loads `chaseCents` is built from, and ONLY those.
   *
   * A load past the line with no rate on it is counted in `chaseUnpricedLoads`
   * instead, so the pair printed on screen — "$4,200 across 3 loads" — is
   * always the same three loads that made the $4,200.
   */
  chaseLoads: number
  chaseUnpricedLoads: number
  /** Short paid or in dispute. Owed, contested, and NOT in any band above. */
  disputedCents: number
  disputedLoads: number
  /** Every load that is out, priced or not, dated or not. */
  waitingLoads: number
  /** The cutoff the chase figures used, so the page prints the same number. */
  chaseAfterDays: number
  /**
   * Loads on these bars aged from a RECORDED INVOICE DATE. The right number.
   */
  agedFromInvoice: number
  /**
   * Loads aged from the day they were ENTERED, because no invoice date was
   * recorded on them. Every one of these is older than the invoice behind it,
   * and `agingSource()` is what says so on screen.
   */
  agedFromEntry: number
}

/**
 * The sentence naming the date these bands were counted from.
 *
 * One string, shared by every page that draws the bands, so two screens can
 * never describe the same arithmetic two different ways. It is deliberately not
 * optional: a chart of ages whose reader cannot name the day the clock started
 * is a chart that loses an argument with a broker.
 */
export function agingSource(aging: Aging): string {
  const { agedFromInvoice: invoiced, agedFromEntry: entered } = aging
  if (invoiced === 0 && entered === 0) return 'Nothing is invoiced and waiting, so there is nothing to count from.'
  if (entered === 0) {
    return 'Counted from the day you sent the invoice.'
  }
  if (invoiced === 0) {
    return 'Counted from the day the load was entered, not the day the invoice went out, because no invoice date is recorded on these loads. Every figure here is older than the invoice behind it.'
  }
  const loadWord = (n: number) => (n === 1 ? 'load' : 'loads')
  return `${invoiced} ${loadWord(invoiced)} counted from the day you sent the invoice. The other ${entered} ${loadWord(entered)} have no invoice date on them, so ${entered === 1 ? 'it is' : 'they are'} counted from the day the load was entered — which is older than the invoice behind ${entered === 1 ? 'it' : 'them'}.`
}

function bandIndexFor(days: number): number {
  // A load entered "tomorrow" — a clock an hour ahead of the carrier's own day —
  // is not aged backwards out of the chart. It belongs in the first band.
  const d = Math.max(0, days)
  return AGE_BANDS.findIndex((b) => d >= b.from && (b.to === null || d <= b.to))
}

/**
 * Split what is still out across the four age bands.
 *
 * `today` is passed in rather than read off the clock, so the banding is
 * deterministic in a test — the same reason `revenueByMonth` and `moneyFunnel`
 * take it.
 *
 * Quoted and cancelled loads are left out, exactly as every other derivation in
 * this folder leaves them out: a quote is money nobody has agreed to pay, and a
 * cancelled load's rate is not arriving. Two charts on one page drawn from two
 * different populations is how a page starts disagreeing with itself.
 */
export function receivablesAging(
  loads: readonly DatedLoad[] | null | undefined,
  today: Date,
  opts: { timeZone?: string; chaseAfterDays?: number } = {},
): Aging {
  const chaseAfterDays = Math.max(1, Math.trunc(opts.chaseAfterDays ?? CHASE_AFTER_DAYS))
  const cells = AGE_BANDS.map(() => ({ cents: 0, loads: 0, unpriced: 0 }))

  let countedLoads = 0
  let unpricedLoads = 0
  let undatedLoads = 0
  let undatedCents = 0
  let oldestDays: number | null = null
  let chaseCents = 0
  let chaseLoads = 0
  let chaseUnpricedLoads = 0
  let disputedCents = 0
  let disputedLoads = 0
  let waitingLoads = 0
  let agedFromInvoice = 0
  let agedFromEntry = 0

  for (const load of loads ?? []) {
    const klass = classifyLoad(load)
    if (klass.kind === 'quoted' || klass.kind === 'cancelled') continue
    const billing = load.billing ?? ''

    if (DISPUTED_BILLING.includes(billing)) {
      disputedLoads++
      if (klass.kind === 'counted') disputedCents += klass.cents
      continue
    }
    if (!WAITING_BILLING.includes(billing)) continue

    waitingLoads++
    // THE INVOICE DATE WHERE THERE IS ONE, THE ENTRY DATE WHERE THERE IS NOT.
    //
    // Not a fallback to be embarrassed about: an invoice date is the day the
    // clock actually started, and the entry date is the only thing we have when
    // nobody typed one. The two are counted separately so `agingSource()` can
    // say on screen which rows are which, because a load aged from the day it
    // was entered reads OLDER than the invoice behind it.
    const fromInvoice = daysSinceDate(load.invoiced_on, today, opts.timeZone)
    const days =
      fromInvoice !== null ? fromInvoice : daysSinceBooked(load.created_at, today, opts.timeZone)
    if (days === null) {
      // Counted and named rather than dropped. A load quietly missing from a
      // money chart is the one failure nobody notices, because the chart still
      // looks fine.
      undatedLoads++
      if (klass.kind === 'counted') undatedCents += klass.cents
      continue
    }
    if (oldestDays === null || days > oldestDays) oldestDays = days

    const i = bandIndexFor(days)
    // Unreachable: the bands cover every day from 0 upwards. Guarded so a future
    // edit to AGE_BANDS that leaves a hole cannot silently delete money.
    if (i === -1) {
      undatedLoads++
      if (klass.kind === 'counted') undatedCents += klass.cents
      continue
    }

    // Counted here and nowhere earlier, so the two figures always add up to the
    // loads actually ON the bands — a row that fell out at one of the guards
    // above is in `undatedLoads` and must not also be claimed by a band.
    if (fromInvoice !== null) agedFromInvoice++
    else agedFromEntry++

    cells[i].loads++
    if (klass.kind === 'counted') {
      cells[i].cents += klass.cents
      countedLoads++
      if (days > chaseAfterDays) {
        chaseCents += klass.cents
        chaseLoads++
      }
    } else {
      cells[i].unpriced++
      unpricedLoads++
      if (days > chaseAfterDays) chaseUnpricedLoads++
    }
  }

  const bands: AgingBand[] = AGE_BANDS.map((band, i) => {
    const cell = cells[i]
    const priced = cell.loads - cell.unpriced
    const value: Value = cell.loads === 0 ? 0 : priced > 0 ? cell.cents : null
    return {
      ...band,
      cents: cell.cents,
      loads: cell.loads,
      unpricedLoads: cell.unpriced,
      value,
      display:
        value !== null
          ? formatCents(value)
          : // Two absences, two different sentences. A band holding three loads
            // nobody has priced must not read like a band holding nothing.
            `no rate on ${cell.unpriced} ${cell.unpriced === 1 ? 'load' : 'loads'}`,
    }
  })

  return {
    bands,
    totalCents: bands.reduce((n, b) => n + b.cents, 0),
    countedLoads,
    unpricedLoads,
    undatedLoads,
    undatedCents,
    oldestDays,
    chaseCents,
    chaseLoads,
    chaseUnpricedLoads,
    disputedCents,
    disputedLoads,
    waitingLoads,
    chaseAfterDays,
    agedFromInvoice,
    agedFromEntry,
  }
}

export interface CustomerForReceivables {
  id: string
  name: string
  days_to_pay?: number | null
}

export interface CustomerReceivable {
  id: string
  name: string
  /** Exact integer cents still out with them. */
  cents: number
  loads: number
  unpricedLoads: number
  /** Days since their oldest load still out was entered. */
  oldestDays: number | null
  /** NULL means they never told us. It does not mean they pay on delivery. */
  daysToPay: number | null
}

export interface CustomerReceivables {
  /** Most money out first. Ties broken by age, then by name, so it is stable. */
  rows: CustomerReceivable[]
  /** Money out on loads with no customer on them. In no row above. */
  unattributedCents: number
  unattributedLoads: number
}

/**
 * Whose money it is.
 *
 * The aging bands answer "how stale is what I am owed". They cannot answer
 * "who do I ring", because a band is a mix of brokers. This is the same
 * population, cut the other way, so the two always add up to the same total —
 * minus the unattributed part, which is returned rather than hidden for exactly
 * that reason.
 */
export function receivablesByCustomer(
  loads: readonly DatedLoad[] | null | undefined,
  customers: readonly CustomerForReceivables[] | null | undefined,
  today: Date,
  opts: { timeZone?: string } = {},
): CustomerReceivables {
  const known = new Map((customers ?? []).map((c) => [c.id, c]))
  const tally = new Map<
    string,
    { cents: number; loads: number; unpriced: number; oldest: number | null }
  >()

  let unattributedCents = 0
  let unattributedLoads = 0

  for (const load of loads ?? []) {
    const klass = classifyLoad(load)
    if (klass.kind === 'quoted' || klass.kind === 'cancelled') continue
    if (!WAITING_BILLING.includes(load.billing ?? '')) continue

    // Same rule as the bands: the invoice date where one was recorded, the day
    // the load was entered where none was. The two pages that draw these rows
    // and the bands beside them must age from the same day per load, or one
    // broker appears twice with two different ages.
    const days =
      daysSinceDate(load.invoiced_on, today, opts.timeZone) ??
      daysSinceBooked(load.created_at, today, opts.timeZone)
    const id = load.customer_id ?? ''
    if (!known.has(id)) {
      // `customer_id` is ON DELETE SET NULL, so a bare null is the normal case.
      unattributedLoads++
      if (klass.kind === 'counted') unattributedCents += klass.cents
      continue
    }

    const entry = tally.get(id) ?? { cents: 0, loads: 0, unpriced: 0, oldest: null }
    entry.loads++
    if (klass.kind === 'counted') entry.cents += klass.cents
    else entry.unpriced++
    if (days !== null && (entry.oldest === null || days > entry.oldest)) entry.oldest = days
    tally.set(id, entry)
  }

  const rows: CustomerReceivable[] = []
  for (const [id, entry] of tally) {
    const customer = known.get(id)
    if (!customer) continue
    rows.push({
      id,
      name: customer.name,
      cents: entry.cents,
      loads: entry.loads,
      unpricedLoads: entry.unpriced,
      oldestDays: entry.oldest,
      daysToPay: customer.days_to_pay ?? null,
    })
  }

  rows.sort((a, b) => {
    if (b.cents !== a.cents) return b.cents - a.cents
    const ao = a.oldestDays ?? -1
    const bo = b.oldestDays ?? -1
    if (bo !== ao) return bo - ao
    return a.name.localeCompare(b.name)
  })

  return { rows, unattributedCents, unattributedLoads }
}

/**
 * How long a wait reads in plain words: "34 days", "1 day".
 *
 * Never "34d". The copy rule is the copy rule, and an abbreviation is a word
 * the reader has to already know.
 */
export function daysWord(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

// ---------------------------------------------------------------------------
// Promised against actual
// ---------------------------------------------------------------------------

/**
 * The fewest paid invoices this will state a pay speed from.
 *
 * One invoice is an anecdote. Two is a coincidence. Three is the smallest
 * number that can be called a habit, and a habit is what the owner is deciding
 * about when he asks whether to take their next load. Below this the page draws
 * the dashed gap and says how many it has — it never averages two numbers and
 * calls the result how a broker pays.
 */
export const MIN_MEASURED_INVOICES = 3

export interface PaySpeed {
  /** What they AGREED to. NULL means nobody has asked them. Not "fast". */
  promisedDays: number | null
  /** Invoices carrying BOTH dates, so a wait could actually be measured. */
  measured: number
  /** The typical wait, in whole days. The middle one, not the average. */
  typicalDays: number | null
  fastestDays: number | null
  slowestDays: number | null
  /** Invoiced and not yet marked paid. Still out, so not yet a measurement. */
  awaiting: number
  /** Loads of theirs with no invoice date on them at all. */
  unrecorded: number
  /** Dates present but impossible — money before the invoice. In no figure. */
  unreadable: number
  /** Measured invoices paid on or before the agreed day. */
  onTime: number
  late: number
  /** Whole percent on time, or `null` when nothing can honestly be said. */
  onTimePercent: number | null
  /** The threshold actually used, so the page prints the number the maths used. */
  minimum: number
  /** Why there is no measured wait, in plain words. `null` when there is one. */
  absence: string | null
  /** Why there is no on-time share. `null` when there is one. */
  punctualityAbsence: string | null
}

const invoiceWord = (n: number) => (n === 1 ? 'invoice' : 'invoices')

/** The middle value of a sorted list of whole days. Never an average. */
function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  // An even count has no middle value. The two either side are averaged and
  // rounded — these are days, not money, so a rounded day is a day and not a
  // cent nobody can reconcile.
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * WHAT THEY PROMISED, AGAINST WHAT THEY ACTUALLY DID.
 *
 * `days_to_pay` on the customer is a sentence off a rate confirmation. It is
 * not a measurement, and reading it as one is the mistake this whole function
 * exists to correct: the reason a small carrier cares about the field at all is
 * that the two numbers differ.
 *
 * WHAT IT REFUSES TO DO. It will not state a pay speed from fewer than
 * `MIN_MEASURED_INVOICES` measured invoices, it will not state one from loads
 * that carry only one of the two dates, and it will not state an on-time share
 * for a customer who never gave terms — there is nothing to be on time against.
 * Each refusal comes back as a SENTENCE, not as a silence and never as a zero,
 * because the page has to print the reason beside the dashed gap.
 *
 * WITH 0029 UNAPPLIED EVERY RESULT IS AN ABSENCE. The columns do not exist, so
 * every load arrives with both dates undefined, `measured` is 0 and `absence`
 * says the dates are not recorded. That is the correct output, not a failure.
 *
 * NO MONEY IS TOUCHED HERE. These are whole days, counted between two calendar
 * dates. The only division is the on-time percentage, which is printed beside
 * the two counts it is made of and never on its own.
 */
export function paySpeed(
  loads: readonly DatedLoad[] | null | undefined,
  promisedDays: number | null | undefined,
  opts: { minimum?: number } = {},
): PaySpeed {
  const minimum = Math.max(1, Math.trunc(opts.minimum ?? MIN_MEASURED_INVOICES))
  const promised = promisedDays ?? null

  const waits: number[] = []
  let awaiting = 0
  let unrecorded = 0
  let unreadable = 0
  let onTime = 0
  let late = 0
  let considered = 0

  for (const load of loads ?? []) {
    const klass = classifyLoad(load)
    // Quoted and cancelled loads are left out here exactly as every other
    // derivation in this folder leaves them out. Nobody invoices a quote.
    if (klass.kind === 'quoted' || klass.kind === 'cancelled') continue
    considered++

    const invoiced = load.invoiced_on ?? null
    const paid = load.paid_on ?? null

    if (!invoiced) {
      unrecorded++
      continue
    }
    if (!paid) {
      awaiting++
      continue
    }

    const days = daysBetweenDates(invoiced, paid)
    // A negative wait is money that arrived before the invoice asked for it —
    // a transposed date. Counted and named rather than averaged in, where it
    // would make a slow broker read as a fast one.
    if (days === null || days < 0) {
      unreadable++
      continue
    }

    waits.push(days)
    if (promised !== null) {
      if (days <= promised) onTime++
      else late++
    }
  }

  waits.sort((a, b) => a - b)
  const measured = waits.length
  const enough = measured >= minimum

  let onTimePercent: number | null = null
  if (enough && promised !== null && measured > 0) {
    const raw = Math.round((onTime / measured) * 100)
    // A rounded 100% over a record that contains a late payment is a claim this
    // app has not earned, and the same in reverse at the bottom of the scale.
    onTimePercent = late > 0 && raw >= 100 ? 99 : onTime > 0 && raw <= 0 ? 1 : raw
  }

  const absence = enough
    ? null
    : considered === 0
      ? 'You have not hauled anything for them yet, so there is nothing to measure.'
      : measured === 0 && unrecorded === considered
        ? 'No load of theirs has an invoice date on it, so how long they really take cannot be worked out. Put the date on the load when you send the invoice, and the date again when the money lands.'
        : measured === 0 && awaiting > 0
          ? `${awaiting} ${invoiceWord(awaiting)} out with them ${awaiting === 1 ? 'has' : 'have'} no payment date yet, so no wait has finished. This does not mean they are slow.`
          : measured === 0
            ? 'No load of theirs carries both an invoice date and a payment date, so there is no wait to measure.'
            : `Only ${measured} paid ${invoiceWord(measured)} ${measured === 1 ? 'carries' : 'carry'} both dates. ${minimum} is the fewest this screen will speak from — one or two is luck, not a habit.`

  const punctualityAbsence =
    promised === null
      ? 'They have never given you payment terms, so there is nothing to measure them against. Settle it before the next load.'
      : absence

  return {
    promisedDays: promised,
    measured,
    typicalDays: enough ? median(waits) : null,
    fastestDays: enough ? (waits[0] ?? null) : null,
    slowestDays: enough ? (waits[waits.length - 1] ?? null) : null,
    awaiting,
    unrecorded,
    unreadable,
    onTime,
    late,
    onTimePercent,
    minimum,
    absence,
    punctualityAbsence,
  }
}

/**
 * The word and the colour for an on-time share.
 *
 * The WORD is the finding and the colour is the second signal, never the first
 * — roughly one man in twelve cannot separate the red gauge from the amber one,
 * and this product is read in a yard, in the sun. The counts behind the share
 * are printed beside it in every caller, so the word is never the only claim
 * either.
 *
 * Green at 90 and up: a broker who misses one invoice in ten is a broker you
 * plan around. Amber from 50: late often enough to matter to a fuel bill.
 * Red below 50: late more often than not, which is a conversation, not a wait.
 */
export function punctualityVerdict(percent: number): { tone: Tone; word: string } {
  if (percent >= 90) return { tone: 'good', word: 'Pays on time' }
  if (percent >= 50) return { tone: 'soon', word: 'Often late' }
  return { tone: 'overdue', word: 'Usually late' }
}
