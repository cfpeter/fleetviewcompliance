/**
 * The pure half of document upload.
 *
 * Every decision under test here is one an attacker gets to push on: the key
 * that addresses an object, the check that decides what we store, and the
 * headers that decide what a browser does with a file somebody else uploaded.
 * The database half — the append-only trigger and the cross-carrier subject
 * check — is in tests/documents-rls.test.ts.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACCEPTED_TYPES,
  checkDates,
  checkFile,
  type DocumentRow,
  dispositionFor,
  downloadHeaders,
  formatSize,
  isStorageKey,
  kindLabel,
  kindsFor,
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_BYTES,
  newStorageKey,
  planReplacement,
  requestTooLarge,
  safeFileName,
  serveHeaders,
  splitByStanding,
  typeFacts,
} from '../src/lib/documents.ts'

const CARRIER = '4fbb2a57-9c78-4da1-ab68-f9df8a20e436'

// --- the storage key --------------------------------------------------------

test('a storage key carries the carrier and nothing else the user chose', () => {
  const key = newStorageKey(CARRIER, 'pdf')
  assert.match(key, /^documents\/4fbb2a57-9c78-4da1-ab68-f9df8a20e436\/[0-9a-f]{48}\.pdf$/)
  assert.ok(isStorageKey(key))
})

test('two keys for the same carrier never collide', () => {
  // 24 random bytes. A thousand draws is not a proof of the space, it is a proof
  // that the generator is not returning a constant — which is the failure that
  // would actually ship.
  const seen = new Set<string>()
  for (let i = 0; i < 1000; i++) seen.add(newStorageKey(CARRIER, 'jpg'))
  assert.equal(seen.size, 1000)
})

test('nothing the uploader typed can reach the key', () => {
  // The whole point. There is no filename parameter on newStorageKey, so a name
  // like this cannot be passed in at all — and the carrier id, which IS passed
  // in, has to be a uuid or the call throws.
  for (const hostile of [
    '../../other-carrier',
    'documents/x',
    '4fbb2a57-9c78-4da1-ab68-f9df8a20e436/../..',
    '',
    'not-a-uuid',
  ]) {
    assert.throws(() => newStorageKey(hostile, 'pdf'), /carrier uuid/)
  }
})

test('an extension outside the accept table is refused', () => {
  assert.throws(() => newStorageKey(CARRIER, 'svg'), /unknown extension/)
  assert.throws(() => newStorageKey(CARRIER, 'html'), /unknown extension/)
  assert.throws(() => newStorageKey(CARRIER, '../x'), /unknown extension/)
})

test('isStorageKey refuses anything this module did not make', () => {
  assert.equal(isStorageKey('documents/../../etc/passwd'), false)
  assert.equal(isStorageKey(`documents/${CARRIER}/short.pdf`), false)
  assert.equal(isStorageKey(`documents/${CARRIER}/${'a'.repeat(48)}.svg`), false)
  assert.equal(isStorageKey(null), false)
  assert.equal(isStorageKey(42), false)
  // A traversal segment glued onto a real key is still not a real key.
  assert.equal(isStorageKey(`${newStorageKey(CARRIER, 'png')}/../x`), false)
})

// --- what we accept ---------------------------------------------------------

/** First bytes of each format, as a phone or a scanner would write them. */
const HEAD = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37],
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d],
  // 'ftyp' at 4, brand 'heic' at 8 — an iPhone photo on the default setting.
  heic: [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63],
  webp: [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  // An mp4 is the same container family with a different brand.
  mp4: [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d],
}

const bytes = (nums: number[]) => new Uint8Array(nums)
const ascii = (s: string) => new Uint8Array([...s].map((ch) => ch.charCodeAt(0)))

function accepts(head: Uint8Array, size = 1024) {
  return checkFile({ name: 'whatever', size, head })
}

