/**
 * Driver settlements.
 *
 * Two halves, and they test two different kinds of failure.
 *
 * The arithmetic half is pure and needs no database. Every case in it pins down
 * a SILENT error — a half-cent CPM rounded away, a percentage taken of the wrong
 * pot, a deduction that adds instead of subtracts. None of these throw; they all
 * produce a plausible number on a document handed to a person who is going to
 * check it against his own notebook.
 *
 * The database half proves the refusals. A per-mile rate with no mileage basis
 * and a percentage with no stated scope are the two disputes this whole module
 * exists to prevent, and "the form asks for it" is not the same promise as "the
 * column cannot hold it". Same for the lock: a paid settlement that is still
 * editable is the bug, and the only proof is trying.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  activeOn,
  agreementsInForce,
  bpToInput,
  categoryOfKind,
  computeEarning,
  computeEarnings,
  divRound,
  flatCents,
  formatPercentBp,
  formatQuantity,
  formatRateMills,
  hourlyCents,
  isLocked,
  milliToInput,
  millsToInput,
  missingTerms,
  type PayAgreement,
  parsePercentToBp,
  parseQuantityToMilli,
  parseRateToMills,
  percentageBasis,
  percentageCents,
  perMileCents,
  settlementTotals,
  signedAmount,
  termsSummary,
} from '../src/lib/settlements/compute.ts'
import {
  actAs,
  actAsOwner,
  attempt,
  configured,
  makeUser,
  queryAsOwner,
  withRollback,
} from './helpers.ts'

/**
 * Unwraps a Parsed<T>, failing the test with the parser's own sentence.
 *
 * assert.fail returns `never`, which is what narrows `r` to the success branch
 * for the return below — an `assert.equal(r.ok, true)` first would read more
 * naturally and throws away the message the parser went to the trouble of
 * writing.
 */
const ok = <T>(r: { ok: true; value: T } | { ok: false; message: string }): T => {
  if (!r.ok) assert.fail(r.message)
  return r.value
}

// ---------------------------------------------------------------- rounding

describe('integer rounding', () => {
  it('rounds halves away from zero in BOTH directions', () => {
    // Math.round is the wrong tool: it rounds toward positive infinity, so
    // Math.round(2.5) is 3 and Math.round(-2.5) is -2. A charge and its
    // identical charge-back would then fail to cancel, and one cent would
    // appear on a statement from nowhere.
    assert.equal(divRound(5, 2), 3)
    assert.equal(divRound(-5, 2), -3, 'the half must go the same distance both ways')
    assert.equal(divRound(4, 2), 2)
    assert.equal(divRound(-4, 2), -2)
    assert.equal(divRound(1, 3), 0)
    assert.equal(divRound(2, 3), 1)
    assert.equal(divRound(0, 7), 0)
  })

  it('refuses a denominator that cannot round', () => {
    assert.throws(() => divRound(10, 0))
  })
})

// ---------------------------------------------------------------- per mile

describe('per-mile pay', () => {
  it('is miles times rate, exactly', () => {
    // 1,000 miles at $0.58 = $580.00
    assert.equal(perMileCents(1_000_000, 580), 58_000)
    // 2,500 miles at $0.62 = $1,550.00
    assert.equal(perMileCents(2_500_000, 620), 155_000)
  })

  it('keeps the half cent that cents alone cannot hold', () => {
    // THE WHOLE REASON THE RATE IS IN MILLS. Real CPM is negotiated in
    // half-cents. 2,500 miles at $0.585 is $1,462.50; at a rate rounded to
    // $0.58 it is $1,450.00 — $12.50 a week, every week, and the driver's own
    // arithmetic is the one that is right.
    assert.equal(perMileCents(2_500_000, 585), 146_250)
    assert.notEqual(perMileCents(2_500_000, 585), perMileCents(2_500_000, 580))
  })

  it('survives a fractional mileage figure', () => {
    // 1,247.5 miles at $0.60 = $748.50
    assert.equal(perMileCents(1_247_500, 600), 74_850)
  })

  it('never loses a cent to floating point', () => {
    // Every one of these is a product that a float multiply gets wrong or
    // nearly wrong. A settlement is a sum of dozens of them.
    for (const [milesMilli, mills, expected] of [
      [1_003_000, 585, 58_676], // 1003 x 0.585 = 586.755 -> 586.76
      [1_001_000, 585, 58_559], // 1001 x 0.585 = 585.585 -> 585.59
      [333_000, 585, 19_481], // 333 x 0.585 = 194.805 -> 194.81
      [1_234_567, 587, 72_469], // exercises the full width of both units
    ] as const) {
      assert.equal(perMileCents(milesMilli, mills), expected, `${milesMilli} x ${mills}`)
    }
  })
})

// ---------------------------------------------------------------- percentage

