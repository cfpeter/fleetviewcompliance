import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  normalizeVin,
  parseVin,
  parseVinEdit,
  VIN_MIN_LENGTH,
  VIN_MODERN_LENGTH,
  vinCheckDigit,
  vinCheckDigitMismatch,
} from '../src/lib/vehicles.ts'

/** A real-shape 17-character VIN with a correct check digit at position 9. */
const GOOD = '1FUJGLD54FLGF1234'

/** Narrow to the accepted case, so a refusal fails here rather than as `undefined`. */
function accepted(raw: string): string | null {
  const parsed = parseVin(raw)
  assert.equal(parsed.ok, true, `expected ${JSON.stringify(raw)} to be accepted`)
  if (!parsed.ok) throw new Error('unreachable')
  return parsed.value
}

/** Narrow to the refusal, and hand back the sentence so a test can read it. */
function refused(raw: string): string {
  const parsed = parseVin(raw)
  assert.equal(parsed.ok, false, `expected ${JSON.stringify(raw)} to be refused`)
  if (parsed.ok) throw new Error('unreachable')
  return parsed.message
}

// --- normalisation ----------------------------------------------------------

test('a blank VIN stays blank rather than becoming an empty string', () => {
  // '' is a VALUE to the partial unique index on VIN, so two trucks saved with
  // the box untouched would collide over a VIN neither of them has. The VIN is
  // also optional by design — the owner may have to walk to the door for it.
  for (const raw of ['', '   ', '  -  ', null]) {
    assert.equal(accepted(raw as unknown as string), null, `expected ${JSON.stringify(raw)} → null`)
  }
})

test('case is normalised so one VIN has one spelling', () => {
  assert.equal(accepted(GOOD.toLowerCase()), GOOD)
  assert.equal(accepted(`  ${GOOD.toLowerCase()}  `), GOOD)
})

test('spaces and hyphens come out, because that is how a VIN is typed off a door plate', () => {
  assert.equal(accepted('1FUJ GLD5 4FLG F1234'), GOOD)
  assert.equal(accepted('1FUJ-GLD5-4FLG-F1234'), GOOD)
  assert.equal(accepted(' 1fuj gld5-4flg f1234 '), GOOD)
})

test('two differently-typed spellings of one VIN collide, which is what the dedupe index needs', () => {
  // THE WHOLE POINT. `vehicles_vin_unique` is a STRING comparison, so without
  // this the same tractor goes in twice — once typed in chunks, once not — and
  // nothing on screen says so. Every spelling below has to reduce to one value.
  const spellings = [GOOD, GOOD.toLowerCase(), '1FUJ GLD5 4FLG F1234', '1fuj-gld5-4flg-f1234']
  const distinct = new Set(spellings.map((s) => accepted(s)))
  assert.equal(distinct.size, 1, `expected one stored value, got ${[...distinct].join(', ')}`)
  assert.equal(normalizeVin('1fuj gld5-4flg f1234'), GOOD)
})

// --- the letters the standard left out --------------------------------------

test('I, O and Q are refused in a 17-character VIN', () => {
  // 49 CFR 565 leaves them out precisely so they cannot be confused with 1 and
  // 0, which means no manufacturer stamped one. At seventeen characters an I in
  // the box was typed by a person reading a dirty plate.
  for (const letter of ['I', 'O', 'Q']) {
    const vin = `${letter}${GOOD.slice(1)}`
    assert.match(refused(vin), /never contains the letter/)
  }
})

test('the refusal names the letter it found, so the owner knows where to look', () => {
  // Word boundary rather than a trailing space: the sentence was rewritten into
  // plain English and the letter now ends a clause, so it is followed by a full
  // stop. What has to hold is that the message NAMES the offending letter.
  assert.match(refused(`I${GOOD.slice(1)}`), /letter I\b/)
  assert.match(refused(`O${GOOD.slice(1)}`), /letter O\b/)
})

test('an I typed for a 1 is caught rather than stored', () => {
  // The audit's case, and the most common one: '1' read off a plate as 'I'.
  // Storing it is a truck CARB and the inspection record will never match.
  assert.match(refused('IFUJGLD54FLGF1234'), /never contains the letter/)
})