test('the formats a phone and a clinic actually produce are accepted', () => {
  const cases: [keyof typeof HEAD, string][] = [
    ['pdf', 'application/pdf'],
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['heic', 'image/heic'],
    ['webp', 'image/webp'],
  ]
  for (const [name, mime] of cases) {
    const result = accepts(bytes(HEAD[name]))
    assert.ok(result.ok, `${name} was refused`)
    if (result.ok) assert.equal(result.type.mime, mime)
  }
})

test('SVG is refused, and told plainly what to do instead', () => {
  // The one refusal that is a security decision rather than a scope decision. An
  // SVG carries script and would run as this site if a browser ever rendered it.
  const result = accepts(ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>'))
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.message, /SVG/)
    assert.match(result.message, /PDF|photo/)
  }
})

test('a web page is refused however it is named or declared', () => {
  // checkFile is never given the name or the declared type, which is the point:
  // there is no argument through which a lie about them could arrive.
  for (const text of [
    '<!DOCTYPE html><html>',
    '<script>alert(1)</script>',
    '<?xml version="1.0"?>',
  ]) {
    const result = accepts(ascii(text))
    assert.equal(result.ok, false, `${text} was accepted`)
  }
})

test('an mp4 does not pass as an iPhone photo', () => {
  // Same `ftyp` box, different brand. Matching on `ftyp` alone would let every
  // video in and would have looked like it worked.
  assert.equal(accepts(bytes(HEAD.mp4)).ok, false)
})

test('a file that only starts right still only proves its first bytes', () => {
  // A polyglot passes this check, and that is a documented limit rather than a
  // bug: what makes it harmless is downloadHeaders below, not this function.
  const polyglot = new Uint8Array([...HEAD.pdf, ...ascii('<script>alert(1)</script>')])
  const result = accepts(polyglot)
  assert.ok(result.ok)
  if (result.ok) assert.equal(result.type.mime, 'application/pdf')
})

test('an empty file is refused before anything else', () => {
  const result = checkFile({ name: 'card.pdf', size: 0, head: new Uint8Array() })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /empty/)
})

test('too big is refused with the limit in the sentence', () => {
  const result = accepts(bytes(HEAD.pdf), MAX_UPLOAD_BYTES + 1)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.message, /too big/)
    assert.match(result.message, /10 MB/)
  }
  // And exactly at the limit is fine — an off-by-one here is a refusal nobody
  // can explain.
  assert.ok(accepts(bytes(HEAD.pdf), MAX_UPLOAD_BYTES).ok)
})

test('every accepted type refuses an empty head rather than throwing', () => {
  for (const type of ACCEPTED_TYPES) {
    assert.equal(type.looksLike(new Uint8Array()), false, `${type.ext} threw or matched on nothing`)
    assert.equal(type.looksLike(new Uint8Array([0x00])), false, `${type.ext} matched one byte`)
  }
})

// --- the early size refusal -------------------------------------------------

test('an enormous request is refused before its body is read', () => {
  const big = new Request('https://x.test/', {
    method: 'POST',
    headers: { 'content-length': String(MAX_REQUEST_BYTES + 1) },
  })
  assert.match(requestTooLarge(big) ?? '', /too big/)

  const fine = new Request('https://x.test/', {
    method: 'POST',
    headers: { 'content-length': '2048' },
  })
  assert.equal(requestTooLarge(fine), null)

  // No header at all is not a refusal. The real check is on the bytes; this one
  // only exists to avoid buffering, and refusing here would break every client
  // that streams.
  assert.equal(requestTooLarge(new Request('https://x.test/', { method: 'POST' })), null)
})

// --- the file name ----------------------------------------------------------

test('a file name is a label, never a path', () => {
  assert.equal(safeFileName('C:\\fakepath\\card.pdf'), 'card.pdf')
  assert.equal(safeFileName('../../../etc/passwd'), 'passwd')
  assert.equal(safeFileName('a/b/c/medical card.jpg'), 'medical card.jpg')
})

