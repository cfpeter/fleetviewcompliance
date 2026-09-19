/**
 * Which rules apply to THIS carrier — the three facts that decide it, and the
 * one direction they are never allowed to be wrong in.
 *
 * THE DEFECT THESE PIN. src/lib/deadlines.ts read `carrier_operation` off a
 * carrier row that had no such column, so `carrierOperation`, `forHire` and
 * `hazmat` were undefined for every carrier, every gate answered 'unknown',
 * and an intrastate private non-hazmat carrier was asked for IFTA, IRP, UCR,
 * PHMSA hazmat registration and an FMCSA insurance filing — on his dashboard
 * and on the proof page a broker reads (docs/product/REVIEW-2026-09-18.md
 * § 2.1). 0031 added the columns; signup fills them from the census row; the
 * settings form lets the owner correct them.
 *
 * THE INVARIANT. NULL means unknown and keeps every gated rule on the board.
 * Only a positive "no" takes a rule away, and `false` on `forHire` alone takes
 * nothing away at all.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadDeadlines } from '../src/lib/deadlines.ts'
import {
  type CensusRow,
  censusOperation,
  forHireFromClassdef,
  hazmatFromHmInd,
  type OperationAnswer,
  operationAnswer,
  operationAnswers,
  operationCode,
  operationFromAnswers,
} from '../src/lib/fmcsa.ts'
import { allRules, evaluate } from '../src/lib/rules/index.ts'
import type { RuleContext } from '../src/lib/rules/types.ts'

const TODAY = new Date(Date.UTC(2026, 8, 18))

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// Census row → the three columns
// ---------------------------------------------------------------------------

/** The carrier the review was run as. Verified live on 2026-09-18. */
const SCHNECK: CensusRow = {
  dot_number: '423193',
  legal_name: 'SCHNECK EXCAVATING INC',
  phy_state: 'IN',
  carrier_operation: 'C',
  hm_ind: 'N',
  classdef: 'PRIVATE PROPERTY',
}

/** The sample row in docs/research/kt-third-party-apis.md, verified 2026-09-14. */
const HULL: CensusRow = {
  dot_number: '344554',
  legal_name: 'HULL COOPERATIVE ASSOCIATION',
  carrier_operation: 'A',
  hm_ind: 'N',
  classdef: 'AUTHORIZED FOR HIRE',
}

test('the census row settles all three facts for the carrier the review was run as', () => {
  assert.deepEqual(censusOperation(SCHNECK), {
    carrier_operation: 'C',
    for_hire: false,
    hazmat: false,
  })
  assert.deepEqual(censusOperation(HULL), {
    carrier_operation: 'A',
    for_hire: true,
    hazmat: false,
  })
})

test('a census value that settles nothing stores NULL, never a guess', () => {
  // 186,115 census rows carry no operation code at all.
  assert.equal(operationCode(undefined), null)
  assert.equal(operationCode(''), null)
  assert.equal(operationCode('X'), null)
  assert.equal(operationCode(' c '), 'C', 'whitespace and case are not information')

  assert.equal(hazmatFromHmInd('Y'), true)
  assert.equal(hazmatFromHmInd('N'), false)
  assert.equal(hazmatFromHmInd(''), null)
  assert.equal(hazmatFromHmInd(undefined), null)

  // A row with nothing usable is null, so the caller writes nothing — the
  // same contract as censusAddress.
  assert.equal(censusOperation({}), null)
  assert.equal(censusOperation(null), null)
  assert.equal(censusOperation({ carrier_operation: '', hm_ind: '', classdef: '' }), null)
  // Any one settled fact is worth writing; the others stay NULL.
  assert.deepEqual(censusOperation({ hm_ind: 'Y' }), {
    carrier_operation: null,
    for_hire: null,
    hazmat: true,
  })
})

