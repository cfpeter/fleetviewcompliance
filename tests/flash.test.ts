/**
 * The flash message is only read when the browser says the request came from
 * this site. Each case below is an attack or a real navigation, named as such.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cameFromThisSite, flashText } from '../src/lib/flash.ts'

const page = (query: string) => new URL(`https://fleetviewcompliance.com/app/customers/new${query}`)

function request(headers: Record<string, string>): Request {
  return new Request('https://fleetviewcompliance.com/app/customers/new', { headers })
}

test('the GET after our own 303 carries same-origin and the message is shown', () => {
  const url = page('?error=A%20customer%20needs%20a%20name.')
  assert.equal(
    flashText(url, request({ 'sec-fetch-site': 'same-origin' })),
    'A customer needs a name.',
  )
})

test('a link opened from an email is cross-site and the message is dropped', () => {
  const url = page('?error=Your%20account%20is%20locked.%20Call%20555-0100.')
  assert.equal(flashText(url, request({ 'sec-fetch-site': 'cross-site' })), null)
})

test('a URL typed or pasted into the bar is none and the message is dropped', () => {
  const url = page('?error=Call%20555-0100')
  assert.equal(flashText(url, request({ 'sec-fetch-site': 'none' })), null)
})

test('same-site is not same-origin: the dev host must not vouch for production', () => {
  const url = page('?error=x')
  assert.equal(flashText(url, request({ 'sec-fetch-site': 'same-site' })), null)
})

test('without the header, a Referer from our own origin is enough', () => {
  const url = page('?error=Pick%20a%20driver.')
  assert.equal(
    flashText(url, request({ referer: 'https://fleetviewcompliance.com/app/customers/new' })),
    'Pick a driver.',
  )
})

test('without the header, a Referer from elsewhere drops the message', () => {
  const url = page('?error=x')
  assert.equal(flashText(url, request({ referer: 'https://evil.example/mail' })), null)
  assert.equal(flashText(url, request({ referer: 'not a url' })), null)
})

test('an old browser sending neither header still sees its form errors', () => {
  const url = page('?error=Pick%20a%20driver.')
  assert.equal(flashText(url, request({})), 'Pick a driver.')
})

test('a missing or empty parameter is null whatever the headers say', () => {
  assert.equal(flashText(page(''), request({ 'sec-fetch-site': 'same-origin' })), null)
  assert.equal(flashText(page('?error='), request({ 'sec-fetch-site': 'same-origin' })), null)
})

test('the key is a parameter, so a second flash name reads the same way', () => {
  const url = page('?dup_name=Load%2012')
  assert.equal(flashText(url, request({ 'sec-fetch-site': 'same-origin' }), 'dup_name'), 'Load 12')
  assert.equal(flashText(url, request({ 'sec-fetch-site': 'cross-site' }), 'dup_name'), null)
})

test('cameFromThisSite compares origins, not hosts', () => {
  const url = page('')
  const headers = new Headers({ referer: 'http://fleetviewcompliance.com/app' })
  // http versus https is a different origin.
  assert.equal(cameFromThisSite(url, headers), false)
})
