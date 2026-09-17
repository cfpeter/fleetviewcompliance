/**
 * What is still missing before a quarterly return can be filed — and, much more
 * carefully, what a full bar is NOT allowed to mean.
 *
 * A progress bar over a tax return is the most dangerous widget in this app. The
 * shape is read in about a second and the reading it invites is "filled means
 * done". It is not. Everything this file can count is typing:
 *
 *   - A truck with miles entered can have the WRONG miles entered. Nothing here
 *     can tell, and nothing here pretends to.
 *   - A jurisdiction can be missing its tax rate, so its miles are known and its
 *     tax is not.
 *   - Fuel receipts arrive all quarter. "Some fuel entered" is not "all fuel
 *     entered", and there is no way to know the difference from inside the app.
 *
 * So three rules hold this file shut, and the tests pin all three:
 *
 * 1. **Nothing here ever says the return is ready.** There is no `ready` flag,
 *    no score, no green light, and no phrase in any string below that a person
 *    could read as permission to file. `src/pages/app/ifta/index.astro` already
 *    refuses to say it and that refusal survives this file.
 *
 * 2. **The checklist cannot be completed by the software.** Two of its steps —
 *    "you check the numbers" and "file by the date" — are permanently grey,
 *    because neither is something this app can observe. A list that always has
 *    an open item cannot be mistaken for a finished job however full the bar is.
 *
 * 3. **Grey is a count, not an absence.** A truck with no miles is grey, it is
 *    NEVER folded into the green, and it is never dropped off the strip. It is
 *    also named, because "3 trucks still need miles" is a sentence somebody can
 *    act on and "43% complete" is not.
 *
 * The colour vocabulary is `tones.ts`'s, unchanged and not extended: `overdue`
 * (red) is act now, `soon` (amber) is due soon, `good` (green) is on track,
 * `neutral` (grey) is missing. That is already exactly the meaning each tone
 * carries everywhere else in the app, so the strip borrows it rather than
 * teaching a second one.
 */

import { gallons } from '../ifta/compute.ts'
import { compactNumber } from './scale.ts'
import type { Tone } from './tones.ts'

const s = (n: number) => (n === 1 ? '' : 's')

/** How many truck names are printed before the rest are counted instead. */
const NAMED_TRUCKS = 6

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

export interface ReadinessStep {
  key: 'miles' | 'fuel' | 'rates' | 'check' | 'file'
  /** The thing that has to be true, in four or five words. */
  label: string
  /** Where it stands right now, in one short sentence. */
  detail: string
  /**
   * `overdue` red, `soon` amber, `good` green, `neutral` grey.
   *
   * `check` and `file` are ALWAYS grey. Whether the figures are right, and
   * whether the form was actually filed, are both outside anything this app can
   * see, so neither may ever be drawn as done.
   */
  tone: Tone
  /** The screen that fixes it, when one exists. */
  href?: string
  /** What that link says. Two or three words, an imperative, never "learn more". */
  action?: string
}

export interface Readiness {
  /** Trucks on file. 0 when there are none AND when the list could not be read. */
  totalTrucks: number
  /** Trucks with miles on this quarter. Never above `totalTrucks`. */
  withMiles: number
  /** The grey ones. Never negative. */
  withoutMiles: number
  /** Names of the trucks with nothing entered, capped at NAMED_TRUCKS. */
  waiting: string[]
  /** How many names `waiting` left out. */
  waitingMore: number
  /**
   * `withMiles / totalTrucks`, clamped into 0..1, and 0 when there are no
   * trucks to divide by.
   *
   * Display only, and deliberately never rendered as a percentage on its own:
   * see the "no unexplained score" note above. It exists so a caller drawing its
   * own strip cannot produce a bar longer than the track. No money, no gallons
   * and no mileage figure is ever derived from it — those are integers in
   * src/lib/ifta/compute.ts and they stay there.
   */
  fraction: number
  /** The sentence the figure leads with. The answer, never the name of a chart. */
  headline: string
  /** The arithmetic, written out, because a bare fraction is an unexplained score. */
  countLine: string
  /** Legend segments for `Proportion`. Grey is always present, even at zero. */
  segments: { label: string; count: number; tone: Tone }[]
  steps: ReadinessStep[]
  /** Handed to `Figure`'s `coverage`. Never empty: a full bar always needs this. */
  caveat: string[]
  /** The truck list could not be read, so no claim may be made about the fleet. */
  unreadable: boolean
}

