/**
 * Where every dollar on the load board is sitting right now.
 *
 * THE SHAPE PROBLEM, AND WHY THIS IS NOT A SIX-STAGE FUNNEL.
 *
 * The obvious chart is Quoted → Booked → Dispatched → Delivered → Invoiced →
 * Paid, one pipeline, money draining left to right. It cannot be built honestly
 * here, and the reason is the whole design of this product: 0009_loads.sql keeps
 * `status` (where the truck is) and `billing` (where the money is) as two
 * SEPARATE enums that move independently, and the load page says so out loud —
 * "Moving this never changes the billing." A delivered load that is not ready to
 * invoice is the most normal row on the board, not an error.
 *
 * Drawn as one funnel, that load has to be put in exactly one box. Put it in
 * Delivered and its money vanishes from the billing half; put it in Invoiced and
 * we have claimed an invoice nobody sent. Either way the owner reads a single
 * pipeline where there are two axes, and "the reports don't match" starts here.
 *
 * SO THE FUNNEL RUNS DOWN THE MONEY AXIS ONLY. `billing` is the one that is
 * about dollars, and every dollar sits at exactly one billing state, so the
 * stages below partition the board with nothing double-counted and nothing lost.
 *
 * The truck axis enters in exactly ONE place, and it is the place where it
 * changes what the owner does today: `not_ready` is split by whether the freight
 * is already off. Money on a truck that is still running is early and fine;
 * money on a load that DELIVERED and still has no paperwork is cash sitting on
 * his own desk. Both facts are reported side by side for the same dollars — no
 * function here derives one enum from the other, and neither is allowed to
 * overwrite the other.
 *
 * COLOUR. red = act now, amber = due soon, green = on track, grey =
 * missing/unknown, and nothing waiting on somebody else is painted green:
 *
 *   grey   on trucks still working — nothing to do yet, and 'no rate' loads,
 *          which are drawn as an absence and never as $0
 *   amber  delivered-and-unbilled, and ready-to-invoice — his to move
 *   blue   invoiced / with the factor / funded — out with somebody else. NOT
 *          green: money that has not arrived is not "on track", and the age of
 *          it is printed in red under the bar when it goes past `SLOW_AFTER_DAYS`
 *   green  paid and closed — actually in the bank
 *   red    short paid, disputed, written off — needs a phone call
 *
 * Red is left to mean what it means everywhere else in this app (broken, act
 * now). Ready-to-invoice stays amber to match the pill printed two inches below
 * it in the table; a chart that recoloured it would teach the owner that neither
 * can be trusted.
 *
 * MONEY IS INTEGER CENTS AND NO FLOAT EXISTS HERE. Every stage total is integer
 * addition, the board total is the sum of the stage totals, and a test pins that
 * they are equal to the cent. The only division is `widthPercent`, which
 * produces a CSS width and never a figure anyone reads.
 */
import { formatCents, totalRateCents } from '../loads.ts'
import { bookedDay, classifyLoad, type RevenueLoad } from './revenue.ts'
import { type Value, widthPercent } from './scale.ts'
import type { Tone } from './tones.ts'

/**
 * When invoiced money stops being normal and starts being chased.
 *
 * Broker terms are usually net 30; 45 leaves slack for the mail and for a
 * factor's reserve. Exported so the page can print the number it used rather
 * than writing "45" out again in prose that could drift from the arithmetic.
 */
export const SLOW_AFTER_DAYS = 45

/**
 * The statuses that mean the freight is off the truck.
 *
 * `pod_received` is included and `at_consignee` is not: backed into a door is
 * not delivered, and billing a load that is still being unloaded is how a
 * carrier ends up re-issuing an invoice.
 */
export const DELIVERED_STATUSES: readonly string[] = ['delivered', 'pod_received']

export type FunnelStageKey =
  | 'working'
  | 'paperwork'
  | 'ready'
  | 'waiting'
  | 'paid'
  | 'problem'
  | 'other'

export interface FunnelStage {
  key: FunnelStageKey
  /** Plain words. Read by owners who are not fluent in English. */
  label: string
  tone: Tone
  /** `billing_status` values from 0009_loads.sql, spelled exactly. */
  billing: readonly string[]
  /**
   * Also requires the freight to be off (`true`) or still on (`false`).
   *
   * Set on the two `not_ready` stages and nowhere else. This is the ONLY place
   * the truck axis touches the money axis, and it adds a fact rather than
   * replacing one: both stages are `not_ready`, and the split says which of
   * them the owner can act on this afternoon.
   */
  delivered?: boolean
}

