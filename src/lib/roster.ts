/**
 * How the roster reads on screen: the big number on /app/setup, the sentence
 * under it, and the one nudge the dashboard is allowed to show.
 *
 * Lifted out of the page for the reason `dueLine` was lifted out of the
 * dashboard and into src/lib/rules/index.ts: a decision that lives only in an
 * .astro file is a decision no test can pin, and this is the exact shape of bug
 * that produces. The page rendered `${added} of ${target}` for every state that
 * had a target, so a carrier who has added seven trucks against a last MCS-150
 * that reported one read "7 of 1" — a progress idiom used on a pair of numbers
 * that are not progress. It looked broken, on the first screen a new customer
 * sees.
 *
 * It sits here rather than beside `rosterProgress` in onboarding.ts because
 * that file holds the DECISIONS — which of four states the roster is in — and
 * this one holds the WORDS. Same split as rules/compute.ts against
 * rules/index.ts.
 *
 * COPY RULE FOR EVERY STRING IN THIS FILE. These sentences are read by small
 * fleet owners in Los Angeles, many of whom read English as a second language.
 * Short sentences. Common words. Say the thing; do not hint at it.
 */

import type { RosterProgress } from './onboarding.ts'

/**
 * The big number on a roster tile.
 *
 * "X of Y" IS A PROGRESS IDIOM AND IT ONLY SURVIVES X <= Y. It earns its place
 * in `partial` ("3 of 7" — four to go) and in `met` ("7 of 7" — done). It has
 * no reading at all when the owner has more trucks in the yard than his last
 * federal filing reported: there is no denominator to be a fraction of, and the
 * federal number is the stale one. So `over` prints the count he actually has,
 * exactly as `unknown` already did, and `rosterLine` below carries the
 * explanation.
 */
export function rosterCount(p: RosterProgress): string {
  switch (p.state) {
    case 'unknown':
    case 'over':
      return String(p.added)
    case 'partial':
    case 'met':
      return `${p.added} of ${p.target}`
  }
}

/** The sentence under the number. `noun` is 'power-unit' or 'driver'. */
export function rosterLine(p: RosterProgress, noun: string): string {
  switch (p.state) {
    case 'unknown':
      return `The federal file does not list a ${noun} count for you. You have added ${p.added}.`
    case 'partial':
      return `FMCSA has you at ${p.target}. You have added ${p.added}. ${p.remaining} to go.`
    case 'met':
      return `FMCSA has you at ${p.target} and you have added ${p.added}. That matches.`
    case 'over':
      return `FMCSA has you at ${p.target}. You have added ${p.added}. Your last MCS-150 is out of date.`
  }
}

/**
 * Is there still roster work to do that WE can see?
 *
 * `partial` is the only state that names something outstanding. `over` is not
 * unfinished — it is finished and then some — and `unknown` with something
 * added is as finished as we can tell, because the federal file gave us no
 * count to measure it against. `unknown` with NOTHING added is the genuinely
 * empty fleet, and that one is not settled.
 *
 * Used for the heading on /app/setup, so a page reached with a complete roster
 * reads as a status page instead of an unfinished chore.
 */
export function rosterSettled(trucks: RosterProgress, drivers: RosterProgress): boolean {
  const done = (p: RosterProgress) => p.added > 0 && p.state !== 'partial'
  return done(trucks) && done(drivers)
}

/**
 * The dashboard's one sentence about setup, or null for "say nothing".
 *
 * WHY THESE TWO NUMBERS AND NOTHING ELSE. The federal targets are not on the
 * `carriers` table — /app/setup fetches them live from FMCSA — and a dashboard
 * that made a network call to a federal data service before it could paint
 * would be a dashboard that hangs when Socrata does. So the trigger is the
 * cheapest honest local fact: an empty truck list, or an empty driver list.
 *
 * It is also the right line to draw. Zero trucks means no inspection and no
 * Clean Truck Check clock; zero drivers means no medical card, no CDL expiry,
 * no MVR and no Clearinghouse clock. Those are the dates the product exists
 * for, so below this line the app is not merely incomplete, it is doing
 * nothing. Above it, the nudge disappears — a banner that never goes away stops
 * being a nudge and becomes furniture.
 */
export function setupNudge(trucks: number, drivers: number): string | null {
  if (trucks > 0 && drivers > 0) return null
  if (trucks === 0 && drivers === 0) {
    return 'You have no trucks and no drivers yet. We have no dates to watch until you add them.'
  }
  if (trucks === 0) {
    return 'You have no trucks yet. Add a truck to see its inspection and Clean Truck Check dates.'
  }
  return 'You have no drivers yet. Add a driver to see the medical card and CDL dates.'
}

/**
 * What /app/setup just did, read back off the URL.
 *
 * An ALLOW-LIST, and it is the same rule `notice()` in onboarding.ts follows:
 * this value arrives in a query string, anybody can write a query string, and a
 * page that renders what the URL says is a page anybody can put words into. The
 * only two answers are the two we send.
 *
 * The record's own name is deliberately NOT carried back. A driver's name in a
 * URL lands in every access log between the phone and the desk, which is the
 * same reason /app/drivers/new refuses to round-trip a date of birth. The
 * counts on the page move on their own, which is the confirmation that matters.
 */
export type AddedKind = 'truck' | 'driver'

export function parseAdded(raw: string | null | undefined): AddedKind | null {
  return raw === 'truck' || raw === 'driver' ? raw : null
}

export function addedLine(kind: AddedKind): string {
  return kind === 'truck'
    ? 'Truck added. Add the next truck, or add a driver.'
    : 'Driver added. Add the next driver, or add a truck.'
}