test('classdef → for-hire follows the strings the federal file actually holds', () => {
  // The whole census grouped on `classdef`, 2026-09-18. The commonest strings
  // first; the mapping is by token, split on ';'.
  const forHire = [
    'AUTHORIZED FOR HIRE',
    'AUTHORIZED FOR HIRE;EXEMPT FOR HIRE',
    'PRIVATE PROPERTY;AUTHORIZED FOR HIRE',
    'PRIVATE PROPERTY;AUTHORIZED FOR HIRE;EXEMPT FOR HIRE',
    'PRIVATE PASSENGER, BUSINESS;PRIVATE PASSENGER, NON-BUSINESS;AUTHORIZED FOR HIRE',
    'OTHER-LEASED;AUTHORIZED FOR HIRE',
    'OTHER-UNKNOWN;AUTHORIZED FOR HIRE',
    'AUTHORIZED FOR HIRE;FEDERAL GOVERNMENT',
    // Exempt for hire is for hire: the exemption is from operating authority,
    // not from hauling for others for pay.
    'EXEMPT FOR HIRE',
    'PRIVATE PROPERTY;EXEMPT FOR HIRE',
  ]
  for (const s of forHire) assert.equal(forHireFromClassdef(s), true, s)

  const privateOnly = [
    'PRIVATE PROPERTY',
    'PRIVATE PASSENGER, BUSINESS',
    'PRIVATE PASSENGER, NON-BUSINESS',
    'PRIVATE PASSENGER, BUSINESS;PRIVATE PASSENGER, NON-BUSINESS',
    'private property', // case is not information
  ]
  for (const s of privateOnly) assert.equal(forHireFromClassdef(s), false, s)

  // Ambiguous, absent, or outside the question: NULL. "OTHER-APPLYING FOR
  // MC;PRIVATE PROPERTY" is a carrier in the middle of becoming for-hire.
  const unsettled = [
    undefined,
    '',
    ';',
    'OTHER',
    'OTHER-APPLYING FOR MC',
    'OTHER-REGISTRANT',
    'OTHER-UNKNOWN',
    'OTHER-LEASED',
    'OTHER-APPLYING FOR MC;PRIVATE PROPERTY',
    'FEDERAL GOVERNMENT',
    'LOCAL GOVERNMENT',
    'STATE GOVERNMENT',
    'MIGRANT',
    'U. S. MAIL',
    'INDIAN TRIBE',
    '18 USC §31',
  ]
  for (const s of unsettled) assert.equal(forHireFromClassdef(s), null, String(s))
})

// ---------------------------------------------------------------------------
// Carrier row → context → the board
// ---------------------------------------------------------------------------

type Facts = Pick<RuleContext, 'carrierOperation' | 'forHire' | 'hazmat'>

/** Every rule code on the board for a carrier, a CDL driver and a heavy truck. */
function codesFor(facts: Facts, state = 'CA'): Set<string> {
  const context = { registrationState: state, ...facts }
  return new Set(
    evaluate(
      [
        { type: 'carrier', id: 'c1', label: 'C', context, anchors: {} },
        { type: 'driver', id: 'd1', label: 'D', context: { ...context, cdl: true }, anchors: {} },
        {
          type: 'power_unit',
          id: 'v1',
          label: 'T',
          context: { ...context, gvwrLbs: 33_000 },
          anchors: {},
        },
      ],
      TODAY,
    ).map((i) => i.rule.code),
  )
}

const INTERSTATE_ONLY = [
  'ca_ifta_quarterly_return',
  'ca_ifta_license_renewal',
  'ca_ifta_decal_display',
  'ca_irp_renewal',
  'fed.ucr.annual-registration',
]
const INSURANCE = 'fed.387.9.liability-insurance-filing'
const HAZMAT_RULES = ['fed.107.608.hazmat-registration', 'fed.172.704.hazmat-recurrent-training']
const FEDERAL_MEDICAL = 'medical_certificate_general'
const CA_MEDICAL = 'ca_intrastate_medical_certificate'

/**
 * The four reads loadDeadlines makes, answered from memory. Filters are
 * ignored on purpose — the rows handed in are already the active ones — so
 * this exercises the WIRING from carrier row to context, which is where the
 * defect lived, and nothing about RLS, which tests/tenancy.test.ts covers.
 */
function fakeSupabase(tables: Record<string, unknown[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? []
      const b = {
        select: () => b,
        eq: () => b,
        single: async () => ({ data: rows[0] ?? null, error: null }),
        // biome-ignore lint/suspicious/noThenProperty: the real query builder is a thenable and loadDeadlines awaits it inside Promise.all
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
      }
      return b
    },
  } as unknown as SupabaseClient
}