/**
 * The stages, in the order money actually travels.
 *
 * Fixed, and always all of them. An axis built from the stages that happen to
 * have money in them today would change shape on every page load and would hide
 * the empty ones — and an empty "Ready to invoice" is a fact worth seeing, not
 * a row to drop.
 */
export const FUNNEL_STAGES: readonly FunnelStage[] = [
  {
    key: 'working',
    label: 'On trucks still working',
    tone: 'neutral',
    billing: ['not_ready'],
    delivered: false,
  },
  {
    key: 'paperwork',
    label: 'Delivered, not invoiced',
    tone: 'soon',
    billing: ['not_ready'],
    delivered: true,
  },
  { key: 'ready', label: 'Ready to invoice', tone: 'soon', billing: ['ready_to_invoice'] },
  {
    key: 'waiting',
    label: 'Invoiced, waiting to get paid',
    tone: 'brand',
    billing: ['invoiced', 'submitted_to_factor', 'funded'],
  },
  { key: 'paid', label: 'Paid', tone: 'good', billing: ['paid', 'closed'] },
  {
    key: 'problem',
    label: 'Short paid, disputed or written off',
    tone: 'overdue',
    billing: ['short_paid', 'in_dispute', 'written_off'],
  },
]

/**
 * A `billing_status` no stage above claims — today that means a value added to
 * the enum by a later migration than this file.
 *
 * It gets its own row rather than being folded into the nearest one, because
 * folding it would put money into a stage whose label is a claim about it that
 * nobody checked. Appended only when it holds something, so the funnel stays six
 * rows long in the normal case.
 */
const OTHER_STAGE: FunnelStage = {
  key: 'other',
  label: 'Some other billing state',
  tone: 'neutral',
  billing: [],
}

export interface FunnelRow {
  key: FunnelStageKey
  label: string
  tone: Tone
  /** Exact integer cents across the priced loads at this stage. */
  cents: number
  /** Priced loads at this stage — the ones `cents` is built from. */
  loads: number
  /** Loads at this stage with no rate typed. Their dollars are unknown, not zero. */
  unpricedLoads: number
  /**
   * What the bar draws.
   *
   * `cents` when anything here is priced. `null` when this stage HAS loads and
   * not one of them carries a rate — the same rule `revenueByMonth` applies to a
   * month, for the same reason: a stage holding four unpriced loads must not
   * draw the same as a stage holding nothing at all. A real, known `0` when the
   * stage is genuinely empty.
   */
  value: Value
  /** The exact figure the owner reads, or the word for the absence. */
  display: string
  /**
   * Share of the board total, 0-100, or `null` for an unknown.
   *
   * Computed here rather than in the component — against the TOTAL, not against
   * the biggest stage, so the six bars are six parts of one board and the widths
   * can be compared with each other. `widthPercent` floors a real amount at
   * `MIN_VISIBLE_PERCENT`, which is what keeps a $150 TONU from disappearing
   * next to a $20,000 month.
   */
  percent: number | null
  /** A short fact under the bar. */
  note?: string
  /** A short line that needs acting on. The page prints it red. */
  alarm?: string
}

export interface MoneyFunnel {
  /** Every stage, always, in money order. */
  rows: FunnelRow[]
  /** Exact integer cents. Equal to the sum of every row's `cents`, to the cent. */
  totalCents: number
  /** Loads behind `totalCents`. */
  countedLoads: number
  /** Loads on the board with no rate typed at all. In no amount here. */
  unpricedLoads: number
  /** Priced or not, a quote is not money. Left off the bars entirely. */
  quotedLoads: number
  /** What those quotes are priced at, where they are priced. Not on the bars. */
  quotedCents: number
  cancelledLoads: number
  cancelledCents: number
  /** Of the `waiting` stage, the part booked more than `slowAfterDays` ago. */
  slowCents: number
  slowLoads: number
  /** Days since the oldest waiting load was entered, or `null` if none. */
  oldestWaitingDays: number | null
  /** The cutoff actually used, so the page prints the number the maths used. */
  slowAfterDays: number
  /** counted + unpriced + quoted + cancelled. Every load handed in, once. */
  loads: number
}

