/**
 * Every grey row on a detail page has somewhere to type.
 *
 * THE DEFECT THIS FILE GUARDS. A truck page drew six boxes and a driver page
 * twelve, and both lists are FACTS ABOUT THE SUBJECT. The engine asks for more
 * than facts: `answerKeyFor` files a rule's last COMPLETION under the rule's own
 * code whenever the recurrence names no anchor, so a `computed` schedule comes
 * back asking for a key no hand-written catalogue contains. Those rows printed
 * "Missing a date" with no input anywhere on the page.
 *
 * The cruelty is in the timing. An EMPTY truck asks for six anchors and every
 * one has a box. Answer all six and three new grey rows appear that nothing on
 * the page can answer. The owner did the work and the screen punished him for
 * it; his words on the Form 2290 row were "i dont see those date input".
 *
 * So the property asserted here is not "the new module works". It is: NO
 * REACHABLE GREY ROW HAS AN ANSWER KEY THAT NOTHING ON ITS PAGE CAN TAKE. It is
 * checked by running the engine over a sweep of anchor sets rather than by
 * reading a list, because the list is exactly the thing that was incomplete.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { readUnboxedDates, unboxedQuestions, unboxedSlots } from '../src/lib/anchors/unboxed.ts'
import { answerLink, resolveAnchor, UNWRITABLE_ANCHOR_KEYS } from '../src/lib/rules/anchors.ts'
import { answerKeyFor } from '../src/lib/rules/answer.ts'
import { DRIVER_ANCHORS } from '../src/lib/rules/driver-anchors.ts'
import { evaluate } from '../src/lib/rules/index.ts'
import type { RuleContext, Subject } from '../src/lib/rules/types.ts'
import { anchorsForKind, type VehicleKind } from '../src/lib/vehicles.ts'

const page = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const VEHICLE_PAGE = page('../src/pages/app/vehicles/[id].astro')
const DRIVER_PAGE = page('../src/pages/app/drivers/[id].astro')

const TODAY = new Date(Date.UTC(2026, 8, 17))
const TODAY_ISO = '2026-09-17'

/**
 * Dates chosen to move rows between standings rather than to be realistic.
 *
 * One long past, one recent, one inside the soon window, one in the future — an
 * expiry anchor is allowed to be ahead of us and several rules only reach
 * `unknown` once the schedule they compute has an occurrence behind it.
 */
const DATES = [
  new Date(Date.UTC(2019, 0, 4)),
  new Date(Date.UTC(2024, 5, 20)),
  new Date(Date.UTC(2026, 7, 1)),
  new Date(Date.UTC(2028, 1, 2)),
]

/** Contexts that switch the applicability tests on and off. */
const VEHICLE_CONTEXTS: Omit<RuleContext, 'today'>[] = [
  { gvwrLbs: 33_000, modelYear: 2015, registrationState: 'CA', carrierOperation: 'A' },
  { registrationState: 'CA' },
  {
    gvwrLbs: 80_000,
    modelYear: 2001,
    registrationState: 'TX',
    carrierOperation: 'B',
    hazmat: true,
  },
]
const DRIVER_CONTEXTS: Omit<RuleContext, 'today'>[] = [
  { registrationState: 'CA', cdl: true, carrierOperation: 'A' },
  { registrationState: 'CA', cdl: false },
  { registrationState: 'TX', cdl: true, hazmat: true, carrierOperation: 'A' },
]

interface Asked {
  key: string
  ruleCode: string
  anchors: string[]
}

/**
 * Every `unknown` answer key the engine can produce for one subject.
 *
 * The anchor keys are swept, not fixed, because the defect only exists in the
 * ANSWERED states: a key that is a rule code appears once the schedule can be
 * computed and no completion is on file. A test run against an empty subject
 * would pass while every one of the broken rows was still broken.
 *
 * `hire_date` and `cdl_expires` are swept for the driver even though no form
 * writes them — deadlines.ts projects both out of `drivers` columns, and four
 * federal rows change shape the moment a hire date exists.
 */
function askedKeys(
  type: Subject,
  sweep: readonly string[],
  contexts: readonly Omit<RuleContext, 'today'>[],
): Asked[] {
  const found = new Map<string, Asked>()
  const combos = 1 << sweep.length

  for (let mask = 0; mask < combos; mask++) {
    const anchors: Record<string, Date> = {}
    for (let bit = 0; bit < sweep.length; bit++) {
      if (mask & (1 << bit)) anchors[sweep[bit]] = DATES[(mask + bit) % DATES.length]
    }
    for (const context of contexts) {
      const items = evaluate([{ type, id: 'subject-1', label: 'Subject', context, anchors }], TODAY)
      for (const item of items) {
        if (item.status.standing !== 'unknown') continue
        const key = item.status.answerKey ?? answerKeyFor(item.rule)
        if (!found.has(key)) {
          found.set(key, { key, ruleCode: item.rule.code, anchors: Object.keys(anchors) })
        }
      }
    }
  }

  return [...found.values()]
}