test('a file name cannot smuggle control characters', () => {
  // U+202E flips the rest of the name, so `card\u202Egpj.exe` renders to a
  // reader as `card exe.jpg`.
  assert.equal(safeFileName('card\u202Egpj.exe'), 'cardgpj.exe')
  assert.equal(safeFileName('bad\r\nname.pdf'), 'badname.pdf')
  assert.equal(safeFileName('   '), null)
  assert.equal(safeFileName(''), null)
  assert.equal(safeFileName(null), null)
  assert.equal(safeFileName(123), null)
  assert.equal(safeFileName('x'.repeat(400))?.length, 120)
})

// --- serving it back --------------------------------------------------------

test('every file is served as an attachment, with sniffing switched off', () => {
  const h = downloadHeaders({ content_type: 'application/pdf', file_name: 'card.pdf' })
  assert.match(h.get('Content-Disposition') ?? '', /^attachment;/)
  assert.equal(h.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(h.get('Content-Security-Policy'), "default-src 'none'; sandbox")
  assert.equal(h.get('X-Frame-Options'), 'DENY')
  assert.equal(h.get('Cache-Control'), 'private, no-store')
})

test('a content type outside the accept table is never reflected', () => {
  // The row is written by storeDocument from the sniffed bytes, so this cannot
  // happen today. It is checked anyway, because this is the header that decides
  // whether a browser runs the file.
  for (const stored of ['text/html', 'image/svg+xml', 'application/javascript', null, '']) {
    const h = downloadHeaders({ content_type: stored, file_name: 'x' })
    assert.equal(h.get('Content-Type'), 'application/octet-stream', `reflected ${stored}`)
  }
  // And a real one is kept, so a PDF still opens in the reader they expect.
  assert.equal(
    downloadHeaders({ content_type: 'application/pdf', file_name: 'x' }).get('Content-Type'),
    'application/pdf',
  )
})

test('a hostile file name cannot break out of the Content-Disposition header', () => {
  const h = downloadHeaders({
    content_type: 'image/jpeg',
    file_name: 'a".pdf"; x=1\r\nSet-Cookie: bad=1',
  })
  const disposition = h.get('Content-Disposition') ?? ''
  // The injection needs a line break to start a second header, and a quote to
  // end the filename parameter early. Neither survives. The words `Set-Cookie`
  // do survive, as text inside a quoted string, which is exactly as harmful as
  // a driver called Set-Cookie: not at all.
  assert.ok(!disposition.includes('\r'), 'a carriage return survived into the header')
  assert.ok(!disposition.includes('\n'), 'a newline survived into the header')
  // One pair of quotes around the ascii form, and nothing inside them.
  assert.match(disposition, /^attachment; filename="[^"]*"; filename\*=UTF-8''/)
  // And nothing anywhere in the header can start a new one.
  assert.ok(!/[\r\n]/.test(h.get('Content-Disposition') ?? ''))
})

test('a non-ascii name survives as filename* and degrades safely otherwise', () => {
  const h = downloadHeaders({ content_type: 'image/jpeg', file_name: 'Ամանոր քարտ.jpg' })
  const disposition = h.get('Content-Disposition') ?? ''
  assert.match(disposition, /filename="_+ _+\.jpg"/)
  assert.ok(disposition.includes(`filename*=UTF-8''${encodeURIComponent('Ամանոր քարտ.jpg')}`))
})

test('a missing file name still produces a usable download', () => {
  const h = downloadHeaders({ content_type: 'application/pdf', file_name: null })
  assert.match(h.get('Content-Disposition') ?? '', /filename="document"/)
})

// --- open it, instead of burying it in Downloads ----------------------------
//
// The disposition is the ONE thing that changed, and it is the one thing that
// used to be the whole defence, so it gets more tests than it used to have.

/** Every value the accept table can put in the column, and what it should do. */
const DISPOSITIONS: [string, 'inline' | 'attachment'][] = [
  ['image/jpeg', 'inline'],
  ['image/png', 'inline'],
  ['image/webp', 'inline'],
  // Accepted on upload because an iPhone produces nothing else by default, and
  // still an attachment because only Safari can draw one. A broken frame is a
  // worse answer than a saved file plus a sentence saying why.
  ['image/heic', 'attachment'],
  // A PDF is SAFE to render and still cannot be rendered here: measured in
  // Chrome, our own CSP sends it to the Downloads folder instead of the viewer.
  // Marking it inline would put "Open" on a row that downloads, which is the bug
  // this whole change exists to fix. See INLINE_TYPES.
  ['application/pdf', 'attachment'],
]

test('a photo opens in the browser', () => {
  for (const [stored, want] of DISPOSITIONS.filter(([, d]) => d === 'inline')) {
    assert.equal(dispositionFor(stored), want, stored)
    assert.match(
      serveHeaders({ content_type: stored, file_name: 'card' }).get('Content-Disposition') ?? '',
      /^inline;/,
      stored,
    )
  }
})

test('HEIC is still sent as a file, because a browser cannot draw one', () => {
  assert.equal(dispositionFor('image/heic'), 'attachment')
  assert.match(
    serveHeaders({ content_type: 'image/heic', file_name: 'IMG_4417.HEIC' }).get(
      'Content-Disposition',
    ) ?? '',
    /^attachment;/,
  )
  // And the list says so in words rather than showing a broken picture.
  const facts = typeFacts('image/heic')
  assert.equal(facts.opens, false)
  assert.equal(facts.showable, false)
  assert.equal(facts.label, 'iPhone photo')
  assert.match(facts.note, /HEIC/)
})

test('a PDF is sent as a file, because our own CSP will not let it render', () => {
  // Not a guess about PDFs in general: with `default-src 'none'; sandbox` on the
  // response, Chrome downloads the file rather than opening its viewer. The row
  // therefore says Save. If this ever flips to inline, the CSP must have been
  // weakened or the file moved to its own origin — check which before believing
  // the new behaviour is an improvement.
  assert.equal(dispositionFor('application/pdf'), 'attachment')
  const facts = typeFacts('application/pdf')
  assert.equal(facts.opens, false)
  assert.equal(facts.showable, false)
  assert.equal(facts.label, 'PDF')
  assert.match(facts.note, /PDF/)
})

test('a file we can show carries no apology, and one we cannot always does', () => {
  for (const [stored, want] of DISPOSITIONS) {
    const facts = typeFacts(stored)
    assert.equal(facts.note === '', want === 'inline', `${stored} note did not match its fate`)
  }
  assert.notEqual(typeFacts('text/html').note, '')
})

test('a stored type outside the accept table can never be served inline', () => {
  // THE ONE THAT MATTERS. If any of these ever comes back `inline`, a file that
  // a browser executes is being rendered on our own origin with the owner's
  // session. The decision runs through servableType first, so every one of them
  // is already application/octet-stream before the inline list is consulted.
  const hostile = [
    'text/html',
    'text/html; charset=utf-8',
    'TEXT/HTML',
    'image/svg+xml',
    'application/xhtml+xml',
    'application/javascript',
    'text/xml',
    'application/octet-stream',
    'application/pdf ', // a trailing space is not a type in the table
    ' application/pdf',
    'image/jpeg;x=1',
    '',
    null,
  ]
  for (const stored of hostile) {
    assert.equal(dispositionFor(stored), 'attachment', `${stored} was allowed inline`)
    const h = serveHeaders({ content_type: stored, file_name: 'x' })
    assert.match(h.get('Content-Disposition') ?? '', /^attachment;/, `${stored} rendered inline`)
    // The type is not reflected either, so nosniff has nothing to work against.
    assert.equal(h.get('Content-Type'), 'application/octet-stream', `reflected ${stored}`)
    // And the list will not offer to open what the server will not render.
    assert.equal(typeFacts(stored).opens, false, `the row offered to open ${stored}`)
  }
})

test('the Save link forces a download, and no parameter can force the reverse', () => {
  // download:true only ever tightens. There is no option that turns attachment
  // into inline — that is why the route reads `?download=1` and nothing else.
  for (const [stored] of DISPOSITIONS) {
    assert.equal(dispositionFor(stored, true), 'attachment', stored)
    assert.match(
      serveHeaders({ content_type: stored, file_name: 'card' }, { download: true }).get(
        'Content-Disposition',
      ) ?? '',
      /^attachment;/,
      stored,
    )
  }
  // downloadHeaders is that call spelled in one word, so the two agree.
  assert.equal(
    downloadHeaders({ content_type: 'image/png', file_name: 'a.png' }).get('Content-Disposition'),
    serveHeaders({ content_type: 'image/png', file_name: 'a.png' }, { download: true }).get(
      'Content-Disposition',
    ),
  )
})

test('going inline changed the disposition and nothing else', () => {
  // The other four headers are the defence that makes inline survivable. If a
  // future edit trades one of them away for a nicer preview, this fails.
  const inline = serveHeaders({ content_type: 'image/png', file_name: 'a.png' })
  const attached = serveHeaders(
    { content_type: 'image/png', file_name: 'a.png' },
    { download: true },
  )
  for (const header of [
    'X-Content-Type-Options',
    'Content-Security-Policy',
    'X-Frame-Options',
    'Cache-Control',
    'Content-Type',
  ]) {
    assert.equal(inline.get(header), attached.get(header), header)
  }
  assert.equal(inline.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(inline.get('Content-Security-Policy'), "default-src 'none'; sandbox")
  assert.equal(inline.get('X-Frame-Options'), 'DENY')
  assert.equal(inline.get('Cache-Control'), 'private, no-store')
  assert.match(inline.get('Content-Disposition') ?? '', /^inline;/)
  assert.match(attached.get('Content-Disposition') ?? '', /^attachment;/)
})

test('a hostile file name cannot break out of an inline header either', () => {
  // The filename is escaped in one place for both dispositions. Pinned on the
  // inline form too, so the escaping cannot be lost on the new path alone.
  const h = serveHeaders({
    content_type: 'image/png',
    file_name: 'a".png"; x=1\r\nSet-Cookie: bad=1',
  })
  const disposition = h.get('Content-Disposition') ?? ''
  assert.ok(!/[\r\n]/.test(disposition), 'a line break survived into the header')
  assert.match(disposition, /^inline; filename="[^"]*"; filename\*=UTF-8''/)
})

test('the badge on a row matches what the server will do with the file', () => {
  // Every type we accept, end to end: the words the owner reads are derived from
  // the same function the route uses, so the row cannot promise "Open" for a
  // file that is about to land in Downloads.
  for (const type of ACCEPTED_TYPES) {
    const facts = typeFacts(type.mime)
    assert.equal(facts.opens, dispositionFor(type.mime) === 'inline', type.mime)
    // Anything we draw in an <img> must also be something the server renders.
    if (facts.showable)
      assert.equal(facts.opens, true, `${type.mime} is shown but not served inline`)
  }
  assert.equal(typeFacts('application/pdf').label, 'PDF')
  assert.equal(typeFacts('image/jpeg').label, 'Photo')
  assert.equal(typeFacts('image/webp').label, 'Photo')
  assert.equal(typeFacts('text/html').label, 'File')
  // A PDF cannot be drawn in an <img> whatever else is decided about it.
  assert.equal(typeFacts('application/pdf').showable, false)
})

// --- dates ------------------------------------------------------------------

test('both dates are optional', () => {
  assert.deepEqual(checkDates('', ''), { ok: true, issuedOn: null, expiresOn: null })
  assert.deepEqual(checkDates(null, undefined), { ok: true, issuedOn: null, expiresOn: null })
})

test('an expiry before the issue date is refused', () => {
  const result = checkDates('2026-05-01', '2026-04-30')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.message, /expiry date is before/)
  // The same day is fine — a one-day permit is a real thing.
  assert.ok(checkDates('2026-05-01', '2026-05-01').ok)
})

test('rubbish in a date box is refused in words she can act on', () => {
  for (const bad of ['tomorrow', '05/01/2026', '2026-13-01', '0026-05-01']) {
    const result = checkDates(bad, '')
    assert.equal(result.ok, false, `${bad} was accepted`)
    if (!result.ok) assert.ok(result.message.length < 80, 'the message is a paragraph')
  }
})

// --- replacing --------------------------------------------------------------

const row = (over: Partial<DocumentRow> = {}): DocumentRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  subject_type: 'driver',
  subject_id: '22222222-2222-4222-8222-222222222222',
  kind: 'medical_certificate',
  storage_key: newStorageKey(CARRIER, 'pdf'),
  file_name: 'card.pdf',
  content_type: 'application/pdf',
  byte_size: 1024,
  issued_on: null,
  expires_on: null,
  uploaded_at: '2026-01-01T00:00:00Z',
  superseded_at: null,
  superseded_by: null,
  ...over,
})