describe('percentage pay and the percentage-of-WHAT problem', () => {
  // One load, the shape a rate confirmation actually arrives in.
  const load = {
    linehaulCents: 200_000, // $2,000.00
    fuelSurchargeCents: 40_000, // $400.00
    accessorialsCents: 15_000, // $150.00 lumper
  }

  it('is three different cheques on one load, which is the whole problem', () => {
    // "70% of the load" — same words, same load, $385 apart. This is the single
    // most common settlement dispute in the segment, and it is argued about six
    // weeks later when neither party remembers the phone call.
    const linehaulOnly = percentageBasis(load, {
      includesFuelSurcharge: false,
      includesAccessorials: false,
    })
    const withFuel = percentageBasis(load, {
      includesFuelSurcharge: true,
      includesAccessorials: false,
    })
    const everything = percentageBasis(load, {
      includesFuelSurcharge: true,
      includesAccessorials: true,
    })

    assert.equal(percentageCents(linehaulOnly.basisCents, 7000), 140_000) // $1,400.00
    assert.equal(percentageCents(withFuel.basisCents, 7000), 168_000) // $1,680.00
    assert.equal(percentageCents(everything.basisCents, 7000), 178_500) // $1,785.00

    assert.equal(
      percentageCents(everything.basisCents, 7000) - percentageCents(linehaulOnly.basisCents, 7000),
      38_500,
      '$385 of spread on one load, decided entirely by a flag nobody set',
    )
  })

  it('always includes linehaul, and names what it included', () => {
    // A percentage that excluded linehaul would be a percentage of nothing.
    const b = percentageBasis(load, { includesFuelSurcharge: true, includesAccessorials: false })
    assert.deepEqual(b.parts, ['Linehaul', 'Fuel surcharge'])
    assert.equal(b.basisCents, 240_000)
  })

  it('treats a missing surcharge on an included load as zero, not as unknown', () => {
    // A load genuinely without a fuel surcharge adds nothing. That is different
    // from a load nobody priced — see the refusal test below.
    const b = percentageBasis(
      { linehaulCents: 200_000, fuelSurchargeCents: null, accessorialsCents: null },
      { includesFuelSurcharge: true, includesAccessorials: true },
    )
    assert.equal(b.basisCents, 200_000)
  })

  it('handles a fractional percentage', () => {
    // 67.5% of $2,000.00 = $1,350.00. Lease agreements really do say this.
    assert.equal(percentageCents(200_000, 6750), 135_000)
    // 68.33% of $1,847.19 is 1,262.184927 -> $1,262.18, and the .4927 is
    // dropped rather than carried. A float multiply of these two lands on
    // 1262.1849270000002, which is the kind of tail that turns into a rogue
    // cent once somebody rounds it twice.
    assert.equal(percentageCents(184_719, 6833), 126_218)
  })
})

// ---------------------------------------------------------------- hourly/flat

describe('hourly and flat pay', () => {
  it('pays part hours without rounding them to whole ones', () => {
    // 7.5 h at $28.50 = $213.75. A driver on drayage bills in quarter hours and
    // a parser that only took whole hours would lose 45 minutes a day.
    assert.equal(hourlyCents(7_500, 2_850), 21_375)
    assert.equal(hourlyCents(7_250, 2_850), 20_663) // 7.25 x 28.50 = 206.625 -> 206.63
  })

  it('pays a flat figure per trip or per stop', () => {
    assert.equal(flatCents(3_000, 2_500), 7_500, 'three stops at $25.00')
    assert.equal(flatCents(1_000, 45_000), 45_000, 'one dedicated run at $450.00')
  })
})

// ---------------------------------------------------------------- agreements

const perMile: PayAgreement = {
  id: 'a1',
  label: 'Linehaul',
  method: 'per_mile',
  rateMills: 585,
  mileageBasis: 'practical',
}

const stopPay: PayAgreement = {
  id: 'a2',
  label: 'Stop pay',
  method: 'flat_per_trip',
  rateCents: 2_500,
}

