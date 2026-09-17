#!/usr/bin/env node
/**
 * Gives the dev database ONE carrier whose dashboard is worth screenshotting.
 *
 * THE PROBLEM THIS SOLVES IS A SALES PROBLEM. The top fold of /app is a donut,
 * four counters and a sentence doing the arithmetic out loud, and it is the
 * picture this product is sold with. Against the carriers that exist on dev it
 * draws roughly four fifths grey — "missing a date" — because those carriers are
 * somebody's manual testing and nobody has typed the dates in. A prospect reads
 * that as a product nobody uses. Nothing in the UI needs to move; the data does.
 *
 * SO IT SEEDS A NEW CARRIER AND NEVER TOUCHES AN EXISTING ONE. The three
 * carriers already on dev belong to people who are mid-test on them, and a
 * script that improved one of them would be indistinguishable, from their chair,
 * from their own edits going wrong. A new carrier also lets the fleet be SHAPED
 * — a believable mix, rather than whatever the last tester happened to type.
 *
 * WHAT "BELIEVABLE" MEANS HERE, because it is the whole skill in this file:
 * most items on track, a handful genuinely due soon, three genuinely overdue and
 * a few genuinely missing. Not perfect. A flawless fleet is exactly as
 * unbelievable as an empty one, and it also makes the product look pointless.
 * The three red items are the three a real yard actually gets caught by: a
 * medical card that lapsed three weeks ago, a truck two months past its annual
 * inspection, and a 90-day BIT that slipped a cycle.
 *
 * IT WRITES THE WAY THE APP WRITES. Every date goes through `planAnchorWrites`
 * from src/lib/anchors/plan.ts — the same function /app, /app/drivers/[id] and
 * /app/vehicles/[id] call — so the rows are supersede-then-insert rows that the
 * app itself could have produced, and so a second run writes nothing at all.
 * There is no shortcut path here that would leave rows the product never makes.
 *
 * IT ADDS AND IT NEVER REMOVES. No DELETE is issued against anything, and no
 * existing compliance record is rewritten: `compliance_records` and `documents`
 * are append-only by trigger and by design (49 CFR 391.51(c) — a driver's file
 * is kept for employment plus three years), and the only mutation this script
 * makes to an existing record is the `superseded_at` stamp the app itself uses.
 *
 *   node scripts/demo-data.mjs          apply, idempotently
 *   node scripts/demo-data.mjs --dry    do all of it, then ROLL BACK, and print
 *                                       exactly what would have changed
 *   node scripts/demo-data.mjs --report print the dashboard's four buckets for
 *                                       the demo carrier and change nothing
 *
 * Refuses to run against production. See `guard()`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import {
  anchorSlot,
  isStorableDate,
  planAnchorWrites,
  recordSubjectFor,
} from '../src/lib/anchors/plan.ts'
import { buildHealth, donutSlices, healthHeadline } from '../src/lib/charts/health.ts'
import { loadDeadlines } from '../src/lib/deadlines.ts'
import { resolveAnchor } from '../src/lib/rules/anchors.ts'
import { answerKeyFor } from '../src/lib/rules/answer.ts'
import { evaluate } from '../src/lib/rules/index.ts'
import { dbConfig } from './db-config.mjs'

// PostgREST hands back 'YYYY-MM-DD' for a date column and the app's date parsing
// is written against that. node-postgres would hand back a Date in the process
// timezone instead, which is a different value for anybody west of UTC.
pg.types.setTypeParser(1082, (v) => v)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry')
const REPORT_ONLY = process.argv.includes('--report')

// ---------------------------------------------------------------- environment

/** Parsed by hand, exactly as migrate.mjs does: this runs outside the bundler. */
function env() {
  const out = {}
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // No .env is fine when the values come from the real environment.
  }
  return { ...out, ...process.env }
}

const e = env()

/**
 * The dev Supabase project this script is allowed to write to.
 *
 * A project ref is not a secret — it is in the URL of every request the browser
 * makes — so naming it here costs nothing and buys the one guard that looks at
 * the connection actually being opened rather than at a label beside it.
 *
 * Overridable by name, never skippable: `DEMO_DEV_PROJECT_REF` replaces which
 * ref is required, and there is no value of it that turns the check off.
 */
const DEV_PROJECT_REF = e.DEMO_DEV_PROJECT_REF?.trim() || 'jgonfqmpecngjjlayfwj'

/**
 * The two production hosts, matched on the HOST and never on a substring.
 *
 * Copied from seed-dev-user.mjs along with its reasoning: dev.fleetviewcompliance.com
 * CONTAINS the production domain, so a substring test refuses the exact database
 * this script exists to seed — and a guard that blocks the ordinary path is one
 * you learn to override every single time, including on the day it was right.
 */
const PRODUCTION_HOSTS = ['fleetviewcompliance.com', 'www.fleetviewcompliance.com']

/**
 * Four independent reasons to stop, and every one of them fails CLOSED: a value
 * that is missing, unparseable or unexpected refuses, rather than falling
 * through to "probably dev".
 */
