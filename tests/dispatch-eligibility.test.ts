/**
 * The gate on the dispatch screen.
 *
 * `eligibility()` is the only thing standing between a dispatcher in a hurry and
 * an unqualified driver on a public road, so these tests pin the two halves of
 * its contract separately and refuse to let either drift:
 *
 *   BLOCK  overdue + a qualification rule  -> the truck does not move
 *   WARN   everything else worth saying    -> the truck moves, on the record
 *
 * Several of these run the REAL catalogue through `evaluate()` rather than
 * hand-building a `DeadlineItem`. That is deliberate, and it has already earned
 * its keep once: `eligibility()` unit-tested on its own passes happily while the
 * pipeline that feeds it hands over a standing the function never blocks on.
 * That is exactly what `status()` did to the 24-month medical certificate — it
 * reported `current` for a card that expired in April — and no amount of testing
 * `eligibility()` in isolation would ever have shown it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  conflicts,
  type EligibilityIssue,
  eligibility,
  isBlocked,
  worstSeverity,
} from '../src/lib/dispatch/eligibility.ts'
import { type DeadlineItem, evaluate, ruleByCode } from '../src/lib/rules/index.ts'

/** Fixed "today", so a test never changes its answer because a year rolled over. */
const TODAY = new Date(Date.UTC(2026, 8, 15))

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d))
}

const DRIVER = 'Juan Ramirez'

/**
 * Every deadline the real catalogue produces for one driver, exactly as the
 * assignment screen feeds it: `loadDeadlines()` returns the whole carrier and
 * the page filters to the subject it is asking about.
 */
function itemsForDriver(anchors: Record<string, Date>): DeadlineItem[] {
  return evaluate(
    [
      {
        type: 'driver',
        id: 'driver-1',
        label: DRIVER,
        // Interstate, CDL holder — the ordinary case. Rules that turn on these
        // facts should not have to be rediscovered by every test below.
        context: { carrierOperation: 'A', cdl: true },
        anchors,
      },
    ],
    TODAY,
  ).filter((i) => i.subjectType === 'driver' && i.subjectId === 'driver-1')
}

function issuesForDriver(anchors: Record<string, Date>): EligibilityIssue[] {
  return eligibility({ items: itemsForDriver(anchors), label: DRIVER })
}

/**
 * A driver whose file is genuinely complete and genuinely current.
 *
 * Both medical anchors are present because they feed different rules: the
 * printed expiry drives the 24-month certificate, and the EXAMINATION date
 * drives the three 12-month variants, which fail open and sit at `unknown`
 * until somebody supplies it. A "clean" fixture missing the exam date produces
 * three warnings and would make the no-issues test below assert nothing.
 */
const CLEAN_DRIVER: Record<string, Date> = {
  hire_date: utc(2024, 1, 2),
  medical_certificate_expires: utc(2027, 6, 1),
  // Added when the cdl_expiry rule landed. Without a licence date this driver
  // is not "complete" — and the fixture going stale is exactly how a test like
  // this stops meaning anything.
  cdl_expires: utc(2028, 6, 30),
  medical_exam_date: utc(2026, 6, 1),
  annual_mvr_last_obtained: utc(2026, 6, 1),
  annual_review_last_completed: utc(2026, 6, 1),
  clearinghouse_query_last_run: utc(2026, 6, 1),
}

// ---------------------------------------------------------------------------
// BLOCK — an expired medical certificate stops the truck
// ---------------------------------------------------------------------------