describe('applying an agreement', () => {
  it('records the mileage basis on the line, not just on the agreement', () => {
    const out = computeEarning(perMile, { milesMilli: 2_500_000 })
    assert.equal(out.kind, 'computed')
    if (out.kind !== 'computed') return
    assert.equal(out.line.amountCents, 146_250)
    assert.equal(out.line.mileageBasis, 'practical')
    assert.equal(out.line.rateMills, 585)
    assert.equal(out.line.quantityMilli, 2_500_000)
    // The agreement WILL be edited — the CPM goes up in April. If the line read
    // its terms back through the agreement, March's statement would silently
    // start claiming it paid the April rate.
    assert.match(out.line.description, /practical miles/)
    assert.match(out.line.description, /\$0\.585\/mi/)
  })

  it('REFUSES a per-mile rate with no mileage basis instead of defaulting one', () => {
    // Defaulting to 'practical' here would be the unlabelled CPM wearing a
    // label somebody else chose. The same run is 3–6% fewer miles on shortest,
    // which is ~$90 a week on a 2,500-mile driver.
    const out = computeEarning({ ...perMile, mileageBasis: null }, { milesMilli: 2_500_000 })
    assert.equal(out.kind, 'incomplete')
    if (out.kind !== 'incomplete') return
    assert.match(out.reason, /which miles/)
  })

  it('REFUSES a percentage that does not say what it is a percentage of', () => {
    const out = computeEarning(
      { label: 'Split', method: 'percentage', percentBp: 7000 },
      { load: { linehaulCents: 200_000, fuelSurchargeCents: 40_000, accessorialsCents: 0 } },
    )
    assert.equal(out.kind, 'incomplete')
    if (out.kind !== 'incomplete') return
    assert.match(out.reason, /fuel surcharge/)
  })

  it('REFUSES a percentage of a load nobody has priced', () => {
    // Not $0.00. "This run paid nothing" and "nobody has typed the rate yet"
    // are different facts and they go to different people.
    const out = computeEarning(
      {
        label: 'Split',
        method: 'percentage',
        percentBp: 7000,
        percentIncludesFuelSurcharge: true,
        percentIncludesAccessorials: false,
      },
      { load: { linehaulCents: null, fuelSurchargeCents: null, accessorialsCents: null } },
    )
    assert.equal(out.kind, 'incomplete')
  })

  it('snapshots both percentage flags onto the line', () => {
    const out = computeEarning(
      {
        label: 'Owner-operator split',
        method: 'percentage',
        percentBp: 6800,
        percentIncludesFuelSurcharge: true,
        percentIncludesAccessorials: false,
      },
      {
        load: { linehaulCents: 200_000, fuelSurchargeCents: 40_000, accessorialsCents: 15_000 },
      },
    )
    assert.equal(out.kind, 'computed')
    if (out.kind !== 'computed') return
    assert.equal(out.line.basisCents, 240_000, 'linehaul + FSC, accessorials left out')
    assert.equal(out.line.amountCents, 163_200) // 68% of $2,400.00
    assert.equal(out.line.percentIncludesFuelSurcharge, true)
    assert.equal(out.line.percentIncludesAccessorials, false)
    assert.match(out.line.description, /68% of linehaul \+ fuel surcharge/)
  })

  it('says "nothing to pay on" rather than producing a zero line', () => {
    assert.equal(computeEarning(perMile, { milesMilli: 0 }).kind, 'no_input')
    assert.equal(computeEarning(stopPay, {}).kind, 'no_input')
  })

  it('runs several agreements at once, which is the normal case', () => {
    // Per-mile on linehaul PLUS flat stop pay is what a real driver is on.
    // Modelling pay as one column on the driver cannot express it.
    const { lines, problems } = computeEarnings([perMile, stopPay], {
      milesMilli: 1_000_000,
      quantityMilli: 3_000,
    })
    assert.equal(lines.length, 2)
    assert.deepEqual(problems, [])
    assert.equal(lines[0].amountCents, 58_500) // 1000 mi x $0.585
    assert.equal(lines[1].amountCents, 7_500) // 3 stops x $25.00
  })

  it('reports an unusable agreement without dropping the usable ones', () => {
    const { lines, problems } = computeEarnings([{ ...perMile, mileageBasis: null }, stopPay], {
      milesMilli: 1_000_000,
      quantityMilli: 3_000,
    })
    assert.equal(lines.length, 1, 'the stop pay still computes')
    assert.equal(problems.length, 1, 'and the broken one is a sentence, not a silent zero')
  })
})

describe('agreements in force', () => {
  const dated: PayAgreement = { ...perMile, effectiveOn: '2026-03-01', endsOn: '2026-05-31' }

  it('is an inclusive window on both ends', () => {
    assert.equal(activeOn(dated, '2026-02-28'), false)
    assert.equal(activeOn(dated, '2026-03-01'), true)
    assert.equal(activeOn(dated, '2026-05-31'), true)
    assert.equal(activeOn(dated, '2026-06-01'), false)
  })

  it('treats an open end as still running', () => {
    assert.equal(activeOn({ ...perMile, effectiveOn: '2026-03-01' }, '2030-01-01'), true)
  })

  it('picks out only the ones running on the day', () => {
    const old = { ...perMile, id: 'old', rateMills: 560, endsOn: '2026-02-28' }
    const live = { ...perMile, id: 'live', effectiveOn: '2026-03-01' }
    const inForce = agreementsInForce([old, live, stopPay], '2026-03-15')
    assert.deepEqual(
      inForce.map((a) => a.id),
      ['live', 'a2'],
    )
  })
})

// ---------------------------------------------------------------- totals

describe('the statement total', () => {
  it('nets earnings, reimbursements, advances and deductions', () => {
    const t = settlementTotals([
      { category: 'earning', amountCents: 146_250 }, // linehaul
      { category: 'earning', amountCents: 7_500 }, // stop pay
      { category: 'earning', amountCents: 5_000 }, // detention
      { category: 'reimbursement', amountCents: 4_275 }, // tolls
      { category: 'reimbursement', amountCents: 1_200 }, // scales
      { category: 'advance', amountCents: -20_000 }, // cash advance
      { category: 'deduction', amountCents: -5_000 }, // escrow
      { category: 'deduction', amountCents: -12_500 }, // insurance
      { category: 'deduction', amountCents: -3_500 }, // ELD fee
    ])

    assert.equal(t.earningsCents, 158_750)
    assert.equal(t.reimbursementsCents, 5_475)
    assert.equal(t.advancesCents, -20_000)
    assert.equal(t.deductionsCents, -21_000)
    assert.equal(t.netCents, 123_225) // $1,232.25 on the cheque
  })

  it('is a plain sum, because the sign is in the data', () => {
    // The convention exists so no caller ever flips a sign. Every sign flip in
    // application code is a place one caller forgets, and a $250 deduction that
    // gets ADDED is a $500 error that looks plausible enough to reach the bank.
    const t = settlementTotals([
      { category: 'earning', amountCents: 100_000 },
      { category: 'deduction', amountCents: -25_000 },
    ])
    assert.equal(t.netCents, 75_000)
  })

  it('is zero for a settlement with no lines, not NaN', () => {
    assert.equal(settlementTotals([]).netCents, 0)
  })

  it('gives a deduction its sign no matter how it was typed', () => {
    // Nobody types "-250" into a deduction box, and a form that demanded it
    // would collect a positive number from somebody eventually.
    assert.equal(signedAmount('deduction', 25_000), -25_000)
    assert.equal(signedAmount('deduction', -25_000), -25_000, 'a typed minus must not pay him')
    assert.equal(signedAmount('advance', 20_000), -20_000)
    assert.equal(signedAmount('earning', 20_000), 20_000)
    assert.equal(signedAmount('reimbursement', 1_200), 1_200)
  })

  it('knows which category every line kind belongs to', () => {
    assert.equal(categoryOfKind('escrow'), 'deduction')
    assert.equal(categoryOfKind('lumper'), 'reimbursement')
    assert.equal(categoryOfKind('detention'), 'earning')
    assert.equal(categoryOfKind('advance'), 'advance')
    // An unknown kind is NULL, never a guess — a guess would file it as an
    // earning and pay it.
    assert.equal(categoryOfKind('nonsense'), null)
  })
})

