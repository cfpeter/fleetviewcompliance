/**
 * The owner's own reminders, on the record they are about.
 *
 * THE DEFECT. A reminder has carried a `driver_id` / `vehicle_id` since 0023.
 * The dashboard printed the truck's name on the row and linked to it. The
 * truck's own page knew nothing about it — so the one screen an owner opens to
 * ask "what is going on with truck 12" was the one screen that did not say. In
 * his words: "the my reminders shows the row but should we also show it to
 * where it belongs like the driver or truck… but when I go to the truck…"
 *
 * TWO THINGS CAN GO WRONG QUIETLY HERE and neither raises anything:
 *
 *   1. THE FILTER GOES MISSING. `loadReminders` without a scope returns the
 *      whole carrier's list, which on a truck page is every other truck's notes
 *      printed as this truck's. The section would look perfectly normal.
 *   2. THE LINK DRIFTS. The "Add a reminder for this truck" link carries the
 *      subject as `kind:id`, which is the exact string /app/reminders puts in
 *      its own <option value="">. If either side changes spelling, the link
 *      stops preselecting and silently files the next reminder against the
 *      whole company instead of the truck he pressed it on.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadReminders } from '../src/lib/reminders.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/**
 * A client that answers from memory and RECORDS the filters it was given.
 * The filters are what this file is about, so unlike the fake in
 * carrier-operation.test.ts they are not ignored — they are the assertion.
 */
function recordingClient(rows: unknown[]) {
  const calls: { column: string; value: unknown }[] = []
  const client = {
    from() {
      const b = {
        select: () => b,
        is: () => b,
        eq: (column: string, value: unknown) => {
          calls.push({ column, value })
          return b
        },
        // The subject filter is an `or(...)` since 0032 — this record's own id
        // OR the fleet-wide scope for its kind. Recorded verbatim, because the
        // exact string is the thing under test.
        or: (filter: string) => {
          calls.push({ column: 'or', value: filter })
          return b
        },
        // biome-ignore lint/suspicious/noThenProperty: the real query builder is a thenable and loadReminders awaits it
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      }
      return b
    },
  } as unknown as SupabaseClient
  return { client, calls }
}

const TODAY = new Date(Date.UTC(2026, 8, 18))
const TRUCK = '33333333-3333-4333-8333-333333333333'
const DRIVER_ID = '44444444-4444-4444-8444-444444444444'

test('a record asks the database for its own reminders, not the whole list', async () => {
  const { client, calls } = recordingClient([])
  await loadReminders(client, null, TODAY, { kind: 'vehicle', id: TRUCK })
  assert.deepEqual(
    calls,
    [{ column: 'or', value: `vehicle_id.eq.${TRUCK},subject_scope.eq.all_vehicles` }],
    'the truck page asks for its own id or the all-trucks scope, and nothing else',
  )
})

test('an id that is not a uuid selects nothing at all', async () => {
  // Fails CLOSED, before a character is spliced into the filter string.
  // `x,subject_scope.eq.all_drivers` would be a perfectly valid filter naming
  // rows this record has nothing to do with — it would not error, it would
  // answer a different question.
  for (const bad of ['truck-12', 'x,subject_scope.eq.all_drivers', '', '*']) {
    const { client, calls } = recordingClient([{ id: 'x' }])
    const out = await loadReminders(client, null, TODAY, { kind: 'vehicle', id: bad })
    assert.deepEqual(out, [], `'${bad}' returns nothing`)
    assert.deepEqual(calls, [], 'and never reaches the database')
  }
})

test('a driver scope filters on driver_id, never on the vehicle column', async () => {
  const { client, calls } = recordingClient([])
  await loadReminders(client, null, TODAY, { kind: 'driver', id: DRIVER_ID })
  assert.deepEqual(calls, [
    { column: 'or', value: `driver_id.eq.${DRIVER_ID},subject_scope.eq.all_drivers` },
  ])
})

test('no scope still means the whole carrier — the dashboard depends on it', async () => {
  const { client, calls } = recordingClient([])
  await loadReminders(client, null, TODAY)
  assert.deepEqual(calls, [], 'an unscoped call adds no subject filter')

  // And the digest's explicit carrier is not confused with a subject.
  const digest = recordingClient([])
  await loadReminders(digest.client, 'carrier-1', TODAY)
  assert.deepEqual(digest.calls, [{ column: 'carrier_id', value: 'carrier-1' }])
})

test('a carrier AND a subject are both applied, in that order', async () => {
  // The digest never does this today, but a screen that runs with the service
  // key would — and dropping either filter is a tenancy bug rather than a
  // cosmetic one.
  const { client, calls } = recordingClient([])
  await loadReminders(client, 'carrier-1', TODAY, { kind: 'vehicle', id: TRUCK })
  assert.deepEqual(calls, [
    { column: 'carrier_id', value: 'carrier-1' },
    { column: 'or', value: `vehicle_id.eq.${TRUCK},subject_scope.eq.all_vehicles` },
  ])
})

test('the add link and the subject select spell a subject the same way', () => {
  // The drift that would file a truck's reminder against the whole company.
  const component = read('../src/components/Reminders.astro')
  const page = read('../src/pages/app/reminders/index.astro')

  assert.match(
    component,
    /\/app\/reminders\?for=\$\{subjectType\}:\$\{encodeURIComponent\(subjectId\)\}/,
    'the link writes kind:id',
  )
  for (const kind of ['driver', 'vehicle']) {
    assert.ok(
      page.includes(`value={\`${kind}:\${`),
      `the select still uses ${kind}:<id> as its option value`,
    )
    assert.ok(
      page.includes(`selected={selectedSubject === \`${kind}:\${`),
      `and the ${kind} option asks the one question that decides the select`,
    )
  }
})