/**
 * Whether one truck counts as having miles for the quarter.
 *
 * DELIBERATELY STRICTER than `truckCoverage()` in ifta.ts, which counts a truck
 * with at least one ROW — a trip sheet typed as zeroes is a truck somebody has
 * been through, and for the "who have I opened" question that is the right test.
 *
 * This is a different question. A truck whose jurisdictions total zero miles
 * puts nothing on the return, so counting it as progress makes the bar longer
 * without making the return any more complete, and the one direction this bar
 * must never err in is over-stating. A truck that genuinely sat in the yard all
 * quarter therefore shows grey, and `caveat` says so in plain words rather than
 * leaving the owner to read it as an accusation.
 */
function truckHasMiles(rows: readonly { vehicleId: string | null; miles: number }[], id: string) {
  return rows.filter((r) => r.vehicleId === id).reduce((n, r) => n + r.miles, 0) > 0
}

export function returnReadiness(args: {
  /** The fleet. `null` means the truck list could not be read, which is not "no trucks". */
  trucks: readonly { id: string; label: string }[] | null
  /** Every mileage row on this quarter, for every truck. */
  rows: readonly { vehicleId: string | null; miles: number }[]
  /** From `quarterlyReturn()`. Jurisdictions driven with no tax rate on file. */
  missingRates: readonly string[]
  totalMiles: number
  /** THOUSANDTHS of a gallon, as everywhere else in IFTA. */
  totalGallonsMilli: number
  /** Negative when the return is late. */
  daysLeft: number
  /** The due date already formatted; this file does no date arithmetic. */
  dueLabel: string
  hrefs: { miles: string; fuel: string; trucks: string }
}): Readiness {
  const { trucks, rows, missingRates, totalMiles, totalGallonsMilli, daysLeft, dueLabel } = args
  const unreadable = trucks === null
  const list = trucks ?? []

  // Counted by walking the truck LIST, never by counting distinct ids on the
  // rows. A mileage row still carrying the id of a truck that has since left the
  // fleet would otherwise push this past the total and print "8 of 7 trucks".
  const withMiles = unreadable ? 0 : list.filter((t) => truckHasMiles(rows, t.id)).length
  const totalTrucks = unreadable ? 0 : list.length
  const withoutMiles = Math.max(0, totalTrucks - withMiles)

  const missing = unreadable ? [] : list.filter((t) => !truckHasMiles(rows, t.id))
  const waiting = missing.slice(0, NAMED_TRUCKS).map((t) => t.label)
  const waitingMore = Math.max(0, missing.length - waiting.length)

  // No trucks means no denominator. 0, not NaN, and not 1 either — a fleet with
  // nothing on file has made no progress, it has not finished.
  const fraction = totalTrucks > 0 ? Math.min(1, Math.max(0, withMiles / totalTrucks)) : 0

  const headline = unreadable
    ? 'We could not read your truck list'
    : totalTrucks === 0
      ? 'No trucks on file yet'
      : withoutMiles > 0
        ? `${withoutMiles} truck${s(withoutMiles)} still need${withoutMiles === 1 ? 's' : ''} miles`
        : `All ${totalTrucks} trucks have miles entered`

  const countLine = unreadable
    ? 'Reload the page before you use this.'
    : totalTrucks === 0
      ? 'Add a truck, then enter its miles for the quarter.'
      : `${withMiles} of ${totalTrucks} truck${s(totalTrucks)} have miles entered.`

  // Both segments always present. The grey one is the point of the strip, so it
  // is never filtered out for being the smaller number.
  const segments: Readiness['segments'] = [
    { label: 'have miles', count: withMiles, tone: 'good' },
    { label: 'no miles yet', count: withoutMiles, tone: 'neutral' },
  ]

  return {
    totalTrucks,
    withMiles,
    withoutMiles,
    waiting,
    waitingMore,
    fraction,
    headline,
    countLine,
    segments,
    steps: buildSteps({
      unreadable,
      totalTrucks,
      withoutMiles,
      waiting,
      waitingMore,
      missingRates,
      totalMiles,
      totalGallonsMilli,
      daysLeft,
      dueLabel,
      hrefs: args.hrefs,
    }),
    caveat: [
      // Three short lines, not a paragraph. Read on a phone, in a yard, by
      // somebody who does not read English all day.
      'This counts what is typed in. It does not mean the numbers are right.',
      'A truck that did not run this quarter also shows as missing.',
      'A full bar does not mean the return is ready to file.',
    ],
    unreadable,
  }
}