const subject = {
  subjectType: 'driver' as const,
  subjectId: '22222222-2222-4222-8222-222222222222',
}

test('a document on this subject can be replaced', () => {
  assert.deepEqual(planReplacement({ existing: row(), ...subject }), {
    ok: true,
    supersedeId: '11111111-1111-4111-8111-111111111111',
  })
})

test('a document that is not ours is simply not there', () => {
  // RLS turns another carrier's row into null before it reaches this function,
  // so null is the cross-tenant case and it must be a plain refusal.
  const plan = planReplacement({ existing: null, ...subject })
  assert.equal(plan.ok, false)
  if (!plan.ok) assert.match(plan.message, /cannot find/)
})

test('a document already replaced is not replaced again', () => {
  const plan = planReplacement({
    existing: row({ superseded_at: '2026-02-02T00:00:00Z' }),
    ...subject,
  })
  assert.equal(plan.ok, false)
  if (!plan.ok) assert.match(plan.message, /already replaced/)
})

test('a document filed on another driver cannot be retired from this page', () => {
  // The id comes from a form field. Without this, one driver's page could
  // supersede a document belonging to a different driver in the same carrier —
  // a legal UPDATE that RLS permits and nobody would ever find.
  const elsewhere = row({ subject_id: '33333333-3333-4333-8333-333333333333' })
  const plan = planReplacement({ existing: elsewhere, ...subject })
  assert.equal(plan.ok, false)
  if (!plan.ok) assert.match(plan.message, /filed somewhere else/)

  const wrongType = row({ subject_type: 'vehicle' })
  assert.equal(planReplacement({ existing: wrongType, ...subject }).ok, false)
})

