/**
 * The driver record form is folded away. These are the three things that must
 * not break because of it.
 *
 * The form is twelve fields the owner corrects about once a year, sitting at the
 * top of a page he opens to read a medical card date, so it now lives inside a
 * `<details>`. Collapsing a form is cheap to do and has three expensive ways to
 * go wrong, none of which shows up on screen:
 *
 *   1. A REFUSED SAVE BEHIND A CLOSED FOLD. The error prints at the top of the
 *      page and the form that caused it is not on screen. He is told no and has
 *      nothing to correct.
 *   2. A RENAMED FIELD. The POST handler dispatches on `name=` and on the intent
 *      value. Rename one and the column silently stops being written — the save
 *      still reports "Saved.", the page still shows the old value, and nothing
 *      anywhere says a field was dropped.
 *   3. A FIELD OUTSIDE THE FORM. Markup moved around a `<details>` is easy to
 *      leave outside the `<form>` it belongs to, and an input outside a form is
 *      not posted at all. Same silence as (2).
 *
 * All three are checked against the page source, because there is no rendering
 * of this page in the test suite and these are properties of the markup.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const PAGE = readFileSync(new URL('../src/pages/app/drivers/[id].astro', import.meta.url), 'utf8')

/**
 * Every column `save_driver` writes, and the box each one is typed into.
 *
 * Kept as a literal list rather than derived from anything: the point is to fail
 * when the page and the handler stop agreeing, and a list generated from one of
 * them would follow whichever it was generated from.
 */
const POSTED_FIELDS = [
  'first_name',
  'last_name',
  'phone',
  'email',
  'cdl_number',
  'cdl_state',
  'cdl_expires_on',
  'hired_on',
  'date_of_birth',
  'status',
]

test('every field the save handler reads is still on the page under the same name', () => {
  for (const name of POSTED_FIELDS) {
    assert.ok(
      PAGE.includes(`name="${name}"`),
      `no box named "${name}" — the handler writes that column and would now write nothing`,
    )
  }
})

test('the handler still reads every field the page posts', () => {
  // The other direction. A box nobody reads is a field the owner fills in and
  // watches disappear on the next page load.
  for (const name of POSTED_FIELDS) {
    assert.ok(
      PAGE.includes(`'${name}'`) || PAGE.includes(`${name}:`),
      `"${name}" is on the form and not in the handler`,
    )
  }
})

test('the save button still carries the intent the handler dispatches on', () => {
  assert.ok(PAGE.includes('value="save_driver"'), 'the record form no longer says what it is')
  assert.ok(PAGE.includes("intent === 'save_driver'"), 'nothing handles save_driver any more')
})

test('every field sits inside the form, and the form inside the fold', () => {
  const fold = PAGE.indexOf('<details open={recordOpen}')
  const form = PAGE.indexOf('<form method="POST"', fold)
  const button = PAGE.indexOf('value="save_driver"')
  const foldEnd = PAGE.indexOf('</details>', fold)

  assert.ok(fold > -1, 'the record is no longer behind a details')
  assert.ok(form > fold && form < foldEnd, 'the record form is not inside the fold')
  assert.ok(button > form && button < foldEnd, 'the save button is not inside the fold')

  for (const name of POSTED_FIELDS) {
    const at = PAGE.indexOf(`name="${name}"`)
    assert.ok(at > form, `"${name}" is before the <form> tag, so it would not be posted`)
    assert.ok(at < button, `"${name}" is after the save button, outside the form`)
  }
})

test('the fold opens by itself when a save was refused', () => {
  // The whole guarantee, in one line of the page: every refusal on this page
  // redirects with `?error=`, and the fold is open whenever that is set. A
  // condition naming one particular failure would go stale the next time
  // somebody adds a way to refuse a save.
  assert.match(
    PAGE,
    /const recordOpen = error !== null/,
    'the fold no longer opens on an error, so a refused save has nothing to correct',
  )
  assert.ok(
    PAGE.includes('<details open={recordOpen}'),
    'the fold is not wired to recordOpen',
  )
  assert.match(
    PAGE,
    /const error = params\.get\('error'\)/,
    'recordOpen reads an `error` that is no longer the page error',
  )
})

test('the closed fold still shows what the page is opened to read', () => {
  // Collapsing is only worth doing if nothing he came for disappears. The
  // summary keeps the number to ring him on and the day his licence runs out.
  const fold = PAGE.indexOf('<details open={recordOpen}')
  const summaryEnd = PAGE.indexOf('</summary>', fold)
  const summary = PAGE.slice(fold, summaryEnd)

  assert.ok(summary.includes('formatPhone(driver.phone)'), 'the closed record hides the phone')
  assert.ok(summary.includes('driver.cdl_expires_on'), 'the closed record hides the CDL expiry')
  assert.ok(
    summary.includes('phoneUndialable'),
    'a number we cannot text goes quiet behind the fold',
  )
})

test('the way off the page is not behind the fold', () => {
  // Both links used to live in the form's own button row. Left there they would
  // only exist once an edit form was open — and for a driver who is not active
  // there is no ring card either, so the qualification file would have no link
  // to it at all.
  const foldEnd = PAGE.indexOf('</details>')
  assert.ok(
    PAGE.indexOf('Qualification file') > foldEnd,
    'the qualification file link is inside the fold',
  )
  assert.ok(PAGE.indexOf('Back to drivers') > foldEnd, 'the way back is inside the fold')
})