test('a pre-1981 serial may keep its I and O, because the standard did not exist yet', () => {
  // Below 17 characters we are looking at something built before the rule, and
  // refusing an O there would be enforcing the rule against the one case short
  // VINs exist for — the 1978 trailer that is still in the yard.
  assert.equal(accepted('F10GLO12345'), 'F10GLO12345')
  assert.equal(accepted('CCL83I1234'), 'CCL83I1234')
})

// --- length -----------------------------------------------------------------

test('a three-character VIN is a typo and is refused', () => {
  // Filed by the audit as "silently accepted". A stub like this looks answered
  // on screen and matches nothing, forever.
  assert.match(refused('ABC'), /only 3 characters/)
  assert.match(refused('1'), /only 1 character\./)
})

test('everything below the floor is refused and everything at it is kept', () => {
  assert.equal(VIN_MIN_LENGTH, 8)
  for (let n = 1; n < VIN_MIN_LENGTH; n++) {
    assert.match(refused('A'.repeat(n)), /Half a VIN is worse than none/, `length ${n}`)
  }
  assert.equal(accepted('A'.repeat(VIN_MIN_LENGTH)), 'A'.repeat(VIN_MIN_LENGTH))
})

test('a pre-1981 length is accepted rather than gatekept', () => {
  // The deliberate looseness. An eleven-character 1970s serial is rare and real,
  // and the record still gets every deadline it is owed either way — so the cost
  // of turning one away is real and the cost of allowing it is nothing.
  for (const legacy of ['F10GLU12345', '1G1AY87K3E5123', 'CCL8311234']) {
    assert.equal(accepted(legacy), legacy)
  }
})

test('longer than seventeen is a doubled paste, not a VIN', () => {
  assert.equal(VIN_MODERN_LENGTH, 17)
  assert.match(refused(`${GOOD}5`), /longer than 17/)
  assert.match(refused(GOOD + GOOD), /longer than 17/)
})

test('anything that is not a letter or a digit is refused', () => {
  // Hyphens and spaces are stripped first, so what lands here is a paste of
  // something that was never a VIN.
  for (const raw of ['1FUJGLD54FLGF123*', '1FUJ/GLD54FLGF124', '1FUJGLD54FLGF12_4']) {
    assert.match(refused(raw), /letters and digits only/)
  }
})

// --- the check digit --------------------------------------------------------

test('the check digit is computed off the other sixteen characters', () => {
  assert.equal(vinCheckDigit(GOOD), GOOD[8])
  // Case and punctuation must not change the answer, or the advisory would fire
  // on a VIN the owner typed in chunks.
  assert.equal(vinCheckDigit('1fuj-gld5-4flg-f1234'), GOOD[8])
})

test('there is no check digit to compute on anything but a 17-character VIN', () => {
  assert.equal(vinCheckDigit('F10GLU12345'), null)
  assert.equal(vinCheckDigit(''), null)
  // I, O and Q have no transliteration value at all — that is why they are out.
  assert.equal(vinCheckDigit('IFUJGLD54FLGF1234'), null)
})

test('a wrong check digit is flagged but never refused', () => {
  // The decision worth defending: a failed check digit is usually a typo, and
  // "usually" is not "always". Small trailer builders ship VINs that fail this
  // arithmetic, and refusing would lock a real unit out of the product over its
  // manufacturer's mistake. So it is advisory and the save still goes through.
  const wrong = `${GOOD.slice(0, 8)}${GOOD[8] === '0' ? '1' : '0'}${GOOD.slice(9)}`
  assert.equal(vinCheckDigitMismatch(wrong), true)
  assert.equal(accepted(wrong), wrong, 'a failed check digit must still save')
})

test('nothing without a check digit is ever flagged as failing one', () => {
  // A pre-1981 serial has no check digit. Flagging one for failing a test that
  // did not exist when it was stamped is how an owner learns to ignore the flag.
  assert.equal(vinCheckDigitMismatch(GOOD), false)
  assert.equal(vinCheckDigitMismatch('F10GLU12345'), false)
  assert.equal(vinCheckDigitMismatch(null), false)
  assert.equal(vinCheckDigitMismatch(''), false)
})

