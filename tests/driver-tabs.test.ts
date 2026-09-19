/**
 * The driver page is four pages, and each section belongs to exactly one.
 *
 * WHAT THIS PINS, in the owner's words: "organaze the driver page is too many
 * sections now is becoming too much of confustion". Eight blocks stood in one
 * column — the record, the checklist, twelve date boxes, a pay chart, the
 * papers, the link panel, his own reminders, every date ever recorded and the
 * delete panel — on a page already measured at 5,618px on a 375px phone. They
 * are now grouped behind `?tab=`, and only the group asked for is rendered.
 *
 * Written as source assertions, like tests/settings-tabs.test.ts, because the
 * failures they guard are not behaviours a unit test can reach: a section that
 * belongs to two groups or to none, a save that answers on a different tab
 * than the one it was typed on, a query that runs for a screen that draws
 * nothing from it, and a link from elsewhere in the app that lands on the wrong
 * tab. Every one of those renders a page that looks perfectly fine and is
 * missing the thing the person came for.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const page = read('../src/pages/app/drivers/[id].astro')

/** The four groups, in the order the strip shows them. */
const TABS = ['dates', 'papers', 'pay', 'record'] as const
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
  // A heading in two groups is two Save buttons writing one row from two
  // screens; a heading in none is a control that has quietly left the product.
  // Both look fine on the screen you happen to be standing on.
  const headingsOf = (tab: (typeof TABS)[number]) =>
    [...groupBody(tab).matchAll(/<h2[^>]*>([^<{]+)/g)].map((m) => m[1].trim()).filter(Boolean)

  assert.deepEqual(headingsOf('dates'), [
    'What this driver needs',
    'Compliance dates',
    'Everything recorded for this driver',
  ])
  assert.deepEqual(headingsOf('pay'), ['Pay'])
  assert.deepEqual(headingsOf('record'), ['Driver record', 'Delete this driver'])

  // The papers tab draws two components, which carry their own headings. Named
  // here rather than counted, so a component dropped from the page fails.
  const papers = groupBody('papers')
  assert.match(papers, /<Documents\s/, 'the paper list is on the papers tab')
  assert.match(papers, /<DriverLinkPanel/, 'asking the driver for paper is beside the paper')

  // His own reminders sit with the dates: both answer "what is coming up for
  // this man", and one of them is the half no regulation asked for.
  assert.match(groupBody('dates'), /<RemindersSection/, 'the reminders are with the dates')

  // Nothing is left outside the four groups except the header. A section that
  // fell out of one would render on every tab, which is what the groups exist
  // to stop.
  const shell = page.slice(page.indexOf('<App '), page.indexOf(MARKERS[0]))
  assert.doesNotMatch(shell, /<h2/, 'no section stands above the groups')
})

