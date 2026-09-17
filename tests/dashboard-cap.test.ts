/**
 * The row cap on the dashboard's sections, and the four ways it can lie.
 *
 * The dashboard drew every row it had. On a real carrier in the dev data that
 * was 15,494px of page on a desktop, with one section — 119 rows of "we need a
 * date from you" — accounting for 11,084px on its own. Everything above the
 * first fold is the part that sells the product; everything below it was a wall.
 *
 * So each section stops at ten rows and hands over to the view its own stat tile
 * already points at. Four things have to stay true for that to be an improvement
 * rather than a data-loss bug, and each has a test here:
 *
 *   1. The link's count is the SECTION's count, not the drawn count. "Show all
 *      10" over a hundred hidden rows is worse than no link at all.
 *   2. A FILTERED view is never capped. It is where the link goes. Capping it
 *      would make "Show all 119" land on a page showing ten.
 *   3. A section at or under the cap shows no link. No "Show all 7" over seven.
 *   4. The cap only ever HIDES the tail. It never reorders, never drops a row
 *      from the count, and never touches the empty states.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  capSection,
  capsSections,
  DASHBOARD_SECTIONS,
  type DashboardSection,
  type DashboardView,
  dashboardHref,
  emptyFilterState,
  parseDashboardView,
  SECTION_ROW_CAP,
} from '../src/lib/dashboard.ts'

const VIEWS: readonly DashboardView[] = ['all', 'overdue', 'unknown', 'soon']

/** `n` distinguishable rows, so a reordering or an off-by-one is visible. */
const rows = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

// ------------------------------------------------- what the cap actually is

test('the cap is ten rows', () => {
  // Pinned because the number is a product decision, not an implementation
  // detail: ten is what a person reads before deciding. If this moves, the
  // copy in the section headings and the measurements in the page comment move
  // with it, so it should not move by accident.
  assert.equal(SECTION_ROW_CAP, 10)
})

test('only the resting view caps — every narrowing view is a destination', () => {
  assert.equal(capsSections('all'), true)
  for (const section of DASHBOARD_SECTIONS) {
    assert.equal(capsSections(section), false, `view '${section}' capped its own section`)
  }
})

// --------------------------------------------------- 1. the link cannot lie

test('the link names the whole section, never the ten rows on screen', () => {
  const capped = capSection('unknown', 'all', rows(119))

  assert.equal(capped.items.length, SECTION_ROW_CAP)
  assert.equal(capped.total, 119)
  assert.equal(capped.hidden, 109)
  assert.equal(capped.more?.label, 'Show all 119 →')

  // The number in the link is the number the heading prints. Two different
  // counts for one section on one screen is the bug this whole file is about.
  assert.ok(capped.more?.label.includes(String(capped.total)))
  assert.ok(
    !capped.more?.label.includes(String(capped.items.length + capped.reminders.length)),
    'the link counted what is drawn instead of what exists',
  )
})

test('the copy is the plain sentence and nothing cleverer', () => {
  // These owners are Glendale and Sun Valley fleet owners, many of whom read
  // English as a second language. Three words, a number they have already seen
  // in the heading, and an arrow that is not a word in any language.
  assert.equal(capSection('overdue', 'all', rows(15)).more?.label, 'Show all 15 →')
  assert.equal(capSection('soon', 'all', rows(11)).more?.label, 'Show all 11 →')
  assert.equal(capSection('unknown', 'all', rows(140)).more?.label, 'Show all 140 →')
})

test('the link goes to the view the stat tile already points at', () => {
  for (const section of DASHBOARD_SECTIONS) {
    const capped = capSection(section, 'all', rows(50))
    assert.equal(capped.more?.href, dashboardHref(section))

    // And the round trip holds: following it lands on a page that renders that
    // exact section. A link whose href did not parse back would land on the
    // unfiltered page, which is the page he was trying to leave.
    const show = new URL(capped.more?.href ?? '', 'https://example.test').searchParams.get('show')
    assert.equal(parseDashboardView(show), section)
  }
})

