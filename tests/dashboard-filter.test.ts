/**
 * The dashboard filter, and the one thing it must never do.
 *
 * The filter exists because the owner reads this screen on a phone and could
 * not reach the "coming up in 45 days" section past a 37-row list. The risk in
 * adding a filter to a ranked list is that someone eventually implements it by
 * building a per-view list of sections — and the moment that list is written by
 * hand, the ordering doctrine in src/lib/rules/index.ts (unknown ranks WITH
 * overdue, never below current) is one careless edit away from being reversed
 * on the page while the engine still reports it correctly. Nothing would throw.
 * The dashboard would just quietly start burying the rows it exists to surface.
 *
 * So these tests assert visibility, and they assert ORDER, separately.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DASHBOARD_SECTIONS,
  type DashboardView,
  dashboardHref,
  emptyFilterState,
  parseDashboardView,
  showsSection,
  viewNoun,
  visibleSections,
} from '../src/lib/dashboard.ts'

const VIEWS: readonly DashboardView[] = ['all', 'overdue', 'unknown', 'soon']

test('the section order on the page is overdue, then unknown, then soon', () => {
  // Pinned deliberately. `unknown` sitting second — above `soon` — is the whole
  // doctrine: a medical card we were never given a date for is not less urgent
  // than one expiring in six weeks.
  assert.deepEqual([...DASHBOARD_SECTIONS], ['overdue', 'unknown', 'soon'])
})

test('a view only ever hides sections — it never reorders them', () => {
  for (const view of VIEWS) {
    const shown = visibleSections(view)

    // Every shown section is a real one, and the shown list is a SUBSEQUENCE of
    // the catalogue: same relative order, some entries dropped. This is the
    // assertion that makes "filtering cannot re-rank" a property rather than a
    // comment somebody can stop honouring.
    const positions = shown.map((s) => DASHBOARD_SECTIONS.indexOf(s))
    assert.ok(
      positions.every((p) => p >= 0),
      `view '${view}' shows a section that is not in the catalogue`,
    )
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
      `view '${view}' reordered the sections`,
    )
  }
})

test('the resting view shows all three sections', () => {
  assert.deepEqual([...visibleSections('all')], [...DASHBOARD_SECTIONS])
})

test('a narrowing view shows exactly its own section', () => {
  for (const section of DASHBOARD_SECTIONS) {
    assert.deepEqual([...visibleSections(section)], [section])

    for (const other of DASHBOARD_SECTIONS) {
      assert.equal(
        showsSection(section, other),
        section === other,
        `view '${section}' got ${other} wrong`,
      )
    }
  }
})

test('every filter actually narrows something', () => {
  // Guards against the filter that renders but does nothing: if a view ever
  // showed all three sections, the page would look filtered and read unfiltered.
  for (const section of DASHBOARD_SECTIONS) {
    assert.ok(
      visibleSections(section).length < DASHBOARD_SECTIONS.length,
      `view '${section}' hides nothing`,
    )
  }
})

test('a missing, empty or nonsense ?show= means everything, never an empty page', () => {
  // An owner who opens his compliance dashboard and sees nothing concludes his
  // data is gone. A stale bookmark or a truncated paste must never produce that.
  for (const raw of [null, undefined, '', '   ', 'nope', 'OVERDUE ', 'soon;drop', '45', 'all']) {
    const view = parseDashboardView(raw)
    assert.ok(VIEWS.includes(view), `parsed '${raw}' to something unrenderable: ${view}`)
  }
  assert.equal(parseDashboardView(null), 'all')
  assert.equal(parseDashboardView(''), 'all')
  assert.equal(parseDashboardView('nope'), 'all')
  assert.equal(parseDashboardView('all'), 'all')
})

test('?show= is read forgivingly: case and stray whitespace still filter', () => {
  assert.equal(parseDashboardView('OVERDUE'), 'overdue')
  assert.equal(parseDashboardView(' soon '), 'soon')
  assert.equal(parseDashboardView('Unknown'), 'unknown')
})

test('every tile links to a URL that parses back to that same tile', () => {
  // The round trip is the back button working. If href and parse ever disagree,
  // clicking a tile lands on an unfiltered page that still paints that tile as
  // selected — the filter would look broken rather than absent.
  for (const view of VIEWS) {
    const href = dashboardHref(view)
    const show = new URL(href, 'https://example.test').searchParams.get('show')
    assert.equal(parseDashboardView(show), view, `${view} did not survive ${href}`)
  }
})

test('the everything view is the bare /app the nav already points at', () => {
  // Not `?show=all`. Two URLs rendering the same resting state would split the
  // back-button history and make the "Dashboard" nav item look like a filter.
  assert.equal(dashboardHref('all'), '/app')
  assert.ok(!dashboardHref('all').includes('?'))
})

test('each narrowing view has its own honest empty state', () => {
  const titles = new Set<string>()
  for (const section of DASHBOARD_SECTIONS) {
    const state = emptyFilterState(section)
    assert.ok(state, `view '${section}' has no empty state`)
    assert.ok(state.title.length > 0 && state.body.length > 0)

    // "Nothing to show" is the sentence this test exists to prevent: filtered to
    // Overdue and finding nothing is good news, and must not read like a bug.
    assert.ok(
      !/nothing to show/i.test(state.title),
      `view '${section}' fell back to a generic empty state`,
    )
    titles.add(state.title)
  }
  assert.equal(titles.size, DASHBOARD_SECTIONS.length, 'two views share an empty-state title')
})

test('the unfiltered view has no filter empty state of its own', () => {
  // A carrier with no drivers and no trucks needs the onboarding state on the
  // page — a button — not a reassurance that nothing is overdue.
  assert.equal(emptyFilterState('all'), null)
})

test('every view has a noun for the "showing … only" line', () => {
  const nouns = VIEWS.map(viewNoun)
  assert.ok(nouns.every((n) => n.length > 0))
  assert.equal(new Set(nouns).size, VIEWS.length, 'two views describe themselves the same way')
})