test('every save comes back to the tab it was typed on', () => {
  // A fragment never reaches the server, so the tab cannot be recovered from
  // one: it has to be in the query string of every redirect this page sends.
  // `back()` is the only place that address is built, and the tab goes in
  // FIRST so a caller's own `#fragment` still trails at the end.
  assert.match(
    page,
    /return Astro\.redirect\(`\/app\/drivers\/\$\{id\}\?tab=\$\{tab\}\$\{params \? `&\$\{params\}` : ''\}`, 303\)/,
    'back() names the tab',
  )
  // Two other redirects exist and both LEAVE the page — the roster, on a driver
  // that is not ours and after a delete. Neither can carry a tab.
  const others = [...page.matchAll(/Astro\.redirect\(/g)].length
  assert.equal(others, 3, 'a new redirect was added — does it keep the reader on his tab?')
  assert.equal((page.match(/back\('\?/g) ?? []).length, 0, "no call site still writes back('?…')")
})

test('an unknown tab falls back and is never echoed', () => {
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
  // addresses is four links. Comments stripped first: the note above the strip
  // EXPLAINS why there is no tablist, and prose naming the thing it rules out
  // must not read as the thing itself.
  const markup = page.replaceAll(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(markup, /role="(tablist|tab|tabpanel)"/, 'no tablist this app cannot operate')
  assert.match(page, /<nav\s+aria-label="Driver sections"/, 'the strip is navigation')
  assert.match(page, /aria-current=\{t\.id === tab \? 'page' : undefined\}/, 'and says which one')
  assert.match(page, /class:list=\{\['filter-tab shrink-0', t\.id === tab && 'is-current'\]\}/)
})

test('who this is stays on screen on every tab but the one that edits it', () => {
  // A tab is a page you can be deep inside. Reading a pay chart for a man who
  // was terminated in March, with nothing on screen saying so, is the failure
  // this line exists to prevent — and a licence that ran out last week is the
  // one date that stops a truck.
  const shell = page.slice(page.indexOf('<App '), page.indexOf(MARKERS[0]))
  assert.match(shell, /tab !== 'record'/, 'the facts line is gated on the record tab, not on one tab')
  for (const fact of ['statusPillClass(driver.status)', 'formatPhone(driver.phone)', 'driver.cdl_expires_on']) {
    assert.ok(shell.includes(fact), `"${fact}" is no longer said outside the record tab`)
  }
})

test('the page loads only what the tab it is drawing needs', () => {
  // Thirteen round trips ran on every view. An owner opening a driver to read a
  // medical card date pulled 400 settlements, 200 documents, every link ever
  // minted and the last 25 things the driver sent — to draw a screen showing
  // none of them, out of a subrequest budget the Worker shares with everything
  // else the request does.
  const from = page.indexOf('const skip = <T,>')
  const to = page.indexOf('const documents = (documentData')
  assert.ok(from !== -1 && to > from, 'the loader block is where it was')
  const loader = page.slice(from, to)

  for (const [call, tab] of [
    ['loadCurrentAnchors()', 'dates'],
    ["from('compliance_records')", 'dates'],
    ['loadDeadlines(', 'dates'],
    ['loadReminders(', 'dates'],
    ["from('settlements')", 'pay'],
    ["from('documents')", 'papers'],
    ["from('driver_links')", 'papers'],
    ["from('driver_submissions')", 'papers'],
  ] as const) {
    const at = loader.indexOf(call)
    assert.notEqual(at, -1, `${call} is still read`)
    assert.match(
      loader.slice(Math.max(0, at - 200), at),
      new RegExp(`tab === '${tab}'`),
      `${call} is read only on '${tab}'`,
    )
  }

  // The driver row itself is NEVER gated: it is the name at the top of the
  // page, it decides whether this driver is ours at all, and every tab is
  // about him.
  const row = page.indexOf("const { data: driver, error: loadError } = await supabase")
  assert.notEqual(row, -1, 'the driver is still loaded')
  assert.doesNotMatch(
    page.slice(Math.max(0, row - 200), row + 200),
    /tab === '/,
    'the driver row is gated on a tab — three tabs out of four would 404 him',
  )
  assert.match(page, /const skip = <T,>\(data: T\) =>/, 'the skipped ones keep the shape')
})

test('every link into a driver box names the tab it is on', () => {
  // A link to the bare page lands on the dates tab. The record form is not
  // there, so a dashboard row saying "already on the driver's own record, fix
  // it there" would drop the owner on a checklist and leave him to find it.
  const anchors = read('../src/lib/rules/anchors.ts')
  assert.equal(
    (anchors.match(/href: '\/app\/drivers\/:id'/g) ?? []).length,
    0,
    'an anchor still links at the bare driver page',
  )
  assert.match(anchors, /href: '\/app\/drivers\/:id\?tab=record#record'/, 'and names the record tab')

  // The checklist's own jump links, and the two ways out of the delete panel.
  assert.match(page, /\?tab=dates&edit=dates&box=/, 'a checklist row opens the box on its own tab')
  assert.match(page, /\?tab=record&edit=record#record/, 'a record row opens the record tab')
  assert.match(page, /\?tab=record&confirm=delete#delete/, 'the delete panel stays on its tab')
  assert.equal(
    (page.match(/href=\{`\/app\/drivers\/\$\{id\}`\}/g) ?? []).length,
    0,
    'a link inside the page still goes to the bare page and loses the tab',
  )

  // The papers tab's own component builds its Preview/Replace/Cancel links from
  // the current URL. Built from the pathname alone they dropped `?tab=papers`
  // and bounced the reader to the dates tab in the middle of the job.
  const documents = read('../src/components/Documents.astro')
  assert.match(documents, /new URLSearchParams\(Astro\.url\.search\)/, 'the links keep the query')
  assert.doesNotMatch(documents, /const here = Astro\.url\.pathname/, 'the pathname-only link is back')
})