// --- the list ---------------------------------------------------------------

test('current and replaced are separated, newest first', () => {
  const rows = [
    row({ id: 'a', uploaded_at: '2026-01-01T00:00:00Z' }),
    row({ id: 'b', uploaded_at: '2026-03-01T00:00:00Z' }),
    row({ id: 'c', uploaded_at: '2026-02-01T00:00:00Z', superseded_at: '2026-03-01T00:00:00Z' }),
  ]
  const { current, replaced } = splitByStanding(rows)
  assert.deepEqual(
    current.map((r) => r.id),
    ['b', 'a'],
  )
  assert.deepEqual(
    replaced.map((r) => r.id),
    ['c'],
  )
})

// --- words ------------------------------------------------------------------

test('kinds differ by subject and every key has a label', () => {
  const driver = kindsFor('driver')
  const vehicle = kindsFor('vehicle')
  assert.ok(driver.some((k) => k.key === 'medical_certificate'))
  assert.ok(vehicle.some((k) => k.key === 'annual_inspection'))
  assert.ok(!vehicle.some((k) => k.key === 'medical_certificate'))
  for (const list of [driver, vehicle]) {
    for (const kind of list) assert.ok(kind.label.length > 0, `${kind.key} has no label`)
  }
})

test('a kind we no longer offer still prints as itself', () => {
  // `kind` is free text in the schema. A row written before a label existed must
  // not render as blank.
  assert.equal(kindLabel('driver', 'medical_certificate'), 'Medical card')
  assert.equal(kindLabel('driver', 'something_old'), 'something_old')
})

test('sizes read at a glance', () => {
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(2048), '2 KB')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB')
  assert.equal(formatSize(null), '')
})
