/**
 * Which state's rules reach which carrier.
 *
 * Before this existed, `RuleContext` carried the carrier's state in TWO fields
 * and not one rule read either of them. All fifteen California rules applied to
 * every carrier in the country: a Texas carrier was shown the California Motor
 * Carrier Permit and CVRA weight decals as obligations he owed. Wrong output is
 * the only failure that matters in a compliance product, and it was also the
 * thing blocking a second state — you cannot add Arizona until the engine can
 * tell an Arizonan from a Californian.
 *
 * The obvious fix — "only show CA rules to CA carriers" — is wrong in a way
 * that is worse than the bug, and the second test below is the one that pins it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allRules, evaluate } from '../src/lib/rules/index.ts'

const TODAY = new Date(Date.UTC(2026, 8, 16))

/** Every rule code the engine produces for a carrier in `state`. */
function codesFor(state: string | undefined, operation = 'A'): Set<string> {
  const context = { registrationState: state, carrierOperation: operation, gvwrLbs: 33_000 }
  return new Set(
    evaluate(
      [
        { type: 'carrier', id: 'c1', label: 'C', context, anchors: {} },
        { type: 'power_unit', id: 'v1', label: 'T', context, anchors: {} },
        { type: 'driver', id: 'd1', label: 'D', context: { ...context, cdl: true }, anchors: {} },
      ],
      TODAY,
    ).map((i) => i.rule.code),
  )
}

test("a carrier in another state is not billed for California's permits", () => {
  // The bug, stated as the user saw it. A Texas carrier has no CA# and no CVRA
  // weight decal, and showing them as deadlines he is late on is the kind of
  // wrong that makes somebody stop believing the rest of the list.
  const tx = codesFor('TX', 'C')
  assert.equal(tx.has('ca_mcp_renewal'), false)
  assert.equal(tx.has('ca_cvra_registration'), false)

  const ca = codesFor('CA', 'C')
  assert.equal(ca.has('ca_mcp_renewal'), true, 'a California carrier still owes it')
  assert.equal(ca.has('ca_cvra_registration'), true)
})

test('IFTA and IRP are NOT California obligations and must survive the gate', () => {
  // THE TEST THAT MATTERS MOST HERE, because the naive fix breaks it silently.
  //
  // These four carry a `CA` tag because CDTFA and California DMV are where a
  // California-based carrier files them. The agreements themselves cover 48
  // states and 10 Canadian provinces. Gate them on the carrier's state and a
  // Texas carrier stops being told about a quarterly fuel tax return he still
  // has to file — the same class of error as the bug, in the direction that
  // costs him a penalty instead of an eye-roll.
  const tx = codesFor('TX')
  for (const code of [
    'ca_ifta_quarterly_return',
    'ca_ifta_license_renewal',
    'ca_ifta_decal_display',
    'ca_irp_renewal',
  ]) {
    assert.equal(tx.has(code), true, `${code} must not be gated by state`)
  }
})

test('a rule that reaches whoever drives through keeps reaching them', () => {
  // CARB's Clean Truck Check applies to any vehicle operating in California
  // whatever its plates, and the CHP's BIT programme follows a terminal here.
  // We do not know where a carrier's trucks actually run, and "we do not know"
  // means we keep tracking it.
  const tx = codesFor('TX')
  assert.equal(tx.has('ca_ctc_test'), true)
  assert.equal(tx.has('ca_bit_inspection'), true)
})

test('an unknown state rules nothing out', () => {
  // Fail open, the same doctrine as everywhere else in the engine: a rule we
  // cannot rule out is a rule we track. A carrier whose FMCSA record has no
  // physical state must not quietly lose obligations because of a blank field.
  assert.deepEqual([...codesFor(undefined, 'C')].sort(), [...codesFor('CA', 'C')].sort())
  assert.deepEqual([...codesFor('', 'C')].sort(), [...codesFor('CA', 'C')].sort())
})

test('the state is read the way it actually arrives', () => {
  // phy_state comes off a federal record and out of a form. Lower case and
  // stray whitespace must not turn a Texan into a Californian.
  for (const raw of ['tx', ' TX ', 'Tx']) {
    assert.equal(codesFor(raw, 'C').has('ca_mcp_renewal'), false, `state ${JSON.stringify(raw)}`)
  }
})

test('federal rules are never gated by state', () => {
  // 36 of the 51 rules are federal and apply in every state. A gate that caught
  // any of them would delete a medical card or an annual inspection.
  const tx = codesFor('TX')
  const federal = allRules.filter((r) => r.jurisdiction === 'federal')
  const dropped = federal.filter((r) => !tx.has(r.code) && r.subject !== 'terminal')
  // Some federal rules legitimately do not apply to this fixture's subjects;
  // what matters is that the STATE is not why. Compared against a Californian
  // with the identical fixture, the federal set must be byte-identical.
  const ca = codesFor('CA')
  const federalTx = federal.filter((r) => tx.has(r.code)).map((r) => r.code)
  const federalCa = federal.filter((r) => ca.has(r.code)).map((r) => r.code)
  assert.deepEqual(federalTx, federalCa, `federal rules differ by state: ${dropped.length}`)
})

test('every state rule declares what connection it needs', () => {
  // The structural guard. Without it the next state rule somebody adds inherits
  // `universal` by omission and silently applies to the whole country — which
  // is precisely the bug this file exists to close, reopened by a default.
  const untagged = allRules.filter((r) => r.jurisdiction !== 'federal' && !r.nexus)
  assert.deepEqual(
    untagged.map((r) => r.code),
    [],
    'a non-federal rule with no `nexus` applies everywhere by accident',
  )
})
