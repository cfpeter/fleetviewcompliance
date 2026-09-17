/**
 * The dashboard's one filter, expressed as data so it can be tested.
 *
 * The owner reads the dashboard on a phone, usually because he is worried about
 * one specific thing. With 46 tracked items the "coming up in the next 45 days"
 * section sits below an Overdue section and a 37-row "we need a date from you"
 * section, which on a phone means it does not exist. So the four stat tiles at
 * the top — which already name the exact subsets, and are already under his
 * thumb — became the filter.
 *
 * Two rules this module exists to keep honest:
 *
 * 1. A filter changes what is VISIBLE and NEVER what is ranked. `unknown` sits
 *    with `overdue` in src/lib/rules/index.ts because not knowing when a medical
 *    card expires carries the same exposure as it having expired. Nothing here
 *    sorts, re-ranks or re-groups; `visibleSections` only ever HIDES, and it
 *    hands back the sections in the catalogue's own order so a future edit
 *    cannot quietly reorder the page by reordering a filter.
 *
 * 2. The view lives in a GET param, never in client state. A filtered dashboard
 *    stays shareable, the back button steps through the filters he tried, and
 *    it works on one bar of signal in a yard — same doctrine as the segmented
 *    control on /app/vehicles.
 */

/** The three narrowing views, in the order the dashboard renders them. */
export const DASHBOARD_SECTIONS = ['overdue', 'unknown', 'soon'] as const
export type DashboardSection = (typeof DASHBOARD_SECTIONS)[number]

/** A narrowing view, or `all` — the resting state, everything on screen. */
export type DashboardView = DashboardSection | 'all'

/**
 * Read `?show=`.
 *
 * Anything we do not recognise means `all`, never an empty page. A stale link,
 * a truncated paste or a typo must not render a dashboard with nothing on it:
 * an owner who sees an empty compliance list concludes his data is gone, and
 * that is a support call and a lost customer, not a cosmetic bug. Same reason
 * the fleet list treats an unknown `?kind=` as "All".
 */
export function parseDashboardView(raw: string | null | undefined): DashboardView {
  const v = (raw ?? '').trim().toLowerCase()
  return v === 'overdue' || v === 'unknown' || v === 'soon' ? v : 'all'
}

/**
 * The URL for a view.
 *
 * `all` drops the param entirely rather than writing `?show=all`, so the way
 * back to everything is the plain `/app` the nav already points at — one URL
 * for the resting state instead of two that render identically.
 */
export function dashboardHref(view: DashboardView): string {
  return view === 'all' ? '/app' : `/app?show=${view}`
}

/** Is this section on screen in this view? */
export function showsSection(view: DashboardView, section: DashboardSection): boolean {
  return view === 'all' || view === section
}

/**
 * The sections on screen, in catalogue order.
 *
 * Derived from `DASHBOARD_SECTIONS` rather than built per view, because a
 * hand-written list per view is exactly how "overdue first" turns into
 * "whatever the last person typed" — and the ordering is the product.
 */
export function visibleSections(view: DashboardView): readonly DashboardSection[] {
  return DASHBOARD_SECTIONS.filter((s) => showsSection(view, s))
}

/**
 * How many rows a section shows before the page stops being a page.
 *
 * Measured, not guessed: unfiltered, the dashboard of a real carrier in the dev
 * data ran 15,494px tall on a desktop, and one section — 119 rows of "we need a
 * date from you" — was 11,084px of that on its own. Everything above it is the
 * part that sells the product: the ring, the four tiles, the arithmetic
 * sentence, the 13-week runway. Everything below it was a wall nobody reached
 * the bottom of, on either a phone or a sales call.
 *
 * Ten because ten is what a person reads before deciding, and because the row
 * eleven onwards was never the row he came for — see `capSection` on why the
 * tail is the safe end to cut.
 */
export const SECTION_ROW_CAP = 10

/**
 * Does THIS view trim its sections?
 *
 * Only the resting view does, and that asymmetry is the whole design rather
 * than an optimisation. The cap's link points at `dashboardHref(section)` —
 * the same URL the stat tile above already points at — so a filtered view is
 * the DESTINATION of a cap. Capping it too would make "Show all 119" land on a
 * page showing ten, which is a link lying about where it goes, on the one
 * screen whose entire job is trust.
 */
export function capsSections(view: DashboardView): boolean {
  return view === 'all'
}

