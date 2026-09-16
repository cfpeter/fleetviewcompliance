/**
 * The post-login redirect target is attacker-controlled (it arrives in the
 * query string), so it gets its own tests.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safeNext } from '../src/lib/redirect.ts'

test('a normal internal path is kept', () => {
  assert.equal(safeNext('/app/drivers'), '/app/drivers')
  assert.equal(safeNext('/app?tab=2'), '/app?tab=2')
})

test('protocol-relative URLs are rejected', () => {
  // The bug this exists to prevent: "//evil.example" starts with '/', so a
  // naive startsWith check lets an attacker send a genuine link to our real
  // login page that lands the user on their site, already trusting us.
  assert.equal(safeNext('//evil.example'), '/app')
  assert.equal(safeNext('//evil.example/phish'), '/app')
})

test('backslash variants are rejected', () => {
  // Some browsers normalise a backslash to a forward slash during parsing.
  assert.equal(safeNext('/\\evil.example'), '/app')
})

test('absolute URLs are rejected', () => {
  assert.equal(safeNext('https://evil.example'), '/app')
  assert.equal(safeNext('javascript:alert(1)'), '/app')
})

test('missing or empty falls back', () => {
  assert.equal(safeNext(null), '/app')
  assert.equal(safeNext(''), '/app')
})
