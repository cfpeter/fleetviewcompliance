/**
 * The settings page is four pages, and each section belongs to exactly one.
 *
 * WHAT THIS PINS, in the owner's words: "the setting page is too much to scroll
 * and update changes". Eight sections stood in one column — his name, his
 * password, his USDOT number, a nine-box notification matrix, quiet hours,
 * snoozes and a log of every message we ever sent him — 9,923px of it on a
 * 375px phone. The sections are now grouped behind `?tab=`, and only the group
 * asked for is rendered.
 *
 * The tests below are source assertions, like the ones in
 * carrier-operation.test.ts, because the failures they guard are not behaviours
 * a unit test can reach: they are a section that silently belongs to two groups
 * or to none, a redirect that forgets which group the reader was working in, and
 * a link from somewhere else in the app that lands on the wrong one. Each of
 * those renders a page that looks perfectly fine and is missing the thing the
 * person came for.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const page = read('../src/pages/app/settings.astro')

/** The four groups, in the order the strip shows them. */
const TABS = ['you', 'company', 'alerts', 'messages'] as const

/**
 * The markup of one group: everything between its own `{tab === 'x' && (` and
 * the next group's, or `</App>` for the last. The groups are siblings and never
 * nest, which is what makes the slice exact — and the test below checks that,
 * so a group moved inside another one fails here rather than quietly widening
 * somebody else's slice.
 */
const MARKERS = TABS.map((t) => `{tab === '${t}' && (`)

function groupBody(tab: (typeof TABS)[number]): string {
  const i = TABS.indexOf(tab)
  const start = page.indexOf(MARKERS[i])
  const end = i + 1 < TABS.length ? page.indexOf(MARKERS[i + 1]) : page.indexOf('</App>')
  return page.slice(start + MARKERS[i].length, end)
}

test('the four groups are siblings, each written once, in the order of the strip', () => {
  let at = -1
  for (const marker of MARKERS) {
    const first = page.indexOf(marker)
    const last = page.lastIndexOf(marker)
    assert.notEqual(first, -1, `${marker} is on the page`)
    assert.equal(first, last, `${marker} is written once`)
    assert.ok(first > at, 'the groups are in the order the strip shows them')
    at = first
  }
  assert.ok(page.indexOf('</App>') > at, 'and all of them are inside the layout')
})