test('the count includes reminders, because the table does', () => {
  // The owner's own lines render in the same table under the same heading, so
  // a link that counted only regulations would be short by exactly the rows he
  // can see at the bottom of it.
  const capped = capSection('overdue', 'all', rows(8, 'rule'), rows(7, 'mine'))
  assert.equal(capped.total, 15)
  assert.equal(capped.more?.label, 'Show all 15 →')
})

// ------------------------------------- 2. the destination is never trimmed

test('a filtered view is never capped, however long the list', () => {
  // The single most likely bug in this change: cap the section, then apply the
  // same cap to the page the link leads to, so "Show all 119" shows ten.
  for (const section of DASHBOARD_SECTIONS) {
    const capped = capSection(section, section, rows(119))
    assert.equal(capped.items.length, 119, `view '${section}' trimmed its own section`)
    assert.equal(capped.hidden, 0)
    assert.equal(capped.more, null, `view '${section}' offered a link to itself`)
  }
})

test('following the link actually shows more than the page you left', () => {
  // End to end, in one assertion, without a browser: cap on the resting view,
  // read the href, parse it back into a view, cap again with that view. If the
  // second number is not larger, the link is decorative.
  for (const section of DASHBOARD_SECTIONS) {
    const all = rows(119)
    const resting = capSection(section, 'all', all)
    const destinationView = parseDashboardView(
      new URL(resting.more?.href ?? '', 'https://example.test').searchParams.get('show'),
    )
    const landed = capSection(section, destinationView, all)

    assert.ok(
      landed.items.length > resting.items.length,
      `'${section}': the link led to ${landed.items.length} rows, from ${resting.items.length}`,
    )
    assert.equal(landed.items.length, all.length)
  }
})

// --------------------------------------------- 3. no link over a short list

test('a section at exactly the cap shows no link', () => {
  const capped = capSection('soon', 'all', rows(SECTION_ROW_CAP))
  assert.equal(capped.items.length, SECTION_ROW_CAP)
  assert.equal(capped.hidden, 0)
  assert.equal(capped.more, null, 'ten rows got a "Show all 10" link above them')
})

test('nothing under the cap shows a link either', () => {
  for (let n = 0; n <= SECTION_ROW_CAP; n++) {
    const capped = capSection('soon', 'all', rows(n))
    assert.equal(capped.more, null, `${n} rows offered a link`)
    assert.equal(capped.items.length, n)
    assert.equal(capped.hidden, 0)
  }
  // One past it, and only one past it, the link appears.
  assert.ok(capSection('soon', 'all', rows(SECTION_ROW_CAP + 1)).more)
  assert.equal(capSection('soon', 'all', rows(SECTION_ROW_CAP + 1)).hidden, 1)
})

test('the cap counts rows, not arrays — nine rules plus two reminders is eleven', () => {
  // Counting the two lists separately would let a section quietly draw twenty
  // rows while both halves believed they were under the cap.
  const capped = capSection('overdue', 'all', rows(9, 'rule'), rows(2, 'mine'))
  assert.equal(capped.total, 11)
  assert.equal(capped.items.length + capped.reminders.length, SECTION_ROW_CAP)
  assert.equal(capped.hidden, 1)
  assert.equal(capped.more?.label, 'Show all 11 →')
})

// ------------------------------------------- 4. it hides, and does nothing else

test('the rows kept are the FIRST rows, in the order they arrived', () => {
  // The lists reach this function ranked — soonest first within a standing, and
  // that ranking is the product. The cap is a `.slice(0, n)` and must stay one:
  // anything that reordered here would bury the rows the page exists to surface
  // while every count on the screen still looked right.
  const all = rows(40)
  const capped = capSection('overdue', 'all', all)
  assert.deepEqual(capped.items, all.slice(0, SECTION_ROW_CAP))
  assert.equal(capped.items[0], 'r0', 'the most urgent row was not kept first')
})