function buildSteps(a: {
  unreadable: boolean
  totalTrucks: number
  withoutMiles: number
  waiting: string[]
  waitingMore: number
  missingRates: readonly string[]
  totalMiles: number
  totalGallonsMilli: number
  daysLeft: number
  dueLabel: string
  hrefs: { miles: string; fuel: string; trucks: string }
}): ReadinessStep[] {
  const steps: ReadinessStep[] = []

  // ---- miles. Grey when short, never red: a trip sheet nobody has typed yet is
  // missing, not wrong, and red here would compete with the "do not file" banners
  // that mean something worse.
  const names =
    a.waiting.length === 0
      ? ''
      : ` ${a.waiting.join(', ')}${a.waitingMore > 0 ? ` and ${a.waitingMore} more` : ''}.`
  steps.push(
    a.unreadable
      ? {
          key: 'miles',
          label: 'Miles for every truck',
          detail: 'We could not read your truck list, so we cannot say.',
          tone: 'neutral',
        }
      : a.totalTrucks === 0
        ? {
            key: 'miles',
            label: 'Miles for every truck',
            detail: 'No trucks on file. Add a truck first.',
            tone: 'neutral',
            href: a.hrefs.trucks,
            action: 'Add a truck',
          }
        : a.withoutMiles > 0
          ? {
              key: 'miles',
              label: 'Miles for every truck',
              detail: `Still waiting on${names}`,
              tone: 'neutral',
              href: a.hrefs.miles,
              action: 'Enter miles',
            }
          : {
              key: 'miles',
              label: 'Miles for every truck',
              detail: `All ${a.totalTrucks} trucks have miles.`,
              tone: 'good',
            },
  )

  // ---- fuel. Red only when there are miles and no gallons at all: that state
  // prices every jurisdiction at nothing, which files short. With neither input
  // yet it is simply a quarter nobody has started.
  steps.push(
    a.totalGallonsMilli > 0
      ? {
          key: 'fuel',
          label: 'Fuel receipts',
          detail: `${gallons(a.totalGallonsMilli)} gallons entered so far.`,
          tone: 'good',
          href: a.hrefs.fuel,
          action: 'Add receipts',
        }
      : a.totalMiles > 0
        ? {
            key: 'fuel',
            label: 'Fuel receipts',
            detail: 'No fuel entered. The tax cannot be worked out.',
            tone: 'overdue',
            href: a.hrefs.fuel,
            action: 'Add receipts',
          }
        : {
            key: 'fuel',
            label: 'Fuel receipts',
            detail: 'Nothing entered for this quarter yet.',
            tone: 'neutral',
            href: a.hrefs.fuel,
            action: 'Add receipts',
          },
  )

  // ---- rates. NAMED, never counted. "3 jurisdictions are missing a rate" is a
  // sentence nobody can act on; the codes are what she takes to the rate tables.
  steps.push(
    a.missingRates.length > 0
      ? {
          key: 'rates',
          label: 'Tax rate for every state',
          detail: `No rate for ${a.missingRates.join(', ')}. Those miles are not priced.`,
          tone: 'overdue',
        }
      : a.totalMiles > 0
        ? {
            key: 'rates',
            label: 'Tax rate for every state',
            detail: 'Every state on this return has a rate.',
            tone: 'good',
          }
        : {
            key: 'rates',
            label: 'Tax rate for every state',
            detail: 'No states on this return yet.',
            tone: 'neutral',
          },
  )

  // ---- the two the software cannot finish. These are why a full bar can never
  // read as a green light: the list still has open items on it, in grey, at the
  // moment every truck turns green.
  steps.push({
    key: 'check',
    label: 'You check the numbers',
    detail: 'We cannot do this for you. Miles can be entered and still be wrong.',
    tone: 'neutral',
  })

  steps.push({
    key: 'file',
    label: `File by ${a.dueLabel}`,
    detail:
      a.daysLeft < 0
        ? `${-a.daysLeft} day${s(-a.daysLeft)} late. File it now.`
        : a.daysLeft === 0
          ? 'Due today.'
          : `${a.daysLeft} day${s(a.daysLeft)} left. We cannot see if you filed.`,
    // Never green. Nothing in this app watches the filing portal, so "filed" is
    // not a fact it is entitled to draw.
    tone: a.daysLeft < 0 ? 'overdue' : a.daysLeft <= 30 ? 'soon' : 'neutral',
  })

  return steps
}

