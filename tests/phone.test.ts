import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toE164 as toE164ViaClaims } from '../src/lib/claims.ts'
import { formatPhone, parsePhone, parsePhoneEdit, toE164 } from '../src/lib/phone.ts'

/** Narrow to the accepted case, so a refusal fails here rather than as `undefined`. */
function accepted(raw: string | null): string | null {
  const parsed = parsePhone(raw)
  assert.equal(parsed.ok, true, `expected ${JSON.stringify(raw)} to be accepted`)
  if (!parsed.ok) throw new Error('unreachable')
  return parsed.value
}

function refused(raw: string): string {
  const parsed = parsePhone(raw)
  assert.equal(parsed.ok, false, `expected ${JSON.stringify(raw)} to be refused`)
  if (parsed.ok) throw new Error('unreachable')
  return parsed.message
}

test('there is one phone parser, not two', () => {
  // The reason this module exists. The claim flow and the driver form asking two
  // different questions about the same column is how an alert gets queued
  // against a number the provider then refuses, hours after the page said it
  // was sent. claims.ts re-exports rather than keeping a copy.
  assert.equal(toE164ViaClaims, toE164)
})

test('a blank phone is still a perfectly good answer', () => {
  // "A name is enough. The rest can follow the paperwork." A required phone box
  // is a box somebody invents a number for, and an invented number is worse
  // than none because it reads as answered.
  for (const raw of ['', '   ', null]) {
    assert.equal(accepted(raw), null, `expected ${JSON.stringify(raw)} → null`)
  }
})

test('one number typed four ways is stored as one string', () => {
  for (const raw of ['(818) 334-0168', '818.334.0168', '8183340168', '1-818-334-0168']) {
    assert.equal(accepted(raw), '+18183340168', `from ${raw}`)
  }
})

test('a box with letters in it never reaches the column as typed', () => {
  // The audit's case, and the invariant that actually matters: whatever is
  // stored is dialable. Each of these either resolves to one unambiguous NANP
  // number or is refused outright — none of them survives into the column as a
  // string somebody would later try to send a compliance alert to.
  for (const raw of ['818-334-0168 ext 2', 'call cell 818 334 0168', 'n/a', 'ask dispatch']) {
    const parsed = parsePhone(raw)
    if (parsed.ok) assert.match(String(parsed.value), /^\+1[2-9]\d{9}$/, `from ${raw}`)
  }
})

test('a number we cannot reach is refused instead of stored', () => {
  // 'n/a' and 'ask dispatch' hold no number at all; an extension leaves eleven
  // digits that are not a NANP number. Storing any of them is an office manager
  // who believes she has a way to reach that driver and has not.
  for (const raw of ['818-334-0168 ext 2', 'n/a', 'ask dispatch', '12345', '(818) 334-016']) {
    assert.match(refused(raw), /could not read that as a number we can dial/, `from ${raw}`)
  }
})

test('a label beside a clean ten digits is dropped, not argued about', () => {
  // The other half of the trade. 'call cell 818 334 0168' contains exactly one
  // number and no ambiguity, and refusing a perfectly clear answer is how a form
  // teaches somebody that it is broken. The label comes off; the number stays.
  assert.equal(accepted('call cell 818 334 0168'), '+18183340168')
  assert.equal(accepted('Bob — 818.334.0168'), '+18183340168')
  // Two numbers in one box is ambiguous and stays refused: picking one for her
  // would be us choosing which line a deadline reminder goes to.
  assert.match(refused('818-334-0168 or 818-334-0169'), /could not read/)
})

test('the refusal names the field, so one sentence serves both forms', () => {
  const parsed = parsePhone('nope', 'Dispatch phone')
  assert.equal(parsed.ok, false)
  if (parsed.ok) throw new Error('unreachable')
  assert.match(parsed.message, /^Dispatch phone: /)
})

test('storage is E.164 and display is not', () => {
  // Deliberately different. E.164 is what a provider needs and what makes two
  // spellings compare equal; it is also what nobody recognises as their own
  // driver's line on a roster of forty.
  assert.equal(formatPhone('+18183340168'), '(818) 334-0168')
  assert.equal(formatPhone(accepted('818.334.0168')), '(818) 334-0168')
  // Round-trips: what the input renders is what the form may post straight back.
  assert.equal(accepted(formatPhone('+18183340168')), '+18183340168')
})

test('a number stored before the form normalised is shown as it stands, never blanked', () => {
  // Rows written earlier are still real numbers. Rendering them as empty would
  // look like data loss on a screen whose job is to be trusted.
  assert.equal(formatPhone('818-334-0168 ext 2'), '818-334-0168 ext 2')
  assert.equal(formatPhone(null), '')
})

/**
 * The edit-form rule. Same shape, one extra argument: the column as it stands.
 *
 * The helper under test is what stops a save being refused over a field nobody
 * touched, so these submit what the FORM WOULD POST — `formatPhone(stored)` —
 * not the raw column. Posting the column would be a test that passes on a helper
 * that is broken in the exact way this exists to prevent.
 */
