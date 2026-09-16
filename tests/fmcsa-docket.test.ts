import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeDocket } from '../src/lib/fmcsa.ts'

test('a docket is stored with its prefix, so we must send one', () => {
  // Verified against the live federal file: docket_number is "MC116200".
  // Querying "116200" returns an EMPTY ARRAY rather than an error — a false
  // negative that renders as "this broker has no authority record".
  assert.equal(normalizeDocket('116200'), 'MC116200')
  assert.equal(normalizeDocket('MC116200'), 'MC116200')
})

test('it accepts what a person actually types', () => {
  assert.equal(normalizeDocket('MC 116200'), 'MC116200')
  assert.equal(normalizeDocket('mc-116200'), 'MC116200')
  assert.equal(normalizeDocket('  mc.116200 '), 'MC116200')
})

test('other docket prefixes survive', () => {
  assert.equal(normalizeDocket('FF12345'), 'FF12345')
  assert.equal(normalizeDocket('MX9999'), 'MX9999')
})

test('nonsense returns null rather than a query that finds nothing', () => {
  // Returning null lets the caller say "that is not a docket number" instead of
  // "we found no authority", which are very different statements to make about
  // somebody's business.
  assert.equal(normalizeDocket(''), null)
  assert.equal(normalizeDocket('not a docket'), null)
  assert.equal(normalizeDocket('MC'), null)
  assert.equal(normalizeDocket('123456789'), null, 'too long to be a docket')
})
