/**
 * The registry has to answer for every question the engine can ask.
 *
 * `Status.answerKey` is a plain string, and the screen that renders a date box
 * looks its words up by that string. A key with no entry is not a crash: it is a
 * date input with no question above it, or a row silently dropped from a list
 * whose entire promise to the owner is that it gets shorter. Nothing logs, and
 * the count on the dashboard simply never reaches zero.
 *
 * So the coverage test below does not compare two catalogues — it RUNS the
 * engine, across every subject, with the contexts that switch each applicability
 * gate on and with the anchors both empty and filled, and demands an entry for
 * whatever comes back. Comparing lists would miss the anchors a `computed` rule
 * reads straight out of `ctx.anchors` without declaring them on the rule row,
 * which is how CTC-VIS, Form 2290 and every one-time driver schedule work.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import {
  ANCHORS,
  type AnchorKind,
  answerLink,
  resolveAnchor,
  UNWRITABLE_ANCHOR_KEYS,
} from '../src/lib/rules/anchors.ts'
import { DRIVER_ANCHORS } from '../src/lib/rules/driver-anchors.ts'
import { allRules, type EvaluationSubject, evaluate } from '../src/lib/rules/index.ts'
import type { RuleContext, Subject } from '../src/lib/rules/types.ts'
import { VEHICLE_ANCHORS } from '../src/lib/vehicles.ts'

const TODAY = new Date(Date.UTC(2026, 8, 15))
/** Any past date. What matters is that supplying one changes the answer. */
const SOME_DATE = new Date(Date.UTC(2024, 2, 10))

const SUBJECTS: readonly Subject[] = [
  'carrier',
  'driver',
  'employee',
  'power_unit',
  'trailer',
  'terminal',
]

/**
 * Contexts chosen to open every `applies` gate in the catalogue.
 *
 * An empty context is not enough on its own. `refinement` in federal-driver.ts
 * answers `false` for an ordinary driver, so the SPE row — and with it the
 * `spe_certificate_expiry` key — never reaches `evaluate` unless the boolean
 * fact is set. Both intrastate and interstate appear because `ca_mcp_renewal` is
 * `not_applicable` for an interstate carrier and would take `mcp_issued` with it.
 */
const CONTEXTS: readonly Omit<RuleContext, 'today'>[] = [
  {},
  { carrierOperation: 'A', cdl: true, hazmat: true, gvwrLbs: 80_000, dotNumber: '1234567' },
  { carrierOperation: 'B', cdl: true, hazmat: true, gvwrLbs: 80_000, dotNumber: '1234567' },
  {
    carrierOperation: 'A',
    cdl: true,
    hazmat: true,
    gvwrLbs: 80_000,
    dotNumber: '1234567',
    insulinTreated: true,
    intracityZoneOnly: true,
    alternativeVisionStandard: true,
    holdsSpeCertificate: true,
    isReasonableSuspicionSupervisor: true,
  },
]

/**
 * Every anchor name any rule mentions, filled in with a real date.
 *
 * Filling them is what reaches the OTHER kind of `unknown`: once a schedule can
 * be computed, `status` asks whether the obligation was ever satisfied, and that
 * fact has no anchor of its own — it answers with the rule's own code. Half the
 * keys in this test only appear on this pass.
 */
function filledAnchors(): Record<string, Date> {
  const keys = new Set<string>()
  for (const rule of allRules) {
    if ('anchor' in rule.recurrence) keys.add(rule.recurrence.anchor)
  }
  // Anchors read inside `computed` schedules, which no rule row declares and
  // which therefore cannot be discovered from the catalogue at all.
  for (const extra of [
    'hire_date',
    'supervisor_designated_date',
    'spe_certificate_expiry',
    'return_to_duty_test_date',
    'ctc_vis_reportable_event',
    'accident_date',
    'periodic_inspection_date',
    'hvut_first_use_date',
  ]) {
    keys.add(extra)
  }
  const out: Record<string, Date> = {}
  for (const k of keys) out[k] = SOME_DATE
  return out
}

/** Every `answerKey` the engine can hand a page, by running the engine. */
function everyAnswerKey(): Set<string> {
  const filled = filledAnchors()
  const keys = new Set<string>()
  for (const type of SUBJECTS) {
    for (const context of CONTEXTS) {
      for (const anchors of [{}, filled]) {
        const subject: EvaluationSubject = { type, id: 'subject-1', label: 'X', context, anchors }
        for (const item of evaluate([subject], TODAY)) {
          if (item.status.answerKey) keys.add(item.status.answerKey)
        }
      }
    }
  }
  return keys
}

