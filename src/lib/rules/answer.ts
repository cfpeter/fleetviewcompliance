/**
 * Where a date typed by the owner actually goes, and which way it points.
 *
 * Both facts already existed in this codebase, and both were spread across
 * files that do not import each other — which is how a date can be stored
 * perfectly and still leave the rule reporting "we need a date from you"
 * forever, with nothing on screen looking broken.
 *
 * `evaluate()` in ./index.ts resolves a rule's completion as
 * `anchors[recurrence.anchor]` when the recurrence names an anchor, and
 * `anchors[rule.code]` when it does not — a `computed` or `fixed_calendar`
 * schedule comes from an algorithm, so there is no anchor name to fall back on
 * and the completion is filed under the rule's own code. That ternary was
 * written once, inside the loop, and any screen that wants to WRITE such a date
 * had to reproduce it from memory. `answerKeyFor` is that same decision, named,
 * so the read path and the write path cannot drift.
 *
 * The direction is the other half. compute.ts walks a rolling or anniversary
 * schedule forward from the anchor until it passes today, so a date in the
 * future there makes it step straight past the occurrence the owner just told
 * us about and answer with the one after — the deadline moves LATER, which is
 * the single direction this domain refuses to be wrong in. An `expiry` anchor
 * is the exact opposite: it is read off the face of a document and is supposed
 * to be ahead of us.
 */
import type { RuleDefinition } from './types.ts'

/**
 * The `compliance_records.anchor_key` a date for this rule is recorded under.
 *
 * Not a formatting choice — it is the join between the form and the engine, and
 * nothing checks that the two agree. See the header of ./driver-anchors.ts for
 * what a mismatch looks like from the office manager's chair.
 */
export function answerKeyFor(rule: RuleDefinition): string {
  return 'anchor' in rule.recurrence ? rule.recurrence.anchor : rule.code
}

/**
 * Which way the date points.
 *
 * Derived from the recurrence rather than looked up in a catalogue, because the
 * catalogues are incomplete: `DRIVER_ANCHORS` covers twelve driver anchors,
 * `VEHICLE_ANCHORS` six vehicle ones, and there is no carrier catalogue at all —
 * so every carrier-level date in the product would have no direction to take
 * its `min`/`max` from. The recurrence is present on every rule by definition.
 *
 * A test asserts this agrees with the `kind` on every anchor that IS in a
 * catalogue, so the derivation cannot quietly diverge from the hand-written one.
 */
export type AnswerDirection = 'expires' | 'last_done'

export function answerDirectionFor(rule: RuleDefinition): AnswerDirection {
  return rule.recurrence.type === 'expiry' ? 'expires' : 'last_done'
}