// ---------------------------------------------------------------- locking

describe('what is locked', () => {
  it('locks paid and void, and deliberately does not lock approved', () => {
    assert.equal(isLocked('paid'), true)
    assert.equal(isLocked('void'), true)
    assert.equal(isLocked('draft'), false)
    // An owner who approves on Friday and finds a missing toll on Saturday must
    // be able to add it. Forcing a revision there trains people to leave
    // everything in draft, which defeats the lock entirely.
    assert.equal(isLocked('approved'), false)
    assert.equal(isLocked(null), false)
  })
})

// ---------------------------------------------------------------- parsing

describe('parsing the units cents cannot hold', () => {
  it('reads a per-mile rate into mills, keeping three decimals', () => {
    assert.equal(ok(parseRateToMills('0.58', { label: 'Rate' })), 580)
    assert.equal(ok(parseRateToMills('0.585', { label: 'Rate' })), 585)
    assert.equal(ok(parseRateToMills('.58', { label: 'Rate' })), 580, 'the missing zero')
    assert.equal(ok(parseRateToMills('$0.62', { label: 'Rate' })), 620, 'pasted with the sign')
    assert.equal(ok(parseRateToMills('1', { label: 'Rate' })), 1000, '$1.00 a mile')
    assert.equal(ok(parseRateToMills('', { label: 'Rate' })), null)
  })

  it('refuses a rate that is not one', () => {
    assert.equal(parseRateToMills('0.5851', { label: 'Rate' }).ok, false, 'four decimals')
    assert.equal(parseRateToMills('-0.58', { label: 'Rate' }).ok, false, 'no negative CPM')
    assert.equal(parseRateToMills('0', { label: 'Rate' }).ok, false, 'zero is an unfinished form')
    assert.equal(parseRateToMills('abc', { label: 'Rate' }).ok, false)
    assert.equal(parseRateToMills('580', { label: 'Rate' }).ok, false, '$580/mi is a typo')
  })

  it('reads a percentage into basis points', () => {
    assert.equal(ok(parsePercentToBp('68', { label: 'Share' })), 6800)
    assert.equal(ok(parsePercentToBp('67.5', { label: 'Share' })), 6750)
    assert.equal(ok(parsePercentToBp('68%', { label: 'Share' })), 6800, 'people type the sign')
    assert.equal(ok(parsePercentToBp('100', { label: 'Share' })), 10_000)
    assert.equal(ok(parsePercentToBp('', { label: 'Share' })), null)
  })

  it('refuses a percentage that would pay more than the load earned', () => {
    // '6800' meaning 68% is the typo, every time it appears.
    assert.equal(parsePercentToBp('6800', { label: 'Share' }).ok, false)
    assert.equal(parsePercentToBp('101', { label: 'Share' }).ok, false)
    assert.equal(parsePercentToBp('0', { label: 'Share' }).ok, false)
  })

  it('reads miles and hours into thousandths', () => {
    assert.equal(ok(parseQuantityToMilli('1250', { label: 'Miles' })), 1_250_000)
    assert.equal(ok(parseQuantityToMilli('1,250', { label: 'Miles' })), 1_250_000, 'typed comma')
    assert.equal(ok(parseQuantityToMilli('7.5', { label: 'Hours' })), 7_500)
    assert.equal(ok(parseQuantityToMilli('1247.5', { label: 'Miles' })), 1_247_500)
    assert.equal(ok(parseQuantityToMilli('', { label: 'Miles' })), null)
    assert.equal(parseQuantityToMilli('-5', { label: 'Miles' }).ok, false)
  })
})

// ---------------------------------------------------------------- formatting