/**
 * The `anchor_kinds` rows, read out of the migrations rather than typed here.
 *
 * Hardcoding the list is how the two drift: 0012 added `cdl_expires` six
 * migrations after 0006 seeded the table, and a copy made at 0006 would still
 * look right. Files are read in name order so a later `on conflict do update`
 * wins, exactly as it does when the migrations run.
 */
function registeredKinds(): Map<string, AnchorKind> {
  const dir = new URL('../supabase/migrations/', import.meta.url)
  const out = new Map<string, AnchorKind>()
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue
    const sql = readFileSync(new URL(file, dir), 'utf8')
    for (const statement of sql.split(';')) {
      if (!/insert\s+into\s+anchor_kinds/i.test(statement)) continue
      const tuples = statement.matchAll(/\(\s*'([a-z0-9_]+)'\s*,\s*'(occurrence|statement)'\s*\)/gi)
      for (const [, key, kind] of tuples) {
        out.set(key, kind.toLowerCase() === 'statement' ? 'expires' : 'last_done')
      }
    }
  }
  return out
}

describe('anchor registry', () => {
  // FAILURE PINNED: a key the engine emits that the registry cannot name, which
  // renders to the owner as a date box with no question above it — or as a row
  // quietly missing from a list that is supposed to get shorter as he answers.
  test('resolves every answerKey the engine can produce, for every subject', () => {
    const keys = everyAnswerKey()

    // Guards the assertion below from passing vacuously if `evaluate` ever stops
    // returning `answerKey`, or an import silently resolves to an empty module.
    assert.ok(keys.size >= 40, `only ${keys.size} answer keys came out of the engine`)
    const codes = new Set(allRules.map((r) => r.code))
    assert.ok(
      [...keys].some((k) => codes.has(k)),
      'no rule-code key: the "never done" branch',
    )
    assert.ok(
      [...keys].some((k) => !codes.has(k)),
      'no anchor key: the missing_data branch',
    )

    const orphans = [...keys].filter((k) => resolveAnchor(k) === undefined).sort()
    assert.deepEqual(
      orphans,
      [],
      `the engine can ask for ${orphans.length} key(s) the registry cannot name: ${orphans.join(', ')}`,
    )
  })

  // FAILURE PINNED: the registry and the database disagreeing about which
  // question an anchor answers. `current_compliance_anchors` picks the latest
  // STATEMENT for an expiry and the latest OCCURRENCE otherwise, so a mismatch
  // means a correction the owner types is accepted, stored, and then ignored by
  // the view — the typo stays on screen however many times he retypes it.
  test('kind agrees with the anchor_kinds table for every key listed there', () => {
    const registered = registeredKinds()
    assert.ok(registered.size >= 2, 'no anchor_kinds rows parsed out of supabase/migrations')

    for (const [key, kind] of registered) {
      const entry = resolveAnchor(key)
      assert.ok(entry, `anchor_kinds lists '${key}' and the registry has no entry for it`)
      assert.equal(
        entry.kind,
        kind,
        `'${key}' is '${kind}' in anchor_kinds and '${entry.kind}' in the registry — ` +
          'corrections to it will be stored and then silently ignored',
      )
    }
  })

  // FAILURE PINNED: the restatement drifting from the original. These sentences
  // were written deliberately — several carry a reason in a comment beside them
  // — and until DRIVER_ANCHORS is rewired to derive from the registry there are
  // two copies of each. A page reading the registry and a page reading
  // DRIVER_ANCHORS would then ask the same question two different ways.
  test('every driver anchor still matches DRIVER_ANCHORS word for word', () => {
    assert.ok(DRIVER_ANCHORS.length >= 12, 'DRIVER_ANCHORS did not load')
    for (const original of DRIVER_ANCHORS) {
      const entry = resolveAnchor(original.key)
      assert.ok(entry, `driver anchor '${original.key}' is missing from the registry`)
      assert.equal(entry.label, original.label, `label drifted for '${original.key}'`)
      assert.equal(entry.help, original.help, `help drifted for '${original.key}'`)
      assert.equal(entry.kind, original.kind, `kind drifted for '${original.key}'`)
      assert.equal(entry.expected, original.expected, `expected drifted for '${original.key}'`)
    }
  })

  // FAILURE PINNED: a vehicle date offered as an expiry. VEHICLE_ANCHORS has no
  // `kind` field and states the invariant in prose instead — "every one of these
  // names an event that has ALREADY HAPPENED". An `expires` here would drop the
  // `max={today}` from the input, and a future date makes compute.ts step past
  // the inspection the owner just reported and answer with the one after.
  test('every vehicle anchor is last_done', () => {
    assert.ok(VEHICLE_ANCHORS.length >= 6, 'VEHICLE_ANCHORS did not load')
    for (const original of VEHICLE_ANCHORS) {
      const entry = resolveAnchor(original.key)
      assert.ok(entry, `vehicle anchor '${original.key}' is missing from the registry`)
      assert.equal(
        entry.kind,
        'last_done',
        `'${original.key}' names an event that has already happened and must be last_done`,
      )
    }
  })

  // FAILURE PINNED: the same drift as the driver test, for the other catalogue.
  test('every vehicle anchor still matches VEHICLE_ANCHORS word for word', () => {
    for (const original of VEHICLE_ANCHORS) {
      const entry = resolveAnchor(original.key)
      assert.ok(entry, `vehicle anchor '${original.key}' is missing from the registry`)
      assert.equal(entry.label, original.label, `label drifted for '${original.key}'`)
      assert.equal(entry.help, original.help, `help drifted for '${original.key}'`)
    }
  })

  // FAILURE PINNED: the worst bug this feature could ship. `hire_date` and
  // `cdl_expires` are column-backed, and deadlines.ts projects them with
  // `if (a[anchorKey]) continue` — a compliance record SILENTLY OUTRANKS the
  // column, so a typo typed into a date box here would permanently override a
  // correct hire date while the driver's own page went on showing the right one.
  // `dot_number` is not a date at all and is read from `ctx.dotNumber`, so a
  // record under that key does nothing and the row can never clear.
  test('the three column-backed keys are unwritable and say where to go instead', () => {
    assert.deepEqual(
      [...UNWRITABLE_ANCHOR_KEYS].sort(),
      ['cdl_expires', 'dot_number', 'hire_date'],
      'the deny-list is exactly these three keys',
    )

    for (const key of ['hire_date', 'cdl_expires', 'dot_number']) {
      const entry = resolveAnchor(key)
      assert.ok(entry, `'${key}' must be IN the registry, not merely skipped`)
      assert.equal(entry.writable, false, `'${key}' must never be rendered as a date input`)

      const elsewhere = entry.answeredElsewhere
      assert.ok(elsewhere, `'${key}' is unwritable and does not say where the real answer lives`)
      assert.ok(elsewhere.where.length > 0, `'${key}' has no words for the link`)
      assert.ok(elsewhere.source.length > 0, `'${key}' does not name the column that feeds it`)
      assert.ok(elsewhere.href.startsWith('/'), `'${key}' has no path to link to`)
    }

    // The substitution lives in one place on purpose: a page that builds the
    // link itself is a page that can ship '/app/drivers/:id' to a real user.
    const hire = resolveAnchor('hire_date')
    assert.ok(hire)
    assert.equal(answerLink(hire, 'abc'), '/app/drivers/abc')
    assert.equal(answerLink(hire, null), null, 'no id means no link, not a broken one')

    const dot = resolveAnchor('dot_number')
    assert.ok(dot)
    assert.equal(answerLink(dot, null), '/app/settings', 'the carrier link needs no subject id')

    // Everything else is answerable here, and must not carry a dead end.
    for (const entry of ANCHORS) {
      if (entry.writable) {
        assert.equal(entry.answeredElsewhere, undefined, `'${entry.key}' is both writable and not`)
      }
    }
  })

  // FAILURE PINNED: a date box rendered with no question, or with a heading and
  // no sentence under it. The whole reason this file exists is that neither
  // failure throws — both just quietly ask the owner for something he cannot
  // identify, and the row stays on his list.
  test('no entry has an empty label or help', () => {
    const entries = [...ANCHORS]
    for (const key of everyAnswerKey()) {
      const entry = resolveAnchor(key)
      if (entry) entries.push(entry)
    }
    for (const entry of entries) {
      assert.ok(entry.label.trim().length > 0, `'${entry.key}' has no label`)
      assert.ok(entry.help.trim().length > 0, `'${entry.key}' has no help sentence`)
    }
  })

  // FAILURE PINNED: a rule code colliding with an anchor key. `resolveAnchor`
  // tries the hand-written entries first and falls back to the catalogue, so a
  // collision would silently shadow one of them — and which one you lost would
  // depend on which side of the fallback it landed.
  test('no rule code is also a hand-written anchor key', () => {
    const written = new Set(ANCHORS.map((a) => a.key))
    const clashes = allRules.filter((r) => written.has(r.code)).map((r) => r.code)
    assert.deepEqual(clashes, [], `rule code(s) shadowed by a hand-written anchor: ${clashes}`)
  })
})