async function boardFor(census: CensusRow | null): Promise<Set<string>> {
  // Census → the three columns → the carrier row, exactly as signup writes it.
  const carrier = {
    id: 'c1',
    dot_number: '423193',
    legal_name: 'SCHNECK EXCAVATING INC',
    phy_state: 'CA',
    carrier_operation: null,
    for_hire: null,
    hazmat: null,
    ...(censusOperation(census) ?? {}),
  }
  const items = await loadDeadlines(
    fakeSupabase({
      carriers: [carrier],
      drivers: [
        { id: 'd1', first_name: 'A', last_name: 'Driver', cdl_number: 'X1', status: 'active' },
      ],
      vehicles: [
        { id: 'v1', kind: 'power_unit', unit_number: '1', gvwr_lbs: 33_000, status: 'active' },
      ],
      current_compliance_anchors: [],
    }),
    'c1',
    TODAY,
  )
  return new Set(items.map((i) => i.rule.code))
}

test('the three facts flow from the census row through the carrier row to the board', async () => {
  const known = await boardFor(SCHNECK)
  for (const code of INTERSTATE_ONLY) {
    assert.equal(known.has(code), false, `${code} shown to an intrastate carrier`)
  }
  assert.equal(known.has(INSURANCE), false, 'a private non-hazmat carrier owes no BMC-91X')
  for (const code of HAZMAT_RULES) {
    assert.equal(known.has(code), false, `${code} shown to a non-hazmat carrier`)
  }
  assert.equal(known.has(FEDERAL_MEDICAL), false)
  assert.equal(known.has(CA_MEDICAL), true, 'the intrastate medical rule takes over')

  // The same carrier with nothing on file: every one of those rows is back.
  const unknown = await boardFor(null)
  for (const code of [...INTERSTATE_ONLY, INSURANCE, ...HAZMAT_RULES, FEDERAL_MEDICAL]) {
    assert.equal(unknown.has(code), true, `${code} must stay on the board when nothing is known`)
  }
  assert.equal(unknown.has(CA_MEDICAL), false, 'its federal twin covers the unknown case')
})

test('a carrier with nothing on file keeps every gated rule on the board', () => {
  // The invariant, stated over the whole catalogue: whatever the facts turn
  // out to be, no rule appears for a KNOWN carrier that was hidden from an
  // UNKNOWN one. The single exception is the intrastate medical rule, which
  // is one half of a partition with the federal medical rule — the unknown
  // case is covered by the other half, and tests/rules-california.test.ts
  // asserts exactly one of the two reports on any driver.
  const unknown = codesFor({})
  for (const carrierOperation of ['A', 'B', 'C'] as const) {
    for (const forHire of [true, false]) {
      for (const hazmat of [true, false]) {
        const known = codesFor({ carrierOperation, forHire, hazmat })
        for (const code of known) {
          if (code === CA_MEDICAL) continue
          assert.ok(
            unknown.has(code),
            `${code} appears for ${carrierOperation}/${forHire}/${hazmat} but not when unknown`,
          )
        }
      }
    }
  }

  // And the same thing asked of each predicate directly: no predicate may say
  // "no" with the three facts unknown and "yes" once they are known. (Some
  // say "no" in both — the insulin, intracity-zone and alternative-vision
  // medical variants answer false until their own anchor exists, and the
  // general medical rule covers the driver meanwhile. That is not this bug.)
  const bare: RuleContext = {
    today: TODAY,
    anchors: {},
    registrationState: 'CA',
    cdl: true,
    gvwrLbs: 33_000,
  }
  for (const rule of allRules) {
    if (!rule.applies || rule.code === CA_MEDICAL) continue
    if (rule.applies(bare) !== false) continue
    for (const carrierOperation of ['A', 'B', 'C'] as const) {
      for (const forHire of [true, false]) {
        for (const hazmat of [true, false]) {
          assert.equal(
            rule.applies({ ...bare, carrierOperation, forHire, hazmat }),
            false,
            `${rule.code} says "no" with the facts unknown and not with them known`,
          )
        }
      }
    }
  }
})