describe('formatting', () => {
  it('prints a rate the way it was negotiated', () => {
    assert.equal(formatRateMills(580), '$0.58', 'a plain cent keeps two digits')
    assert.equal(formatRateMills(585), '$0.585', 'a half cent keeps its third')
    assert.equal(formatRateMills(1000), '$1.00')
    assert.equal(formatRateMills(null), '—')
  })

  it('prints a percentage without false precision', () => {
    assert.equal(formatPercentBp(6800), '68%')
    assert.equal(formatPercentBp(6750), '67.5%')
    assert.equal(formatPercentBp(6705), '67.05%')
  })

  it('prints a quantity without false precision', () => {
    assert.equal(formatQuantity(1_250_000), '1,250')
    assert.equal(formatQuantity(7_500), '7.5')
    assert.equal(formatQuantity(1_247_500), '1,247.5')
    assert.equal(formatQuantity(null), '—')
  })

  it('round-trips through the form inputs', () => {
    for (const mills of [580, 585, 1000, 62]) {
      assert.equal(ok(parseRateToMills(millsToInput(mills), { label: 'Rate' })), mills)
    }
    for (const bp of [6800, 6750, 6705, 10_000]) {
      assert.equal(ok(parsePercentToBp(bpToInput(bp), { label: 'Share' })), bp)
    }
    for (const milli of [1_250_000, 7_500, 1_247_500]) {
      assert.equal(ok(parseQuantityToMilli(milliToInput(milli), { label: 'Miles' })), milli)
    }
  })
})

describe('warning about an agreement that looks complete and is not', () => {
  it('flags a per-mile rate with no basis', () => {
    // It LOOKS finished — it has a rate, and a rate is what people check.
    assert.match(missingTerms({ ...perMile, mileageBasis: null }) ?? '', /mileage basis/)
    assert.equal(missingTerms(perMile), null)
  })

  it('flags a percentage with no stated scope', () => {
    assert.match(
      missingTerms({ label: 'Split', method: 'percentage', percentBp: 7000 }) ?? '',
      /what the percentage is of/,
    )
  })

  it('says nothing reassuring when a term is missing', () => {
    // termsSummary returns '' rather than "practical miles", which would be the
    // unlabelled CPM all over again, one layer up.
    assert.equal(termsSummary({ ...perMile, mileageBasis: null }), '')
    assert.equal(termsSummary(perMile), 'Practical miles')
  })
})

// ---------------------------------------------------------------------------
// The database half
// ---------------------------------------------------------------------------

if (!configured()) {
  console.error(
    '\n  ⚠  SKIPPING settlement database tests: no database configured.\n' +
      '     Until these run, the mileage-basis requirement and the paid-settlement\n' +
      '     lock are promises made only by a form.\n',
  )
}

type Client = Parameters<Parameters<typeof withRollback>[0]>[0]

/** One carrier, one driver, signed in as the owner of both. */
async function fixture(c: Client) {
  await actAsOwner(c)
  const userId = await makeUser(c, `settle-${Date.now()}-${Math.random()}@test.local`)
  await actAs(c, userId)
  const { rows } = await queryAsOwner(c, `select create_carrier($1, $2) as id`, [
    `${Math.floor(Math.random() * 9_000_000) + 1_000_000}`,
    'Settlement Test Carrier',
  ])
  const carrierId = rows[0].id as string
  const { rows: d } = await c.query(
    `insert into drivers (carrier_id, first_name, last_name)
     values ($1, 'Ana', 'Ruiz') returning id`,
    [carrierId],
  )
  return { userId, carrierId, driverId: d[0].id as string }
}

describe('the database refuses what the form must never collect', { skip: !configured() }, () => {
  it('will not store a per-mile rate with no mileage basis', async () => {
    await withRollback(async (c) => {
      const { carrierId, driverId } = await fixture(c)
      const err = await attempt(
        c,
        `insert into pay_agreements (carrier_id, driver_id, label, method, rate_mills)
         values ($1, $2, 'Linehaul', 'per_mile', 585)`,
        [carrierId, driverId],
      )
      assert.ok(err, 'an unlabelled CPM must not be storable')
      assert.match(String(err?.message), /basis_required/)
    })
  })

  it('will not store a mileage basis on an hourly agreement', async () => {
    await withRollback(async (c) => {
      const { carrierId, driverId } = await fixture(c)
      // The biconditional cuts both ways: a basis on an hourly agreement would
      // print on the statement and imply a mileage term that does not exist.
      const err = await attempt(
        c,
        `insert into pay_agreements (carrier_id, driver_id, label, method, rate_cents, mileage_basis)
         values ($1, $2, 'Yard', 'hourly', 2850, 'practical')`,
        [carrierId, driverId],
      )
      assert.ok(err)
    })
  })

  it('will not store a percentage that does not say what it is of', async () => {
    await withRollback(async (c) => {
      const { carrierId, driverId } = await fixture(c)
      const err = await attempt(
        c,
        `insert into pay_agreements (carrier_id, driver_id, label, method, percent_bp)
         values ($1, $2, 'Split', 'percentage', 6800)`,
        [carrierId, driverId],
      )
      assert.ok(err, 'the most common dispute in the segment must not be storable')
      assert.match(String(err?.message), /percent_scope_required/)

      // Half an answer is still refused: both flags or neither.
      const half = await attempt(
        c,
        `insert into pay_agreements
           (carrier_id, driver_id, label, method, percent_bp, percent_includes_fuel_surcharge)
         values ($1, $2, 'Split', 'percentage', 6800, true)`,
        [carrierId, driverId],
      )
      assert.ok(half)
    })
  })

  it('will not store a rate in the column belonging to a different method', async () => {
    await withRollback(async (c) => {
      const { carrierId, driverId } = await fixture(c)
      // 58 in rate_cents on a per_mile agreement is "$0.58" typed into the
      // hourly box — it would pay 58 cents an hour and look configured.
      const err = await attempt(
        c,
        `insert into pay_agreements (carrier_id, driver_id, label, method, rate_cents, mileage_basis)
         values ($1, $2, 'Linehaul', 'per_mile', 58, 'practical')`,
        [carrierId, driverId],
      )
      assert.ok(err)
    })
  })

  it('will not let a deduction be stored as a positive number', async () => {
    await withRollback(async (c) => {
      const { carrierId, driverId } = await fixture(c)
      const { rows: s } = await c.query(
        `insert into settlements (carrier_id, driver_id, period_start, period_end)
         values ($1, $2, '2026-03-01', '2026-03-07') returning id`,
        [carrierId, driverId],
      )
      const err = await attempt(
        c,
        `insert into settlement_lines (carrier_id, settlement_id, category, kind, amount_cents)
         values ($1, $2, 'deduction', 'escrow', 25000)`,
        [carrierId, s[0].id],
      )
      assert.ok(err, 'a positive escrow line would be ADDED to his pay')
      assert.match(String(err?.message), /sign_matches_category/)
    })
  })

  it('will not let a deduction be filed as an earning', async () => {
    await withRollback(async (c) => {
      const { carrierId, driverId } = await fixture(c)
      const { rows: s } = await c.query(
        `insert into settlements (carrier_id, driver_id, period_start, period_end)
         values ($1, $2, '2026-03-01', '2026-03-07') returning id`,
        [carrierId, driverId],
      )
      const err = await attempt(
        c,
        `insert into settlement_lines (carrier_id, settlement_id, category, kind, amount_cents)
         values ($1, $2, 'earning', 'escrow', 25000)`,
        [carrierId, s[0].id],
      )
      assert.ok(err)
      assert.match(String(err?.message), /kind_matches_category/)
    })
  })
})