test('every section is rendered by exactly one tab', () => {
  // The headings a person reads, taken from the markup rather than searched for
  // in it: a heading in two groups is two Save buttons writing one row from two
  // screens, and a heading in none is a control that has quietly left the
  // product. Both look fine on the screen you happen to be standing on.
  const headingsOf = (tab: (typeof TABS)[number]) =>
    [...groupBody(tab).matchAll(/<h2[^>]*>([^<{]+)/g)].map((m) => m[1].trim())

  assert.deepEqual(headingsOf('you'), ['Your account'])
  assert.deepEqual(headingsOf('company'), [
    'Your carrier',
    'How your company operates',
    'Who can sign in',
  ])
  assert.deepEqual(headingsOf('alerts'), ['Who gets told what', 'Quiet hours', 'Snoozed items'])
  assert.deepEqual(headingsOf('messages'), ['Recent messages'])

  // Nothing is left outside the four groups. A section that fell out of one
  // would render on every tab, which is the failure the groups exist to stop.
  const shell = page.slice(page.indexOf('<App '), page.indexOf(MARKERS[0]))
  assert.doesNotMatch(shell, /<h2/, 'no section stands above the groups')
})

test('each form saves back into the tab it was submitted from', () => {
  // Every branch of the POST handler leaves through `back()`, and `back()` is
  // the only place the address is built. A call site that wrote its own URL
  // would be a save that answers on a different screen.
  assert.match(
    page,
    /const back = \(query = ''\) =>\s*\n?\s*Astro\.redirect\(`\/app\/settings\?tab=\$\{tab\}/,
    'back() names the tab',
  )
  assert.equal(
    (page.match(/Astro\.redirect\(/g) ?? []).length,
    1,
    'there is one redirect on the page and every branch goes through it',
  )
  // `?saved=` and `?error=` used to start the query string. They are now the
  // second parameter, so a call site that kept the leading `?` would produce
  // `?tab=you?saved=profile` — a page with no tab and a parameter named
  // "tab=you?saved".
  assert.equal((page.match(/back\('\?/g) ?? []).length, 0, "no call site still writes back('?…')")
})

test('an unknown tab falls back and is never echoed', () => {
  // The same rule as `?error=`: a value out of the query string is matched
  // against what we know and dropped otherwise. It must never reach the page,
  // and it must never reach the redirect — `?tab=` is in every Location header
  // this page sends.
  assert.match(
    page,
    /TABS\.find\(\(t\) => t\.id === Astro\.url\.searchParams\.get\('tab'\)\) \?\? TABS\[0\]/,
    'the tab is resolved against the list, not read from the URL',
  )
  assert.equal(
    (page.match(/searchParams\.get\('tab'\)/g) ?? []).length,
    1,
    'the raw parameter is read once and nowhere else',
  )
})

test('the strip is links, not a tablist', () => {
  // `role="tablist"` is a promise to handle arrow keys, Home and End in script.
  // This app ships no client JavaScript at all, so the honest markup for four
  // addresses is four links — which every browser and screen reader already
  // drives.
  // `role="table"` and its row roles ARE on this page — the notification matrix
  // is a real table that becomes blocks on a phone — so the three tab roles are
  // named exactly rather than matched by prefix.
  // Comments stripped first: the note above the strip EXPLAINS why there is no
  // `role="tablist"` here, and prose that names the thing it rules out must not
  // read as the thing itself.
  const markup = page.replaceAll(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(markup, /role="(tablist|tab|tabpanel)"/, 'no tablist this app cannot operate')
  assert.match(page, /<nav\s+aria-label="Settings sections"/, 'the strip is navigation')
  assert.match(page, /aria-current=\{t\.id === tab \? 'page' : undefined\}/, 'and says which one')
  // Colour is never the only signal: aria-current above, semibold in
  // `.is-current`, and the pill is the same one the loads and drivers lists use.
  assert.match(page, /class:list=\{\['filter-tab shrink-0', t\.id === tab && 'is-current'\]\}/)
})

test('the page loads only what the tab it is drawing needs', () => {
  // The LOADER, not the whole file: `notification_preferences` is also written
  // by the save handler, where the tab decides nothing and a match would pass
  // for the wrong reason.
  const from = page.indexOf('const skip = <T,>')
  const to = page.indexOf('const carrier = carrierResult.data')
  assert.ok(from !== -1 && to > from, 'the loader block is where it was')
  const loader = page.slice(from, to)

  // These ran on every view. Somebody changing their phone number pulled 200
  // notification_log rows and the whole member list to draw a screen that shows
  // neither, out of a subrequest budget the Worker shares with everything else.
  for (const [table, tab] of [
    ['notification_preferences', 'alerts'],
    ['notification_category_preferences', 'alerts'],
    ['notification_snoozes', 'alerts'],
    ['notification_log', 'messages'],
    ['carrier_members', 'company'],
  ] as const) {
    const at = loader.indexOf(table)
    assert.notEqual(at, -1, `${table} is still read`)
    assert.match(
      loader.slice(Math.max(0, at - 200), at),
      new RegExp(`tab === '${tab}'`),
      `${table} is read only on '${tab}'`,
    )
  }

  // carriers and profiles are NOT gated: one row each, and between the timezone
  // fallback, the quiet hours and the carrier name on a snooze they are read by
  // more than one group.
  for (const table of ["from('carriers')", "from('profiles')"]) {
    const at = loader.indexOf(table)
    assert.notEqual(at, -1, `${table} is still read`)
    assert.doesNotMatch(
      loader.slice(Math.max(0, at - 200), at),
      /tab === '/,
      `${table} is not gated`,
    )
  }
  assert.match(page, /const skip = <T,>\(data: T\) =>/, 'the skipped ones keep the shape')
})

test('every link into a settings box names the box it is in', () => {
  // A link to the bare page lands on the account group. The USDOT box is in the
  // company group, so the dashboard row that says "we need your USDOT number"
  // would drop the owner on his own name and password and leave him to find it.
  const anchors = read('../src/lib/rules/anchors.ts')
  assert.match(anchors, /href: '\/app\/settings\?tab=company'/, 'the dot_number anchor names it')

  const dashboard = read('../src/pages/app/index.astro')
  assert.match(dashboard, /'\/app\/settings\?tab=company'/, 'a carrier subject goes to the company')
})
