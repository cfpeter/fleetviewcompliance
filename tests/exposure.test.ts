/**
 * The total, and the four ways it lies.
 *
 * This is the first number in the product that is about the owner's money, and
 * it is the easiest one to get wrong in his favour — which is the only
 * direction that matters. Each test below pins one of the four:
 *
 *   1. counting a driver's penalty as the carrier's
 *   2. multiplying a daily amount by the days elapsed, so the figure grows
 *      overnight on a row nobody touched
 *   3. counting a date that has not arrived yet
 *   4. reporting "no figure" as zero, which renders as "nothing at stake" over
 *      a fleet whose drivers cannot legally drive
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type ExposureInput, exposure } from '../src/lib/rules/exposure.ts'
import { allRules } from '../src/lib/rules/index.ts'
import {
  CLEARINGHOUSE,
  PART382_DRIVER,
  PART382_EMPLOYER,
  type Penalty,
  RECORDKEEPING,
} from '../src/lib/rules/penalties.ts'

const overdue = (...penalty: Penalty[]): ExposureInput => ({
  standing: 'overdue',
  penalty,
})

describe('penalty exposure', () => {
  test('sums the carrier maximums of the rows that carry one', () => {
    const e = exposure([overdue(CLEARINGHOUSE), overdue(PART382_EMPLOYER)])
    assert.equal(e.ceilingCents, CLEARINGHOUSE.maxCents + PART382_EMPLOYER.maxCents)
    assert.equal(e.counted, 2)
    assert.equal(e.unpriced, 0)
  })

  // FAILURE PINNED: billing the owner for the driver's penalty. Appendix B sets
  // $19,246 at (a)(3) for the employer and $4,812 at (a)(4) for the driver for
  // the same subject matter, and only one of them is his.
  test('never counts a penalty somebody else pays', () => {
    const e = exposure([{ standing: 'overdue', penalty: [PART382_DRIVER] }])
    assert.equal(e.ceilingCents, 0, "the driver's money is not the carrier's exposure")
    assert.equal(e.counted, 0)
    assert.equal(e.unpriced, 1, 'and a row we cannot price for HIM is unpriced, not free')

    // Both sides on one rule: his side only, and it is the larger.
    const both = exposure([overdue(PART382_EMPLOYER, PART382_DRIVER)])
    assert.equal(both.ceilingCents, PART382_EMPLOYER.maxCents)
    assert.equal(both.counted, 1)
  })

  // FAILURE PINNED: a figure that grows every night. $1,584 a day × 400 days
  // overdue is $633,600 and is not a number Appendix B supports — (a)(1) caps
  // at $15,846, and the cap is the ceiling.
  test('a daily amount contributes its cap, not its daily rate', () => {
    const e = exposure([overdue(RECORDKEEPING)])
    assert.equal(e.ceilingCents, RECORDKEEPING.capCents)
    assert.ok(
      RECORDKEEPING.capCents && RECORDKEEPING.capCents > RECORDKEEPING.maxCents,
      'the fixture is only meaningful while the cap exceeds one day',
    )
  })

  // FAILURE PINNED: a price on a deadline he still has time to meet, which
  // turns a reminder into a threat.
  test('only overdue and unknown are at risk', () => {
    const rows: ExposureInput[] = [
      { standing: 'current', penalty: [PART382_EMPLOYER] },
      { standing: 'not_applicable', penalty: [PART382_EMPLOYER] },
      { standing: 'unsupported', penalty: [PART382_EMPLOYER] },
    ]
    const e = exposure(rows)
    assert.equal(e.ceilingCents, 0)
    assert.equal(e.counted, 0)
    assert.equal(e.unpriced, 0, 'a row that is not at risk is not unpriced either — it is absent')
  })

  // A date nobody has typed carries the same exposure as one that expired. It
  // counts, or a fleet that has answered nothing looks cheaper than one that
  // answered everything badly.
  test('a missing date counts the same as an expired one', () => {
    const missing = exposure([{ standing: 'unknown', penalty: [CLEARINGHOUSE] }])
    const expired = exposure([{ standing: 'overdue', penalty: [CLEARINGHOUSE] }])
    assert.deepEqual(missing, expired)
  })

  // FAILURE PINNED, AND IT IS THE WORST ONE. A fleet in real trouble whose
  // overdue rows happen to carry no dollar figure must not report $0 with
  // nothing beside it. This is not hypothetical: it is the resting state of the
  // first carrier this ran against — two expired medical cards, an expired CDL,
  // and not one amount between them.
  test('rows with no amount are reported, never treated as free', () => {
    const e = exposure([
      { standing: 'overdue' },
      { standing: 'overdue', penalty: [] },
      { standing: 'unknown' },
    ])
    assert.equal(e.ceilingCents, 0)
    assert.equal(e.counted, 0)
    assert.equal(e.unpriced, 3, 'three rows at risk and nothing to price them with')
  })

  test('an empty fleet is zero of everything, not a crash', () => {
    assert.deepEqual(exposure([]), { ceilingCents: 0, counted: 0, unpriced: 0 })
  })

  // Run against the REAL catalogue rather than fixtures, because the thing most
  // likely to break this is not the arithmetic — it is somebody attaching a
  // driver-side amount to a rule, or the penalty wiring coming loose entirely.
  test('the real catalogue still produces a carrier ceiling above zero', () => {
    const rows: ExposureInput[] = allRules.map((r) => ({
      standing: 'overdue',
      penalty: r.penalty,
    }))
    const e = exposure(rows)

    assert.ok(e.counted >= 15, `only ${e.counted} rules priced — the wiring has come loose`)
    assert.ok(e.ceilingCents > 0, 'the whole catalogue prices at nothing')
    assert.ok(
      e.unpriced > e.counted,
      'most of this catalogue has no line-item penalty; if that has flipped, amounts are ' +
        'being attached to rules the research does not cover',
    )
  })
})