/** A section's rows after the cap, plus the link to the rest. */
export interface CappedSection<Item, Extra> {
  /** The regulation rows to render. */
  items: Item[]
  /** The owner's own reminder rows, which sit under them in the same table. */
  reminders: Extra[]
  /** Every row the section holds. What the heading and the link must say. */
  total: number
  /** How many the cap is holding back. 0 when nothing is hidden. */
  hidden: number
  /** The way to the rest, or null when there is no rest. */
  more: { href: string; label: string } | null
}

/**
 * The first `cap` rows of a section, and an honest link to the others.
 *
 * WHICH ROWS SURVIVE. The tail is cut, and that is only safe because the lists
 * arrive ranked. `compareDeadlines` puts the soonest first within a standing
 * and sorts undated rows last among their peers; `compareReminders` does the
 * same for the owner's own lines. So:
 *
 *   - Overdue cuts expired documents first onto the screen (their due date is
 *     behind us, so they sort ahead of everything), then missed recurring
 *     filings by how soon the next cycle lands. The rows that go are the ones
 *     whose next cycle is furthest out.
 *   - Coming up cuts strictly soonest-first. The tail is the far end of 45 days.
 *   - Missing a date is NOT urgency-ranked and cannot be — nothing in that
 *     bucket has a date we can trust. It is ranked by the schedule we worked
 *     out unaided, most stale first, and the rows with no date at all sort last
 *     of all. So the tail this cap hides is disproportionately the rows with
 *     nothing on them. That is survivable only because the link goes to the
 *     date editor, which groups every one of them by driver and truck and is
 *     the surface for answering them anyway. It would not be survivable if the
 *     link went nowhere.
 *
 * Reminders are trimmed after the regulations, never before them, because that
 * is the order they already render in: when a federal deadline and an errand
 * are both overdue, the one that stops a truck is the one to read first.
 *
 * THE LINK COUNTS THE WHOLE SECTION, not what is on screen. A link reading
 * "Show all 10" above ten rows would be noise, so a section at or under the cap
 * gets no link at all; a link reading "Show all 10" above a hundred hidden rows
 * would be a lie, which is worse than no link.
 */
export function capSection<Item, Extra>(
  section: DashboardSection,
  view: DashboardView,
  items: readonly Item[],
  reminders: readonly Extra[] = [],
  cap: number = SECTION_ROW_CAP,
): CappedSection<Item, Extra> {
  const total = items.length + reminders.length

  if (!capsSections(view) || total <= cap) {
    return { items: [...items], reminders: [...reminders], total, hidden: 0, more: null }
  }

  const shownItems = items.slice(0, cap)
  const shownReminders = reminders.slice(0, cap - shownItems.length)

  return {
    items: shownItems,
    reminders: shownReminders,
    total,
    hidden: total - shownItems.length - shownReminders.length,
    // Plain, and deliberately not cleverer than this. The owners reading it are
    // Glendale and Sun Valley fleet owners, many of whom read English as a
    // second language: three words, one of them a number they already saw in
    // the heading, and an arrow that is not a word in any language.
    more: { href: dashboardHref(section), label: `Show all ${total} →` },
  }
}

/** How a view reads mid-sentence: "Showing {noun} only". */
export function viewNoun(view: DashboardView): string {
  switch (view) {
    case 'overdue':
      return 'what is overdue'
    case 'unknown':
      return 'what is missing a date'
    case 'soon':
      return 'what is coming up'
    case 'all':
      return 'everything'
  }
}

/**
 * What an empty filtered list should say.
 *
 * "Nothing to show" is a lie of omission here. Filtered to Overdue and finding
 * nothing is the best news this app can give him and should read like it;
 * filtered to Missing a date and finding nothing means the opposite of a broken
 * page. One generic empty state for all three would make the good outcome
 * indistinguishable from a bug, on the screen whose entire job is trust.
 */
export function emptyFilterState(view: DashboardView): { title: string; body: string } | null {
  switch (view) {
    case 'overdue':
      return {
        title: 'Nothing is overdue',
        body: 'Every deadline we have a date for is still ahead of you. The ones with no date are under "Missing a date". Those carry the same risk as an expired one.',
      }
    case 'unknown':
      return {
        title: 'We have a date for everything',
        body: 'Nothing is waiting on you. Every rule we track has a date to count from, so every row on this dashboard is a real answer, not a guess.',
      }
    case 'soon':
      return {
        title: 'Nothing is due in the next 45 days',
        body: 'Your next deadline is further out than that. Anything already past due, or still missing a date, is on the other two tiles.',
      }
    // `all` has its own onboarding empty state on the page — a carrier with no
    // drivers and no trucks yet needs a button, not a reassurance.
    case 'all':
      return null
  }
}