describe('a paid settlement is locked', { skip: !configured() }, () => {
  /** A settlement with one line, taken all the way to paid. */
  async function paidSettlement(c: Client) {
    const f = await fixture(c)
    const { rows: s } = await c.query(
      `insert into settlements (carrier_id, driver_id, period_start, period_end)
       values ($1, $2, '2026-03-01', '2026-03-07') returning id`,
      [f.carrierId, f.driverId],
    )
    const settlementId = s[0].id as string
    await c.query(
      `insert into settlement_lines (carrier_id, settlement_id, category, kind, amount_cents)
       values ($1, $2, 'earning', 'linehaul', 146250)`,
      [f.carrierId, settlementId],
    )
    await c.query(
      `update settlements set status = 'paid', net_cents = 146250, paid_on = '2026-03-10'
        where id = $1`,
      [settlementId],
    )
    return { ...f, settlementId }
  }

  it('refuses an edit to the settlement itself', async () => {
    await withRollback(async (c) => {
      const { settlementId } = await paidSettlement(c)
      const err = await attempt(c, `update settlements set net_cents = 999 where id = $1`, [
        settlementId,
      ])
      assert.ok(err, 'the number on the cheque must not move after the cheque')
      assert.match(String(err?.message), /cannot be edited/)
    })
  })

  it('refuses a status change back out of paid', async () => {
    await withRollback(async (c) => {
      const { settlementId } = await paidSettlement(c)
      const err = await attempt(c, `update settlements set status = 'draft' where id = $1`, [
        settlementId,
      ])
      assert.ok(err, 'unlocking by re-opening would defeat the whole mechanism')
    })
  })

  it('refuses every change to its lines', async () => {
    await withRollback(async (c) => {
      const { carrierId, settlementId } = await paidSettlement(c)
      // Locking the header and leaving the lines writable would be no lock at
      // all: the frozen total would stay put while the lines moved underneath.
      const added = await attempt(
        c,
        `insert into settlement_lines (carrier_id, settlement_id, category, kind, amount_cents)
         values ($1, $2, 'deduction', 'escrow', -5000)`,
        [carrierId, settlementId],
      )
      assert.ok(added, 'no new lines')

      const changed = await attempt(
        c,
        `update settlement_lines set amount_cents = 1 where settlement_id = $1`,
        [settlementId],
      )
      assert.ok(changed, 'no edits')

      const removed = await attempt(c, `delete from settlement_lines where settlement_id = $1`, [
        settlementId,
      ])
      assert.ok(removed, 'no deletions')

      const { rows } = await c.query(
        `select amount_cents from settlement_lines where settlement_id = $1`,
        [settlementId],
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0].amount_cents, 146250, 'the statement is exactly as it was')
    })
  })

  it('still allows the one annotation a revision needs', async () => {
    await withRollback(async (c) => {
      const { carrierId, driverId, settlementId } = await paidSettlement(c)
      // The correction route: a NEW settlement at revision 2 supersedes the
      // paid one, and the paid one is annotated rather than altered. Same
      // allowance the append-only compliance_records trigger makes.
      const { rows: rev } = await c.query(
        `insert into settlements
           (carrier_id, driver_id, period_start, period_end, revision, supersedes_id)
         values ($1, $2, '2026-03-01', '2026-03-07', 2, $3) returning id, revision`,
        [carrierId, driverId, settlementId],
      )
      assert.equal(rev[0].revision, 2)

      const err = await attempt(c, `update settlements set superseded_at = now() where id = $1`, [
        settlementId,
      ])
      assert.equal(err, null, 'marking a locked statement as replaced is not an edit to it')

      const { rows } = await c.query(
        `select status, superseded_at from settlements where id = $1`,
        [settlementId],
      )
      assert.equal(rows[0].status, 'paid')
      assert.ok(rows[0].superseded_at)
    })
  })

  it('will not mark a settlement paid without the number that was paid', async () => {
    await withRollback(async (c) => {
      const { carrierId, driverId } = await fixture(c)
      const { rows: s } = await c.query(
        `insert into settlements (carrier_id, driver_id, period_start, period_end)
         values ($1, $2, '2026-03-01', '2026-03-07') returning id`,
        [carrierId, driverId],
      )
      const err = await attempt(c, `update settlements set status = 'paid' where id = $1`, [
        s[0].id,
      ])
      assert.ok(err, 'a paid statement with a blank cheque amount prints a blank')
    })
  })
})

