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
        body: 'Every deadline we have a date for is still ahead of you. The ones we cannot date are under "Missing a date" — those carry the same exposure as an expired one.',
      }
    case 'unknown':
      return {
        title: 'We have a date for everything',
        body: 'Nothing is waiting on you for a date. Every rule we track has something to count from, so every row on this dashboard is a real answer rather than a guess.',
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