test('an expired medical certificate blocks the assignment', () => {
  // Built from the real rule row rather than a stub, so renaming the rule code
  // or retitling the rule fails here instead of silently producing an issue
  // nobody blocks on. The standing is set directly because this is a test of
  // `eligibility()`, not of the date arithmetic that reaches it.
  const rule = ruleByCode('medical_certificate_general')
  assert.ok(rule, "the catalogue must still contain 'medical_certificate_general'")

  const expired: DeadlineItem = {
    rule,
    subjectType: 'driver',
    subjectId: 'driver-1',
    subjectLabel: DRIVER,
    status: { standing: 'overdue', nextDue: utc(2026, 4, 1) },
    daysUntil: -167,
  }

  const issues = eligibility({ items: [expired], label: DRIVER })

  assert.equal(issues.length, 1, 'an expired card is exactly one issue, not a pile')
  assert.equal(issues[0].severity, 'block')
  assert.equal(issues[0].code, 'expired')
  assert.equal(issues[0].ruleCode, 'medical_certificate_general')
  assert.equal(isBlocked(issues), true, 'this is the one thing that must not be overridable')
  assert.equal(worstSeverity(issues), 'block')

  // The dispatcher is trying to move freight, not read a citation. The message
  // has to name the person so she knows whose page to open.
  assert.match(issues[0].message, /Juan Ramirez/)
  assert.match(issues[0].message, /expired/i)
})

test('a medical examination more than 12 months old blocks, through the real engine', () => {
  // The end-to-end proof that a block can be produced from dates a carrier
  // actually types: an office that recorded only "he had his physical in June
  // 2024" and never captured the printed expiry.
  //
  // The printed expiry is REMOVED from the fixture on purpose. It governs when
  // present, and medical_certificate_by_exam_date steps aside for it — so
  // leaving a valid 2027 card in place would (correctly) produce no block at
  // all, and the test would be asserting nothing.
  const { medical_certificate_expires: _printed, ...withoutPrintedExpiry } = CLEAN_DRIVER
  const issues = issuesForDriver({ ...withoutPrintedExpiry, medical_exam_date: utc(2024, 6, 1) })

  assert.equal(isBlocked(issues), true, 'a two-year-old DOT physical is not a warning')
  const blocks = issues.filter((i) => i.severity === 'block')
  assert.ok(blocks.length > 0)
  for (const b of blocks) {
    assert.equal(b.code, 'expired')
    assert.match(b.ruleCode ?? '', /^medical_certificate_/)
    assert.match(b.message, /Juan Ramirez/)
  }
})

test('a medical card whose printed expiry has passed blocks, through the real engine', () => {
  /**
   * The end-to-end proof for the 24-month certificate, and the reason this file
   * insists on going through `evaluate()`.
   *
   * This assertion failed when it was first written, and the cause was three
   * modules away: `medical_certificate_general` is an `expiry` rule with NO
   * interval, so `previousDue()` correctly declines to invent a previous
   * occurrence, `lastDue` came back undefined, and `status()` fell straight past
   * the overdue comparison to `current` — for a card that expired in April.
   * `eligibility()` was working perfectly and could never block, because nothing
   * upstream ever handed it an `overdue`.
   *
   * If this ever goes red again, the bug is in compute.ts, not here.
   */
  const issues = issuesForDriver({
    ...CLEAN_DRIVER,
    medical_certificate_expires: utc(2026, 4, 1), // five months behind TODAY
  })

  assert.equal(isBlocked(issues), true, 'a lapsed medical card must stop the truck')
  const block = issues.find((i) => i.ruleCode === 'medical_certificate_general')
  assert.ok(block, 'the 24-month certificate is the one that must be raised')
  assert.equal(block.severity, 'block')
  assert.equal(block.code, 'expired')
  assert.match(block.message, /Juan Ramirez/)
})

// ---------------------------------------------------------------------------
// WARN — not knowing is not the same as expired
// ---------------------------------------------------------------------------

test('an unknown medical date warns but does not block', () => {
  // The single most important asymmetry in the product, and the reason the long
  // comment in eligibility.ts exists: on day one every driver's dates are
  // unknown, and a product that parks the whole fleet on day one is a product
  // somebody switches off before it has ever told them anything true.
  const { medical_certificate_expires, medical_exam_date, ...noMedical } = CLEAN_DRIVER
  const issues = issuesForDriver(noMedical)

  assert.equal(isBlocked(issues), false, 'a gap in OUR records must never stop a truck')
  assert.equal(worstSeverity(issues), 'warn')

  const general = issues.find((i) => i.ruleCode === 'medical_certificate_general')
  assert.ok(general, 'the missing 24-month certificate must still be raised')
  assert.equal(general.severity, 'warn')
  assert.equal(general.code, 'unknown_blocking_date')
  // The honesty clause: it says plainly that not knowing carries the same risk.
  assert.match(general.message, /same risk/i)
  assert.match(general.message, /Juan Ramirez/)
})