/* -------------------------------------------------------------------------
   1. A grey row with no local box still offers a way to answer it.
   ------------------------------------------------------------------------- */

/**
 * The three things a page can do with an answer key, and it must be able to do
 * one of them.
 *
 *   a box   the page's own catalogue draws it
 *   a slot  src/lib/anchors/unboxed.ts adds a box for it in the same form
 *   a link  the deny-list: it must never be typed, and the registry says where
 *           the real answer lives, so the row becomes a link instead
 *
 * Nothing else is acceptable. A fourth outcome is a grey row the owner cannot
 * act on, which is the entire complaint.
 */
function routeFor(key: string, subject: Subject, boxed: readonly string[]): string {
  if (boxed.includes(key)) return 'box'
  if (unboxedSlots(subject, boxed).some((s) => s.key === key)) return 'slot'
  const entry = resolveAnchor(key)
  if (entry?.answeredElsewhere && answerLink(entry, 'subject-1')) return 'link'
  return 'DEAD END'
}

for (const kind of ['power_unit', 'trailer'] as const) {
  test(`every grey row on a ${kind} page can be answered on that page`, () => {
    const boxed = anchorsForKind(kind as VehicleKind).map((a) => a.key)
    const asked = askedKeys(kind, boxed, VEHICLE_CONTEXTS)

    assert.ok(asked.length > 0, 'the sweep produced no grey rows — it is testing nothing')

    for (const { key, ruleCode, anchors } of asked) {
      assert.notEqual(
        routeFor(key, kind, boxed),
        'DEAD END',
        `'${ruleCode}' asks a ${kind} for '${key}' and the page has no box, no slot and ` +
          `nowhere to send him. Reachable with these dates on file: ${anchors.join(', ') || 'none'}`,
      )
    }
  })
}

test('every grey row on the driver page can be answered on that page', () => {
  const boxed = DRIVER_ANCHORS.map((a) => a.key)
  // The two projected columns are swept alongside the twelve boxes. Without
  // them the DQF, the road test, the hire-time MVR and the previous-employer
  // investigation never get past "we need the hire date" and the four rows this
  // fix is about are never reached.
  const asked = askedKeys('driver', [...boxed, 'hire_date', 'cdl_expires'], DRIVER_CONTEXTS)

  assert.ok(asked.length > 0, 'the sweep produced no grey rows — it is testing nothing')

  for (const { key, ruleCode, anchors } of asked) {
    assert.notEqual(
      routeFor(key, 'driver', boxed),
      'DEAD END',
      `'${ruleCode}' asks a driver for '${key}' and the page has no box, no slot and nowhere ` +
        `to send her. Reachable with these dates on file: ${anchors.join(', ') || 'none'}`,
    )
  }
})

test('the rows this was reported for are the ones that used to be dead', () => {
  // Named explicitly so a refactor that quietly stops producing them fails here
  // rather than passing a sweep that no longer covers the defect. The first two
  // are the rows the owner was looking at.
  const vehicle = unboxedSlots(
    'power_unit',
    anchorsForKind('power_unit').map((a) => a.key),
  )
  const keys = vehicle.map((s) => s.key)
  assert.ok(keys.includes('fed.irs.2290.heavy-vehicle-use-tax'), 'Form 2290 has no box')
  assert.ok(
    keys.includes('fed.396.21.inspection-report-retention.power-unit'),
    'keeping the inspection report has no box',
  )

  const driver = unboxedSlots(
    'driver',
    DRIVER_ANCHORS.map((a) => a.key),
  ).map((s) => s.key)
  for (const code of [
    'dqf_maintained',
    'road_test_or_equivalent',
    'mvr_inquiry_at_hire',
    'safety_performance_history_investigation',
    'hazmat_training_date',
  ]) {
    assert.ok(driver.includes(code), `'${code}' has no box on the driver page`)
  }
})

