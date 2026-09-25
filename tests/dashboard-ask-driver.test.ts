/**
 * "Ask the driver" from the dashboard: the one press that replaces the phone
 * call.
 *
 * The card on `?show=unknown` already says "Driver · 3 dates missing". Before
 * this it offered one thing — a link to type them in — which assumes the owner
 * is holding paperwork that is in the driver's wallet. The menu on that card
 * now sends the driver a link asking for exactly those dates.
 *
 * WHAT THESE PIN, in order of how much damage getting it wrong would do:
 *
 *   1. The dashboard never takes the asks out of the request body. A posted ask
 *      key would be an owner nominating what an unauthenticated phone may write
 *      into, and the one key that must never be on that list is the return-to-
 *      duty test date (49 CFR 40.307(g)).
 *   2. There is ONE send path. Two copies of a handler that mints a bearer
 *      credential and texts it to a person is two places to get the expiry, the
 *      supersede or the failure message wrong.
 *   3. The button is not inside the form it appears to be inside. The date
 *      editor is one big form; a nested form is invalid HTML that browsers
 *      resolve by silently dropping the inner one.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  ASK_KEYS,
  answerKeyForAsk,
  asksForAnswerKeys,
  DRIVER_ASKS,
} from '../src/lib/driver-link/asks.ts'
import { DRIVER_ANCHORS } from '../src/lib/rules/driver-anchors.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// Missing dates → what the driver can be asked for
// ---------------------------------------------------------------------------

test('the dashboard’s own answer keys map onto the six asks, licence included', () => {
  // Every ask is reachable from the key the dashboard would hold for it.
  for (const ask of DRIVER_ASKS) {
    assert.deepEqual(
      asksForAnswerKeys([answerKeyForAsk(ask)]),
      [ask.key],
      `${ask.key} is not reachable from ${answerKeyForAsk(ask)}`,
    )
  }

  // The licence is the one that is not an anchor — it is a column on the
  // driver, projected into the engine as `cdl_expires` by src/lib/deadlines.ts.
  // Miss this and a driver whose only missing date is his licence, which is the
  // most common missing date there is, offers no ask at all.
  assert.deepEqual(asksForAnswerKeys(['cdl_expires']), ['cdl'])

  // Order follows the catalogue, not the order the dashboard happened to list
  // them, so the message a driver gets reads the same from either screen.
  const shuffled = asksForAnswerKeys(
    ['vision', 'medical_certificate_expires'].concat(['cdl_expires']),
  )
  assert.deepEqual(shuffled, ['medical', 'cdl'])
  assert.ok(ASK_KEYS.indexOf('medical') < ASK_KEYS.indexOf('cdl'))
})

test('a key nobody can be asked for returns nothing, and 40.307(g) is one of them', () => {
  assert.deepEqual(asksForAnswerKeys([]), [])
  assert.deepEqual(asksForAnswerKeys(['not_a_key']), [])

  // THE ONE THAT MUST NEVER PASS. 49 CFR 40.307(g): the carrier must not be
  // told the return-to-duty test date, so it cannot be on a driver's phone.
  assert.deepEqual(asksForAnswerKeys(['return_to_duty_test_date']), [])

  // And the things the CARRIER performs — he cannot ask a driver to send back
  // a query he has to run himself.
  for (const key of [
    'annual_mvr_last_obtained',
    'annual_review_last_completed',
    'clearinghouse_query_last_run',
  ]) {
    assert.deepEqual(asksForAnswerKeys([key]), [], key)
  }

  // Derived rather than listed: a new driver anchor added tomorrow is outside
  // the ask catalogue until somebody puts it in, which is the safe default.
  const askable = new Set(DRIVER_ASKS.map(answerKeyForAsk))
  for (const anchor of DRIVER_ANCHORS) {
    if (askable.has(anchor.key)) continue
    assert.deepEqual(asksForAnswerKeys([anchor.key]), [], `${anchor.key} must not be askable`)
  }

  // A whole driver's worth of missing dates, mixed: only the askable survive.
  assert.deepEqual(
    asksForAnswerKeys([
      'medical_certificate_expires',
      'return_to_duty_test_date',
      'annual_mvr_last_obtained',
      'cdl_expires',
    ]),
    ['medical', 'cdl'],
  )
})

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

test('the dashboard derives what to ask for and takes only the driver from the body', () => {
  const page = read('../src/pages/app/index.astro')

  // The subject has to be one THIS page built, so a driver id that is not on
  // the screen cannot be asked about at all.
  assert.match(page, /const subject = actionIndex\.get\(driverId\)/)

  // AND THE INDEX IS NOT THE DATE EDITOR'S. `editor` is `items.filter(standing
  // === 'unknown')`; building the actions on it made the SERVER believe "can be
  // texted" meant "is missing a date", so a driver whose medical card expired
  // eight days ago — the man most worth texting — got "that driver is not on
  // this list any more" from every intent.
  assert.match(page, /const actionIndex = buildActionIndex\(items, carrierId\)/)
  assert.doesNotMatch(page, /editor\.subjects\.find/)
  assert.doesNotMatch(page, /askTargetsFor\(editor\.subjects\)/)

  // And he is asked for what he still OWES, not for every paper he has.
  assert.match(page, /const dated = asksForAnswerKeys\(subject\.needKeys\)/)
  // EVERY DRIVER CAN BE TEXTED. Where none of his missing dates is one of the
  // six dated papers, the link carries the dateless seventh (0042) and the page
  // he opens is the free upload box. The button used to be absent there, which
  // on dev meant four of six carriers had no way to text anybody at all.
  assert.match(page, /const asks = dated\.length > 0 \? dated : \[ANYTHING_ASK\]/)

  // Nothing about WHAT to ask for is read out of the request.
  assert.doesNotMatch(page, /form\.getAll\('ask'\)/, 'the dashboard must not accept posted asks')
  assert.doesNotMatch(page, /form\.get\('ask'\)/)

  // And the id is checked before it reaches Postgres, or a hand-edited body
  // puts "invalid input syntax for type uuid" across the top of his dashboard.
  assert.match(page, /if \(!UUID\.test\(driverId\)\) return to\(here\(''\)\)/)
})

test('the driver page and the dashboard send through the same function', () => {
  const action = read('../src/lib/driver-link/ask-action.ts')
  // The mint and the send live here, and nowhere else.
  assert.match(action, /mintDriverLink\(/)
  assert.match(action, /deliverDriverLink\(/)
  // The phone number is read here, not taken from a form on either screen.
  assert.match(action, /\.from\('drivers'\)\n?\s*\.select\('first_name, phone, email'\)/)

  for (const path of ['../src/pages/app/index.astro', '../src/pages/app/drivers/[id].astro']) {
    const page = read(path)
    assert.match(page, /askDriver\(\{/, `${path} calls the shared action`)
    assert.doesNotMatch(page, /mintDriverLink\(/, `${path} must not mint its own link`)
    assert.doesNotMatch(page, /deliverDriverLink\(/, `${path} must not send its own message`)
  }
})

test('what happened comes back as a code and a driver id, never a phone number', () => {
  const page = read('../src/pages/app/index.astro')
  assert.match(page, /const ASKED_OUTCOMES = \['sms', 'email', 'none', 'failed'\] as const/)
  assert.match(page, /ASKED_OUTCOMES\.find\(\(o\) => o === params\.get\('asked'\)\) \?\? null/)
  assert.match(page, /&asked=\$\{asked\.outcome\}&who=\$\{encodeURIComponent\(driverId\)\}/)
  // The token never rides back to the dashboard: there is nowhere on this
  // screen to show it, and a live credential in browser history is what
  // 0026 exists to stop.
  assert.doesNotMatch(page, /minted=/)

  // A send that did not go is not an error and is not printed in red. The link
  // is minted and valid; TWILIO_* is unset until 10DLC clears.
  assert.match(page, /askedOutcome === 'sms' \|\| askedOutcome === 'email' \? 'ok' : 'note'/)
})

// ---------------------------------------------------------------------------
// The markup
// ---------------------------------------------------------------------------

test('the ask button is not nested inside the date editor’s form', () => {
  const page = read('../src/pages/app/index.astro')
  const menu = read('../src/components/DateSubjectActions.astro')

  // One form PER INTENT, all rendered outside the editor, and every button
  // points at one of them by id. The button's own name and value are spoken
  // for by the subject id, so the intent has to be a hidden input — and a
  // hidden input can only say one thing, which is why there are four.
  assert.match(page, /const ACTION_FORMS = \{/)
  for (const [key, intent] of [
    ['ask', 'ask_driver_dates'],
    ['remind', 'remind_me_later'],
    ['retire', 'retire_driver'],
    ['askAll', 'ask_all_drivers'],
  ]) {
    assert.match(
      page,
      new RegExp(`id=\\{ACTION_FORMS\\.${key}\\}[\\s\\S]{0,120}value="${intent}"`),
      `${key} posts ${intent}`,
    )
  }
  assert.match(menu, /form=\{forms\.ask\}/)
  assert.match(menu, /form=\{forms\.remind\}/)
  assert.match(menu, /form=\{forms\.retire\}/)
  assert.match(menu, /name="driver_id"\s+value=\{subject\.id\}/)

  // The card is the disclosure now. A button inside a link is invalid HTML,
  // and <summary> only controls the <details> when it is its FIRST child — so
  // the name, the count and the menu are one card and the editor link is the
  // first item inside it.
  assert.match(menu, /<details/)
  assert.match(menu, /<summary/)
  assert.match(menu, /Type the dates in/)
  assert.doesNotMatch(page, /<a[^>]*href=\{subjectHrefFor\(subject\.id\)\}/)
})

test('an open menu never covers the next card’s button', () => {
  // THE TRAP THIS REPLACED. An absolutely positioned panel sits over the row
  // beneath it, so the next tap lands on the open panel and appears to do
  // nothing — twice. Closing on an outside click needs a document listener and
  // this app ships one script, for forms. A panel in the normal flow pushes the
  // list down instead, and needs nothing.
  const menu = read('../src/components/DateSubjectActions.astro')
  assert.doesNotMatch(menu, /\babsolute\b/, 'the panel must stay in the normal flow')
  assert.doesNotMatch(menu, /\bz-\d/, 'nothing here is stacked over anything')

  // The focused header puts it under the heading rather than beside it, so the
  // panel has the width to be read on a phone and pushes the form down instead
  // of covering the first date box.
  const page = read('../src/pages/app/index.astro')
  assert.match(page, /variant="inline"/)
  assert.match(menu, /'mt-3 max-w-sm'/)
})

test('the menu offers only what will actually happen', () => {
  const menu = read('../src/components/DateSubjectActions.astro')

  // The note under the button comes from the SAME reachFor the send uses, so
  // "Goes by text" cannot appear over a driver with no number on file.
  assert.match(menu, /reach\?\.channel === 'sms'/)
  assert.match(menu, /reach\?\.channel === 'email'/)
  assert.match(menu, /No number and no email on file/)

  // The note also says WHAT it asks for, which is not the same sentence in the
  // two cases: his dated papers when he owes any, and otherwise an open ask.
  assert.match(menu, /Asks for their \$\{askWhat\}/)
  assert.match(menu, /Asks them to send whatever you need/)

  // Only a driver is ever asked. A truck cannot answer a text.
  assert.match(menu, /const isDriver = subject\.type === 'driver'/)
  // And EVERY driver can be, with no condition on what he happens to be missing.
  assert.doesNotMatch(menu, /None of these are things/)

  assert.doesNotMatch(menu, /askable\.length/)

  // The two lookups behind the note are no longer gated to one view. Gated,
  // they were empty maps everywhere else, and the menu would have printed
  // "no number and no email on file" over drivers whose numbers we hold.
  const page2 = read('../src/pages/app/index.astro')
  assert.match(page2, /const hasDrivers = \[\.\.\.actionIndex\.values\(\)\]\.some/)
  assert.doesNotMatch(page2, /view === 'unknown' && editor\.subjects\.some/)

  // Contact details are read whenever the carrier has a driver at all. This
  // used to be gated on the view, which is how a menu comes to offer what it
  // cannot do — see the assertions above.
  assert.match(page2, /if \(hasDrivers\) \{/)
})

test('the menu needs no JavaScript, because this app ships almost none', () => {
  const menu = read('../src/components/DateSubjectActions.astro')
  assert.doesNotMatch(menu, /<script/, 'a menu that needs script is dead on a bad connection')
  assert.doesNotMatch(menu, /onclick|addEventListener/)
  // The inline variant's summary is read with no row around it, so it says
  // whose actions these are.
  assert.match(menu, /<span class="sr-only">for \{subject\.label\}<\/span>/)
})