test('a lapsed annual MVR warns, it does not stop the truck', () => {
  // An overdue annual MVR is a real 49 CFR 391.25 failure and belongs in front
  // of the dispatcher — but it is not a § 391.11 qualification defect, so the
  // load still goes. Getting this wrong in the blocking direction parks a
  // perfectly qualified driver over an office errand.
  const issues = issuesForDriver({ ...CLEAN_DRIVER, annual_mvr_last_obtained: utc(2024, 6, 1) })

  assert.equal(isBlocked(issues), false)
  const mvr = issues.find((i) => i.ruleCode === 'mvr_inquiry_annual')
  assert.ok(mvr, 'a stale annual MVR must still be said out loud')
  assert.equal(mvr.severity, 'warn')
  assert.equal(mvr.code, 'lapsed')
})

// ---------------------------------------------------------------------------
// CLEAN — the product must be able to say nothing at all
// ---------------------------------------------------------------------------

test('a driver with a complete, current file produces no issues', () => {
  /**
   * A screen that always has something to say is a screen nobody reads.
   *
   * This is the test that keeps the override box meaningful. Every warning that
   * a fully documented driver cannot clear — a rule that reports overdue however
   * the date is recorded, an applicability check that can only ever say
   * "unknown" — turns the checkbox and the reason field into furniture the
   * dispatcher tabs through twenty times a day. At that point the audit trail
   * says "ok" twenty times and answers nothing.
   *
   * So: if this goes red, the assignment page has begun crying wolf, and the
   * fix belongs in the rule that started it, never in this assertion.
   */
  const issues = issuesForDriver(CLEAN_DRIVER)

  assert.deepEqual(issues, [], 'a complete, current file must produce nothing to acknowledge')
  assert.equal(worstSeverity(issues), null)
  assert.equal(isBlocked(issues), false)
})

// ---------------------------------------------------------------------------
// CONFLICTS — double-booking
// ---------------------------------------------------------------------------

test('conflicts() ignores the load being assigned itself', () => {
  // The bug this exists to prevent: re-opening the assignment screen for a load
  // the driver is ALREADY on, and being told he is double-booked — with himself.
  // That is the fastest possible way to teach a dispatcher that the warnings on
  // this screen are noise, after which the real ones are gone too.
  const thisLoad = { loadId: 'load-1', loadLabel: '4471' }

  const none = conflicts({
    openDriverLoads: [thisLoad],
    openTractorLoads: [thisLoad],
    openTrailerLoads: [thisLoad],
    thisLoadId: 'load-1',
  })
  assert.deepEqual(none, [], 'a load never conflicts with itself, on any of the three slots')

  // And the same rows against a DIFFERENT load must still be reported, so the
  // test above cannot be satisfied by a function that returns nothing.
  const elsewhere = conflicts({
    openDriverLoads: [thisLoad],
    openTractorLoads: [thisLoad],
    openTrailerLoads: [thisLoad],
    thisLoadId: 'load-2',
  })
  assert.equal(elsewhere.length, 3)
  assert.deepEqual(
    elsewhere.map((i) => i.code),
    ['driver_double_booked', 'tractor_double_booked', 'trailer_double_booked'],
  )
})

test('a genuine double-booking warns and names the other load', () => {
  const issues = conflicts({
    openDriverLoads: [
      { loadId: 'load-1', loadLabel: '4471' },
      { loadId: 'load-9', loadLabel: '4488' },
    ],
    openTractorLoads: [],
    openTrailerLoads: [],
    thisLoadId: 'load-1',
  })

  assert.equal(issues.length, 1, 'only the OTHER load is a conflict')
  assert.equal(issues[0].severity, 'warn')
  assert.equal(issues[0].code, 'driver_double_booked')
  // Teams, relays and drop-and-hook all legitimately double up. The dispatcher
  // is told, not argued with — and told WHICH load, or the message is useless.
  assert.match(issues[0].message, /4488/)
  assert.equal(isBlocked(issues), false)
})