test('every added box has words to put above it', () => {
  // A key with no registry entry renders as a date input with no question, or
  // as a label reading `fed.396.21.inspection-report-retention.power-unit`.
  // `unboxedSlots` drops those; this is what makes sure it never has to.
  for (const [subject, boxed] of [
    ['power_unit', anchorsForKind('power_unit').map((a) => a.key)],
    ['trailer', anchorsForKind('trailer').map((a) => a.key)],
    ['driver', DRIVER_ANCHORS.map((a) => a.key)],
  ] as const) {
    for (const slot of unboxedSlots(subject, boxed)) {
      const entry = resolveAnchor(slot.key)
      assert.ok(entry, `'${slot.key}' has no registry entry, so its box has no question`)
      assert.ok(slot.label.trim().length > 0, `'${slot.key}' has an empty label`)
      assert.ok(entry.help.trim().length > 0, `'${slot.key}' has no sentence under the box`)
      assert.notEqual(slot.label, slot.key, `'${slot.key}' is labelled with its own key`)
    }
  }
})

/* -------------------------------------------------------------------------
   2. The link carries the subject and the key.
   ------------------------------------------------------------------------- */

test('a box and the link to it agree on the field name', () => {
  // One convention, three screens: the dashboard posts `date_<answerKey>` and so
  // do both detail pages. The fragment is the same string, because the id it
  // lands on is the box that carries that name.
  for (const slot of unboxedSlots(
    'driver',
    DRIVER_ANCHORS.map((a) => a.key),
  )) {
    assert.equal(slot.field, `date_${slot.key}`)
  }
  const questions = unboxedQuestions({
    subject: 'power_unit',
    boxed: anchorsForKind('power_unit').map((a) => a.key),
    rows: [
      {
        rule: { code: 'fed.irs.2290.heavy-vehicle-use-tax', title: 'Form 2290', citation: 'IRC' },
        subjectId: 'v1',
        status: { standing: 'unknown', answerKey: 'fed.irs.2290.heavy-vehicle-use-tax' },
      },
    ],
    onFile: () => '',
  })
  assert.equal(questions.length, 1)
  assert.equal(questions[0].field, 'date_fed.irs.2290.heavy-vehicle-use-tax')
  assert.equal(questions[0].domId, questions[0].field)
})

test('the truck page sends a row to one named box on this truck', () => {
  // Three things have to be in that href or it lands somewhere useless: the
  // vehicle id (this truck, not the list), `add=1` (the fold is closed and a
  // fragment never reaches the server) and the key (the box, not the heading).
  const boxFor = VEHICLE_PAGE.slice(
    VEHICLE_PAGE.indexOf('function boxFor('),
    VEHICLE_PAGE.indexOf('function detailOf('),
  )
  assert.ok(boxFor.length > 0, 'boxFor is gone — this test is checking nothing')
  assert.match(
    boxFor,
    /\/app\/vehicles\/\$\{vehicle\.id\}\?add=1#date_\$\{key\}/,
    'the truck row link no longer carries the truck, the fold parameter and the key',
  )
  // Both lists, and only those two. A link built without checking would point at
  // an id the form never renders.
  assert.match(boxFor, /boxKeys\.has\(key\)/, 'the anchor boxes are no longer checked')
  assert.match(boxFor, /unboxedByKey\.has\(key\)/, 'the added boxes are no longer checked')
})

test('the driver page sends a row to one named box on this driver', () => {
  const answerHref = DRIVER_PAGE.slice(
    DRIVER_PAGE.indexOf('function answerHref('),
    DRIVER_PAGE.indexOf('/** Which date box a link asked for'),
  )
  assert.ok(answerHref.length > 0, 'answerHref is gone — this test is checking nothing')
  // THE TAB IS PART OF THE ADDRESS NOW. The driver page is four tabs, and the
  // date boxes are on one of them — a link with only the fold parameter opens
  // the fold on a tab the reader is not looking at, which is the same failure
  // as a bare `#fragment` one layer up.
  assert.match(
    answerHref,
    /\/app\/drivers\/\$\{id\}\?tab=dates&edit=dates&box=\$\{key\}#date_\$\{key\}/,
    'the driver row link no longer carries the driver, the tab, the fold parameter and the key',
  )
  // The deny-list half: `hire_date` and `cdl_expires` must reach the record
  // form, never a date box and never a link back to the page he is standing on.
  assert.match(
    answerHref,
    /\/app\/drivers\/\$\{id\}\?tab=record&edit=record#record/,
    'a key answered on the driver record no longer opens the record',
  )
  assert.match(answerHref, /answeredElsewhere/, 'the deny-list route is no longer registry-driven')
})

