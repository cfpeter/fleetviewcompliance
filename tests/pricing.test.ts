import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimatePrice, monthlyPrice, pricingHref, site } from '../src/lib/site.ts'

test('the floor covers the smallest fleets', () => {
  assert.equal(monthlyPrice(1), 29)
  assert.equal(monthlyPrice(4), 29)
})

test('past the floor it is strictly linear', () => {
  assert.equal(monthlyPrice(5), 30)
  assert.equal(monthlyPrice(10), 60)
  assert.equal(monthlyPrice(40), 240)
})

test('adding a truck never makes the bill jump', () => {
  // The whole reason for linear-with-a-floor rather than bands: a cliff gives
  // an owner a reason to under-report fleet size to a compliance product.
  for (let n = 1; n < 100; n++) {
    const delta = monthlyPrice(n + 1) - monthlyPrice(n)
    assert.ok(delta >= 0 && delta <= 6, `truck ${n}->${n + 1} jumped by ${delta}`)
  }
})

// --- the /pricing?trucks= estimator -----------------------------------------

/** Narrow to the priced case, so a wrong state fails here instead of as `undefined`. */
function priced(raw: string) {
  const e = estimatePrice(raw)
  assert.equal(e.state, 'priced', `expected ${JSON.stringify(raw)} to price`)
  if (e.state !== 'priced') throw new Error('unreachable')
  return e
}

test('the estimator is the same price as the rest of the site', () => {
  // The whole point of this test: two implementations of the price means two
  // prices, and the one on the marketing page is the one a customer quotes back.
  for (let n = 1; n <= site.pricing.maxQuotedTrucks; n++) {
    assert.equal(priced(String(n)).monthly, monthlyPrice(n), `disagreement at ${n} trucks`)
  }
})

test('the floor stops binding between 4 and 5 trucks', () => {
  // 4 x $6 = $24, under the $29 minimum. 5 x $6 = $30, over it. Off by one here
  // and the page tells a four-truck fleet it is paying the per-truck rate.
  assert.equal(priced('4').onFloor, true)
  assert.equal(priced('4').monthly, 29)
  assert.equal(priced('5').onFloor, false)
  assert.equal(priced('5').monthly, 30)
})

test('the per-truck figure is the bill divided by the fleet, not the rate', () => {
  assert.equal(priced('1').effectivePerTruck, 29)
  assert.equal(priced('10').effectivePerTruck, 6)
  // On the floor it is strictly worse than $6, and the page has to say so.
  assert.ok(priced('2').effectivePerTruck > site.pricing.perTruck)
})

test('the published price stops at the top of the segment', () => {
  const max = site.pricing.maxQuotedTrucks
  assert.equal(estimatePrice(String(max)).state, 'priced')

  const over = estimatePrice(String(max + 1))
  assert.equal(over.state, 'oversize')
  // The count survives, so the page can answer an 80-truck fleet by its size
  // instead of showing everyone above the cap the same anonymous block.
  if (over.state === 'oversize') assert.equal(over.trucks, max + 1)
})

test('a fleet size nobody has is a typo, not a fleet', () => {
  assert.equal(estimatePrice('10000').state, 'oversize')
  assert.equal(estimatePrice('10001').state, 'unreadable')
  assert.equal(estimatePrice('999999999').state, 'unreadable')
})

test('nothing in the URL means the resting page, not an empty one', () => {
  for (const raw of [null, undefined, '', '   ']) {
    assert.equal(estimatePrice(raw).state, 'none', `expected ${JSON.stringify(raw)} to rest`)
  }
})

test('something we cannot read says so instead of guessing', () => {
  for (const raw of ['abc', '12.5', '1e3', '5 trucks', 'ten', '--3', '4,000', '<script>']) {
    assert.equal(estimatePrice(raw).state, 'unreadable', `expected ${raw} to be unreadable`)
  }
})

test('zero and negative trucks clamp to one, never to a $0 quote', () => {
  for (const raw of ['0', '-0', '-1', '-3', '-9999']) {
    const e = priced(raw)
    assert.equal(e.trucks, 1, `${raw} should clamp to one truck`)
    assert.equal(e.monthly, site.pricing.floor)
  }
})

test('a real number written loosely still prices', () => {
  assert.equal(priced(' 12 ').trucks, 12)
  assert.equal(priced('012').trucks, 12)
  assert.equal(priced('+7').trucks, 7)
})

test('no input can produce a bill under the floor', () => {
  // The one output that must not exist. Anything that survives to `priced` pays
  // at least the minimum, whatever was in the query string.
  const hostile = ['0', '-500', '1', '   2 ', '+0', '000', 'abc', '', '50', '51', '1e9']
  for (const raw of hostile) {
    const e = estimatePrice(raw)
    if (e.state === 'priced') {
      assert.ok(e.monthly >= site.pricing.floor, `${raw} priced at ${e.monthly}`)
    }
  }
})

test('a control already on screen does not scroll the page to reach itself', () => {
  // Measured, after the owner reported the page "scrolling up and down" on
  // every tap: the estimator starts 426px into an 812px phone screen, so it is
  // already visible when the page loads at the top. With `#estimate` on the
  // link the browser painted at the top and THEN jumped ~390px to reach
  // something the reader could already see — once per tap, which is what made
  // stepping the truck count feel like the page lurching.
  assert.equal(pricingHref(10), '/pricing?trucks=10')
  assert.equal(pricingHref(10).includes('#'), false)
})

test('a link from far down the page still lands on the answer', () => {
  // The other half. The "what that works out to" ladder sits ~2,500px down;
  // tapping a row there without the anchor drops the reader back at the hero
  // wondering where the answer went. Distance is what decides this, not taste.
  assert.equal(pricingHref(10, { fromBelow: true }), '/pricing?trucks=10#estimate')
})

test('an estimator link still carries a readable truck count', () => {
  assert.equal(
    estimatePrice(new URL(`https://x.test${pricingHref(25)}`).searchParams.get('trucks')).state,
    'priced',
  )
  assert.equal(
    estimatePrice(
      new URL(`https://x.test${pricingHref(25, { fromBelow: true })}`).searchParams.get('trucks'),
    ).state,
    'priced',
  )
})
