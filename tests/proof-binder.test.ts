/**
 * The printed binder, guarded at the only level it can be guarded at.
 *
 * tests/proof-dqf.test.ts already proves the DATA makes no claim: summarise()
 * returns counts and a date and no boolean. That leaves the one place the claim
 * could still get made — the page that renders it. A single word typed into the
 * markup ("…and this driver is compliant") would undo the whole design, and it
 * would do it silently, because nothing in TypeScript objects to a string.
 *
 * So this reads the page as text. That is a blunt instrument and it is chosen on
 * purpose: the binder is one file, its vocabulary is the product, and a test
 * that renders Astro to assert on the DOM would need a build step to catch a
 * thing a substring match catches for free.
 *
 * The ban covers comments too. A verdict word sitting in a comment explaining
 * why we do not use it is one careless copy-paste away from being markup, and
 * the rule is easier to keep when it has no exceptions to remember.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BINDER = fileURLToPath(new URL('../src/pages/app/drivers/[id]/file.astro', import.meta.url))

const source = await readFile(BINDER, 'utf8')

test('the binder never claims a verdict', () => {
  // Word boundaries matter. "certification of compliance" is in the footer
  // DISCLAIMING one, and "Medical examiner's certificate" is the name of a
  // statutory item — neither is a claim, and a loose match would ban both.
  const banned = [
    /\bcompliant\b/i,
    /\bverified\b/i,
    /\bverif(?:y|ies)\b/i,
    /\bcertified\b/i,
    /\bin good standing\b/i,
    /\bfully qualified\b/i,
  ]

  for (const pattern of banned) {
    const hit = source.match(pattern)
    assert.equal(
      hit,
      null,
      `the binder must not say "${hit?.[0]}" — a packet a carrier generates about ` +
        'himself is structurally untrusted, and a verdict makes the whole document ' +
        'read as marketing',
    )
  }
})

test('the binder says what it is not', () => {
  // The footer is load-bearing: a document that states dated observations and
  // omits the disclaimer will be read as the certification it declines to be.
  assert.match(source, /not a certification/i)
  assert.match(source, /not affiliated with FMCSA, the DOT, or any government agency/)
})

test('an item we cannot evaluate reads as not known, never as satisfied', () => {
  // The five states come from dqf.ts; these are the words printed for them. The
  // failure this guards is the tempting one — labelling `unknown` as "N/A" or
  // "—", which reads as "nothing to do here" to somebody skimming a printout.
  assert.match(source, /unknown:\s*'Not known'/)
  assert.match(source, /missing:\s*'Not on file'/)
  assert.match(source, /expired:\s*'Expired'/)
})

test('the print rules the document exists for are actually present', () => {
  // Each of these is a defect somebody would only find after printing: app
  // navigation across the top of a legal record, an item split over a page
  // boundary, a colour-coded badge printed as grey mush on a mono laser.
  assert.match(source, /@media print/)
  assert.match(source, /@page\s*\{[^}]*margin/)
  assert.match(source, /break-inside:\s*avoid/)
  assert.match(source, /body > header/, 'the app nav must be hidden in print')
  assert.match(source, /\[data-screen-only\]/, 'the print button must hide itself')
})

test('the PDF is the browser’s, not ours', () => {
  // Native PDF libraries want a filesystem and a font cache; the Cloudflare
  // Workers runtime has neither. If this assertion ever fails because somebody
  // added a server-side renderer, the deploy would have failed anyway — this
  // just says so in a test rather than in production.
  assert.match(source, /window\.print\(\)/)
})