test('both pages open the fold on the server, never on a fragment alone', () => {
  // A `#anchor` never reaches the server, so a link to a box inside a closed
  // `details` scrolls to a closed box — which is how the owner was proved right
  // the first time. The parameter is the half that opens it.
  assert.match(VEHICLE_PAGE, /params\.get\('add'\) === '1'/)
  assert.match(DRIVER_PAGE, /params\.get\('edit'\) === 'dates'/)
})

/* -------------------------------------------------------------------------
   3. Nothing renders a box for a key the page cannot save.
   ------------------------------------------------------------------------- */

test('what is drawn is always a subset of what is read back', () => {
  // The two sets come from one function on purpose. `unboxedSlots` is what the
  // POST handler loops over and `unboxedQuestions` is what the form draws, so a
  // box on screen that the handler never looks at cannot exist — it would take a
  // date, say "saved", and change nothing.
  for (const [subject, boxed] of [
    ['power_unit', anchorsForKind('power_unit').map((a) => a.key)],
    ['driver', DRIVER_ANCHORS.map((a) => a.key)],
  ] as const) {
    const readable = new Set(unboxedSlots(subject, boxed).map((s) => s.key))
    // Every key the engine can ask this subject for, all at once — a wider set
    // than any single page state, so the subset claim is not tested on an easy
    // case.
    const rows = askedKeys(
      subject,
      subject === 'driver' ? [...boxed, 'hire_date', 'cdl_expires'] : boxed,
      subject === 'driver' ? DRIVER_CONTEXTS : VEHICLE_CONTEXTS,
    ).map((a) => ({
      rule: { code: a.ruleCode, title: a.ruleCode, citation: '' },
      subjectId: 'subject-1',
      status: { standing: 'unknown', answerKey: a.key },
    }))

    for (const q of unboxedQuestions({ subject, boxed, rows, onFile: () => '' })) {
      assert.ok(readable.has(q.key), `'${q.key}' is drawn on the ${subject} page and never read`)
    }
  }
})

test('a key the page already has a box for is never added twice', () => {
  // Two inputs for one date is two chances to disagree, and `planAnchorWrites`
  // refuses the whole submit as a conflict when they do.
  const boxed = anchorsForKind('power_unit').map((a) => a.key)
  for (const slot of unboxedSlots('power_unit', boxed)) {
    assert.ok(!boxed.includes(slot.key), `'${slot.key}' already has a box on the truck page`)
  }
  const driverBoxed = DRIVER_ANCHORS.map((a) => a.key)
  for (const slot of unboxedSlots('driver', driverBoxed)) {
    assert.ok(!driverBoxed.includes(slot.key), `'${slot.key}' already has a box on the driver page`)
  }
})

test('the deny-list never becomes a box, on either page', () => {
  // `hire_date` and `cdl_expires` are projected out of the driver's own columns
  // by deadlines.ts with `if (a[anchorKey]) continue`, so a compliance record
  // SILENTLY OUTRANKS the column: a typo would move five federal rules onto
  // wrong dates and leave his own page still showing the right one.
  // `dot_number` is not a date and nothing would read it.
  for (const [subject, boxed] of [
    ['power_unit', anchorsForKind('power_unit').map((a) => a.key)],
    ['trailer', anchorsForKind('trailer').map((a) => a.key)],
    ['driver', DRIVER_ANCHORS.map((a) => a.key)],
    ['carrier', []],
  ] as const) {
    for (const slot of unboxedSlots(subject, boxed)) {
      assert.ok(
        !UNWRITABLE_ANCHOR_KEYS.has(slot.key),
        `'${slot.key}' must never be a date input and one was added on the ${subject} page`,
      )
    }
  }
})

test('a question is drawn only for a row that is asking, or a date already held', () => {
  const boxed = anchorsForKind('power_unit').map((a) => a.key)
  const base = {
    subject: 'power_unit' as const,
    boxed,
    onFile: () => '',
  }

  // Nothing asking and nothing on file: no card at all, which is why an empty
  // truck's page does not grow.
  assert.deepEqual(unboxedQuestions({ ...base, rows: [] }), [])

  // A row that is NOT grey does not open a box. `return_to_duty_follow_up_testing`
  // is the shape that matters: it is a rule code in the catalogue, but the row
  // asks for `return_to_duty_test_date`, so a box under the code would be a
  // question nobody asked.
  const settled = unboxedQuestions({
    ...base,
    rows: [
      {
        rule: { code: 'fed.irs.2290.heavy-vehicle-use-tax', title: 'Form 2290', citation: 'IRC' },
        subjectId: 'v1',
        status: { standing: 'current', answerKey: 'fed.irs.2290.heavy-vehicle-use-tax' },
      },
    ],
  })
  assert.deepEqual(settled, [])

  // Unless a date is on file for it. Answering a question must not delete the
  // box that answered it: the latest date wins, so a year typed wrong could
  // otherwise only be undone through Withdraw in the history.
  const held = unboxedQuestions({
    ...base,
    rows: [],
    onFile: (key) => (key === 'fed.irs.2290.heavy-vehicle-use-tax' ? '2026-08-20' : ''),
  })
  assert.deepEqual(
    held.map((q) => [q.key, q.on]),
    [['fed.irs.2290.heavy-vehicle-use-tax', '2026-08-20']],
  )
})