function guard(cfg) {
  const stop = (why, ...rest) => {
    console.error(`Refusing to run: ${why}`)
    for (const line of rest) console.error(`  ${line}`)
    process.exit(1)
  }

  // 1. The label on the environment. Absent is not "development".
  const deploy = (e.DEPLOY_ENV ?? '').trim().toLowerCase()
  if (deploy !== 'development') {
    stop(
      `DEPLOY_ENV is ${deploy ? `'${deploy}'` : 'not set'}, not 'development'.`,
      'This script only ever writes to the development database.',
    )
  }

  // 2. The Supabase project the app is pointed at.
  const url = (e.PUBLIC_SUPABASE_URL ?? '').trim()
  if (!url) stop('PUBLIC_SUPABASE_URL is not set.', 'Cannot tell which project this is.')
  const ref = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('.')[0]
    .toLowerCase()
  if (ref !== DEV_PROJECT_REF) {
    stop(
      `PUBLIC_SUPABASE_URL points at project '${ref}', not the dev project.`,
      `Expected '${DEV_PROJECT_REF}'.`,
    )
  }

  // 3. The site the app believes it is. Parsed by hand rather than with
  //    `new URL`, which throws on a value written without a scheme — and a throw
  //    here would skip the check rather than fail it.
  const siteHost = (e.PUBLIC_SITE_URL ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split('/')[0]
    .split(':')[0]
    .toLowerCase()
  if (PRODUCTION_HOSTS.includes(siteHost)) {
    stop(`PUBLIC_SITE_URL is the production site (${siteHost}).`)
  }

  // 4. THE CONNECTION ITSELF, which is the only one of the four that describes
  //    the database about to be written to rather than a setting beside it. The
  //    session pooler puts the project ref in the username (postgres.<ref>), and
  //    the direct host carries it in the hostname.
  const carriesRef =
    (cfg.user ?? '').toLowerCase().includes(DEV_PROJECT_REF) ||
    (cfg.host ?? '').toLowerCase().includes(DEV_PROJECT_REF)
  if (!carriesRef) {
    stop(
      'The database connection does not name the dev project.',
      `user=${cfg.user} host=${cfg.host}`,
      `Expected '${DEV_PROJECT_REF}' in one of them.`,
    )
  }
}

// -------------------------------------------------------------------- the day
//
// Every date below is chosen relative to ONE day, stated once. Pinning it means
// a re-run next month writes the same rows rather than drifting, which is half
// of what makes this script idempotent — and it means the mix that was designed
// (three overdue, a handful due soon) is the mix that is actually stored, not a
// mix that slowly decays into "everything is overdue" as the calendar moves.
//
// It is what the demo fleet's paperwork was designed around. Move it forward and
// re-check the report: the dates are a snapshot of a working yard, not a rolling
// window.
const TODAY = '2026-09-17'
const asDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
const today = asDate(TODAY)

// ------------------------------------------------------------------ the demo
//
// A small Sun Valley drayage outfit: six tractors, two trailers, four drivers.
// Everything in here is invented. The phone numbers are in the 555-01xx range
// reserved for fiction and the VINs carry 'DEM' where a real WMI would be, so
// nothing in this fixture can collide with a real vehicle or a real person.

const DEMO_EMAIL = 'demo@fleetview.test'
/** Not a secret: a known password on a dev-only account, documented in docs/OPERATIONS.md. */
const DEMO_PASSWORD = 'fleetview-demo'

const CARRIER = {
  dot_number: '3912847',
  legal_name: 'RIO VISTA CARTAGE LLC',
  dba_name: 'Rio Vista Cartage',
  timezone: 'America/Los_Angeles',
  phy_street: '11420 Sheldon St',
  phy_city: 'Sun Valley',
  // Load-bearing, not decoration. `nexusExcludes` in src/lib/rules/index.ts gates
  // every `based` California rule on this column, so a demo carrier with a null
  // or out-of-state value silently loses the Motor Carrier Permit and the CVRA
  // rows — which are half the reason this product exists in this market.
  phy_state: 'CA',
  phy_zip: '91352',
  phone: '(818) 555-0142',
}

/**
 * The carrier's own dates.
 *
 * Two are deliberately blank and both blanks are the honest answer rather than
 * an oversight:
 *
 *   accident_date                      — no reportable accident. The registry
 *                                        says "leave blank if you have had none".
 *   fed.107.608.hazmat-registration    — this carrier hauls no hazmat. Nothing
 *                                        populates `RuleContext.hazmat`, so the
 *                                        rule fails open and the row stays grey;
 *                                        inventing a hazmat registration to
 *                                        clear it would be a lie on the screen.
 *
 * The rule-code keys are not a shortcut. `answerKeyFor` files a completion under
 * the rule's own code whenever the schedule comes from an algorithm or the
 * calendar rather than from a date the owner gave us, and that is exactly where
 * `evaluate` reads it back from.
 */
const CARRIER_ANCHORS = {
  // Designated the dispatcher in 2021 and had him trained nine days later.
  // § 382.603 is one-time per supervisor, never annual.
  supervisor_designated_date: '2021-02-01',
  supervisor_reasonable_suspicion_training: '2021-02-10',

  // The 31 December that ends the registration year paid for — not the day the
  // money left, which is the autumn before.
  ucr_paid_through: '2025-12-31',

  // Both random-testing rates are measured over a calendar year and reported by
  // 31 December, so the completion is the year end itself.
  random_controlled_substances_testing_rate: '2025-12-31',
  random_alcohol_testing_rate: '2025-12-31',

  // MCS-150 is biennial and the month comes off the digits of the USDOT number.
  // 3912847 puts the last one at 31 July 2026 and the next at 31 July 2028.
  'fed.390.19T.mcs150-biennial-update': '2026-07-31',

  // IFTA: Q2 2026 filed on its 31 July due date, the licence renewed at the
  // 2025 year end, this year's decals displayed by the end of February.
  ca_ifta_quarterly_return: '2026-07-31',
  ca_ifta_license_renewal: '2025-12-31',
  ca_ifta_decal_display: '2026-02-28',

  // The 300A goes up on 1 February and stays up to 30 April.
  ca_osha_300a_posting: '2026-02-01',

  // Permit renewed in March, apportioned plates in May — DMV assigns the IRP
  // month, so it is not January for everybody.
  mcp_issued: '2026-03-19',
  irp_last_renewed: '2026-05-31',

  // The plan itself, which is a different job from training the staff on it.
  wvpp_plan_reviewed: '2026-01-15',
}

/**
 * Four drivers.
 *
 * Every date is consistent with the one beside it, and the consistency is
 * checked rather than promised — see `checkConsistency`. The shapes worth
 * knowing before reading the numbers:
 *
 *   - the annual review of the driving record is signed AFTER the MVR it
 *     reviews, never before and never on a different year;
 *   - the pre-employment Clearinghouse query and the pre-hire MVR come days
 *     BEFORE the hire date, because that is when you pull them;
 *   - the 30-day items (the hire MVR, the previous-employer investigation) fall
 *     inside 30 days of hire;
 *   - the CDL expires on a birthday, five years out, which is how California
 *     issues them;
 *   - nobody was hired before January 2020 with a pre-employment Clearinghouse
 *     query, because the Clearinghouse did not exist.
 */
const DRIVERS = [
  {
    // The veteran. Everything in order, nothing dramatic.
    first_name: 'Miguel',
    last_name: 'Arellano',
    date_of_birth: '1979-04-30',
    hired_on: '2021-02-15',
    cdl_number: 'Y4182706',
    cdl_state: 'CA',
    cdl_expires_on: '2029-04-30',
    phone: '(818) 555-0171',
    email: 'miguel.arellano@riovistacartage.test',
    anchors: {
      medical_certificate_expires: '2027-05-02',
      annual_mvr_last_obtained: '2026-02-10',
      annual_review_last_completed: '2026-02-12',
      clearinghouse_query_last_run: '2026-01-20',
      harassment_training_completed: '2025-06-04',
      wvpp_training_completed: '2026-03-18',
      dqf_maintained: '2021-02-15',
      road_test_or_equivalent: '2021-02-15',
      clearinghouse_query_pre_employment: '2021-02-11',
      mvr_inquiry_at_hire: '2021-02-17',
      safety_performance_history_investigation: '2021-03-02',
    },
  },
  {
    // Card expires in a month. This is the amber row the product exists for.
    first_name: 'Dana',
    last_name: 'Whitfield',
    date_of_birth: '1986-11-30',
    hired_on: '2022-08-01',
    cdl_number: 'B7310945',
    cdl_state: 'CA',
    cdl_expires_on: '2027-11-30',
    phone: '(818) 555-0184',
    email: 'dana.whitfield@riovistacartage.test',
    anchors: {
      medical_certificate_expires: '2026-10-20',
      annual_mvr_last_obtained: '2026-07-06',
      annual_review_last_completed: '2026-07-09',
      clearinghouse_query_last_run: '2026-06-25',
      harassment_training_completed: '2026-04-21',
      wvpp_training_completed: '2026-03-18',
      dqf_maintained: '2022-08-01',
      road_test_or_equivalent: '2022-08-01',
      clearinghouse_query_pre_employment: '2022-07-27',
      mvr_inquiry_at_hire: '2022-08-03',
      safety_performance_history_investigation: '2022-08-19',
    },
  },
  {
    // Card lapsed three weeks ago. One of the three red rows, and the one that
    // parks a truck: § 391.45 makes him unqualified from the expiry date.
    first_name: 'Ruben',
    last_name: 'Ocampo',
    date_of_birth: '1991-01-31',
    hired_on: '2024-06-03',
    cdl_number: 'C2648173',
    cdl_state: 'CA',
    cdl_expires_on: '2028-01-31',
    phone: '(818) 555-0196',
    email: 'ruben.ocampo@riovistacartage.test',
    anchors: {
      medical_certificate_expires: '2026-08-28',
      annual_mvr_last_obtained: '2026-05-12',
      annual_review_last_completed: '2026-05-14',
      clearinghouse_query_last_run: '2026-05-12',
      harassment_training_completed: '2025-09-30',
      wvpp_training_completed: '2026-03-18',
      dqf_maintained: '2024-06-03',
      road_test_or_equivalent: '2024-06-03',
      clearinghouse_query_pre_employment: '2024-05-29',
      mvr_inquiry_at_hire: '2024-06-05',
      safety_performance_history_investigation: '2024-06-21',
    },
  },
  {
    // Hired three weeks ago, and his file is the shape a three-week-old file
    // actually is: the things you do on day one are done, the previous-employer
    // investigation is still out with the previous employer, and the workplace
    // violence session is the next one on the calendar. Both gaps carry a real
    // date the dashboard can count down to rather than a shrug.
    first_name: 'Terrence',
    last_name: 'Boyd',
    date_of_birth: '1994-06-30',
    hired_on: '2026-08-24',
    cdl_number: 'D5093612',
    cdl_state: 'CA',
    cdl_expires_on: '2030-06-30',
    phone: '(818) 555-0108',
    email: 'terrence.boyd@riovistacartage.test',
    anchors: {
      medical_certificate_expires: '2028-06-30',
      annual_mvr_last_obtained: '2026-08-20',
      annual_review_last_completed: '2026-08-25',
      clearinghouse_query_last_run: '2026-08-20',
      harassment_training_completed: '2026-09-02',
      dqf_maintained: '2026-08-24',
      road_test_or_equivalent: '2026-08-24',
      clearinghouse_query_pre_employment: '2026-08-20',
      mvr_inquiry_at_hire: '2026-08-20',
      // safety_performance_history_investigation — still outstanding, due 23 Sep
      // wvpp_training_completed                  — not yet trained
    },
  },
]

/**
 * Six tractors and two trailers.
 *
 * A TRAILER OWES FEWER THINGS AND IS GIVEN FEWER DATES. `rulesFor('trailer')`
 * hands back two rules against a power unit's nine, because the ones a trailer
 * is missing are the ones that need an engine — no Clean Truck Check, no Form
 * 2290, no fuel tax. Writing a `carb_ctc_first_deadline` against a trailer would
 * store a date no rule will ever read and quietly imply the opposite.
 * `checkConsistency` derives the permitted key set per unit from the engine
 * itself and refuses anything outside it, so that cannot be done by accident.
 *
 * The CARB deadline month and the CVRA renewal month agree per unit, because
 * both come off the DMV registration month for a California-plated truck.
 */
const VEHICLES = [
  {
    kind: 'power_unit',
    unit_number: '112',
    vin: '1FVDEM00000000112',
    make: 'Freightliner',
    model: 'Cascadia',
    model_year: 2019,
    gvwr_lbs: 80000,
    plate: '8K91427',
    plate_state: 'CA',
    anchors: {
      periodic_inspection_date: '2026-03-10',
      'fed.396.21.inspection-report-retention.power-unit': '2026-03-10',
      hvut_first_use_date: '2021-03-05',
      'fed.irs.2290.heavy-vehicle-use-tax': '2026-08-31',
      // March registration, so the CTC deadline that has already passed is
      // 31 March and the next six-month test lands on 30 September — thirteen
      // days out, which is the one genuinely imminent item on this truck.
      carb_ctc_first_deadline: '2026-03-31',
      bit_last_inspection: '2026-08-14',
      cvra_last_registered: '2026-03-12',
    },
  },
  {
    kind: 'power_unit',
    unit_number: '118',
    vin: '1FVDEM00000000118',
    make: 'Peterbilt',
    model: '579',
    model_year: 2018,
    gvwr_lbs: 80000,
    plate: '7J55208',
    plate_state: 'CA',
    anchors: {
      // Two months past its annual § 396.17. One of the three red rows, and the
      // ordinary way a small fleet gets there: the truck was in the shop in July
      // and the inspection never got rebooked.
      periodic_inspection_date: '2025-07-14',
      'fed.396.21.inspection-report-retention.power-unit': '2025-07-14',
      hvut_first_use_date: '2020-09-08',
      'fed.irs.2290.heavy-vehicle-use-tax': '2026-08-31',
      carb_ctc_first_deadline: '2026-07-31',
      bit_last_inspection: '2026-08-28',
      cvra_last_registered: '2026-07-22',
    },
  },
  {
    kind: 'power_unit',
    unit_number: '205',
    vin: '1FVDEM00000000205',
    make: 'Freightliner',
    model: 'Cascadia',
    model_year: 2022,
    gvwr_lbs: 80000,
    plate: '9M31764',
    plate_state: 'CA',
    anchors: {
      periodic_inspection_date: '2025-11-19',
      'fed.396.21.inspection-report-retention.power-unit': '2025-11-19',
      hvut_first_use_date: '2022-11-16',
      'fed.irs.2290.heavy-vehicle-use-tax': '2026-08-31',
      carb_ctc_first_deadline: '2026-05-31',
      // Next BIT inside three weeks.
      bit_last_inspection: '2026-07-09',
      cvra_last_registered: '2026-05-27',
    },
  },
  {
    kind: 'power_unit',
    unit_number: '214',
    vin: '1FVDEM00000000214',
    make: 'Kenworth',
    model: 'T680',
    model_year: 2023,
    gvwr_lbs: 80000,
    plate: '9P44815',
    plate_state: 'CA',
    anchors: {
      periodic_inspection_date: '2026-01-28',
      'fed.396.21.inspection-report-retention.power-unit': '2026-01-28',
      hvut_first_use_date: '2023-02-09',
      'fed.irs.2290.heavy-vehicle-use-tax': '2026-08-31',
      carb_ctc_first_deadline: '2026-06-30',
      // A 90-day BIT cycle that slipped one cycle. The third red row, and the
      // most ordinary failure in a California yard.
      bit_last_inspection: '2026-05-20',
      cvra_last_registered: '2026-06-24',
    },
  },
  {
    kind: 'power_unit',
    unit_number: '307',
    vin: '1FVDEM00000000307',
    make: 'Volvo',
    model: 'VNL 760',
    model_year: 2024,
    gvwr_lbs: 80000,
    plate: '1R20938',
    plate_state: 'CA',
    anchors: {
      periodic_inspection_date: '2026-06-11',
      'fed.396.21.inspection-report-retention.power-unit': '2026-06-11',
      hvut_first_use_date: '2024-07-19',
      'fed.irs.2290.heavy-vehicle-use-tax': '2026-08-31',
      carb_ctc_first_deadline: '2026-08-31',
      bit_last_inspection: '2026-09-02',
      cvra_last_registered: '2026-08-19',
    },
  },
  {
    kind: 'power_unit',
    unit_number: '331',
    vin: '1FVDEM00000000331',
    make: 'International',
    model: 'LT',
    model_year: 2021,
    gvwr_lbs: 80000,
    plate: '8T67312',
    plate_state: 'CA',
    anchors: {
      // Bought used last month. Everything was done at the purchase — the
      // pre-purchase § 396.17, the BIT, the re-registration — except the Form
      // 2290, whose prorated return for a truck first used in August is due
      // 30 September. That row sits grey with a real date thirteen days out,
      // which is the single most useful thing on the whole dashboard: it is the
      // product finding a deadline a new truck creates and nobody remembers.
      periodic_inspection_date: '2026-08-05',
      'fed.396.21.inspection-report-retention.power-unit': '2026-08-05',
      hvut_first_use_date: '2026-08-10',
      carb_ctc_first_deadline: '2026-08-31',
      bit_last_inspection: '2026-08-06',
      cvra_last_registered: '2026-08-12',
    },
  },
  {
    kind: 'trailer',
    unit_number: 'T-401',
    vin: '1UYDEM00000000401',
    make: 'Utility',
    model: '3000R',
    model_year: 2019,
    gvwr_lbs: 65000,
    plate: '4TR9061',
    plate_state: 'CA',
    anchors: {
      periodic_inspection_date: '2026-02-18',
      'fed.396.21.inspection-report-retention.trailer': '2026-02-18',
    },
  },
  {
    kind: 'trailer',
    unit_number: 'T-408',
    vin: '1UYDEM00000000408',
    make: 'Great Dane',
    model: 'Everest',
    model_year: 2016,
    gvwr_lbs: 65000,
    plate: '3TR5528',
    plate_state: 'CA',
    anchors: {
      periodic_inspection_date: '2026-06-05',
      'fed.396.21.inspection-report-retention.trailer': '2026-06-05',
    },
  },
]

// ------------------------------------------------------- consistency checking
//
// A date that contradicts the date beside it is worse than no date at all: it is
// the one thing a buyer who knows this industry will spot in the screenshot, and
// once he has spotted one he stops believing the other hundred. So the fixture
// is checked against the engine's own vocabulary rather than against a second
// list written here — a list here would be one more thing to keep in step.

const daysBetweenIso = (a, b) => Math.round((asDate(b) - asDate(a)) / 86_400_000)

/**
 * Which anchor keys the rule engine will actually READ for this subject.
 *
 * Derived by asking the engine twice: once with no dates at all, which makes
 * every rule report the anchor it is waiting for, and once with the dates this
 * fixture supplies, which surfaces the questions that only appear after an
 * earlier one is answered. Anything outside the union is a key nothing will ever
 * read — a Clean Truck Check date on a trailer being the case this exists for.
 */
function readableKeys(subject) {
  const keys = new Set()
  for (const anchors of [{}, subject.anchors]) {
    for (const item of evaluate([{ ...subject, anchors }], today)) {
      keys.add(answerKeyFor(item.rule))
      if (item.status.answerKey) keys.add(item.status.answerKey)
      for (const need of item.status.needs ?? []) keys.add(need)
    }
  }
  return keys
}

function checkConsistency() {
  const problems = []
  const bad = (msg) => problems.push(msg)

  const everyAnchor = [
    ['carrier', 'the carrier', CARRIER_ANCHORS],
    ...DRIVERS.map((d) => ['driver', `${d.first_name} ${d.last_name}`, d.anchors]),
    ...VEHICLES.map((v) => [v.kind, `unit ${v.unit_number}`, v.anchors]),
  ]

  // 1. Every date is a date Postgres will accept and a human meant. The app's own
  //    validator, so '2026-02-31' is caught here rather than three days later.
  for (const [, who, anchors] of everyAnchor) {
    for (const [key, on] of Object.entries(anchors)) {
      if (!isStorableDate(on)) bad(`${who}: ${key} = '${on}' is not a real date`)
    }
  }
  for (const d of DRIVERS) {
    for (const f of ['date_of_birth', 'hired_on', 'cdl_expires_on']) {
      if (!isStorableDate(d[f])) bad(`${d.last_name}: ${f} = '${d[f]}' is not a real date`)
    }
  }

  // 2. A date that points the wrong way. `last_done` names something that has
  //    ALREADY happened — compute.ts walks forward from it, so a future one
  //    steps past the occurrence just reported and moves the deadline LATER,
  //    which is the single direction this domain refuses to be wrong in.
  //    `expires` is the opposite and is allowed to be, and usually is, ahead.
  //    The direction is read from src/lib/rules/anchors.ts, never decided here.
  for (const [, who, anchors] of everyAnchor) {
    for (const [key, on] of Object.entries(anchors)) {
      const entry = resolveAnchor(key)
      if (!entry) {
        bad(`${who}: ${key} is not an anchor this app knows about`)
        continue
      }
      if (!entry.writable) {
        bad(`${who}: ${key} must never be written as a record — ${entry.answeredElsewhere.source}`)
      }
      if (entry.kind === 'last_done' && on > TODAY) {
        bad(`${who}: ${key} = ${on} is in the future, but it names something already done`)
      }
    }
  }

  // 3. A key nothing will read, per subject. This is the trailer rule.
  for (const [kind, who, anchors] of everyAnchor) {
    // The engine wants Dates, and — for a driver — the two facts that live on
    // the driver ROW rather than in compliance_records. Without those projected
    // in, five federal rules report "we need the hire date" and half the
    // questions this check is looking for never appear.
    const dated = Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, asDate(v)]))
    const d = kind === 'driver' && DRIVERS.find((x) => `${x.first_name} ${x.last_name}` === who)
    const subject = {
      type: kind,
      id: 'x',
      label: who,
      context:
        kind === 'carrier'
          ? {
              dotNumber: CARRIER.dot_number,
              registrationState: CARRIER.phy_state,
              fleetSize: VEHICLES.filter((v) => v.kind === 'power_unit').length,
            }
          : kind === 'driver'
            ? { cdl: true, registrationState: CARRIER.phy_state }
            : {
                registrationState: CARRIER.phy_state,
                gvwrLbs: VEHICLES.find((v) => `unit ${v.unit_number}` === who)?.gvwr_lbs,
              },
      anchors: d
        ? { ...dated, hire_date: asDate(d.hired_on), cdl_expires: asDate(d.cdl_expires_on) }
        : dated,
    }
    const allowed = readableKeys(subject)
    for (const key of Object.keys(anchors)) {
      if (!allowed.has(key)) {
        bad(`${who}: nothing reads ${key} for a ${kind} — the date would be stored and ignored`)
      }
    }
  }

  // 4. The driver-file orderings a person would notice.
  for (const d of DRIVERS) {
    const who = `${d.first_name} ${d.last_name}`
    const a = d.anchors

    const ageAtHire = daysBetweenIso(d.date_of_birth, d.hired_on) / 365.25
    if (ageAtHire < 21) bad(`${who}: hired at ${ageAtHire.toFixed(1)}; § 391.11 needs 21`)
    if (d.cdl_expires_on.slice(5) !== d.date_of_birth.slice(5)) {
      bad(`${who}: a California CDL expires on the birthday, not ${d.cdl_expires_on}`)
    }

    // The review is a different piece of paper from the MVR and is signed after
    // reading it. Same date is fine; earlier is not, and a year apart is not a
    // review of that record.
    if (a.annual_mvr_last_obtained && a.annual_review_last_completed) {
      const gap = daysBetweenIso(a.annual_mvr_last_obtained, a.annual_review_last_completed)
      if (gap < 0) bad(`${who}: the annual review is signed ${-gap} days BEFORE the MVR it reviews`)
      if (gap > 60) bad(`${who}: the annual review is ${gap} days after its MVR`)
    }

    // Pulled to decide whether to hire, so they come before the hire — but not
    // from a different year.
    for (const key of ['clearinghouse_query_pre_employment', 'mvr_inquiry_at_hire']) {
      if (!a[key]) continue
      const gap = daysBetweenIso(d.hired_on, a[key])
      if (gap < -60) bad(`${who}: ${key} is ${-gap} days before the hire date`)
      if (key === 'mvr_inquiry_at_hire' && gap > 30) {
        bad(`${who}: the hire MVR is ${gap} days after hire; § 391.23 allows 30`)
      }
    }
    if (a.safety_performance_history_investigation) {
      const gap = daysBetweenIso(d.hired_on, a.safety_performance_history_investigation)
      if (gap > 30) bad(`${who}: the previous-employer investigation is ${gap} days after hire`)
    }
    // Training happens once somebody works here.
    for (const key of ['harassment_training_completed', 'wvpp_training_completed']) {
      if (a[key] && a[key] < d.hired_on) bad(`${who}: ${key} predates the hire date`)
    }
    // A driver hired before the Clearinghouse existed cannot have been queried.
    if (
      a.clearinghouse_query_pre_employment &&
      a.clearinghouse_query_pre_employment < '2020-01-06'
    ) {
      bad(`${who}: a pre-employment Clearinghouse query dated before the register opened`)
    }
    // The one-time items are anchored to employment, so they cannot predate it
    // except for the two pulled during recruiting, handled above.
    for (const key of ['dqf_maintained', 'road_test_or_equivalent']) {
      if (a[key] && a[key] < d.hired_on) bad(`${who}: ${key} predates the hire date`)
    }
  }

  // 5. The vehicle orderings.
  for (const v of VEHICLES) {
    const who = `unit ${v.unit_number}`
    const a = v.anchors
    if (a.hvut_first_use_date && Number(a.hvut_first_use_date.slice(0, 4)) < v.model_year) {
      bad(`${who}: first used in ${a.hvut_first_use_date.slice(0, 4)}, a ${v.model_year} model`)
    }
    // A California-plated truck's CARB compliance month IS its DMV registration
    // month, so the two must agree or the fixture contradicts itself.
    if (a.carb_ctc_first_deadline && a.cvra_last_registered) {
      if (a.carb_ctc_first_deadline.slice(5, 7) !== a.cvra_last_registered.slice(5, 7)) {
        bad(`${who}: CARB deadline month and registration month disagree`)
      }
    }
    // The retention clock runs from the inspection it retains.
    const retain =
      a['fed.396.21.inspection-report-retention.power-unit'] ??
      a['fed.396.21.inspection-report-retention.trailer']
    if (retain && retain !== a.periodic_inspection_date) {
      bad(`${who}: the inspection-report retention date is not the inspection date`)
    }
  }

  return problems
}