test('the prefill is matched against the options and never echoed', () => {
  const page = read('../src/pages/app/reminders/index.astro')
  // Read once, compared, and that is all. A `?for=` printed into the page — or
  // carried into the save — would be a value out of the query string deciding
  // which record a reminder lands on.
  assert.equal((page.match(/params\.get\('for'\)/g) ?? []).length, 1)
  assert.doesNotMatch(page, /\{prefillSubject\}/, 'it is never rendered')
  assert.doesNotMatch(page, /value=\{prefillSubject\}/, 'and never posted back')
  // "Whole company" must stop being selected once a real option matched, or the
  // browser takes the LAST selected option and the prefill silently loses.
  assert.match(
    page,
    /<option value="" selected=\{selectedSubject === ''\}>Whole company<\/option>/,
    'and "Whole company" is selected by the same one decision as every other option',
  )
})

test('both record pages render the section, and pass their own id to it', () => {
  for (const [path, kind, id] of [
    ['../src/pages/app/vehicles/[id].astro', 'vehicle', '{vehicle.id}'],
    ['../src/pages/app/drivers/[id].astro', 'driver', '{id}'],
  ] as const) {
    const page = read(path)
    assert.match(page, /import RemindersSection from/, `${kind} page imports the section`)
    assert.match(page, new RegExp(`subjectType="${kind}"[\\s\\S]{0,120}reminders=\\{reminders\\}`))
    assert.ok(page.includes(`subjectId=${id}`), `${kind} page passes its own id`)
    // Scoped in the QUERY. Loading every reminder and filtering in the markup
    // would put the whole carrier's list in the HTML of one truck's page.
    assert.match(
      page,
      new RegExp(`loadReminders\\(supabase, null, undefined, \\{ kind: '${kind}', id`),
      `${kind} page scopes the load`,
    )
  }
})

// ---------------------------------------------------------------------------
// All drivers, all trucks — one row, not one per record (0032)
// ---------------------------------------------------------------------------

test('a record asks for its own reminders AND the fleet-wide ones', () => {
  // THE WHOLE POINT OF THE SCOPE, in the owner's words: "when the user chooses
  // all drivers we show it to all drivers." Filtering on the id alone would
  // store "Safety meeting · All drivers" and then show it nowhere but the
  // reminders page — a reminder about this driver that his own page denies.
  const src = read('../src/lib/reminders.ts')
  assert.match(
    src,
    /query\.or\(`\$\{idColumn\}\.eq\.\$\{scope\.id\},subject_scope\.eq\.\$\{fleetWide\}`\)/,
    'the record filter takes its own id or the matching fleet-wide scope',
  )
  assert.match(src, /const fleetWide = scope\.kind === 'driver' \? 'all_drivers' : 'all_vehicles'/)
})

test('the subject id is checked before it is spliced into a filter string', () => {
  // `.or()` takes a STRING. A comma would end the first condition and a dot
  // would end a column name, so an id carrying either does not error — it
  // quietly becomes a different query against a table that holds every
  // carrier's reminders. RLS still stands behind it; a filter built by hand
  // still has to check its own inputs, and fail closed when they are wrong.
  const src = read('../src/lib/reminders.ts')
  assert.match(src, /if \(scope && !SUBJECT_ID\.test\(scope\.id\)\) return \[\]/)
  const guard = src.indexOf('if (scope && !SUBJECT_ID.test(scope.id)) return []')
  const filter = src.indexOf('query.or(')
  assert.ok(guard !== -1 && guard < filter, 'the check comes before the string is built')
})

test('a scope and a named record can never both be true', () => {
  // "All drivers" and "Aram" are two answers to one question, and a row holding
  // both has no honest label on any screen. Refused in the database, and
  // refused on the page so it comes back as a sentence rather than as a
  // constraint violation.
  const sql = read('../supabase/migrations/0032_reminder_scope.sql')
  assert.match(sql, /subject_scope is null or \(driver_id is null and vehicle_id is null\)/)
  assert.match(sql, /check \(subject_scope in \('all_drivers', 'all_vehicles'\)\)/)

  const page = read('../src/pages/app/reminders/index.astro')
  // The page returns the scope with both ids null — it cannot express the
  // forbidden pair even by accident.
  assert.match(
    page,
    /return \{ driver_id: null, vehicle_id: null, subject_scope: text \}/,
    'a scope is parsed with no id at all',
  )
})

test('the dropdown opens on the right option, and one thing decides it', () => {
  const page = read('../src/pages/app/reminders/index.astro')
  // Three things want a say — the reminder being edited, the record page he
  // came from, and the shape of the suggestion he tapped. Decided in one
  // place, because two places would disagree and the select would silently
  // take the LAST selected option.
  assert.equal((page.match(/const selectedSubject =/g) ?? []).length, 1)
  assert.match(page, /editing\s*\?\s*subjectValue\(editing\)/, 'editing wins over any link')
  assert.equal(
    (page.match(/selected=\{selectedSubject === /g) ?? []).length,
    5,
    'all five ask it: company, all drivers, all trucks, one driver, one truck',
  )
  // A suggestion that fits exactly one kind names that kind; one that fits
  // several names none, because "Safety meeting" is as much the company's as
  // the drivers'.
  assert.match(page, /suggested\.fits\.length === 1/)
})

test('a fleet-wide option is only offered when it can mean something', () => {
  // "All drivers" on a carrier with no drivers is an option that saves a
  // reminder nobody will ever see.
  const page = read('../src/pages/app/reminders/index.astro')
  assert.match(page, /\{drivers\.length > 0 && \(\s*<option value="all_drivers"/)
  assert.match(page, /\{vehicles\.length > 0 && \(\s*<option value="all_vehicles"/)
})