test('both pages draw and read the same list', () => {
  // The POST loop and the GET render take their keys from one module. Copying
  // either list into the page is how the two drift, and the failure is silent:
  // a box that saves nothing, or a saved date with no box to correct it in.
  for (const [name, source] of [
    ['truck', VEHICLE_PAGE],
    ['driver', DRIVER_PAGE],
  ] as const) {
    assert.match(source, /readUnboxedDates\(/, `the ${name} page no longer reads the added boxes`)
    assert.match(source, /unboxedSlots\(/, `the ${name} page no longer lists what it will read`)
    assert.match(source, /unboxedQuestions\(/, `the ${name} page no longer draws the added boxes`)
  }
})

/* -------------------------------------------------------------------------
   Reading the boxes back.
   ------------------------------------------------------------------------- */

const SLOTS = unboxedSlots(
  'power_unit',
  anchorsForKind('power_unit').map((a) => a.key),
)
const read = (values: Record<string, string>) => (field: string) => values[field] ?? ''

test('a blank box comes back as null and changes nothing', () => {
  const got = readUnboxedDates(SLOTS, read({}), TODAY_ISO)
  assert.ok(got.ok)
  assert.equal(got.typed.length, SLOTS.length)
  assert.ok(got.typed.every((t) => t.on === null))
})

test('a last_done date in the future is refused, in words', () => {
  // The one direction this domain refuses to be wrong in. compute.ts walks
  // forward from the anchor until it passes today, so a future date makes it
  // step past the occurrence just reported and answer with the one after: the
  // deadline moves LATER. The `max` attribute is a browser's promise, not a
  // server's.
  const got = readUnboxedDates(
    SLOTS,
    read({ 'date_fed.irs.2290.heavy-vehicle-use-tax': '2027-01-01' }),
    TODAY_ISO,
  )
  assert.equal(got.ok, false)
  assert.match(got.ok ? '' : got.message, /is in the future/)
  assert.match(got.ok ? '' : got.message, /last time it happened/)
})

test('one bad value refuses the whole submit', () => {
  // All-or-nothing, the same as both pages already are. A partial save leaves
  // him looking at a screen where some boxes took and some did not, with one
  // message to explain it.
  const got = readUnboxedDates(
    SLOTS,
    read({
      date_ca_ctc_vis_listing: '2026-01-05',
      'date_fed.irs.2290.heavy-vehicle-use-tax': 'last tuesday',
    }),
    TODAY_ISO,
  )
  assert.equal(got.ok, false)
  assert.match(got.ok ? '' : got.message, /not a date we can read/)
})

test('a year that is a typo is refused', () => {
  const got = readUnboxedDates(
    SLOTS,
    read({ 'date_fed.irs.2290.heavy-vehicle-use-tax': '0202-08-20' }),
    TODAY_ISO,
  )
  assert.equal(got.ok, false)
  assert.match(got.ok ? '' : got.message, /looks like a typo/)
})

test('a refusal names the box, not the key', () => {
  // The message prints at the top of a long page, so it has to name something
  // he can find on it. `fed.irs.2290.heavy-vehicle-use-tax` is not on the screen.
  const got = readUnboxedDates(
    SLOTS,
    read({ 'date_fed.irs.2290.heavy-vehicle-use-tax': '2027-01-01' }),
    TODAY_ISO,
  )
  assert.equal(got.ok, false)
  assert.match(got.ok ? '' : got.message, /^Form 2290 heavy vehicle use tax /)
})

test('nothing is read by a field name taken from the body', () => {
  // The loop is over the slots this subject has, so a `date_hire_date` posted by
  // hand is not rejected — it is never looked at, which is the only version of
  // that defence with no list to keep up to date.
  const got = readUnboxedDates(
    SLOTS,
    read({ date_hire_date: '1999-01-01', date_dot_number: '2020-01-01' }),
    TODAY_ISO,
  )
  assert.ok(got.ok)
  assert.ok(!got.typed.some((t) => t.key === 'hire_date' || t.key === 'dot_number'))
})