test('the check digit catches a single wrong character', () => {
  // What it is actually for: one character copied wrong off a door plate. Not
  // every slip changes the checksum, but most do, which is the whole value.
  let tried = 0
  let caught = 0
  for (let i = 0; i < GOOD.length; i++) {
    if (i === 8) continue // position 9 IS the check digit
    for (const d of '0123456789') {
      if (d === GOOD[i]) continue
      tried++
      if (vinCheckDigitMismatch(`${GOOD.slice(0, i)}${d}${GOOD.slice(i + 1)}`)) caught++
    }
  }
  // The checksum is mod 11, so roughly ten in eleven single-character slips move
  // it. Anything far below that means the transliteration table or the weights
  // are wrong — and a check digit that agrees with everything warns about
  // nothing, which is worse than not computing one.
  assert.ok(
    caught / tried > 0.85,
    `expected most single-character typos to be caught, got ${caught}/${tried}`,
  )
})

// --- editing a row that is older than these rules ---------------------------
//
// The rules above landed after the rows did. On the ADD form that costs nothing
// — everything typed there is new. On the EDIT form, judging what was posted
// means an owner updating a BIT inspection date is refused over a VIN box he
// never put a cursor in, and his whole record is locked out of the product by a
// field he did not touch. `parseVinEdit` asks whether he CHANGED it instead.

/** Narrow to the accepted case, so a refusal fails here rather than as `undefined`. */
function acceptedEdit(raw: string | null, stored: string | null): string | null {
  const parsed = parseVinEdit(raw, stored)
  const what = `${JSON.stringify(raw)} over stored ${JSON.stringify(stored)}`
  assert.equal(parsed.ok, true, `expected ${what} to save`)
  if (!parsed.ok) throw new Error('unreachable')
  return parsed.value
}

/** Narrow to the refusal, and hand back the sentence so a test can read it. */
function refusedEdit(raw: string | null, stored: string | null): string {
  const parsed = parseVinEdit(raw, stored)
  const what = `${JSON.stringify(raw)} over stored ${JSON.stringify(stored)}`
  assert.equal(parsed.ok, false, `expected ${what} to be refused`)
  if (parsed.ok) throw new Error('unreachable')
  return parsed.message
}

/**
 * The two VINs actually sitting in the dev database that `parseVin` refuses: a
 * half-typed stub, and a seventeen-character string carrying an I. Two of the
 * five VIN rows there, which is how big this regression was.
 */
const DB_STUB = '234'
const DB_WITH_I = '1TSTINV1LDVINI000'

/** The same bad VIN as it might have been stored: lower case, and with a space. */
const DB_MESSY = '1tstinv1 ldvini000'

test('a bad VIN nobody touched still saves, because no owner is blocked on a field he did not edit', () => {
  // The regression this exists for. He came to the page to change an inspection
  // date; the VIN box was never focused and posted back what it was given.
  // Refusing here refuses the whole record, over a rule written after the row.
  assert.equal(acceptedEdit(DB_STUB, DB_STUB), DB_STUB)
  assert.equal(acceptedEdit(DB_WITH_I, DB_WITH_I), DB_WITH_I)
  // And both of them are genuinely refused by the strict parser, or this test
  // would be passing for the wrong reason.
  assert.equal(parseVin(DB_STUB).ok, false)
  assert.equal(parseVin(DB_WITH_I).ok, false)
})

test('an untouched VIN goes back byte for byte — not uppercased, not stripped of spaces', () => {
  // Rewriting a value the owner did not touch is its own bug. It also changes
  // what `vehicles_vin_unique` compares, so a save that was about a date could
  // silently move this truck onto or off another truck's VIN.
  assert.equal(acceptedEdit(DB_MESSY, DB_MESSY), DB_MESSY)
  assert.notEqual(acceptedEdit(DB_MESSY, DB_MESSY), normalizeVin(DB_MESSY))
  assert.equal(acceptedEdit(DB_MESSY, DB_MESSY), '1tstinv1 ldvini000')
})