// ---------------------------------------------------------------------------
// The two places this gate was silently doing nothing
// ---------------------------------------------------------------------------

test('a one-time obligation that WAS completed stops being reported as overdue', () => {
  /**
   * A one-time obligation is due on a fixed day — the hire date — which is in
   * the past for everybody who already works here. So the "a date already behind
   * us IS expired" rule in `status()` has to be scoped to the shape it was
   * written for (`expiry` rules, which read a date off a document) and must not
   * swallow the completion check for `once_on_hire_date` and its siblings.
   *
   * When it did, `clearinghouse_query_pre_employment` was permanently overdue for
   * every driver in every fleet, recording the completion changed nothing, and —
   * because that code is in WARNING_RULE_CODES — the override checkbox and the
   * reason box appeared on EVERY assignment in the product. An override box that
   * is always there is an override box nobody reads, which costs the audit trail
   * the whole reason it exists.
   */
  const items = evaluate(
    [
      {
        type: 'driver',
        id: 'driver-1',
        label: DRIVER,
        context: { carrierOperation: 'A', cdl: true },
        anchors: CLEAN_DRIVER,
        lastDone: { clearinghouse_query_pre_employment: utc(2024, 1, 2) },
      },
    ],
    TODAY,
  )

  assert.deepEqual(
    eligibility({ items, label: DRIVER }),
    [],
    'a fully documented driver must reach the assignment screen with nothing to acknowledge',
  )
})

test('a tractor with a lapsed periodic inspection is raised on the assignment screen', () => {
  /**
   * The assignment screen runs equipment through this same engine. While
   * BLOCKING_RULE_CODES and WARNING_RULE_CODES held driver codes only,
   * `eligibility()` returned an empty list for every power unit and trailer ever
   * passed to it — so the tractor and trailer panels showed "nothing
   * outstanding" for a truck 20 months past its § 396.17 inspection, while
   * looking for all the world like they had checked.
   *
   * A silent pass is worse than no check at all: it is a check the dispatcher
   * has been taught to trust.
   */
  const items = evaluate(
    [
      {
        type: 'power_unit',
        id: 'unit-1',
        label: 'Unit 12',
        context: { gvwrLbs: 80000, registrationState: 'CA' },
        anchors: { periodic_inspection_date: utc(2024, 1, 2) },
      },
    ],
    TODAY,
  )

  const issues = eligibility({ items, label: 'Unit 12' })
  assert.ok(issues.length > 0, 'a 20-month-old annual inspection must reach the dispatcher')
  assert.match(issues[0].message, /Unit 12/)
  // Equipment warns, it does not block: a lapsed inspection is a serious finding
  // and an out-of-service risk, but it does not make the DRIVER unqualified, and
  // the truck can be inspected this afternoon. Blocking here would stop a
  // dispatcher planning next week's work over a garage appointment.
  assert.equal(isBlocked(issues), false)
})

// ------------------------------------------------- the dashboard uses the gate

/**
 * FAILURE PINNED: two screens disagreeing about who can work today.
 *
 * The dashboard now prints "N drivers cannot be dispatched" at the top of the
 * page. That number and the refusal on the assignment screen have to be the
 * same answer, or the owner reads "2 cannot be dispatched", opens Dispatch, and
 * is allowed to put one of them on a load. The only way to guarantee it is that
 * both screens ask THIS function — so the dashboard must import it, and must
 * never carry a list of blocking rule codes of its own.
 *
 * Checked against the page source because there is no rendering of it in this
 * suite, and because what is being pinned is which code the page calls rather
 * than what it computes.
 */
const DASHBOARD = readFileSync(new URL('../src/pages/app/index.astro', import.meta.url), 'utf8')

/** The page with its comments stripped, so the reasoning is not read as code. */
const dashboardCode = DASHBOARD.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