describe('settlement rows cannot reach across carriers', { skip: !configured() }, () => {
  it("refuses a pay agreement on another carrier's driver", async () => {
    await withRollback(async (c) => {
      const mine = await fixture(c)
      const theirs = await fixture(c)
      // Back to my own session. RLS is satisfied — the row carries MY
      // carrier_id — and without the trigger this lands on their driver, where
      // RLS then hides it from me. I have written into their record and cannot
      // see what I did.
      await actAs(c, mine.userId)
      const err = await attempt(
        c,
        `insert into pay_agreements (carrier_id, driver_id, label, method, rate_mills, mileage_basis)
         values ($1, $2, 'Linehaul', 'per_mile', 585, 'practical')`,
        [mine.carrierId, theirs.driverId],
      )
      assert.ok(err)
      assert.match(String(err?.message), /does not belong to carrier/)
    })
  })

  it("refuses a line paying one driver at another driver's rate", async () => {
    await withRollback(async (c) => {
      const f = await fixture(c)
      const { rows: other } = await c.query(
        `insert into drivers (carrier_id, first_name, last_name)
         values ($1, 'Marco', 'Diaz') returning id`,
        [f.carrierId],
      )
      const { rows: agreement } = await c.query(
        `insert into pay_agreements (carrier_id, driver_id, label, method, rate_mills, mileage_basis)
         values ($1, $2, 'Linehaul', 'per_mile', 700, 'practical') returning id`,
        [f.carrierId, other[0].id],
      )
      const { rows: s } = await c.query(
        `insert into settlements (carrier_id, driver_id, period_start, period_end)
         values ($1, $2, '2026-03-01', '2026-03-07') returning id`,
        [f.carrierId, f.driverId],
      )
      // BOTH rows are inside one carrier, so no policy anywhere would catch
      // this. On screen it renders as an ordinary line at a rate that is simply
      // not his.
      const err = await attempt(
        c,
        `insert into settlement_lines
           (carrier_id, settlement_id, category, kind, amount_cents, pay_agreement_id,
            method, rate_mills, mileage_basis)
         values ($1, $2, 'earning', 'linehaul', 70000, $3, 'per_mile', 700, 'practical')`,
        [f.carrierId, s[0].id, agreement[0].id],
      )
      assert.ok(err)
      assert.match(String(err?.message), /different driver/)
    })
  })
})

