/**
 * Which key each page looks its dates up by.
 *
 * `current_compliance_anchors` comes back the same shape on every screen, and
 * each screen puts it in a Map — but not under the same key. A page that saves
 * for one subject keys by SLOT (`driver:<id>:<anchor>`), because the planner it
 * hands the Map to is shared with the dashboard, where one submit spans the
 * whole fleet and an anchor key alone would collapse every truck into one slot.
 * A page that only reads its own subject's dates keys by the bare anchor key.
 *
 * Both are correct. What is not correct is a Map built one way and read the
 * other, and that is invisible: the keys are strings on both sides, so the
 * compiler is happy, the lookup simply never matches, and a date that is on file
 * reads as a date nobody has typed in.
 *
 * FAILURE PINNED: the driver page's "Dates not recorded" card reading 6 for a
 * driver whose file is complete. `loadCurrentAnchors` keys by slot; the count
 * asked `current.has(a.key)`, which can never be true, so the card showed every
 * always-expected anchor forever. The date inputs on the same page had been
 * fixed for this once already and the count was missed — the two reads sit 500
 * lines apart and must move together.
 *
 * Checked against the page source because there is no rendering of these pages
 * in the test suite, and the keying is a property of the code, not of the data.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const page = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const DRIVER_PAGE = page('../src/pages/app/drivers/[id].astro')
const VEHICLE_PAGE = page('../src/pages/app/vehicles/[id].astro')
const DASHBOARD = page('../src/pages/app/index.astro')

/**
 * A page with its comments taken out.
 *
 * The driver page carries a comment quoting the broken lookup verbatim, so a
 * test that greps the raw file would fail on the explanation of the fix.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

/** Every `current.has(...)` / `current.get(...)`, with what it was handed. */
function reads(source: string): { at: number; argument: string }[] {
  return [...code(source).matchAll(/current\.(?:has|get)\(([^\n]*)/g)].map((m) => ({
    at: m.index ?? 0,
    argument: m[1],
  }))
}

// --- the pages that key by slot ---------------------------------------------

test('the driver page still keys its anchors by slot', () => {
  // The premise of the test below. If this Map ever goes back to bare anchor
  // keys, the reads have to follow it and the assertion flips.
  const body = code(DRIVER_PAGE)
  const start = body.indexOf('async function loadCurrentAnchors')
  assert.ok(start > -1, 'loadCurrentAnchors is gone — this file is testing nothing')

  const built = body.slice(start, body.indexOf('\n}', start))
  assert.match(
    built,
    /anchorSlot\('driver', id,/,
    'loadCurrentAnchors no longer keys by slot, so every read below it is now wrong',
  )
})

test('every driver-page lookup goes through anchorSlot', () => {
  const found = reads(DRIVER_PAGE)

  // Both of them: the date inputs and the "Dates not recorded" count. A test
  // that found one would pass while the other was broken, which is the exact
  // state this file exists to stop.
  assert.ok(found.length >= 2, `only ${found.length} lookup(s) found — the regex has gone stale`)

  for (const { argument } of found) {
    assert.ok(
      argument.startsWith('anchorSlot('),
      `a driver date is looked up by "${argument.trim()}" and the Map is keyed by slot, ` +
        'so it can never match: dates on file read as missing and "Dates not recorded" ' +
        'shows the full count for a complete file',
    )
  }
})

test('the dashboard never reads its slot-keyed map by key', () => {
  // It builds the Map only to hand it to `planAnchorWrites`. Nothing is looked
  // up, and anything added must go through anchorSlot — one submit there spans
  // several subjects, so a bare key is not merely wrong, it is ambiguous.
  for (const { argument } of reads(DASHBOARD)) {
    assert.ok(
      argument.startsWith('anchorSlot('),
      `the dashboard looks a date up by "${argument.trim()}" in a Map keyed by slot`,
    )
  }
})

// --- the page that keys both ways -------------------------------------------

test('the vehicle page keys for the planner by slot and for the screen by anchor', () => {
  // Two Maps, same name, different scopes: the save handler's goes to the shared
  // planner and is keyed by slot; the one the screen reads covers a single
  // vehicle and is keyed by the bare anchor key. Correct as it stands — the
  // failure would be changing one and not the other.
  const body = code(VEHICLE_PAGE)
  const forPlanner = body.indexOf("current.set(anchorSlot('vehicle'")
  const forScreen = body.indexOf('current.set(String(r.anchor_key)')

  assert.ok(
    forPlanner > -1,
    'the save handler no longer keys by slot: one truck per fleet-wide submit',
  )
  assert.ok(
    forScreen > -1,
    'the Map the screen reads is no longer keyed by the bare anchor key — every lookup ' +
      'below it must change with it, or dates on file will render as blank boxes',
  )
  assert.ok(
    forPlanner < forScreen,
    'the two Maps swapped places; the reads below are now the wrong ones',
  )
})

test('every vehicle-page lookup belongs to the map the screen builds', () => {
  const body = code(VEHICLE_PAGE)
  const forScreen = body.indexOf('current.set(String(r.anchor_key)')
  const found = reads(VEHICLE_PAGE)

  // "Dates we still want", the date inputs, and the in-force row in the history.
  assert.ok(found.length >= 3, `only ${found.length} lookup(s) found — the regex has gone stale`)

  for (const { at, argument } of found) {
    assert.ok(at > forScreen, `a lookup runs before the Map the screen reads is built`)
    assert.ok(
      !argument.startsWith('anchorSlot('),
      `a vehicle date is looked up by slot in a Map keyed by the bare anchor key: ` +
        `"${argument.trim()}"`,
    )
  }
})
