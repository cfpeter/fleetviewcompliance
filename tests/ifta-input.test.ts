/**
 * What a person types, turned into what the IFTA tables store.
 *
 * No database here: everything under test is string handling and integer
 * arithmetic that decides what is filed with a tax authority. The bugs pinned
 * down below are all silent ones — a tenth of a gallon padded from the wrong
 * end, a comma read as a decimal point, a superseded tax rate that still looks
 * like a rate, and a quarter picked from the wrong side of midnight.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { quarterLabel, quarterStart, returnDueOn } from '../src/lib/ifta/compute.ts'
import {
  daysUntil,
  effectiveRates,
  IFTA_JURISDICTIONS,
  isIftaJurisdiction,
  isoDay,
  jurisdictionName,
  MAX_GALLONS_MILLI,
  MAX_QUARTER_MILES,
  nextQuarterStart,
  parseGallonsToMilli,
  parseJurisdiction,
  parseMiles,
  periodFromParam,
  pricePerGallonMills,
  recentQuarters,
} from '../src/lib/ifta/input.ts'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

const gal = (typed: string): number | null => {
  const r = parseGallonsToMilli(typed, { label: 'Gallons' })
  assert.equal(r.ok, true, r.ok ? '' : `refused ${JSON.stringify(typed)}: ${r.message}`)
  return r.ok ? r.value : null
}

const galFails = (typed: string, because: string): string => {
  const r = parseGallonsToMilli(typed, { label: 'Gallons' })
  assert.equal(r.ok, false, `${JSON.stringify(typed)} was accepted, and ${because}`)
  return r.ok ? '' : r.message
}

// ------------------------------------------------------------------ gallons

describe('gallons to thousandths', () => {
  it('reads the shapes a pump receipt actually prints', () => {
    assert.equal(gal('125.4'), 125_400, 'one decimal is TENTHS of a gallon')
    assert.equal(gal('125.400'), 125_400)
    assert.equal(gal('125.40'), 125_400)
    assert.equal(gal('125'), 125_000, 'a whole number is not 125 thousandths')
    assert.equal(gal('1,250.5'), 1_250_500, 'an owner types the thousands separator')
    assert.equal(gal('  125.400  '), 125_400)
    assert.equal(gal('125.400 GAL'), 125_400, 'pasted off a receipt, unit and all')
    assert.equal(gal('125.4 gallons'), 125_400)
    assert.equal(gal('.5'), 500, 'half a gallon, missing zero supplied')
    assert.equal(gal('0.001'), 1, 'the smallest thing the column can hold')
  })

  it('pads the fraction from the RIGHT, which is the whole function', () => {
    // padStart would store 125.004 for a receipt reading 125.4 — 396
    // thousandths short, silently, on the figure the entire return derives from.
    assert.equal(gal('125.4'), 125_400)
    assert.equal(gal('125.04'), 125_040)
    assert.equal(gal('125.004'), 125_004)
    // The three are three different receipts and must be three different numbers.
    assert.notEqual(gal('125.4'), gal('125.04'))
    assert.notEqual(gal('125.04'), gal('125.004'))
  })

  it('never lets a float decide a gallon', () => {
    // Every one of these is a value where some naive float route (truncation,
    // or multiplying before rounding) drops or gains a thousandth.
    for (const [typed, expected] of [
      ['8.115', 8_115],
      ['1.005', 1_005],
      ['16.08', 16_080],
      ['70.07', 70_070],
      ['859.295', 859_295],
      ['1234.555', 1_234_555],
      ['0.07', 70],
    ] as const) {
      assert.equal(gal(typed), expected, `${typed} gallons`)
      assert.ok(Number.isInteger(gal(typed)), `${typed} produced a non-integer`)
    }
  })

  it('refuses a dollar sign instead of quietly reading the cost as gallons', () => {
    // The gallons box and the total-cost box sit next to each other. '$125.40'
    // in this one means the two were swapped, and stripping the '$' would store
    // the dollars as gallons and ruin the quarter's MPG.
    const message = galFails('$125.40', 'the cost would have been stored as gallons')
    assert.match(message, /cost box/i, 'the message has to name the real mistake')
  })

  it('refuses a comma standing in for a decimal point', () => {
    // '12,5' stripped of its comma is 125 — a ten-times error in the one figure
    // that prices every jurisdiction on the return.
    galFails('12,5', 'it would have become 125 gallons')
    galFails('1,25.5', 'it is not a thousands separator')
    galFails('12,50', 'it would have become 1,250 gallons')
  })

  it('refuses more than three decimals rather than rounding them', () => {
    // The shape that lands here is a per-gallon PRICE pasted into the gallons
    // box. Rounding it to 4.260 would file a plausible-looking lie.
    const message = galFails('4.2599', 'a price would have been rounded into gallons')
    assert.match(message, /three decimals/i)
    galFails('125.4000', 'four decimals is not a receipt shape')
  })

  it('refuses zero, negatives and blanks instead of letting the check constraint do it', () => {
    // gallons_milli is NOT NULL with `check (gallons_milli > 0)`. Postgres would
    // refuse these too — with a sentence naming a constraint, after losing
    // everything else typed into the form.
    galFails('0', 'zero gallons is not a purchase')
    galFails('0.000', 'zero gallons is not a purchase')
    galFails('-125.4', 'the column refuses it')
    galFails('', 'the column is NOT NULL')
    galFails('   ', 'whitespace is still blank')
  })

  it('refuses junk, and the shapes that look like numbers but are not', () => {
    galFails('abc', 'it is not a number')
    galFails('12gal5', 'a blanket unit strip would have made this 125')
    galFails('1e3', 'exponent notation is a paste accident')
    galFails('125.4.5', 'two decimal points')
    galFails('125-4', 'a dash is not a decimal point')
    galFails('1/2', 'a fraction is not a receipt shape')
  })

  it('catches the extra zero before it wrecks the fleet MPG', () => {
    assert.equal(gal('8000'), 8_000_000, 'a full tanker delivery is legitimate')
    galFails('125000', 'no single receipt is 125,000 gallons')
    assert.ok(MAX_GALLONS_MILLI === 100_000_000)
  })
})

describe('what a receipt worked out to per gallon', () => {
  it('is the cross-check that makes a ten-times gallons typo obvious', () => {
    // $501.60 for 125.400 gallons is $4.000/gal. The same money against a
    // mistyped 1,254.00 gallons is $0.400/gal, which nobody can read past.
    assert.equal(pricePerGallonMills(50_160, 125_400), 4_000)
    assert.equal(pricePerGallonMills(50_160, 1_254_000), 400)
    assert.equal(pricePerGallonMills(50_160, 12_540), 40_000)
  })

  it('stays exact where a float would print $3.999', () => {
    assert.equal(pricePerGallonMills(40_000, 100_000), 4_000)
    assert.equal(pricePerGallonMills(12_345, 30_000), 4_115)
    assert.ok(Number.isInteger(pricePerGallonMills(12_345, 30_000)))
  })

  it('is NULL rather than Infinity or zero when a side is missing', () => {
    // A receipt with no total is an ordinary row — the gallons are what the
    // return needs — and it must not render as $0.000 a gallon.
    assert.equal(pricePerGallonMills(null, 125_400), null)
    assert.equal(pricePerGallonMills(0, 125_400), null)
    assert.equal(pricePerGallonMills(50_160, null), null)
    assert.equal(pricePerGallonMills(50_160, 0), null)
  })
})

// -------------------------------------------------------------------- miles

describe('miles by jurisdiction', () => {
  const miles = (typed: string) => parseMiles(typed, { label: 'Miles' })

  it('keeps blank and zero as two different answers', () => {
    // Blank means "I did not touch this row" and must leave the stored figure
    // alone. Zero is an instruction: it takes a mistaken 4,000 back down.
    assert.deepEqual(miles(''), { ok: true, value: null })
    assert.deepEqual(miles('   '), { ok: true, value: null })
    assert.deepEqual(miles('0'), { ok: true, value: 0 })
  })

  it('reads a trip sheet', () => {
    assert.deepEqual(miles('4820'), { ok: true, value: 4820 })
    assert.deepEqual(miles('12,450'), { ok: true, value: 12_450 })
  })

  it('refuses what the column would refuse, and what it would not', () => {
    assert.equal(miles('-5').ok, false, 'check (miles >= 0)')
    assert.equal(miles('4820.5').ok, false, 'whole miles only')
    assert.equal(miles('abc').ok, false)
    assert.equal(miles(String(MAX_QUARTER_MILES + 1)).ok, false, 'an extra zero')
  })
})

// ------------------------------------------------------------ jurisdictions

describe('IFTA jurisdictions', () => {
  it('is the 58 member jurisdictions, not the US state list', () => {
    assert.equal(IFTA_JURISDICTIONS.length, 58)
    assert.equal(IFTA_JURISDICTIONS.filter((j) => j.country === 'US').length, 48)
    assert.equal(IFTA_JURISDICTIONS.filter((j) => j.country === 'CA').length, 10)
  })

  it('excludes the three that cannot be filed and includes the ten that must be', () => {
    // No bridge reaches Alaska or Hawaii, and DC is not an IFTA member — a
    // US-states dropdown offers all three and omits every province, which tells
    // a carrier running Vancouver that those miles do not count.
    for (const code of ['AK', 'HI', 'DC']) {
      assert.equal(isIftaJurisdiction(code), false, `${code} is not a member jurisdiction`)
    }
    for (const code of ['AB', 'BC', 'ON', 'QC', 'SK', 'MB', 'NB', 'NL', 'NS', 'PE']) {
      assert.equal(isIftaJurisdiction(code), true, `${code} is a member jurisdiction`)
    }
  })

  it('has no duplicate codes', () => {
    const codes = IFTA_JURISDICTIONS.map((j) => j.code)
    assert.equal(new Set(codes).size, codes.length)
  })

  it('reads a code off a form, and refuses a misspelling the database would keep', () => {
    // `jurisdiction` is plain text with no FK and no check, so 'Californa'
    // stores fine and then appears as its own line on the return, splitting the
    // state's miles in two and reporting both halves short.
    assert.deepEqual(parseJurisdiction('ca', { label: 'Jurisdiction' }), { ok: true, value: 'CA' })
    assert.deepEqual(parseJurisdiction(' NV ', { label: 'Jurisdiction' }), {
      ok: true,
      value: 'NV',
    })
    assert.equal(parseJurisdiction('Californa', { label: 'Jurisdiction' }).ok, false)
    assert.equal(parseJurisdiction('', { label: 'Jurisdiction' }).ok, false)
    assert.equal(parseJurisdiction('AK', { label: 'Jurisdiction' }).ok, false)
    assert.equal(jurisdictionName('CA'), 'California')
    assert.equal(jurisdictionName('ZZ'), 'ZZ', 'an unknown code renders as itself, never blank')
  })
})

// ----------------------------------------------------------------- quarters

describe('picking a quarter', () => {
  it('offers the quarter being lived in and the four before it', () => {
    const list = recentQuarters(utc(2026, 9, 15), 5)
    assert.deepEqual(list.map(isoDay), [
      '2026-07-01',
      '2026-04-01',
      '2026-01-01',
      '2025-10-01',
      '2025-07-01',
    ])
    assert.equal(quarterLabel(list[0]), 'Q3 2026')
  })

  it('steps across a year boundary without producing month zero', () => {
    const list = recentQuarters(utc(2026, 2, 3), 5)
    assert.deepEqual(list.map(isoDay), [
      '2026-01-01',
      '2025-10-01',
      '2025-07-01',
      '2025-04-01',
      '2025-01-01',
    ])
  })

  it('snaps a mid-quarter date in the URL to the quarter it belongs to', () => {
    // '?q=2026-08-15' queried literally matches no period_start row at all, and
    // the page would render an empty quarter — which on a filing screen reads as
    // "you ran nothing".
    assert.equal(isoDay(periodFromParam('2026-08-15', utc(2026, 9, 15))), '2026-07-01')
    assert.equal(isoDay(periodFromParam('2026-07-01', utc(2026, 9, 15))), '2026-07-01')
  })

  it('falls back to the current quarter rather than handing junk to Postgres', () => {
    // '?q=banana' in `.eq('period_start', …)` is `invalid input syntax for type
    // date` across the top of the page, not an empty result.
    const today = utc(2026, 9, 15)
    for (const junk of ['banana', '', '2026-13-01', '2026-02-30', '15/08/2026', '2026-8-1']) {
      assert.equal(isoDay(periodFromParam(junk, today)), '2026-07-01', `?q=${junk}`)
    }
    assert.equal(isoDay(periodFromParam(null, today)), '2026-07-01')
  })

  it('knows where a quarter ends, so a fuel query can be a half-open range', () => {
    assert.equal(isoDay(nextQuarterStart(utc(2026, 7, 1))), '2026-10-01')
    assert.equal(isoDay(nextQuarterStart(utc(2026, 10, 1))), '2027-01-01', 'across the year')
    // The range is [start, nextStart) precisely so nothing has to compute "the
    // last day of the quarter" and get 30 September wrong.
    assert.equal(isoDay(quarterStart(utc(2026, 9, 30))), '2026-07-01')
  })

  it('counts the days to the deadline, and past it', () => {
    // Q3 2026 falls nominally on Saturday 31 Oct and ROLLS to Monday 2 Nov.
    // Before the roll existed this test asserted -1 on 1 November — the page
    // calling a return overdue on a Sunday it was not late.
    const due = returnDueOn(utc(2026, 7, 1)) // rolled to 2026-11-02
    assert.equal(isoDay(due), '2026-11-02')
    assert.equal(daysUntil(due, utc(2026, 9, 15)), 48)
    assert.equal(daysUntil(due, utc(2026, 11, 1)), 1, 'the Sunday is still a day early')
    assert.equal(daysUntil(due, utc(2026, 11, 2)), 0, 'due Monday, not overdue')
    assert.equal(daysUntil(due, utc(2026, 11, 3)), -1, 'one day late')
  })

  it('counts across a daylight-saving change without losing the hour', () => {
    // US clocks go back on 1 November 2026. Done on local Dates this count
    // gains a 25-hour day and rounds "due tomorrow" into "due today".
    const due = returnDueOn(utc(2026, 10, 1)) // Sun 31 Jan rolls to Mon 1 Feb
    assert.equal(isoDay(due), '2027-02-01')
    assert.equal(daysUntil(due, utc(2026, 10, 31)), 93)
    assert.equal(daysUntil(due, utc(2026, 11, 2)), 91)
  })
})

// -------------------------------------------------------------------- rates

describe('the rate in force for a quarter', () => {
  const rows = [
    { jurisdiction: 'CA', fuel_type: 'diesel', period_start: '2026-07-01', rate_mills: 979 },
    { jurisdiction: 'CA', fuel_type: 'diesel', period_start: '2026-01-01', rate_mills: 936 },
    { jurisdiction: 'NV', fuel_type: 'diesel', period_start: '2026-01-01', rate_mills: 270 },
  ]

  it('takes the latest row starting on or before the quarter', () => {
    const q3 = effectiveRates(rows, utc(2026, 7, 1))
    assert.deepEqual(q3, [
      { jurisdiction: 'CA', rateMills: 979 },
      { jurisdiction: 'NV', rateMills: 270 },
    ])
  })

  it('does not price a quarter at a rate that had not started yet', () => {
    // A superseded or not-yet-effective rate produces a return that is short by
    // exactly the rate change and reconciles against nothing.
    const q2 = effectiveRates(rows, utc(2026, 4, 1))
    assert.deepEqual(
      q2.find((r) => r.jurisdiction === 'CA'),
      { jurisdiction: 'CA', rateMills: 936 },
    )
  })

  it('leaves a jurisdiction out entirely when nothing is in force yet', () => {
    // ABSENT, never zero. quarterlyReturn() reads a missing entry as
    // rate_unknown and refuses to complete the return; a zero here would be a
    // silent $0.00 owed for a state the truck drove through.
    const q4of2025 = effectiveRates(rows, utc(2025, 10, 1))
    assert.deepEqual(q4of2025, [])
  })

  it('matches the seeded row: CA diesel from Q3 2026 onward, and nothing before', () => {
    // 0015_ifta.sql seeds exactly one rate. Every other jurisdiction showing as
    // unknown is correct behaviour, not a gap to paper over.
    const seed = [
      { jurisdiction: 'CA', fuel_type: 'diesel', period_start: '2026-07-01', rate_mills: 979 },
    ]
    assert.deepEqual(effectiveRates(seed, utc(2026, 4, 1)), [], 'Q2 2026 has no CA rate')
    assert.deepEqual(effectiveRates(seed, utc(2026, 7, 1)), [
      { jurisdiction: 'CA', rateMills: 979 },
    ])
    assert.deepEqual(effectiveRates(seed, utc(2027, 1, 1)), [
      { jurisdiction: 'CA', rateMills: 979 },
    ])
  })

  it('never lets another fuel type become the latest rate', () => {
    // fuel_purchases has no fuel_type column, so every gallon here is diesel. A
    // gasoline row added to ifta_rates later must not price this return.
    const mixed = [
      ...rows,
      { jurisdiction: 'CA', fuel_type: 'gasoline', period_start: '2026-07-01', rate_mills: 511 },
    ]
    const q3 = effectiveRates(mixed, utc(2026, 7, 1))
    assert.deepEqual(
      q3.find((r) => r.jurisdiction === 'CA'),
      { jurisdiction: 'CA', rateMills: 979 },
    )
  })
})