interface Cell {
  cents: number
  loads: number
  unpriced: number
}

/**
 * Whole days between the day a load was entered and today, in the carrier's
 * own calendar.
 *
 * `bookedDay` returns UTC midnight of the LOCAL day, so both sides of the
 * subtraction are exact day boundaries and the difference is a whole number of
 * days with no clock arithmetic and no float creeping in.
 *
 * `created_at` is the only date a load has — 0009_loads.sql records no invoice
 * date and no payment date — so this is days since the load was ENTERED, not
 * days since it was billed. Every caller has to say so on screen.
 */
export function daysSinceBooked(
  createdAt: string | null | undefined,
  today: Date,
  timeZone?: string,
): number | null {
  const booked = bookedDay(createdAt, timeZone)
  const now = bookedDay(today.toISOString(), timeZone)
  if (!booked || !now) return null
  return Math.round((now.getTime() - booked.getTime()) / 86_400_000)
}

/** The stage a load belongs to, or -1 for a billing value no stage claims. */
function stageIndexFor(billing: string, delivered: boolean): number {
  return FUNNEL_STAGES.findIndex(
    (s) => s.billing.includes(billing) && (s.delivered === undefined || s.delivered === delivered),
  )
}

/**
 * Split the board's money across the billing stages.
 *
 * `today` is passed in rather than read, so the ageing is deterministic in a
 * test — the same reason `revenueByMonth` takes it.
 *
 * Quoted and cancelled loads are LEFT OUT of every bar, exactly as
 * `revenueByMonth` and `billingMix` leave them out. Two charts on one page drawn
 * from two different populations is how a page starts disagreeing with itself,
 * and a quote is money nobody has agreed to pay. Both are counted and returned
 * so the page can say what it left out and what it was worth.
 */
export function moneyFunnel(
  loads: readonly RevenueLoad[] | null | undefined,
  today: Date,
  opts: { timeZone?: string; slowAfterDays?: number } = {},
): MoneyFunnel {
  const slowAfterDays = Math.max(1, Math.trunc(opts.slowAfterDays ?? SLOW_AFTER_DAYS))
  const cells: Cell[] = FUNNEL_STAGES.map(() => ({ cents: 0, loads: 0, unpriced: 0 }))
  const other: Cell = { cents: 0, loads: 0, unpriced: 0 }

  let quotedLoads = 0
  let quotedCents = 0
  let cancelledLoads = 0
  let cancelledCents = 0
  let unpricedLoads = 0
  let countedLoads = 0
  let slowCents = 0
  let slowLoads = 0
  let oldestWaitingDays: number | null = null
  let loadCount = 0

  const waitingIndex = FUNNEL_STAGES.findIndex((s) => s.key === 'waiting')

  for (const load of loads ?? []) {
    loadCount++
    const klass = classifyLoad(load)
    if (klass.kind === 'quoted') {
      quotedLoads++
      quotedCents += totalRateCents(load) ?? 0
      continue
    }
    if (klass.kind === 'cancelled') {
      cancelledLoads++
      cancelledCents += totalRateCents(load) ?? 0
      continue
    }

    const delivered = DELIVERED_STATUSES.includes(load.status ?? '')
    const index = stageIndexFor(load.billing ?? '', delivered)
    const cell = index === -1 ? other : cells[index]

    if (klass.kind === 'counted') {
      cell.cents += klass.cents
      cell.loads++
      countedLoads++
    } else {
      cell.unpriced++
      unpricedLoads++
    }

    if (index === waitingIndex) {
      const age = daysSinceBooked(load.created_at, today, opts.timeZone)
      if (age !== null) {
        if (oldestWaitingDays === null || age > oldestWaitingDays) oldestWaitingDays = age
        // Counted and summed together, so the count and the amount under the
        // bar are two views of the same loads rather than two populations.
        if (age > slowAfterDays && klass.kind === 'counted') {
          slowCents += klass.cents
          slowLoads++
        }
      }
    }
  }

  const defs = other.loads + other.unpriced > 0 ? [...FUNNEL_STAGES, OTHER_STAGE] : FUNNEL_STAGES
  const live = other.loads + other.unpriced > 0 ? [...cells, other] : cells
  const totalCents = live.reduce((n, c) => n + c.cents, 0)

  const rows: FunnelRow[] = defs.map((def, i) => {
    const cell = live[i]
    // `loads > 0`, not `cents > 0`. A stage whose only load really was written
    // for zero has a figure and that figure is zero; a stage holding two loads
    // nobody has priced has no figure at all and must not draw as $0.00.
    const value: Value = cell.loads > 0 ? cell.cents : cell.unpriced > 0 ? null : 0
    const note =
      cell.loads > 0 && cell.unpriced > 0
        ? `${cell.unpriced} more ${cell.unpriced === 1 ? 'load' : 'loads'} here with no rate.`
        : undefined
    const alarm =
      def.key === 'waiting' && slowCents > 0
        ? `${formatCents(slowCents)} of this is over ${slowAfterDays} days old. Chase it.`
        : undefined
    return {
      key: def.key,
      label: def.label,
      tone: def.tone,
      cents: cell.cents,
      loads: cell.loads,
      unpricedLoads: cell.unpriced,
      value,
      // 'no rate' is the same word `revenueByMonth` prints for the same absence,
      // so the two charts on this page name it identically.
      display: value === null ? 'no rate' : formatCents(value),
      percent: widthPercent(value, totalCents),
      note,
      alarm,
    }
  })

  return {
    rows,
    totalCents,
    countedLoads,
    unpricedLoads,
    quotedLoads,
    quotedCents,
    cancelledLoads,
    cancelledCents,
    slowCents,
    slowLoads,
    oldestWaitingDays,
    slowAfterDays,
    loads: loadCount,
  }
}