// ---------------------------------------------------------------------------
// Miles by jurisdiction, for the screen the miles are typed on
// ---------------------------------------------------------------------------

export interface JurisdictionBar {
  label: string
  value: number
  display: string
  tone: Tone
}

export interface JurisdictionMiles {
  items: JurisdictionBar[]
  total: number
  /** The sentence under the bars, or null when there is nothing true to say. */
  takeaway: string | null
}

/**
 * The quarter's miles added up per jurisdiction, ranked, for `Bars`.
 *
 * BARS, AND ONLY EVER BARS. Miles by jurisdiction is what the return reports, so
 * it belongs on screen — but it is drawn as a ranked list of codes and never as
 * a map or anything with a shape on it. This product is not a tracker, it does
 * not know where a truck is, and a picture that looks like it knows is a promise
 * the product cannot keep and would not want to.
 *
 * A jurisdiction with twelve miles against a fleet total of fifteen thousand is
 * the row that matters most and the one that is sub-pixel at true scale.
 * `widthPercent` floors it at `MIN_VISIBLE_PERCENT` inside `Bars`, which is why
 * this function hands over real values and lets the component scale them rather
 * than pre-computing widths here.
 */
export function jurisdictionMilesBars(
  rows: readonly { jurisdiction: string; miles: number }[],
): JurisdictionMiles {
  const totals = new Map<string, number>()
  for (const row of rows) {
    totals.set(row.jurisdiction, (totals.get(row.jurisdiction) ?? 0) + row.miles)
  }

  const items: JurisdictionBar[] = [...totals]
    .map(([label, value]) => ({
      label,
      value,
      display: compactNumber(value),
      // Brand, not red. Red means a problem in this app, and a big number here
      // is not a problem — it is just the state the trucks ran in most.
      tone: 'brand' as Tone,
    }))
    // Biggest first, ties broken by code so the order does not shuffle between
    // two page loads of the same quarter.
    .sort((x, y) => y.value - x.value || x.label.localeCompare(y.label))

  const total = items.reduce((n, i) => n + i.value, 0)
  const top = items[0]
  const takeaway =
    !top || total <= 0
      ? null
      : `${top.label} has ${compactNumber(top.value)} of the ${compactNumber(total)} miles on file. ${items.length} state${s(items.length)} or province${s(items.length)} this quarter.`

  return { items, total, takeaway }
}
