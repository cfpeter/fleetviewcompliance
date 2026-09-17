/**
 * What /app/setup prints about the roster, and the one nudge the dashboard
 * shows back to it.
 *
 * These are the sentences and the number a new customer meets on his first
 * screen, and every one of them used to live inside an .astro file where no
 * test could reach it. That is how the tile came to read "7 of 1".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rosterProgress } from '../src/lib/onboarding.ts'
import {
  addedLine,
  parseAdded,
  rosterCount,
  rosterLine,
  rosterSettled,
  setupNudge,
} from '../src/lib/roster.ts'

// ------------------------------------------------------------ the big number

test('the big number: "of" only where there is real progress to show', () => {
  // partial and met are the two states where "X of Y" is a fraction of
  // something. Both keep it.
  assert.equal(rosterCount(rosterProgress(3, 7)), '3 of 7')
  assert.equal(rosterCount(rosterProgress(0, 7)), '0 of 7')
  assert.equal(rosterCount(rosterProgress(7, 7)), '7 of 7')

  // No federal count on file, so there is no denominator to print.
  assert.equal(rosterCount(rosterProgress(7, null)), '7')
  assert.equal(rosterCount(rosterProgress(0, null)), '0')
})

test('THE "7 of 1" BUG: over never renders a denominator', () => {
  // The reported bug, exactly. Seven trucks in the yard against a last MCS-150
  // that reported one is not "7 of 1" — it is seven trucks and a stale filing.
  assert.equal(rosterCount(rosterProgress(7, 1)), '7')

  // Held as a property rather than as one example, because the next person to
  // touch this file will be tempted by a single template for all four states.
  for (const [added, target] of [
    [7, 1],
    [2, 1],
    [1, 0],
    [40, 12],
    [100, 99],
  ] as const) {
    const p = rosterProgress(added, target)
    assert.equal(p.state, 'over')
    const rendered = rosterCount(p)
    assert.equal(rendered, String(added))
    assert.ok(!rendered.includes(' of '), `over rendered a denominator: ${rendered}`)
  }
})

test('the number the tile shows is always the number he has added', () => {
  // Whatever the shape, the leading figure is his own count — never the federal
  // one. A tile whose big number is somebody else's figure is a tile he cannot
  // check against his own yard.
  for (const target of [null, 0, 1, 5, 12]) {
    for (const added of [0, 1, 5, 12]) {
      const p = rosterProgress(added, target)
      assert.equal(rosterCount(p).split(' ')[0], String(added))
    }
  }
})

// -------------------------------------------------------- the line under it

test('the explanation under the number names both figures for over', () => {
  // The headline dropped the federal number, so this line has to carry it —
  // otherwise "7" on its own says nothing about the stale MCS-150.
  const line = rosterLine(rosterProgress(7, 1), 'power-unit')
  assert.match(line, /FMCSA has you at 1\./)
  assert.match(line, /You have added 7\./)
  assert.match(line, /MCS-150 is out of date/)
})

test('every state gets a sentence, and the noun is the caller’s', () => {
  assert.match(rosterLine(rosterProgress(3, 7), 'power-unit'), /4 to go/)
  assert.match(rosterLine(rosterProgress(7, 7), 'driver'), /That matches/)
  assert.match(rosterLine(rosterProgress(3, null), 'driver'), /does not list a driver count/)
  assert.match(
    rosterLine(rosterProgress(3, null), 'power-unit'),
    /does not list a power-unit count/,
  )
})

// ------------------------------------------------------------- settled or not

test('a roster is settled when neither side is still short', () => {
  // met and over are both finished. over is finished and then some.
  assert.equal(rosterSettled(rosterProgress(7, 7), rosterProgress(7, 7)), true)
  assert.equal(rosterSettled(rosterProgress(9, 7), rosterProgress(7, 7)), true)
  // No federal count, but something on the list: as settled as we can tell.
  assert.equal(rosterSettled(rosterProgress(3, null), rosterProgress(2, null)), true)
})

test('a roster is not settled while anything is short or empty', () => {
  assert.equal(rosterSettled(rosterProgress(3, 7), rosterProgress(7, 7)), false)
  assert.equal(rosterSettled(rosterProgress(7, 7), rosterProgress(3, 7)), false)
  // The genuinely empty fleet. `met` at 0 of 0 is the trap here: FMCSA saying
  // zero trucks does not make an empty roster a finished one.
  assert.equal(rosterSettled(rosterProgress(0, 0), rosterProgress(0, 0)), false)
  assert.equal(rosterSettled(rosterProgress(0, null), rosterProgress(0, null)), false)
  assert.equal(rosterSettled(rosterProgress(5, 5), rosterProgress(0, null)), false)
})

// ------------------------------------------------------------ dashboard door

test('the dashboard nudge disappears once both lists have something on them', () => {
  assert.equal(setupNudge(1, 1), null)
  assert.equal(setupNudge(7, 3), null)
  // A nudge that never goes away is furniture, so this is the property that
  // matters most: it is off for every fleet that has started.
  for (let t = 1; t <= 5; t++) {
    for (let d = 1; d <= 5; d++) assert.equal(setupNudge(t, d), null)
  }
})

test('the nudge names the list that is actually empty', () => {
  assert.match(String(setupNudge(0, 0)), /no trucks and no drivers/)
  assert.match(String(setupNudge(0, 4)), /no trucks yet/)
  assert.match(String(setupNudge(4, 0)), /no drivers yet/)
})

test('the nudge stays short and plain', () => {
  // The reader is a Los Angeles fleet owner who often reads English as a second
  // language. Two sentences, no clauses stacked on clauses.
  for (const body of [setupNudge(0, 0), setupNudge(0, 2), setupNudge(2, 0)]) {
    const text = String(body)
    assert.ok(text.length <= 110, `too long: ${text}`)
    const sentences = text.split('. ').length
    assert.ok(sentences <= 2, `too many sentences: ${text}`)
  }
})

// ----------------------------------------------------- the return-trip receipt

test('the added marker is an allow-list, not an echo', () => {
  assert.equal(parseAdded('truck'), 'truck')
  assert.equal(parseAdded('driver'), 'driver')

  // The bug this shuts: anybody can write a query string, and a page that
  // renders what the URL says is a page anybody can put words into.
  assert.equal(parseAdded(null), null)
  assert.equal(parseAdded(undefined), null)
  assert.equal(parseAdded(''), null)
  assert.equal(parseAdded('Truck'), null)
  assert.equal(parseAdded('1'), null)
  assert.equal(parseAdded('constructor'), null)
  assert.equal(parseAdded('toString'), null)
  assert.equal(parseAdded('Your account is locked, call 555-0100'), null)
})

test('the receipt says what was added and where to go next', () => {
  assert.match(addedLine('truck'), /^Truck added\./)
  assert.match(addedLine('truck'), /add a driver/)
  assert.match(addedLine('driver'), /^Driver added\./)
  assert.match(addedLine('driver'), /add a truck/)
})