/** One stage by key, for a page writing a sentence about it. */
export function stageOf(funnel: MoneyFunnel, key: FunnelStageKey): FunnelRow | undefined {
  return funnel.rows.find((r) => r.key === key)
}

/**
 * The sentence the figure leads with.
 *
 * LABEL THE ANSWER, NOT THE CHART. "Load pipeline" is a name for a widget;
 * "$23,095.00 on the board. $8,400.00 you can invoice today." is the thing the
 * owner opened the page to find out, and it is readable without looking at the
 * bars at all.
 *
 * Two clauses, never more. The first is the board total — which is the sum of
 * the bars underneath and nothing cleverer, so there is no composite score here
 * to explain. The second is the ONE thing worth doing first.
 *
 * THE ORDER IS BY WHAT HE CAN TURN INTO CASH SOONEST, NOT BY WHAT IS LOUDEST.
 * Ready-to-invoice leads, and it leads even over money that came back short,
 * which looks wrong for about a second: red means act now, and a short payment
 * is broken. But a short payment ANNOUNCED ITSELF — a cheque arrived light and
 * somebody noticed. A finished load that was never invoiced announces nothing at
 * all. It is silent, it is five minutes of work, it is a full recovery, and
 * loads.ts already calls it "where a small carrier's cash actually gets stuck".
 * So: send the invoice, then find the POD, then make the phone call, then chase
 * the old one, then the money that is simply out with somebody else.
 *
 * Every figure in the sentence is one stage's exact total, printed again on that
 * stage's own bar a few lines below, so there is nothing here to take on trust.
 */
export function funnelHeadline(funnel: MoneyFunnel): string {
  if (funnel.countedLoads === 0) {
    return funnel.unpricedLoads > 0
      ? 'No load on the board has a rate yet, so there is no amount to show.'
      : 'No money on the board yet.'
  }
  const at = (key: FunnelStageKey) => stageOf(funnel, key)?.cents ?? 0
  const board = `${formatCents(funnel.totalCents)} on the board.`
  if (at('ready') > 0) return `${board} ${formatCents(at('ready'))} you can invoice today.`
  if (at('paperwork') > 0) {
    return `${board} ${formatCents(at('paperwork'))} delivered and not invoiced yet.`
  }
  if (at('problem') > 0) {
    return `${board} ${formatCents(at('problem'))} came back short or disputed.`
  }
  if (funnel.slowCents > 0) {
    return `${board} ${formatCents(funnel.slowCents)} has been waiting over ${funnel.slowAfterDays} days.`
  }
  if (at('waiting') > 0) {
    return `${board} ${formatCents(at('waiting'))} invoiced and waiting to get paid.`
  }
  if (at('working') > 0) return `${board} All of it is on trucks still working.`
  return `${board} All of it is paid.`
}
