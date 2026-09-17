/**
 * The one definition of what you run, and the two callers that must never
 * disagree about it.
 *
 * src/lib/fleet/active.ts is six lines of code and a page of reasoning, and the
 * reasoning is the part that breaks. These tests pin the four things that were
 * actually wrong before it existed: an out-of-service truck on the bill, an
 * out-of-service truck in the alerts, a driver filter that did not match the
 * vehicle filter, and — the one that makes the rest possible — two files each
 * holding their own copy of the answer.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { isBillableTruck } from '../src/lib/billing/trucks.ts'
import type { DriverStatus } from '../src/lib/drivers.ts'
import {
  ACTIVE_DRIVER_STATUS,
  ACTIVE_VEHICLE_STATUS,
  DRIVER_NOT_ACTIVE_MEANS,
  isActiveDriver,
  isActiveVehicle,
  VEHICLE_NOT_ACTIVE_MEANS,
} from '../src/lib/fleet/active.ts'
import type { VehicleStatus } from '../src/lib/vehicles.ts'

const VEHICLE_STATUSES: VehicleStatus[] = ['active', 'out_of_service', 'sold', 'inactive']
const DRIVER_STATUSES: DriverStatus[] = ['active', 'inactive', 'terminated']

/**
 * A source file with its comments taken out.
 *
 * These modules argue at length about the filters they used to hold, quoting
 * them exactly. A test that greps for a banned expression has to read the code
 * and not the history, or the explanation of the fix fails the test for the fix.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

// --- the rule ---------------------------------------------------------------

test('only an ACTIVE vehicle is watched and billed', () => {
  // The owner's words: bill me for the trucks I run. out_of_service is the one
  // that was arguable — a truck in the shop still has a registration running
  // out — and it is OFF, on both sides, because "watched for free" is the one
  // combination that invites an owner to mislabel a working truck.
  assert.equal(isActiveVehicle({ status: 'active' }), true)
  assert.equal(isActiveVehicle({ status: 'out_of_service' }), false)
  assert.equal(isActiveVehicle({ status: 'inactive' }), false)
  assert.equal(isActiveVehicle({ status: 'sold' }), false)
})

test('only an ACTIVE driver is watched', () => {
  assert.equal(isActiveDriver({ status: 'active' }), true)
  assert.equal(isActiveDriver({ status: 'inactive' }), false)
  assert.equal(isActiveDriver({ status: 'terminated' }), false)
})

test('exactly one status out of each list is the live one', () => {
  // A count, not a spot check: a fifth vehicle status added next year lands here
  // as a decision to make rather than as a silent default.
  assert.equal(VEHICLE_STATUSES.filter((status) => isActiveVehicle({ status })).length, 1)
  assert.equal(DRIVER_STATUSES.filter((status) => isActiveDriver({ status })).length, 1)
  assert.equal(ACTIVE_VEHICLE_STATUS, 'active')
  assert.equal(ACTIVE_DRIVER_STATUS, 'active')
})

// --- the two callers --------------------------------------------------------

test('billing answers exactly what the predicate answers, for every status', () => {
  for (const status of VEHICLE_STATUSES) {
    assert.equal(
      isBillableTruck({ kind: 'power_unit', status }),
      isActiveVehicle({ status }),
      `the bill and the shared rule disagree about a ${status} power unit`,
    )
  }
})

test('a trailer is never billed, and that is a separate rule from being watched', () => {
  // Two different questions with two different answers, and they must stay
  // separable: /pricing promises trailers are free, and a trailer's annual
  // § 396.17 inspection is still watched while the trailer is active.
  assert.equal(isBillableTruck({ kind: 'trailer', status: 'active' }), false)
  assert.equal(isActiveVehicle({ status: 'active' }), true)
})

test('the deadline loader filters on the shared constants, not on its own literals', () => {
  // The bug this whole module exists to stop is textual, so the test is too.
  // src/lib/deadlines.ts used to hold `.neq('status', 'sold')` and
  // `.eq('status', 'active')` — two hand-written filters that could be edited
  // one at a time. If either literal comes back, the two sides can drift again
  // without a single assertion elsewhere in this suite noticing.
  const source = readFileSync(new URL('../src/lib/deadlines.ts', import.meta.url), 'utf8')
  assert.ok(
    source.includes("eq('status', ACTIVE_VEHICLE_STATUS)"),
    'the vehicle filter must come from src/lib/fleet/active.ts',
  )
  assert.ok(
    source.includes("eq('status', ACTIVE_DRIVER_STATUS)"),
    'the driver filter must come from src/lib/fleet/active.ts',
  )
  // Comments stripped first: the file explains what it used to say, and the
  // explanation quotes the very filter this line is looking for.
  assert.doesNotMatch(
    code(source),
    /neq\('status'/,
    'a "not sold" filter is back, and it is wider than what billing charges for',
  )
})

test('billing takes its status from the shared module rather than restating it', () => {
  const source = readFileSync(new URL('../src/lib/billing/trucks.ts', import.meta.url), 'utf8')
  assert.ok(source.includes("from '../fleet/active.ts'"), 'billing must read the shared rule')
  assert.doesNotMatch(
    code(source),
    /status !== 'sold'|status === 'sold'/,
    'billing has its own copy of the status rule again',
  )
})

// --- what the screens promise -----------------------------------------------

test('the sentence shown to the owner says BOTH consequences for a truck', () => {
  // "It comes off your bill" alone reads as a saving with no cost attached. A
  // man who parks a truck to save $6 has to be told in the same sentence that we
  // stop watching its dates, or the next thing that expires is a registration.
  assert.match(VEHICLE_NOT_ACTIVE_MEANS, /reminder/i)
  assert.match(VEHICLE_NOT_ACTIVE_MEANS, /bill/i)
  assert.match(VEHICLE_NOT_ACTIVE_MEANS, /Active/)
})

test('the driver sentence never promises a saving, because drivers are free', () => {
  assert.match(DRIVER_NOT_ACTIVE_MEANS, /reminder/i)
  assert.match(DRIVER_NOT_ACTIVE_MEANS, /free/i)
  assert.doesNotMatch(DRIVER_NOT_ACTIVE_MEANS, /your bill/i)
})

test('every screen that can change a status prints the consequence', () => {
  // Three screens, one sentence, and the sentence has to be ON them. A rule the
  // owner discovers from his invoice is a rule we hid.
  const pages = [
    '../src/pages/app/vehicles/[id].astro',
    '../src/pages/app/drivers/[id].astro',
    '../src/pages/app/billing.astro',
  ].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'))

  assert.ok(pages[0].includes('VEHICLE_NOT_ACTIVE_MEANS'), 'the truck page must say it')
  assert.ok(pages[1].includes('DRIVER_NOT_ACTIVE_MEANS'), 'the driver page must say it')
  // The billing page writes it out in its own longer form; what matters is that
  // it no longer claims a parked truck is still charged for.
  assert.doesNotMatch(
    pages[2],
    /parked or out of service\s+still costs/,
    'the billing page still promises to charge for a truck it no longer watches',
  )
  assert.match(pages[2], /Only <span class="font-medium">Active<\/span> trucks count/)
})