test('reminders are trimmed before regulations, never the other way round', () => {
  // They already render last within the bucket: when a federal deadline and an
  // errand are both overdue, the one that stops a truck is the one to read
  // first. The cap has to cut from the same end.
  const capped = capSection('overdue', 'all', rows(8, 'rule'), rows(8, 'mine'))
  assert.equal(capped.items.length, 8, 'a regulation was dropped while a reminder stayed')
  assert.equal(capped.reminders.length, 2)
  assert.deepEqual(capped.reminders, ['mine0', 'mine1'])
})

test('a section with more regulations than the cap shows no reminders at all', () => {
  const capped = capSection('overdue', 'all', rows(15, 'rule'), rows(4, 'mine'))
  assert.equal(capped.items.length, SECTION_ROW_CAP)
  assert.equal(capped.reminders.length, 0)
  // Which is why the page keys the "these are your own lines" note off the
  // SHOWN reminders. Explaining a badge that is not on screen is noise.
  assert.equal(capped.total, 19)
  assert.equal(capped.hidden, 9)
})

test('hidden plus drawn is always the total, in every view and at every length', () => {
  for (const view of VIEWS) {
    for (const section of DASHBOARD_SECTIONS) {
      for (const n of [0, 1, 9, 10, 11, 37, 119, 400]) {
        for (const m of [0, 1, 3, 12]) {
          const capped = capSection(section, view, rows(n, 'rule'), rows(m, 'mine'))
          assert.equal(capped.total, n + m, `${view}/${section} ${n}+${m}: wrong total`)
          assert.equal(
            capped.items.length + capped.reminders.length + capped.hidden,
            capped.total,
            `${view}/${section} ${n}+${m}: rows went missing`,
          )
          // A link exists if and only if something is hidden.
          assert.equal(capped.more !== null, capped.hidden > 0)
        }
      }
    }
  }
})

test('an empty section stays empty — the cap invents nothing', () => {
  // The page renders a section only when it has rows, and then falls through to
  // the per-filter empty states. Both of those read `total`, so a cap that
  // reported anything but 0 here would put an empty table on screen or swallow
  // the "Nothing is overdue" reassurance.
  for (const view of VIEWS) {
    for (const section of DASHBOARD_SECTIONS) {
      const capped = capSection(section, view, [], [])
      assert.equal(capped.total, 0)
      assert.equal(capped.hidden, 0)
      assert.equal(capped.items.length, 0)
      assert.equal(capped.reminders.length, 0)
      assert.equal(capped.more, null, 'an empty section offered "Show all 0"')
    }
  }
})

test('the filter empty states are untouched by capping', () => {
  // The cap and the empty state answer different questions — "is this list long"
  // and "is this list empty" — and the empty state is the one that must still
  // read like good news.
  for (const section of DASHBOARD_SECTIONS) {
    const state = emptyFilterState(section)
    assert.ok(state, `view '${section}' lost its empty state`)
    assert.ok(state.title.length > 0 && state.body.length > 0)
  }
  assert.equal(emptyFilterState('all'), null)
})

test('the cap never changes which sections are on screen', () => {
  // Visibility is `showsSection`'s job and stays there. A cap that could take a
  // section to zero rows would be a second, silent filter.
  const sections: DashboardSection[] = [...DASHBOARD_SECTIONS]
  for (const section of sections) {
    const capped = capSection(section, 'all', rows(400))
    assert.ok(capped.items.length > 0, `'${section}' was capped out of existence`)
  }
})

test('the caller can hand the cap a different number and the link still tells the truth', () => {
  // The cap is a parameter so a test can pin behaviour at a boundary without
  // building 119 rows. The invariants must not depend on it being 10.
  const capped = capSection('soon', 'all', rows(5), [], 3)
  assert.equal(capped.items.length, 3)
  assert.equal(capped.hidden, 2)
  assert.equal(capped.more?.label, 'Show all 5 →')
  assert.equal(capSection('soon', 'all', rows(3), [], 3).more, null)
})