// ------------------------------------------------------------------- the work

const cfg = dbConfig(e)
if (!cfg) {
  console.error('No database connection configured.')
  console.error('Supabase dashboard -> Connect -> Session pooler (port 5432, NOT 6543).')
  process.exit(1)
}
guard(cfg)

const problems = checkConsistency()
if (problems.length > 0) {
  console.error(`The demo fixture contradicts itself in ${problems.length} place(s):`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error('\nNothing was written.')
  process.exit(1)
}

const client = new pg.Client(cfg)
await client.connect()

/** Owner grants for one statement, keeping whatever JWT claim is in force. */
async function asOwner(sql, params = []) {
  await client.query('reset role')
  const r = await client.query(sql, params)
  await client.query(`select set_config('role', 'authenticated', true)`)
  return r
}

/**
 * The four reads `loadDeadlines` makes, over this transaction's connection.
 *
 * Deliberately NOT scoped by hand: the queries run as the demo user with RLS on,
 * which is how the app reaches this data, so a report that came out right here
 * is a report that will come out right on the screen.
 */
function supabaseShim() {
  // pg cannot run two queries at once on one connection, and loadDeadlines
  // issues its four in a Promise.all. Serialised rather than given a pool,
  // because they have to run inside this transaction to see uncommitted work.
  let queue = Promise.resolve()
  const run = (table, filters) =>
    (queue = queue.then(async () => {
      const where = []
      const params = []
      for (const [col, val] of filters) {
        params.push(val)
        where.push(`${col} = $${params.length}`)
      }
      const sql = `select * from ${table}${where.length ? ` where ${where.join(' and ')}` : ''}`
      const { rows } = await client.query(sql, params)
      return rows
    }))
  return {
    from(table) {
      const filters = []
      const b = {
        select: () => b,
        eq: (col, val) => {
          filters.push([col, val])
          return b
        },
        single: async () => ({ data: (await run(table, filters))[0] ?? null }),
        // Thenable ON PURPOSE. PostgREST's builder is awaited directly —
        // `await supabase.from('drivers').select('*').eq(...)` — and loadDeadlines
        // does exactly that inside a Promise.all. A shim that was not thenable
        // would need loadDeadlines rewritten for this script, which is the one
        // thing that would stop the report describing the real screen.
        // biome-ignore lint/suspicious/noThenProperty: the real client is thenable and this stands in for it
        then: (res, rej) =>
          run(table, filters)
            .then((rows) => ({ data: rows }))
            .then(res, rej),
      }
      return b
    },
  }
}

async function report(carrierId) {
  const items = await loadDeadlines(supabaseShim(), carrierId, today)
  const health = buildHealth(
    items.map((i) => ({ standing: i.status.standing, daysUntil: i.daysUntil })),
  )
  console.log('')
  console.log(`  dashboard, as at ${TODAY}`)
  console.log(`    ${healthHeadline(health)} — out of ${health.total} we track`)
  for (const b of health.buckets) {
    console.log(`      ${String(b.count).padStart(4)}  ${b.label}`)
  }
  console.log(
    `    donut: ${donutSlices(health)
      .map((s) => `${s.key} ${s.percent.toFixed(1)}%`)
      .join(' · ')}`,
  )
  console.log(
    `    ${health.unschedulable} more have no due date anyone can work out (outside the ring)`,
  )

  // `--items` prints the rows behind the four numbers. The counters on the
  // dashboard are only worth trusting if they can be taken apart, and the same
  // goes for the ones printed here.
  if (process.argv.includes('--items')) {
    console.log('')
    for (const i of items) {
      const days = i.daysUntil === undefined ? '' : `${i.daysUntil > 0 ? '+' : ''}${i.daysUntil}d`
      console.log(
        `    ${i.status.standing.padEnd(12)} ${i.subjectLabel.slice(0, 20).padEnd(20)} ` +
          `${i.rule.code.padEnd(44)} ${days.padStart(7)}`,
      )
    }
  }
  return health
}

const counts = { drivers: { created: 0, updated: 0 }, vehicles: { created: 0, updated: 0 } }

try {
  await client.query('begin')

  // ---- the demo login. Found by email, created only when absent, NEVER deleted.
  let { rows: users } = await client.query(
    'select id from auth.users where lower(email) = lower($1)',
    [DEMO_EMAIL],
  )
  if (users.length === 0 && !REPORT_ONLY) {
    users = (
      await client.query(
        `insert into auth.users (
           instance_id, id, aud, role, email, encrypted_password,
           email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
           created_at, updated_at,
           confirmation_token, recovery_token, email_change,
           email_change_token_new, email_change_token_current,
           phone_change, phone_change_token, reauthentication_token
         ) values (
           '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
           'authenticated', 'authenticated', $1, crypt($2, gen_salt('bf')),
           now(), '{"provider":"email","providers":["email"]}'::jsonb,
           jsonb_build_object('full_name', 'Rio Vista Cartage (demo)'),
           now(), now(),
           '', '', '', '', '', '', '', ''
         )
         returning id`,
        [DEMO_EMAIL.toLowerCase(), DEMO_PASSWORD],
      )
    ).rows
    console.log(`  + auth user ${DEMO_EMAIL}`)
  }
  if (users.length === 0) {
    throw new Error(`no ${DEMO_EMAIL} yet — run without --report first`)
  }
  const userId = users[0].id

  // Everything from here acts as that user. The role and the claim are set
  // independently, exactly as tests/helpers.ts does it, so `asOwner` can borrow
  // the owner's grants for one statement without losing auth.uid().
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: userId, role: 'authenticated' }),
  ])
  await client.query(`select set_config('role', 'authenticated', true)`)

  // ---- the carrier. Keyed on the DOT number, which is UNIQUE, so a second run
  //      finds the same row. `create_carrier` was revoked from `authenticated`
  //      in 0021 — that revoke IS the security property — so this borrows the
  //      owner's grant for one statement, the way makeCarrier() does.
  let { rows: carriers } = await asOwner('select id from carriers where dot_number = $1', [
    CARRIER.dot_number,
  ])
  if (carriers.length === 0 && !REPORT_ONLY) {
    carriers = (
      await asOwner('select create_carrier($1, $2, $3, $4) as id', [
        CARRIER.dot_number,
        CARRIER.legal_name,
        CARRIER.dba_name,
        CARRIER.timezone,
      ])
    ).rows
    console.log(`  + carrier ${CARRIER.legal_name} (DOT ${CARRIER.dot_number})`)
  }
  if (carriers.length === 0) throw new Error('no demo carrier yet — run without --report first')
  const carrierId = carriers[0].id

  if (REPORT_ONLY) {
    await report(carrierId)
    await client.query('rollback')
    await client.end()
    process.exit(0)
  }

  // The address the state gate reads. An UPDATE with the same values twice is
  // the same row twice, so this needs no guard of its own.
  await client.query(
    `update carriers
        set phy_street = $2, phy_city = $3, phy_state = $4, phy_zip = $5,
            phone = $6, dba_name = $7, legal_name = $8
      where id = $1`,
    [
      carrierId,
      CARRIER.phy_street,
      CARRIER.phy_city,
      CARRIER.phy_state,
      CARRIER.phy_zip,
      CARRIER.phone,
      CARRIER.dba_name,
      CARRIER.legal_name,
    ],
  )

  // ---- drivers, keyed on the CDL number: unique to a person, stable across
  //      runs, and already on the row this script would otherwise duplicate.
  const driverIds = new Map()
  for (const d of DRIVERS) {
    const found = await client.query(
      'select id from drivers where carrier_id = $1 and cdl_number = $2',
      [carrierId, d.cdl_number],
    )
    if (found.rows.length > 0) {
      await client.query(
        `update drivers set first_name=$2, last_name=$3, date_of_birth=$4, phone=$5,
                            email=$6, cdl_state=$7, cdl_expires_on=$8, hired_on=$9,
                            status='active', terminated_on=null
          where id = $1`,
        [
          found.rows[0].id,
          d.first_name,
          d.last_name,
          d.date_of_birth,
          d.phone,
          d.email,
          d.cdl_state,
          d.cdl_expires_on,
          d.hired_on,
        ],
      )
      driverIds.set(d.cdl_number, found.rows[0].id)
      counts.drivers.updated++
    } else {
      const ins = await client.query(
        `insert into drivers (carrier_id, first_name, last_name, date_of_birth, phone, email,
                              cdl_number, cdl_state, cdl_expires_on, hired_on, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active') returning id`,
        [
          carrierId,
          d.first_name,
          d.last_name,
          d.date_of_birth,
          d.phone,
          d.email,
          d.cdl_number,
          d.cdl_state,
          d.cdl_expires_on,
          d.hired_on,
        ],
      )
      driverIds.set(d.cdl_number, ins.rows[0].id)
      counts.drivers.created++
    }
  }

  // ---- vehicles, keyed on the unit number.
  const vehicleIds = new Map()
  for (const v of VEHICLES) {
    const found = await client.query(
      'select id from vehicles where carrier_id = $1 and unit_number = $2',
      [carrierId, v.unit_number],
    )
    if (found.rows.length > 0) {
      await client.query(
        `update vehicles set kind=$2, vin=$3, make=$4, model=$5, model_year=$6,
                             gvwr_lbs=$7, plate=$8, plate_state=$9, status='active'
          where id = $1`,
        [
          found.rows[0].id,
          v.kind,
          v.vin,
          v.make,
          v.model,
          v.model_year,
          v.gvwr_lbs,
          v.plate,
          v.plate_state,
        ],
      )
      vehicleIds.set(v.unit_number, found.rows[0].id)
      counts.vehicles.updated++
    } else {
      const ins = await client.query(
        `insert into vehicles (carrier_id, kind, unit_number, vin, make, model, model_year,
                               gvwr_lbs, plate, plate_state, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active') returning id`,
        [
          carrierId,
          v.kind,
          v.unit_number,
          v.vin,
          v.make,
          v.model,
          v.model_year,
          v.gvwr_lbs,
          v.plate,
          v.plate_state,
        ],
      )
      vehicleIds.set(v.unit_number, ins.rows[0].id)
      counts.vehicles.created++
    }
  }

  // ---- the dates, through the app's own planner.
  //
  // `planAnchorWrites` is what makes a second run a no-op: it compares each
  // desired date against what `current_compliance_anchors` shows right now and
  // returns it as `unchanged` when they match, so nothing is inserted. It also
  // carries the supersede rule — a correction to an EARLIER date has to mark the
  // visible row superseded or the view goes on showing the old one — which is
  // the part that is easy to get wrong and the reason this does not hand-roll
  // an insert.
  const entries = []
  const push = (subject, subjectId, anchors) => {
    for (const [anchorKey, on] of Object.entries(anchors)) {
      entries.push({ subject, subjectId, anchorKey, on })
    }
  }
  push(recordSubjectFor('carrier'), carrierId, CARRIER_ANCHORS)
  for (const d of DRIVERS) push(recordSubjectFor('driver'), driverIds.get(d.cdl_number), d.anchors)
  for (const v of VEHICLES) push(recordSubjectFor(v.kind), vehicleIds.get(v.unit_number), v.anchors)

  const { rows: currentRows } = await client.query(
    'select id, subject_type, subject_id, anchor_key, occurred_on from current_compliance_anchors',
  )
  const current = new Map(
    currentRows.map((r) => [
      anchorSlot(r.subject_type, r.subject_id, r.anchor_key),
      { id: String(r.id), occurred_on: String(r.occurred_on).slice(0, 10) },
    ]),
  )

  const recordedAt = new Date().toISOString()
  const plan = planAnchorWrites({ entries, current, carrierId, userId, recordedAt })
  if (plan.conflicts.length > 0) {
    throw new Error(`two dates for one question: ${plan.conflicts.join(', ')}`)
  }

  if (plan.supersede.length > 0) {
    await client.query(
      'update compliance_records set superseded_at = $2 where id = any($1::uuid[])',
      [plan.supersede, recordedAt],
    )
  }
  for (const row of plan.inserts) {
    await client.query(
      `insert into compliance_records
         (carrier_id, subject_type, subject_id, anchor_key, occurred_on, recorded_by, recorded_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        row.carrier_id,
        row.subject_type,
        row.subject_id,
        row.anchor_key,
        row.occurred_on,
        row.recorded_by,
        row.recorded_at,
      ],
    )
  }

  console.log(
    `  drivers   ${counts.drivers.created} created, ${counts.drivers.updated} already there`,
  )
  console.log(
    `  vehicles  ${counts.vehicles.created} created, ${counts.vehicles.updated} already there`,
  )
  console.log(
    `  dates     ${plan.inserts.length} written, ${plan.unchanged} already correct, ` +
      `${plan.supersede.length} superseded`,
  )

  await report(carrierId)

  if (DRY) {
    await client.query('rollback')
    console.log('\n--dry: rolled back. Nothing was written.')
  } else {
    await client.query('commit')
    console.log(`\nDone. Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}.`)
  }
} catch (err) {
  await client.query('rollback').catch(() => {})
  console.error('failed:', err.message)
  process.exitCode = 1
} finally {
  await client.end()
}