function editAccepted(raw: string | null, stored: string | null): string | null {
  const parsed = parsePhoneEdit(raw, stored)
  assert.equal(parsed.ok, true, `expected ${JSON.stringify(raw)} to be accepted`)
  if (!parsed.ok) throw new Error('unreachable')
  return parsed.value
}

function editRefused(raw: string, stored: string | null): string {
  const parsed = parsePhoneEdit(raw, stored)
  assert.equal(parsed.ok, false, `expected ${JSON.stringify(raw)} to be refused`)
  if (parsed.ok) throw new Error('unreachable')
  return parsed.message
}

test('an untouched legacy number survives a save byte for byte', () => {
  // The whole reason this helper exists. Every phone on the fleet today is a
  // seven-digit placeholder that the strict parser refuses, and the save
  // handlers refuse the WHOLE submit on a bad phone — so an owner opening a
  // driver to type a MEDICAL CARD DATE was blocked on a field she never touched.
  // Grandfathered through, and through UNCHANGED: silently rewriting it would
  // make the record disagree with the paperwork the office is working from.
  for (const stored of ['555-0142', '555-0101', 'ask dispatch', '818-334-0168 ext 2']) {
    assert.equal(editAccepted(formatPhone(stored), stored), stored, `from ${stored}`)
  }
})

test('the same legacy number edited to something undialable is still refused', () => {
  // The mercy is for the value she did not touch, not for the column. Once she
  // has typed in that box she is telling us a number, and a number we cannot
  // dial has to come back to her now rather than as a reminder that never
  // arrives — the strict parser's sentence, word for word.
  assert.match(editRefused('555-0143', '555-0142'), /could not read that as a number we can dial/)
  assert.match(editRefused('555-0142 ext 4', '555-0142'), /could not read/)
  // Even a near-miss on the same digits is a change, because we cannot tell an
  // intended correction from a typo and only one of them is safe to keep.
  assert.match(editRefused('(555) 0142', '555-0142'), /could not read/)
})

test('a blank stays a perfectly good answer on an edit form too', () => {
  // Clearing the box is how a wrong number gets removed. If blank were treated
  // as "unchanged" and refilled from the column, the legacy value would be
  // unremovable — the advisory beside the field would be asking for a fix the
  // form refuses to accept.
  for (const raw of ['', '   ', null]) {
    assert.equal(editAccepted(raw, '555-0142'), null, `expected ${JSON.stringify(raw)} → null`)
    assert.equal(editAccepted(raw, '+18183340168'), null, `expected ${JSON.stringify(raw)} → null`)
  }
})

test('a good number still normalises to E.164 on an edit form', () => {
  // Grandfathering is a last resort, not a second opinion: anything dialable is
  // settled by the strict parser and reaches the column in one spelling, so two
  // spellings of one number still compare equal.
  for (const raw of ['(818) 334-0168', '818.334.0168', '8183340168', '1-818-334-0168']) {
    assert.equal(editAccepted(raw, '555-0142'), '+18183340168', `from ${raw}`)
    assert.equal(editAccepted(raw, null), '+18183340168', `from ${raw}`)
  }
})

test('unchanged is measured against what the form showed, not against the column', () => {
  // THE TRAP. The edit forms render `value={formatPhone(driver.phone)}`, so the
  // browser posts the DISPLAYED string back. Compare that against the raw column
  // and an untouched field reads as changed — which is the refusal this helper
  // was written to stop, passing every other test on the way through.
  //
  // A stored value the strict parser cannot read comes back from `formatPhone`
  // TRIMMED, so the column and its own rendering differ by the whitespace:
  const stored = '  555-0142  '
  assert.equal(formatPhone(stored), '555-0142', 'the form shows it trimmed')
  assert.notEqual(formatPhone(stored), stored, 'and that is not what the column holds')
  // Posted back untouched, it is recognised as unchanged and the COLUMN is what
  // goes back — padding and all, because we were not asked to change it.
  assert.equal(editAccepted('555-0142', stored), stored)

  // The other half of the same trap: a stored value the parser CAN read is shown
  // in a spelling the column has never held. It never reaches the comparison —
  // the strict parse settles it first — and it must not be refused for it.
  assert.equal(formatPhone('8183340168'), '(818) 334-0168')
  assert.equal(editAccepted('(818) 334-0168', '8183340168'), '+18183340168')
})

test('a missing stored value gives the edit form no legacy to lean on', () => {
  // Nothing was there, so nothing was untouched. A number typed into an empty
  // box is new, and new means strict — otherwise the grandfathering would apply
  // to the add form by the back door.
  assert.match(editRefused('ask dispatch', null), /could not read/)
  assert.match(editRefused('555-0142', null), /could not read/)
  // An empty column renders an empty box, and an empty box is blank rather than
  // "unchanged" — blank is the first branch and must never resolve to a column.
  assert.equal(editAccepted('', null), null)
})

test('the edit refusal names the field, so one sentence serves both forms', () => {
  const parsed = parsePhoneEdit('nope', '555-0142', 'Dispatch phone')
  assert.equal(parsed.ok, false)
  if (parsed.ok) throw new Error('unreachable')
  assert.match(parsed.message, /^Dispatch phone: /)
})