describe('a week, end to end', { skip: !configured() }, () => {
  it('builds a statement the way the pages build one, and locks it', async () => {
    await withRollback(async (c) => {
      const { carrierId, driverId } = await fixture(c)

      // Two agreements at once, which is the normal case: per mile on the
      // linehaul, flat on the stops.
      const { rows: ag } = await c.query(
        `insert into pay_agreements
           (carrier_id, driver_id, label, method, rate_mills, mileage_basis, effective_on)
         values ($1, $2, 'Linehaul', 'per_mile', 585, 'practical', '2026-01-01')
         returning id`,
        [carrierId, driverId],
      )
      const { rows: stop } = await c.query(
        `insert into pay_agreements
           (carrier_id, driver_id, label, method, rate_cents, effective_on)
         values ($1, $2, 'Stop pay', 'flat_per_trip', 2500, '2026-01-01')
         returning id`,
        [carrierId, driverId],
      )

      const { rows: s } = await c.query(
        `insert into settlements (carrier_id, driver_id, period_start, period_end)
         values ($1, $2, '2026-03-02', '2026-03-08') returning id, revision`,
        [carrierId, driverId],
      )
      const settlementId = s[0].id as string

      // The two earning lines, computed exactly the way the page computes them,
      // and written with the same column names the page writes. A rename in the
      // schema that the page did not follow fails HERE rather than on a screen.
      const linehaul = computeEarning(
        {
          id: ag[0].id,
          label: 'Linehaul',
          method: 'per_mile',
          rateMills: 585,
          mileageBasis: 'practical',
        },
        { milesMilli: 2_487_000 },
      )
      assert.equal(linehaul.kind, 'computed')
      if (linehaul.kind !== 'computed') return

      const stops = computeEarning(
        { id: stop[0].id, label: 'Stop pay', method: 'flat_per_trip', rateCents: 2500 },
        { quantityMilli: 4_000 },
      )
      assert.equal(stops.kind, 'computed')
      if (stops.kind !== 'computed') return

      for (const line of [linehaul.line, stops.line]) {
        await c.query(
          `insert into settlement_lines
             (carrier_id, settlement_id, category, kind, description, amount_cents,
              pay_agreement_id, method, quantity_milli, rate_mills, percent_bp, rate_cents,
              basis_cents, mileage_basis, percent_includes_fuel_surcharge,
              percent_includes_accessorials)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [
            carrierId,
            settlementId,
            line.category,
            line.kind,
            line.description,
            line.amountCents,
            line.payAgreementId ?? null,
            line.method,
            line.quantityMilli,
            line.rateMills,
            line.percentBp,
            line.rateCents,
            line.basisCents,
            line.mileageBasis,
            line.percentIncludesFuelSurcharge,
            line.percentIncludesAccessorials,
          ],
        )
      }

      // A toll reimbursement, an advance he took on Wednesday, and the weekly
      // escrow. The last two are negated by signedAmount, which is the only
      // place in the codebase that decides a direction.
      for (const [category, kind, typed] of [
        ['reimbursement', 'toll', 4275],
        ['advance', 'advance', 20000],
        ['deduction', 'escrow', 5000],
      ] as const) {
        await c.query(
          `insert into settlement_lines
             (carrier_id, settlement_id, category, kind, amount_cents)
           values ($1, $2, $3, $4, $5)`,
          [carrierId, settlementId, category, kind, signedAmount(category, typed)],
        )
      }

      const { rows: stored } = await c.query(
        `select category, amount_cents, mileage_basis from settlement_lines
          where settlement_id = $1 order by created_at`,
        [settlementId],
      )
      assert.equal(stored.length, 5)
      // 2,487 mi x $0.585 = $1,454.895 -> $1,454.90
      assert.equal(stored[0].amount_cents, 145_490)
      assert.equal(stored[0].mileage_basis, 'practical', 'which miles, on the line itself')
      assert.equal(stored[1].amount_cents, 10_000, 'four stops at $25.00')

      const totals = settlementTotals(
        stored.map((r) => ({ category: r.category, amountCents: r.amount_cents })),
      )
      assert.equal(totals.earningsCents, 155_490)
      assert.equal(totals.reimbursementsCents, 4_275)
      assert.equal(totals.advancesCents, -20_000)
      assert.equal(totals.deductionsCents, -5_000)
      assert.equal(totals.netCents, 134_765) // $1,347.65 on the cheque

      // Approved does NOT lock: the toll receipt that turns up on Saturday has
      // to be addable without a formal revision.
      await c.query(`update settlements set status = 'approved' where id = $1`, [settlementId])
      const late = await attempt(
        c,
        `insert into settlement_lines (carrier_id, settlement_id, category, kind, amount_cents)
         values ($1, $2, 'reimbursement', 'scale', 1200)`,
        [carrierId, settlementId],
      )
      assert.equal(late, null, 'an approved settlement is still editable')

      await c.query(
        `update settlements set status = 'paid', net_cents = $2, paid_on = '2026-03-12'
          where id = $1`,
        [settlementId, totals.netCents + 1200],
      )

      // And now it is shut.
      const shut = await attempt(
        c,
        `insert into settlement_lines (carrier_id, settlement_id, category, kind, amount_cents)
         values ($1, $2, 'deduction', 'insurance', -12500)`,
        [carrierId, settlementId],
      )
      assert.ok(shut, 'paid means paid')

      // The correction route, in the order the page does it: revision first,
      // lines copied, and only then the paid row annotated as replaced.
      const { rows: rev } = await c.query(
        `insert into settlements
           (carrier_id, driver_id, period_start, period_end, revision, supersedes_id)
         values ($1, $2, '2026-03-02', '2026-03-08', 2, $3) returning id`,
        [carrierId, driverId, settlementId],
      )
      await c.query(
        `insert into settlement_lines
           (carrier_id, settlement_id, category, kind, description, amount_cents, load_id,
            method, quantity_milli, rate_mills, percent_bp, rate_cents, basis_cents,
            mileage_basis, percent_includes_fuel_surcharge, percent_includes_accessorials)
         select carrier_id, $2, category, kind, description, amount_cents, load_id,
                method, quantity_milli, rate_mills, percent_bp, rate_cents, basis_cents,
                mileage_basis, percent_includes_fuel_surcharge, percent_includes_accessorials
           from settlement_lines where settlement_id = $1`,
        [settlementId, rev[0].id],
      )
      await c.query(`update settlements set superseded_at = now() where id = $1`, [settlementId])

      const { rows: copied } = await c.query(
        `select count(*)::int as n from settlement_lines where settlement_id = $1`,
        [rev[0].id],
      )
      assert.equal(copied[0].n, 6, 'the revision starts as a copy of what was paid')

      const { rows: original } = await c.query(
        `select net_cents, status, superseded_at from settlements where id = $1`,
        [settlementId],
      )
      assert.equal(original[0].net_cents, 135_965, 'the paid figure is exactly as it was')
      assert.equal(original[0].status, 'paid')
      assert.ok(original[0].superseded_at)
    })
  })
})