test("'C' drops IFTA, IRP and UCR and picks up the intrastate medical rule", () => {
  const intrastate = codesFor({ carrierOperation: 'C' })
  for (const code of INTERSTATE_ONLY) assert.equal(intrastate.has(code), false, code)
  assert.equal(intrastate.has(CA_MEDICAL), true)
  assert.equal(intrastate.has(FEDERAL_MEDICAL), false)
  // 'B' is the other intrastate code and behaves the same way.
  const intrastateHazmat = codesFor({ carrierOperation: 'B' })
  for (const code of INTERSTATE_ONLY) assert.equal(intrastateHazmat.has(code), false, code)
  assert.equal(intrastateHazmat.has(CA_MEDICAL), true)

  // 'A' keeps all five and takes the federal medical rule.
  const interstate = codesFor({ carrierOperation: 'A' })
  for (const code of INTERSTATE_ONLY) assert.equal(interstate.has(code), true, code)
  assert.equal(interstate.has(FEDERAL_MEDICAL), true)
  assert.equal(interstate.has(CA_MEDICAL), false)

  // The operation code alone touches nothing about hazmat or insurance.
  assert.equal(intrastate.has(INSURANCE), true)
  for (const code of HAZMAT_RULES) assert.equal(intrastate.has(code), true, code)
})

test('for-hire false AND hazmat false drops the insurance filing, and nothing else does', () => {
  const ops = [undefined, 'A', 'B', 'C'] as const
  const bools = [undefined, true, false] as const
  for (const carrierOperation of ops) {
    for (const forHire of bools) {
      for (const hazmat of bools) {
        const codes = codesFor({ carrierOperation, forHire, hazmat })
        const expected = !(forHire === false && hazmat === false)
        assert.equal(
          codes.has(INSURANCE),
          expected,
          `insurance filing with ${carrierOperation}/${forHire}/${hazmat}`,
        )
      }
    }
  }

  // `forHire` on its own removes NOTHING from the board — it is read by one
  // rule, and that rule needs hazmat to be known too.
  assert.deepEqual([...codesFor({ forHire: false })].sort(), [...codesFor({})].sort())
  assert.deepEqual([...codesFor({ forHire: true })].sort(), [...codesFor({})].sort())

  // And with hazmat known false, adding forHire=false removes exactly one row.
  const hazmatNo = codesFor({ hazmat: false })
  const both = codesFor({ hazmat: false, forHire: false })
  assert.deepEqual(
    [...hazmatNo].filter((c) => !both.has(c)),
    [INSURANCE],
  )
})

// ---------------------------------------------------------------------------
// The settings form
// ---------------------------------------------------------------------------

test('the settings answers round-trip, and "I\'m not sure" stores NULL', () => {
  assert.deepEqual(
    operationFromAnswers({ crossesStateLines: 'yes', forHire: 'yes', hazmat: 'yes' }),
    { carrier_operation: 'A', for_hire: true, hazmat: true },
  )
  assert.deepEqual(operationFromAnswers({ crossesStateLines: 'no', forHire: 'no', hazmat: 'no' }), {
    carrier_operation: 'C',
    for_hire: false,
    hazmat: false,
  })
  // Intrastate with hazmat is the federal 'B'.
  assert.deepEqual(
    operationFromAnswers({ crossesStateLines: 'no', forHire: 'no', hazmat: 'yes' }),
    { carrier_operation: 'B', for_hire: false, hazmat: true },
  )
  // Not sure is NULL, on every question, independently.
  assert.deepEqual(
    operationFromAnswers({ crossesStateLines: 'unsure', forHire: 'unsure', hazmat: 'unsure' }),
    { carrier_operation: null, for_hire: null, hazmat: null },
  )
  assert.deepEqual(
    operationFromAnswers({ crossesStateLines: 'no', forHire: 'unsure', hazmat: 'unsure' }),
    { carrier_operation: 'C', for_hire: null, hazmat: null },
  )

  // Stored → checked radio → stored again, for every combination.
  const answers: readonly OperationAnswer[] = ['yes', 'no', 'unsure']
  for (const crossesStateLines of answers) {
    for (const forHire of answers) {
      for (const hazmat of answers) {
        const stored = operationFromAnswers({ crossesStateLines, forHire, hazmat })
        assert.deepEqual(operationAnswers(stored), { crossesStateLines, forHire, hazmat })
      }
    }
  }
  // What was never written reads as "not sure", not as "no".
  assert.deepEqual(operationAnswers({}), {
    crossesStateLines: 'unsure',
    forHire: 'unsure',
    hazmat: 'unsure',
  })

  // Only the three words the form offers are accepted.
  assert.equal(operationAnswer('yes'), 'yes')
  assert.equal(operationAnswer(' unsure '), 'unsure')
  assert.equal(operationAnswer('maybe'), null)
  assert.equal(operationAnswer(''), null)
  assert.equal(operationAnswer(null), null)
})