test('the dashboard asks eligibility() rather than deciding for itself', () => {
  assert.match(
    dashboardCode,
    /import \{ eligibility, isBlocked \} from '\.\.\/\.\.\/lib\/dispatch\/eligibility\.ts'/,
    'the dashboard no longer imports the shared gate',
  )
  assert.match(
    dashboardCode,
    /isBlocked\(eligibility\(/,
    'the dashboard imports the gate and does not run it',
  )
})

/**
 * The deny-list, read out of its own source rather than imported.
 *
 * `BLOCKING_RULE_CODES` is not exported, and widening the module's API so a
 * test can read it would be the test changing the code to suit itself. Same
 * approach as the anchor registry's reading of the migrations: parse the one
 * true copy where it lives.
 */
function blockingCodes(): string[] {
  const src = readFileSync(new URL('../src/lib/dispatch/eligibility.ts', import.meta.url), 'utf8')
  const set = src.slice(src.indexOf('const BLOCKING_RULE_CODES'))
  const body = set.slice(0, set.indexOf('])'))
  return [...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

test('the dashboard names no blocking rule code of its own', () => {
  // The deny-list lives in one file on purpose. A code named here is a second
  // copy that will still look right on the day the two stop agreeing — which is
  // the day California's intrastate medical rule was added to the set and any
  // hand-copied list would have kept quietly letting that driver out of the yard.
  const codes = blockingCodes()
  assert.ok(codes.length >= 6, `only ${codes.length} blocking codes parsed — the regex has drifted`)

  for (const code of codes) {
    assert.ok(
      !dashboardCode.includes(code),
      `the dashboard names '${code}' itself instead of asking eligibility()`,
    )
  }
})

// ----------------------------------------------- the driver page uses it too

/**
 * FAILURE PINNED: the man's own page being the one screen that does not say it.
 *
 * Before this, the dashboard counted him among "2 drivers cannot be dispatched"
 * and the assignment screen refused to put him on a load, while his own page —
 * the page an owner opens to find out about him — listed the expired medical
 * card and never drew the conclusion. Three screens, one driver, and the one
 * with his name at the top was the one that stayed quiet.
 *
 * Same rule as the dashboard: ask the gate, never carry a copy of its list.
 */
const DRIVER_PAGE = readFileSync(
  new URL('../src/pages/app/drivers/[id].astro', import.meta.url),
  'utf8',
)

const driverPageCode = DRIVER_PAGE.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

test('the driver page asks eligibility() rather than deciding for itself', () => {
  assert.match(
    driverPageCode,
    /import \{ eligibility \} from '\.\.\/\.\.\/\.\.\/lib\/dispatch\/eligibility\.ts'/,
    'the driver page no longer imports the shared gate',
  )
  assert.match(driverPageCode, /eligibility\(\{/, 'it imports the gate and does not run it')
  for (const code of blockingCodes()) {
    assert.ok(
      !driverPageCode.includes(code),
      `the driver page names '${code}' itself instead of asking eligibility()`,
    )
  }
})

test('the driver page loads the deadlines it needs on every tab', () => {
  // The banner is on all four tabs on purpose — Pay is where a settlement gets
  // run for him, Record is where his status changes — and every other loader on
  // that page is gated on `tab === '...'`. A gate reintroduced here would make
  // the warning silently absent on three of the four screens, which is worse
  // than never having shown it: it reads as "we checked, he is fine".
  assert.ok(
    /\n\s*loadDeadlines\(supabase, carrierId\),/.test(driverPageCode),
    'loadDeadlines is gated on a tab again, so the cannot-be-dispatched banner ' +
      'is missing on the tabs that did not need the deadline list',
  )
})

test('the banner is not hidden on the Record tab with the identity strip', () => {
  // The strip above it is `tab !== 'record'`, because the Record FORM reprints
  // the same four facts in the boxes that change them. Nothing on that form
  // says a man cannot legally drive, so the banner does not take that exception
  // — and the easiest way to break this is to move it inside that block.
  const strip = driverPageCode.indexOf("tab !== 'record' &&")
  const banner = driverPageCode.indexOf('cannot be dispatched.')
  assert.ok(strip > -1 && banner > -1, 'the strip or the banner has been renamed')
  const stripEnd = driverPageCode.indexOf('phoneUndialable', strip)
  assert.ok(banner > stripEnd, 'the banner has been moved inside the `tab !== record` block')
})
