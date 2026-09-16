/**
 * The pure logic behind the loads screens.
 *
 * No database here on purpose: everything under test is arithmetic and string
 * handling that decides what a dispatcher sees, and all three of the bugs these
 * cases pin down are silent ones — a cent lost to binary floating point, a load
 * that looks free because nobody priced it, and a lane that looks empty because
 * the stops were relays rather than a pickup and a delivery.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  billingStatusLabel,
  centsToInput,
  formatCents,
  isBillingStatus,
  isLoadStatus,
  laneFromStops,
  loadLabel,
  MAX_MONEY_CENTS,
  matchCustomerName,
  parseMoneyToCents,
  referenceSearchFilter,
  totalRateCents,
} from '../src/lib/loads.ts'

const ok = (result: ReturnType<typeof parseMoneyToCents>): number | null => {
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  return result.ok ? result.value : null
}

describe('dollars to integer cents', () => {
  it('reads the shapes that get typed and pasted', () => {
    assert.equal(ok(parseMoneyToCents('1850', { label: 'Rate' })), 185000)
    assert.equal(ok(parseMoneyToCents('1850.5', { label: 'Rate' })), 185050, '.5 is fifty cents')
    assert.equal(ok(parseMoneyToCents('1850.50', { label: 'Rate' })), 185050)
    assert.equal(ok(parseMoneyToCents('$1,850.50', { label: 'Rate' })), 185050, 'pasted from email')
    assert.equal(ok(parseMoneyToCents('  1850.05 ', { label: 'Rate' })), 185005)
    assert.equal(ok(parseMoneyToCents('0', { label: 'Rate' })), 0, 'zero is a rate, not a blank')
  })

  it('leaves an untouched box as NULL rather than zero', () => {
    assert.equal(ok(parseMoneyToCents('', { label: 'Rate' })), null)
    assert.equal(ok(parseMoneyToCents('   ', { label: 'Rate' })), null)
    assert.equal(ok(parseMoneyToCents(null, { label: 'Rate' })), null)
  })

  it('never loses a cent to floating point', () => {
    // The whole reason the parser splits the string instead of multiplying.
    // Math.round(Number(d) * 100) is wrong for some of these, and one cent off
    // a linehaul rate is a broker holding payment over our arithmetic.
    for (const [typed, expected] of [
      ['1234.55', 123455],
      ['16.08', 1608],
      ['1.005', null],
      ['859.29', 85929],
      ['10.07', 1007],
      ['70.07', 7007],
      ['8.29', 829],
    ] as const) {
      const result = parseMoneyToCents(typed, { label: 'Rate' })
      if (expected === null) {
        assert.equal(result.ok, false, `${typed} has three decimals and must be refused`)
      } else {
        assert.equal(result.ok && result.value, expected, `${typed} is ${expected} cents`)
      }
    }
  })

  it('refuses a third decimal place instead of rounding it away', () => {
    // Rounding silently changes the number she typed, on a figure that becomes
    // an invoice. Refusing asks her to look at it.
    const result = parseMoneyToCents('1850.555', { label: 'Linehaul rate' })
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.message, /Linehaul rate/)
  })

  it('refuses what is not a number at all', () => {
    for (const bad of ['abc', '18-50', '1.2.3', '--5', '1,2.3.4']) {
      assert.equal(parseMoneyToCents(bad, { label: 'Rate' }).ok, false, `${bad} is not money`)
    }
  })

  it('accepts a leading decimal point', () => {
    // Refusing '.50' would be refusing a perfectly clear answer, which is how a
    // form teaches someone it is broken.
    assert.equal(ok(parseMoneyToCents('.50', { label: 'Rate' })), 50)
    assert.equal(ok(parseMoneyToCents('$.05', { label: 'Rate' })), 5)
    assert.equal(ok(parseMoneyToCents('-.50', { label: 'Accessorials', allowNegative: true })), -50)
  })

  it('reads a lone currency symbol as an empty box', () => {
    // The field already prints a static $ beside the input, so a typed one is
    // noise. Refusing it would be an error message about a field she meant to
    // leave alone.
    assert.equal(ok(parseMoneyToCents('$', { label: 'Rate' })), null)
  })

  it('allows a negative only where a deduction is real', () => {
    // A lumper or an advance comes off the rate confirmation as a deduction;
    // a negative linehaul is not a thing.
    assert.equal(
      ok(parseMoneyToCents('-150.00', { label: 'Accessorials', allowNegative: true })),
      -15000,
    )
    assert.equal(parseMoneyToCents('-150.00', { label: 'Linehaul rate' }).ok, false)
  })

  it('refuses an amount the int4 column cannot hold', () => {
    // Postgres would raise "integer out of range" and lose the whole save with
    // a message about a type. In practice this only ever fires on an extra zero.
    assert.equal(ok(parseMoneyToCents('21474836.47', { label: 'Rate' })), MAX_MONEY_CENTS)
    assert.equal(parseMoneyToCents('21474836.48', { label: 'Rate' }).ok, false)
  })
})

describe('cents back onto the screen', () => {
  it('formats to the cent, with the thousands separator', () => {
    assert.equal(formatCents(185050), '$1,850.50')
    assert.equal(formatCents(5), '$0.05')
    assert.equal(formatCents(0), '$0.00')
    assert.equal(formatCents(-15000), '-$150.00')
  })

  it('renders an unknown amount as an em dash and never as zero', () => {
    // "$0.00" reads as "this load pays nothing"; "—" reads as "nobody has typed
    // the rate yet". Those go to different people.
    assert.equal(formatCents(null), '—')
    assert.equal(formatCents(undefined), '—')
  })

  it('round-trips through the money input without drifting', () => {
    for (const cents of [0, 5, 99, 100, 185050, 123455, MAX_MONEY_CENTS]) {
      const typed = centsToInput(cents)
      const parsed = parseMoneyToCents(typed, { label: 'Rate' })
      assert.equal(parsed.ok && parsed.value, cents, `${cents} survived the form`)
    }
    assert.equal(centsToInput(null), '', 'a blank stays blank')
  })
})

describe('the total on the board', () => {
  it('adds the three components exactly', () => {
    assert.equal(
      totalRateCents({
        linehaul_cents: 185000,
        fuel_surcharge_cents: 32550,
        accessorials_cents: 0,
      }),
      217550,
    )
  })

  it('treats a missing component inside a priced load as nothing', () => {
    // A load really can have no fuel surcharge.
    assert.equal(
      totalRateCents({
        linehaul_cents: 185000,
        fuel_surcharge_cents: null,
        accessorials_cents: null,
      }),
      185000,
    )
  })

  it('subtracts a deduction', () => {
    assert.equal(
      totalRateCents({
        linehaul_cents: 185000,
        fuel_surcharge_cents: null,
        accessorials_cents: -15000,
      }),
      170000,
    )
  })

  it('stays NULL while nothing at all has been priced', () => {
    // The distinction the whole helper exists for: an unpriced load must not
    // render as $0.00, because nobody chases a load that appears to pay nothing.
    assert.equal(
      totalRateCents({
        linehaul_cents: null,
        fuel_surcharge_cents: null,
        accessorials_cents: null,
      }),
      null,
    )
    assert.equal(totalRateCents({}), null)
  })
})

describe('the lane, derived from the stops', () => {
  it('reads first and last by sequence, not by the order the rows arrived', () => {
    const lane = laneFromStops([
      { sequence: 2, city: 'Phoenix', state: 'AZ' },
      { sequence: 0, city: 'Fontana', state: 'ca' },
      { sequence: 1, city: 'Barstow', state: 'CA' },
    ])
    assert.equal(lane.origin, 'Fontana, CA', 'state is normalised to the printed form')
    assert.equal(lane.destination, 'Phoenix, AZ', 'the middle stop is not the destination')
  })

  it('does not filter by stop type', () => {
    // A drop-and-hook relay has neither a 'pickup' nor a 'delivery' row on it.
    // Filtering by type renders a fully entered load with a blank lane, which
    // reads as missing data.
    const lane = laneFromStops([
      { sequence: 1, city: 'Ontario', state: 'CA' },
      { sequence: 2, city: 'Las Vegas', state: 'NV' },
    ])
    assert.equal(lane.origin, 'Ontario, CA')
    assert.equal(lane.destination, 'Las Vegas, NV')
  })

  it('gives an origin and no destination while only one stop is entered', () => {
    const lane = laneFromStops([{ sequence: 1, city: 'Fontana', state: 'CA' }])
    assert.equal(lane.origin, 'Fontana, CA')
    assert.equal(lane.destination, null, 'one stop is not a round trip to itself')
  })

  it('says something for a half-typed stop', () => {
    assert.deepEqual(laneFromStops([{ sequence: 1, city: null, state: 'AZ' }]), {
      origin: 'AZ',
      destination: null,
    })
    assert.deepEqual(laneFromStops([{ sequence: 1, city: 'Fontana', state: null }]), {
      origin: 'Fontana',
      destination: null,
    })
  })

  it('survives a load with no stops at all', () => {
    assert.deepEqual(laneFromStops([]), { origin: null, destination: null })
    assert.deepEqual(laneFromStops(null), { origin: null, destination: null })
    assert.deepEqual(laneFromStops(undefined), { origin: null, destination: null })
  })
})

describe('identifying a load', () => {
  it('prefers our number and falls back to the broker’s', () => {
    assert.equal(loadLabel({ load_number: '1042', broker_reference: '6841102' }), '1042')
    assert.equal(loadLabel({ load_number: null, broker_reference: '6841102' }), '6841102')
    assert.equal(loadLabel({ load_number: '  ', broker_reference: '6841102' }), '6841102')
  })

  it('never renders an empty link', () => {
    assert.equal(loadLabel({ load_number: null, broker_reference: null }), 'Untitled load')
  })
})

describe('searching by either reference number', () => {
  it('always covers both columns', () => {
    // The dispatcher does not know which of the two numbers is printed on the
    // sheet in her hand, and a search that misses hers reads as "never entered".
    const filter = referenceSearchFilter('6841102')
    assert.equal(filter, 'load_number.ilike.%6841102%,broker_reference.ilike.%6841102%')
  })

  it('strips the characters PostgREST reads as syntax', () => {
    // A comma in the box becomes a second filter and a 400, not a search; % and
    // _ are LIKE wildcards that would match the whole board.
    const filter = referenceSearchFilter('TQL, 68%_1(2)') ?? ''
    assert.ok(!filter.includes('%TQL,'), 'the comma is gone')
    assert.ok(!filter.includes('('), 'the bracket is gone')
    assert.equal(referenceSearchFilter('   '), null, 'an empty box is no filter at all')
    assert.equal(referenceSearchFilter('%%%'), null, 'a box of wildcards is no filter either')
  })
})

describe('the free-text customer box', () => {
  const rows = [
    { id: 'a', name: 'TQL' },
    { id: 'b', name: '  C.H. Robinson ' },
  ]

  it('matches an existing customer whatever the casing', () => {
    // Without this, every hand-typed load creates another customer row and the
    // list becomes four spellings of one broker.
    assert.equal(matchCustomerName(rows, 'tql'), 'a')
    assert.equal(matchCustomerName(rows, ' TQL '), 'a')
    assert.equal(matchCustomerName(rows, 'c.h. robinson'), 'b')
  })

  it('reports a genuine miss so the caller inserts', () => {
    assert.equal(matchCustomerName(rows, 'Landstar'), null)
    assert.equal(matchCustomerName(rows, ''), null)
    assert.equal(matchCustomerName(rows, null), null)
    assert.equal(matchCustomerName(null, 'TQL'), null)
  })

  it('does not treat the typed name as a pattern', () => {
    // '.ilike()' would match TQL here. This is why the comparison is done in
    // JavaScript over the carrier's own list.
    assert.equal(matchCustomerName(rows, 'T%'), null)
    assert.equal(matchCustomerName(rows, '_QL'), null)
  })
})

describe('the two vocabularies stay separate', () => {
  it('does not accept a billing status where a load status belongs', () => {
    // The guard that stops `invalid input value for enum` reaching a dispatcher:
    // the two enums share no values, and neither list is a stage of the other.
    assert.equal(isLoadStatus('delivered'), true)
    assert.equal(isLoadStatus('invoiced'), false)
    assert.equal(isBillingStatus('not_ready'), true)
    assert.equal(isBillingStatus('delivered'), false)
    assert.equal(isLoadStatus(''), false, 'a cleared filter is not a status')
  })

  it('renders a value we have no label for rather than a blank cell', () => {
    // A status added to the enum by a migration before this list catches up
    // should look odd, not invisible.
    assert.equal(billingStatusLabel('some_future_value'), 'some_future_value')
    assert.equal(billingStatusLabel(null), '')
  })
})