test('the settings page asks the three questions in the open and saves through the mapping', () => {
  const page = read('../src/pages/app/settings.astro')

  assert.match(page, /How your company operates/, 'the section heading is on the page')
  // Not inside a <details>: the review said a carrier could not say "that rule
  // does not apply to me" anywhere, and a disclosure is where that answer
  // would go back to being invisible.
  const heading = page.indexOf('How your company operates')
  const before = page.slice(0, heading)
  const opened = (before.match(/<details/g) ?? []).length
  const closed = (before.match(/<\/details>/g) ?? []).length
  assert.equal(opened, closed, 'the section must not sit inside an open <details>')

  for (const name of ['crosses_state_lines', 'for_hire', 'hazmat']) {
    for (const value of ['yes', 'no', 'unsure']) {
      const radio = new RegExp(`name="${name}"\\s+value="${value}"`)
      assert.match(page, radio, `${name}=${value} must be a real option`)
    }
  }
  assert.match(page, /value="save_operation"/, 'the save button carries its intent')
  assert.match(page, /intent === 'save_operation'/, 'the handler dispatches on it')
  assert.match(page, /operationFromAnswers\(\{ crossesStateLines, forHire, hazmat \}\)/)
  assert.match(page, /operation_source: 'owner'/, 'an owner answer is marked as his')
  assert.match(page, /timezone, carrier_operation, for_hire, hazmat, operation_source'/)
  // Every exit is a 303 AND carries the tab. Settings groups its sections behind
  // `?tab=` now, so a redirect without it answers a save made in the company
  // group by rendering the account group — the confirmation the owner needs to
  // read would land on a page he is no longer looking at.
  assert.match(
    page,
    /Astro\.redirect\(\s*`\/app\/settings\?tab=\$\{tab\}\$\{query \? `&\$\{query\}` : ''\}`,\s*303,?\s*\)/,
    'every exit is a 303 and names the tab',
  )
})

// ---------------------------------------------------------------------------
// The owner's dashboard and the broker's page read the same columns
// ---------------------------------------------------------------------------

test('signup, the dashboard, the proof page and share_carrier all carry the three columns', () => {
  const setup = read('../src/pages/app/setup.astro')
  assert.match(setup, /censusOperation\(census\)/, 'signup reads the facts off the census row')
  assert.match(setup, /operation_source: 'fmcsa'/, 'and marks them as the federal record')

  const deadlines = read('../src/lib/deadlines.ts')
  for (const col of ['c?.carrier_operation', 'c?.for_hire', 'c?.hazmat']) {
    assert.ok(deadlines.includes(col), `deadlines.ts reads ${col}`)
  }
  // On every subject, not only the carrier: the driver gate reads the code.
  assert.equal((deadlines.match(/\.\.\.operation/g) ?? []).length, 3)

  const proof = read('../src/pages/proof/[token].astro')
  for (const col of ['carrier?.carrier_operation', 'carrier?.for_hire', 'carrier?.hazmat']) {
    assert.ok(proof.includes(col), `the proof page reads ${col}`)
  }
  assert.equal((proof.match(/\.\.\.operation/g) ?? []).length, 2, 'driver file and summary')

  const migration = read('../supabase/migrations/0031_carrier_operation.sql')
  assert.match(migration, /check \(carrier_operation in \('A', 'B', 'C'\)\)/)
  assert.match(migration, /add column for_hire boolean,/)
  assert.match(migration, /add column hazmat boolean,/)
  assert.doesNotMatch(
    migration.replace(/--.*$/gm, ''),
    /default/i,
    'no default on any of these: NULL is the only honest starting value',
  )
  assert.match(migration, /drop function share_carrier\(text\)/, 'the return type changes')
  assert.match(
    migration,
    /c\.carrier_operation, c\.for_hire, c\.hazmat/,
    'share_carrier hands the broker the same three facts',
  )
  assert.match(migration, /grant execute on function share_carrier\(text\) to anon, authenticated/)
})
