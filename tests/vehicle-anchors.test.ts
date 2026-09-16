/**
 * The join between the vehicles screen and the rule catalogue.
 *
 * `compliance_records.anchor_key` is a plain string on both sides: the screen
 * writes it, the engine reads it back as `ctx.anchors[key]`. Nothing enforces
 * that they agree. A single typo does not throw and does not log — the rule just
 * never finds its date and reports `missing_data` forever, so the dashboard asks
 * for a date the owner typed in months ago and the whole product looks broken in
 * the one way that makes people stop trusting it.
 *
 * So this file asserts the agreement in both directions, and it asserts it by
 * running the engine rather than by comparing two lists. Comparing lists would
 * miss the anchors a `computed` rule reads straight out of `ctx.anchors` without
 * ever declaring them on the rule row — which is exactly how CTC-VIS works.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { californiaRules } from '../src/lib/rules/california.ts'
import { nextDue } from '../src/lib/rules/compute.ts'
import { federalCarrierRules } from '../src/lib/rules/federal-carrier.ts'
import type { RuleContext, RuleDefinition } from '../src/lib/rules/types.ts'
import { anchorsForKind, VEHICLE_ANCHORS, type VehicleKind } from '../src/lib/vehicles.ts'

const TODAY = new Date(Date.UTC(2026, 8, 15))
/** Any past date. What matters is that supplying one changes the answer. */
const SOME_DATE = new Date(Date.UTC(2025, 2, 10))

const vehicleRules: readonly RuleDefinition[] = [...federalCarrierRules, ...californiaRules].filter(
  (r) => r.subject === 'power_unit' || r.subject === 'trailer',
)

const subjectOf = (r: RuleDefinition): VehicleKind =>
  r.subject === 'trailer' ? 'trailer' : 'power_unit'

function ctx(anchors: Readonly<Record<string, Date>>): RuleContext {
  return { today: TODAY, anchors }
}

test('the catalogue has vehicle rules to check against at all', () => {
  // Guards the two tests below from passing vacuously if the import ever stops
  // resolving or the rules move file.
  assert.ok(vehicleRules.length >= 6, `only ${vehicleRules.length} vehicle rules found`)
  assert.ok(VEHICLE_ANCHORS.length >= 6)
})

test('every date the vehicles screen collects is a date some rule reads', () => {
  for (const anchor of VEHICLE_ANCHORS) {
    for (const kind of anchor.kinds) {
      const moved = vehicleRules
        .filter((r) => subjectOf(r) === kind)
        .filter(
          (r) =>
            JSON.stringify(nextDue(r, ctx({}))) !==
            JSON.stringify(nextDue(r, ctx({ [anchor.key]: SOME_DATE }))),
        )

      assert.ok(
        moved.length > 0,
        `anchor '${anchor.key}' changes nothing for a ${kind}. Either the key is misspelled in ` +
          'src/lib/vehicles.ts, or the rule that used it is gone and the screen is still asking ' +
          'the owner for a date nobody wants.',
      )
    }
  }
})

test('every anchor a vehicle rule declares is a date the screen asks for', () => {
  for (const rule of vehicleRules) {
    if (!('anchor' in rule.recurrence)) continue
    const key = rule.recurrence.anchor
    const kind = subjectOf(rule)

    assert.ok(
      anchorsForKind(kind).some((a) => a.key === key),
      `rule '${rule.code}' needs anchor '${key}' for a ${kind}, and no field on the vehicles ` +
        'screen collects it. That rule can only ever report missing_data.',
    )
  }
})