test('the value stored is what goes back, even when the post differs only by surrounding space', () => {
  // A text input posts its value with whitespace intact, so the comparison trims
  // both sides — but what gets WRITTEN is still the stored bytes, never the
  // trimmed post. The alternative is a normalisation nobody asked for.
  assert.equal(acceptedEdit(` ${DB_STUB} `, DB_STUB), DB_STUB)
  assert.equal(acceptedEdit(DB_STUB, ` ${DB_STUB} `), ` ${DB_STUB} `)
})

test('the same bad VIN is refused the moment it is actually edited', () => {
  // Typing IS the keystroke where a wrong character enters the system, so a VIN
  // he touched gets the full rules and the same sentence the add form gives.
  assert.match(refusedEdit('2345', DB_STUB), /Half a VIN is worse than none/)
  assert.match(refusedEdit('1TSTINV1LDVINI001', DB_WITH_I), /never contains the letter/)
  // Changed to something bad in a DIFFERENT way is still just refused.
  assert.match(refusedEdit('1FUJGLD54FLGF123*', DB_WITH_I), /letters and digits only/)
})

test('a bad VIN typed into a box that was empty is refused like any other new VIN', () => {
  // Nothing to grandfather: there is no stored value he could have left alone.
  assert.match(refusedEdit('234', null), /Half a VIN is worse than none/)
  assert.match(refusedEdit('IFUJGLD54FLGF1234', null), /never contains the letter/)
})

test('clearing the box is allowed whatever was on file, and lands as NULL', () => {
  // Blank stays blank — the field is optional on purpose, a VIN can follow the
  // paperwork. NULL and not '': the partial unique index treats '' as a VALUE,
  // so two cleared trucks would collide over a VIN neither of them has.
  for (const stored of [DB_STUB, DB_WITH_I, GOOD, null]) {
    assert.equal(acceptedEdit('', stored), null, `blank over ${JSON.stringify(stored)}`)
    assert.equal(acceptedEdit('   ', stored), null, `spaces over ${JSON.stringify(stored)}`)
  }
})

test('a good VIN on the edit form normalises exactly as it would on the add form', () => {
  // Grandfathering is only ever a fallback for a refusal. Anything that parses
  // goes through the same one-spelling reduction the duplicate guard needs.
  assert.equal(acceptedEdit(GOOD.toLowerCase(), DB_STUB), GOOD)
  assert.equal(acceptedEdit('1FUJ-GLD5-4FLG-F1234', DB_WITH_I), GOOD)
  assert.equal(acceptedEdit(` ${GOOD} `, null), GOOD)
  // Same answer as the strict parser, in every case, or the two forms would
  // store the same truck under two spellings.
  for (const raw of [GOOD, GOOD.toLowerCase(), '1fuj gld5-4flg f1234', 'F10GLU12345']) {
    const strict = parseVin(raw)
    assert.equal(strict.ok, true)
    if (strict.ok) assert.equal(acceptedEdit(raw, DB_STUB), strict.value)
  }
})

test('a stored VIN that is merely typed oddly is normalised, not grandfathered', () => {
  // '1fuj gld5-4flg f1234' PARSES, so it never reaches the unchanged branch —
  // it is reduced to one spelling like anything else. Grandfathering it would
  // leave a perfectly good VIN sitting in the column in a spelling the duplicate
  // index cannot match against the same truck typed cleanly.
  assert.equal(acceptedEdit('1fuj gld5-4flg f1234', '1fuj gld5-4flg f1234'), GOOD)
})

test('a failed check digit still saves on the edit form, touched or not', () => {
  // It was never a refusal, so it was never part of this regression — but a
  // grandfathering path that accidentally started refusing it would lock out the
  // small-builder trailer this product deliberately lets in.
  const wrong = `${GOOD.slice(0, 8)}${GOOD[8] === '0' ? '1' : '0'}${GOOD.slice(9)}`
  assert.equal(vinCheckDigitMismatch(wrong), true)
  assert.equal(acceptedEdit(wrong, wrong), wrong)
  assert.equal(acceptedEdit(wrong, GOOD), wrong)
})
