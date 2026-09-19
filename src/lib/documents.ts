/**
 * Document upload: the paper behind a date.
 *
 * A date in this product says the driver had a medical card. The scan of the
 * card is the PROOF he had one, and it is the thing an investigator asks for.
 * supabase/migrations/0003_documents.sql holds the rules — the table is
 * append-only, a trigger refuses any UPDATE that touches the file, the dates or
 * the carrier, and there is no DELETE grant at all. Nothing in this file fights
 * that: replacing a document means superseding the old row and inserting a new
 * one, and the old object stays in R2 for as long as the row does.
 *
 * THREE THINGS IN HERE ARE SECURITY, NOT PLUMBING.
 *
 *  1. The storage key is generated, never derived. See `newStorageKey`.
 *  2. The file type is sniffed, never believed. See `checkFile`.
 *  3. The object is written BEFORE the row, and the row is deleted-forward
 *     rather than the object. See `storeDocument`.
 *
 * Serving the file safely is the other half and it lives in
 * src/pages/app/documents/[id].ts, which is behind the /app guard in
 * src/middleware.ts. Read `serveHeaders` below — and the note on INLINE_TYPES
 * beside it — before changing that route.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type DocumentSubject = 'carrier' | 'driver' | 'vehicle' | 'terminal'

// ---------------------------------------------------------------------------
// What we accept
// ---------------------------------------------------------------------------

/**
 * The realistic set for a fleet office and a phone in a yard.
 *
 * A medical card is photographed, not scanned — an owner standing beside the
 * truck holds up the card and taps the shutter. So the photo formats a phone
 * actually produces have to be here or the feature does not work where it is
 * used: JPEG and PNG from any phone, HEIC from an iPhone left on its default
 * "High Efficiency" setting, WEBP from an Android that saved from a message.
 * PDF is what the clinic emails and what a scanner in the office makes.
 *
 * SVG IS NOT HERE AND MUST NOT BE ADDED. An SVG is a script container: it can
 * carry `<script>` and event handlers, and a browser that renders one from our
 * own origin runs that script as our site, with the signed-in owner's session.
 * Nobody photographs a medical card into an SVG, so refusing it costs a real
 * user nothing and removes a whole class of attack. HTML, XML and anything else
 * a browser executes is refused for the same reason.
 *
 * `ext` is OURS, not the uploader's. It is appended to a generated key so an
 * object in the bucket can be recognised by hand, and it is picked from this
 * table by what the BYTES say — never from the name the browser sent.
 */
export interface AcceptedType {
  /** Stored in `documents.content_type` and re-checked before serving. */
  mime: string
  /** Appended to the generated storage key. Fixed strings only. */
  ext: string
  /** For the "we take these" line under the file input. */
  label: string
  /** True when the first bytes are this format. */
  looksLike: (head: Uint8Array) => boolean
}

/** ASCII bytes of `text` starting at `at`. */
function magic(head: Uint8Array, at: number, text: string): boolean {
  if (head.length < at + text.length) return false
  for (let i = 0; i < text.length; i++) {
    if (head[at + i] !== text.charCodeAt(i)) return false
  }
  return true
}

function bytesAt(head: Uint8Array, at: number, expected: number[]): boolean {
  if (head.length < at + expected.length) return false
  return expected.every((b, i) => head[at + i] === b)
}

/**
 * ISO base media brands that mean "a picture", which is what an iPhone writes.
 *
 * The brand sits at offset 8, right after the `ftyp` box type. `mif1`/`msf1` are
 * the generic HEIF brands; the rest are the HEIC and HEVC variants iOS has
 * shipped. An `ftyp` box whose brand is not in this list is something else in
 * the same container family — `isom`/`mp4` is a video — and is refused.
 */
const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']

export const ACCEPTED_TYPES: readonly AcceptedType[] = [
  {
    mime: 'application/pdf',
    ext: 'pdf',
    label: 'PDF',
    looksLike: (h) => magic(h, 0, '%PDF-'),
  },
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    label: 'JPG',
    looksLike: (h) => bytesAt(h, 0, [0xff, 0xd8, 0xff]),
  },
  {
    mime: 'image/png',
    ext: 'png',
    label: 'PNG',
    looksLike: (h) => bytesAt(h, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    mime: 'image/heic',
    ext: 'heic',
    label: 'HEIC (iPhone photo)',
    looksLike: (h) => magic(h, 4, 'ftyp') && HEIF_BRANDS.some((b) => magic(h, 8, b)),
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    label: 'WEBP',
    looksLike: (h) => magic(h, 0, 'RIFF') && magic(h, 8, 'WEBP'),
  },
]

/** For the `accept` attribute. A hint to the file picker, never a check. */
export const ACCEPT_ATTRIBUTE = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,application/pdf,image/*'

/** The words under the file input, in the order of the table above. */
export const ACCEPTED_LABEL = ACCEPTED_TYPES.map((t) => t.label).join(', ')

/**
 * 10 MB.
 *
 * Two reasons, and neither is arbitrary. A Worker request body is capped by the
 * platform, and a request that dies at the cap fails as a broken pipe — no
 * message, half a file, nothing to tell the owner. And a yard is where the
 * signal is worst: a 40 MB photo over one bar is a two-minute upload that often
 * does not finish. Every phone camera produces a card photo well under this.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/**
 * What a whole multipart request may weigh.
 *
 * The file is the body plus the field names, the boundaries and the dates, so
 * the request is always a little larger than the file. This cap is checked
 * against `Content-Length` BEFORE the body is read, so an enormous upload is
 * refused without buffering it. It is a fast rejection, not the rule: the rule
 * is MAX_UPLOAD_BYTES, measured on the bytes themselves after they arrive,
 * because a Content-Length header is written by the client and can lie.
 */
export const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024

/** The limit in the words shown to an owner. */
export const MAX_UPLOAD_LABEL = '10 MB'

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export interface DocumentKind {
  /** Written into `documents.kind`. Free text in the schema; fixed here. */
  key: string
  label: string
}

/**
 * What an owner files on a driver.
 *
 * The keys line up with the anchor keys in src/lib/rules/driver-anchors.ts
 * wherever there is a matching date, so that wiring `expires_on` into the
 * deadline engine later is a join and not a translation table. Where there is no
 * anchor — an application form, a road test — the key is the plain name of the
 * paper.
 */
export const DRIVER_DOCUMENT_KINDS: readonly DocumentKind[] = [
  { key: 'medical_certificate', label: 'Medical card' },
  { key: 'cdl', label: 'Driver licence (CDL)' },
  { key: 'mvr', label: 'Driving record (MVR)' },
  { key: 'annual_review', label: 'Annual review of the driving record' },
  { key: 'clearinghouse_query', label: 'Clearinghouse query' },
  { key: 'drug_alcohol_test', label: 'Drug or alcohol test result' },
  { key: 'employment_application', label: 'Job application' },
  { key: 'previous_employer_check', label: 'Past employer check' },
  { key: 'road_test', label: 'Road test certificate' },
  { key: 'spe_certificate', label: 'SPE certificate' },
  // Added with the driver links (0034–0037). Without them an accepted zone
  // exemption or assessment filed as "Other paper", which is what the owner
  // saw: he ticked "Intracity zone exemption" and got back a nameless other.
  { key: 'intracity_exemption', label: 'Intracity zone exemption' },
  { key: 'medical_assessment', label: 'Medical assessment' },
  { key: 'training_certificate', label: 'Training certificate' },
  // A photo sent in answer to one of the owner's OWN reminders — a tire check,
  // an oil change. No regulation asks for it, so it is not a compliance paper
  // and must not wear the name of one; but "Other paper" was the complaint that
  // started this list growing, and a photo the owner specifically asked for is
  // the last thing that should come back nameless. The reminder's own title is
  // written into `file_name`, so the row reads "Photo for a reminder · Check
  // the tires".
  { key: 'reminder_photo', label: 'Photo for a reminder' },
  { key: 'other', label: 'Other paper' },
]

/** What an owner files on a truck or a trailer. */
export const VEHICLE_DOCUMENT_KINDS: readonly DocumentKind[] = [
  { key: 'annual_inspection', label: 'Annual DOT inspection report' },
  { key: 'bit_inspection', label: '90-day BIT inspection report' },
  { key: 'registration', label: 'Registration (cab card)' },
  { key: 'title', label: 'Title' },
  { key: 'insurance', label: 'Insurance card' },
  { key: 'ctc_result', label: 'Clean Truck Check result' },
  { key: 'form_2290', label: 'Form 2290 receipt (HVUT)' },
  { key: 'repair_order', label: 'Repair order' },
  { key: 'roadside_inspection', label: 'Roadside inspection report' },
  { key: 'other', label: 'Other paper' },
]

export function kindsFor(subject: DocumentSubject): readonly DocumentKind[] {
  if (subject === 'driver') return DRIVER_DOCUMENT_KINDS
  if (subject === 'vehicle') return VEHICLE_DOCUMENT_KINDS
  return [{ key: 'other', label: 'Other paper' }]
}

/** The label for a stored key, or the key itself when it predates the list. */
export function kindLabel(subject: DocumentSubject, key: string): string {
  return kindsFor(subject).find((k) => k.key === key)?.label ?? key
}

// ---------------------------------------------------------------------------
// The storage key
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Built from the table above so the two can never disagree. */
const STORAGE_KEY_SHAPE = new RegExp(
  `^documents/[0-9a-f-]{36}/[0-9a-f]{48}\\.(${ACCEPTED_TYPES.map((t) => t.ext).join('|')})$`,
)

/** 24 bytes. Enough that nobody ever guesses a neighbour's object name. */
const KEY_RANDOM_BYTES = 24

/**
 * Random bytes, or an exception — never a fallback.
 *
 * Same rule as src/lib/proof/token.ts: `Math.random()` is a recoverable PRNG,
 * and a silent fallback to it would produce keys that look exactly like good
 * ones. Both runtimes this ships to have Web Crypto as a global.
 */
function randomHex(count: number): string {
  const source = globalThis.crypto
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is unavailable; refusing to generate a storage key.')
  }
  const bytes = source.getRandomValues(new Uint8Array(count))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A fresh object key. NOTHING THE USER TYPED GOES IN IT.
 *
 * A key built from the uploaded filename is path traversal with extra steps:
 * `../../other-carrier/medical.pdf` is a perfectly ordinary filename, R2 keys
 * are flat strings that happily contain `..`, and any later code that maps a key
 * back to a path or a prefix inherits the bug. It is also an information leak in
 * its own right — an object listing would publish the names of every driver's
 * paperwork.
 *
 * So the key is: a fixed prefix, the carrier id from the SESSION, 24 random
 * bytes, and an extension chosen from our own table by what the bytes said. The
 * name the owner's phone sent is kept in `documents.file_name` for display and
 * is never part of an address.
 *
 * The carrier id is in the key so that an object can be traced to a tenant
 * during an incident, and so that a bulk export or a lifecycle rule can work by
 * prefix. It is asserted to be a uuid first: a carrier id arrives from the
 * session, but this function must be safe for whatever calls it next.
 */
export function newStorageKey(carrierId: string, ext: string): string {
  if (!UUID.test(carrierId)) throw new Error('storage key needs a carrier uuid')
  if (!ACCEPTED_TYPES.some((t) => t.ext === ext)) throw new Error(`unknown extension ${ext}`)
  const key = `documents/${carrierId.toLowerCase()}/${randomHex(KEY_RANDOM_BYTES)}.${ext}`
  // Belt and braces: the key is built from checked parts, and then the whole
  // thing is checked again. A key that fails this never reaches the bucket.
  if (!STORAGE_KEY_SHAPE.test(key)) throw new Error('generated storage key failed its own shape')
  return key
}

/** True for a key this module generated. Used before any R2 read. */
export function isStorageKey(value: unknown): value is string {
  return typeof value === 'string' && STORAGE_KEY_SHAPE.test(value)
}

// ---------------------------------------------------------------------------
// Checking the file
// ---------------------------------------------------------------------------

export type FileCheck = { ok: true; type: AcceptedType } | { ok: false; message: string }

/** Bytes that mean "a browser will try to run this". */
function looksExecutable(head: Uint8Array): boolean {
  const text = new TextDecoder('utf-8', { fatal: false })
    .decode(head.slice(0, 64))
    .trim()
    .toLowerCase()
  return (
    text.startsWith('<?xml') ||
    text.startsWith('<svg') ||
    text.startsWith('<!doctype html') ||
    text.startsWith('<html') ||
    text.startsWith('<script')
  )
}

/**
 * Is this a file we will store?
 *
 * THE CLIENT'S CONTENT-TYPE AND FILENAME ARE NOT CONSULTED. Both are typed by
 * whoever sent the request. `evil.svg` renamed to `card.pdf` and posted with
 * `Content-Type: application/pdf` passes every check that reads either one, and
 * a form post is not a browser file picker — a script can send anything.
 *
 * So the decision is made on the first bytes. That is a real check, and it is
 * worth saying plainly what it does and does not buy:
 *
 *   IT CATCHES the ordinary and the casual — a renamed HTML page, a ZIP, a
 *   video, an SVG, an executable — because none of them start with `%PDF-` or a
 *   JPEG marker.
 *
 *   IT DOES NOT CATCH a polyglot: a file that really does begin with a valid PDF
 *   header and carries HTML or script further in. Such a file exists and is easy
 *   to make. What makes it harmless here is NOT this function — it is the
 *   download route, which sends every file as an attachment, with nosniff, with
 *   a content type re-checked against this same table, and never as the type the
 *   uploader asked for. Sniffing narrows the door; the response headers are the
 *   lock.
 *
 *   IT DOES NOT CATCH a malicious PDF or a malformed image aimed at the reader's
 *   own viewer. Nothing we can do at upload time would, short of rendering it,
 *   and that is a bigger attack surface than the one it closes.
 */
export function checkFile(args: { name: string; size: number; head: Uint8Array }): FileCheck {
  if (args.size === 0) {
    return { ok: false, message: 'That file is empty. Pick the file again.' }
  }
  if (args.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `That file is too big. The limit is ${MAX_UPLOAD_LABEL}. Take a new photo, or send a smaller file.`,
    }
  }
  for (const type of ACCEPTED_TYPES) {
    if (type.looksLike(args.head)) return { ok: true, type }
  }
  // A clearer answer for the one refusal people hit on purpose. The generic
  // message below is true for an SVG too, but a person who just tried to upload
  // one deserves to be told what to do instead of reading a list.
  if (looksExecutable(args.head)) {
    return {
      ok: false,
      message:
        'We do not take web pages, SVG or XML files. Save the paper as a PDF, or take a photo of it.',
    }
  }
  return {
    ok: false,
    message: `We only take ${ACCEPTED_LABEL} files. This file is not one of those.`,
  }
}

/**
 * Refuse a huge request before the body is read.
 *
 * Called by the page BEFORE `request.formData()`, because formData() pulls the
 * whole body into memory and a 200 MB post is a dead Worker, not an error
 * message. Returns the sentence to show, or null to carry on.
 */
export function requestTooLarge(request: Request): string | null {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (!Number.isFinite(declared) || declared <= MAX_REQUEST_BYTES) return null
  return `That file is too big. The limit is ${MAX_UPLOAD_LABEL}. Take a new photo, or send a smaller file.`
}

// ---------------------------------------------------------------------------
// The file name we keep
// ---------------------------------------------------------------------------

/**
 * The uploader's filename, made safe to store and to print.
 *
 * Kept for one reason: an owner recognises "IMG_4417.HEIC" or
 * "mike-medcard-2026.pdf" and does not recognise a random key. It is DISPLAY
 * ONLY — it never addresses anything.
 *
 * Everything before the last slash or backslash is dropped, because some
 * browsers still send `C:\fakepath\card.pdf` and because a name is not a path.
 * Control characters go, including the right-to-left override that renders
 * `card\u202Egpj.exe` as `card exe.jpg`. Length is capped so the list stays
 * readable and the Content-Disposition header stays sane.
 */
export function safeFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const base = raw.split(/[/\\]/).pop() ?? ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e]/g, '').trim()
  if (cleaned === '') return null
  return cleaned.slice(0, 120)
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

export type DateCheck =
  | { ok: true; issuedOn: string | null; expiresOn: string | null }
  | {
      ok: false
      message: string
    }

/**
 * The two optional dates on the form.
 *
 * Both may be blank — an owner filing a repair order has neither, and a feature
 * that demands them is a feature he stops using. What is refused is a pair that
 * cannot both be true, because that is a typo he wants to know about now rather
 * than the day the expiry drives a reminder.
 */
export function checkDates(issuedRaw: unknown, expiresRaw: unknown): DateCheck {
  const clean = (v: unknown) => {
    const s = String(v ?? '').trim()
    return s === '' ? null : s
  }
  const issuedOn = clean(issuedRaw)
  const expiresOn = clean(expiresRaw)

  for (const [value, label] of [
    [issuedOn, 'issue date'],
    [expiresOn, 'expiry date'],
  ] as const) {
    if (value === null) continue
    if (!DATE_SHAPE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      return { ok: false, message: `That ${label} is not a real date. Use the date picker.` }
    }
    const year = Number(value.slice(0, 4))
    if (year < 1900 || year > 2200) {
      return { ok: false, message: `Check the year on that ${label}.` }
    }
  }

  if (issuedOn && expiresOn && expiresOn < issuedOn) {
    return { ok: false, message: 'The expiry date is before the issue date. Check both dates.' }
  }
  return { ok: true, issuedOn, expiresOn }
}

// ---------------------------------------------------------------------------
// Replacing a document
// ---------------------------------------------------------------------------

/** The row shape every screen and every plan in here works from. */
export interface DocumentRow {
  id: string
  subject_type: DocumentSubject
  subject_id: string | null
  kind: string
  storage_key: string
  file_name: string | null
  content_type: string | null
  byte_size: number | null
  issued_on: string | null
  expires_on: string | null
  uploaded_at: string
  superseded_at: string | null
  superseded_by: string | null
}

/**
 * The columns every subject page selects, spelled once.
 *
 * `storage_key` is deliberately in it and deliberately never printed: the list
 * needs nothing from it, and the download route reads its own copy. It is here
 * only so `DocumentRow` is one shape everywhere rather than two that drift.
 */
export const DOCUMENT_COLUMNS =
  'id, subject_type, subject_id, kind, storage_key, file_name, content_type, byte_size, issued_on, expires_on, uploaded_at, superseded_at, superseded_by'

export type ReplacementPlan = { ok: true; supersedeId: string } | { ok: false; message: string }

/**
 * May this upload replace that document?
 *
 * Pure, and separate from the write, because every answer here is a refusal that
 * has to be right. The database will not save us: the append-only trigger
 * permits setting `superseded_at`, so a bad supersede is a legal UPDATE.
 *
 *  - No such row. RLS already makes another carrier's document invisible, so
 *    "not ours" and "does not exist" arrive here as the same null, which is the
 *    correct outcome and the correct message.
 *  - Already superseded. Superseding twice would move the time on a row that was
 *    replaced weeks ago and hide which document actually followed it.
 *  - A different subject. The id comes from a form field, so without this check
 *    a document filed on one driver could be retired from another driver's page
 *    — a supersede nobody would ever find again.
 */
export function planReplacement(args: {
  existing: Pick<DocumentRow, 'id' | 'subject_type' | 'subject_id' | 'superseded_at'> | null
  subjectType: DocumentSubject
  subjectId: string
}): ReplacementPlan {
  const { existing } = args
  if (!existing) {
    return { ok: false, message: 'We cannot find the document you are replacing. Nothing changed.' }
  }
  if (existing.superseded_at !== null) {
    return { ok: false, message: 'That document was already replaced. Nothing changed.' }
  }
  if (existing.subject_type !== args.subjectType || existing.subject_id !== args.subjectId) {
    return { ok: false, message: 'That document is filed somewhere else. Nothing changed.' }
  }
  return { ok: true, supersedeId: existing.id }
}

/**
 * Current first, then what was replaced.
 *
 * Superseded documents stay REACHABLE — 49 CFR 391.51(c) wants the file kept for
 * as long as the driver is employed and three years after, and the expired card
 * is the proof he was qualified while it ran. They are separated rather than
 * mixed in so nobody hands an investigator last year's card thinking it is the
 * one in force.
 */
export function splitByStanding(rows: readonly DocumentRow[]): {
  current: DocumentRow[]
  replaced: DocumentRow[]
} {
  const newestFirst = (a: DocumentRow, b: DocumentRow) => b.uploaded_at.localeCompare(a.uploaded_at)
  return {
    current: rows.filter((r) => r.superseded_at === null).sort(newestFirst),
    replaced: rows.filter((r) => r.superseded_at !== null).sort(newestFirst),
  }
}

/** '1.4 MB', '812 KB'. Sizes are read at a glance, never audited. */
export function formatSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Serving a file back
// ---------------------------------------------------------------------------

/**
 * Only a type from our own table, ever.
 *
 * `documents.content_type` is written by `storeDocument` from the sniffed bytes,
 * so today it is always one of these. It is checked again anyway, because this
 * is the line that decides what a browser does with the response and it must not
 * depend on every future writer of that column being careful.
 */
function servableType(stored: string | null): string {
  return ACCEPTED_TYPES.some((t) => t.mime === stored) && stored
    ? stored
    : 'application/octet-stream'
}

/**
 * The types a browser may RENDER instead of save, and why each one is here.
 *
 * The owner's complaint was fair: a medical card that lands in a Downloads
 * folder has not been shown to him. So the disposition is now decided per type
 * instead of being `attachment` for everything. NOTHING ELSE ABOUT THE RESPONSE
 * CHANGED — see the header note below.
 *
 * What makes this safe is not this list, it is `checkFile`: the stored type is
 * decided by the FIRST BYTES of the upload, never by the name or the declared
 * type, and SVG, HTML and XML match no entry in ACCEPTED_TYPES, so they are
 * refused at the door. A renamed `.svg` never becomes a row. That is why the
 * only things in the bucket are PDF and raster images, and a raster image is
 * pixels: a browser cannot be talked into executing one.
 *
 * WHY EACH ENTRY:
 *   image/jpeg, image/png, image/webp — decoded as pixels by an image decoder.
 *     There is no scripting surface in any of the three. Checked in Chrome 148
 *     against this exact response: a top-level open renders the picture, and an
 *     `<img>` in the list renders it too.
 *
 * WHAT IS DELIBERATELY ABSENT, and the PDF is the surprising one:
 *
 *   application/pdf — A PDF IS SAFE TO RENDER BUT CANNOT BE RENDERED HERE, so
 *     promising otherwise would re-create the bug this change was meant to fix.
 *     Measured, not assumed: served with `inline` and the headers below, Chrome
 *     148 DOWNLOADS the file instead of opening its viewer. It is our own CSP
 *     that does it — `sandbox` blocks plugin instantiation and `default-src
 *     'none'` implies `object-src 'none'`, and the PDF viewer is reached through
 *     both. It is not a browser preference: `navigator.pdfViewerEnabled` was
 *     true in the same browser, so that Chrome renders PDFs everywhere else.
 *
 *     The choice was therefore: weaken the CSP for PDFs, or tell the owner the
 *     truth. The CSP stays. A PDF row says "Save" and says why in one line,
 *     because a link marked "Open" that quietly downloads is exactly what he
 *     complained about. If inline PDFs are wanted later, the fix is NOT to drop
 *     the CSP — it is to serve documents from a separate origin, where a
 *     rendered file cannot reach this site's session no matter what it contains.
 *
 *   image/heic — accepted on upload because an iPhone on its default setting
 *     produces nothing else, but only Safari can display it. Inline in Chrome or
 *     Firefox is a broken frame or a silent download, which is the same broken
 *     promise. It stays an attachment and the list says so in words.
 *
 *   Anything not on this list, INCLUDING a type nobody has thought of yet.
 *     Membership is tested AFTER `servableType`, so an unknown or hostile stored
 *     value has already collapsed to application/octet-stream and can never
 *     match. The list is allow-only; it fails closed.
 */
const INLINE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp']

/**
 * JPEG, PNG, WEBP: the ones an `<img>` on our own page can draw.
 *
 * THE SAME THREE AS INLINE_TYPES TODAY, AND NOT THE SAME IDEA — do not merge
 * them. Inline is "the browser may render this as a page of its own"; showable
 * is "an `<img>` can draw it in our list". They coincide only because the PDF is
 * currently barred from the first list by our CSP. Give documents their own
 * origin and the PDF becomes inline but still not showable, because no `<img>`
 * has ever drawn a PDF.
 */
const SHOWABLE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp']

/**
 * inline or attachment, decided from the validated type and nothing else.
 *
 * `servableType` runs FIRST and is the only input. A row that claims
 * `text/html`, `image/svg+xml` or anything else off the accept table becomes
 * application/octet-stream here, which is not in INLINE_TYPES, so it is an
 * attachment — there is no path through this function that turns an unsafe
 * stored value into `inline`. tests/documents.test.ts pins that.
 *
 * `wantsDownload` can only ever make the answer STRICTER. It is the Save link,
 * and it is one-way on purpose: there is no parameter anywhere that asks for
 * inline, because a parameter is written by whoever typed the URL.
 */
export function dispositionFor(
  stored: string | null,
  wantsDownload = false,
): 'inline' | 'attachment' {
  if (wantsDownload) return 'attachment'
  return INLINE_TYPES.includes(servableType(stored)) ? 'inline' : 'attachment'
}

export interface TypeFacts {
  /** Badge text on the row: 'PDF', 'Photo', 'iPhone photo', 'File'. */
  label: string
  /** True when an `<img>` in our own page can show it. JPEG, PNG, WEBP. */
  showable: boolean
  /** True when clicking it opens it in the browser instead of saving it. */
  opens: boolean
  /**
   * One plain sentence for a file we cannot show, or '' for one we can.
   *
   * It lives here rather than in the component so the reason and the behaviour
   * are written in the same place: whatever makes `opens` false is what this
   * sentence has to explain.
   */
  note: string
}

/**
 * What the list is allowed to PROMISE about a file.
 *
 * `opens` is derived from `dispositionFor`, the same function the route uses, so
 * a row can never offer "Open" for a file the server is about to send as a
 * download. That is the whole reason this lives here and not in the component.
 */
export function typeFacts(stored: string | null): TypeFacts {
  const type = servableType(stored)
  const label =
    type === 'application/pdf'
      ? 'PDF'
      : type === 'image/heic'
        ? 'iPhone photo'
        : SHOWABLE_TYPES.includes(type)
          ? 'Photo'
          : 'File'
  // Short sentences, and each one says what to DO. The readers here often read
  // English as a second language, so no clause explains a header to them.
  const note =
    type === 'application/pdf'
      ? 'A PDF does not open here. Save it, then open it.'
      : type === 'image/heic'
        ? 'HEIC does not open in a browser. Save it, then open it on your phone.'
        : SHOWABLE_TYPES.includes(type)
          ? ''
          : 'We cannot show this file here. Save it to open it.'
  return {
    label,
    note,
    showable: SHOWABLE_TYPES.includes(type),
    opens: dispositionFor(stored) === 'inline',
  }
}

/**
 * The headers that make serving an uploaded file safe.
 *
 * SERVING USER FILES FROM YOUR OWN ORIGIN IS HOW STORED XSS HAPPENS. A file the
 * browser decides to render runs inside this site: it can read the session
 * cookie's pages, post forms as the owner, and read every carrier record the
 * owner can. Four headers, and each one closes a different way in:
 *
 *   Content-Disposition — WHAT CHANGED, and the only thing that changed. It was
 *     `attachment` for every file. It is now `inline` for the types in
 *     INLINE_TYPES and `attachment` for everything else, decided by
 *     `dispositionFor` from the re-validated type. Read the note on
 *     INLINE_TYPES for why that is safe; the short version is that the upload
 *     path refuses every executable format by its first bytes, so nothing that
 *     a browser could run as this site is ever in the bucket. The filename is
 *     the uploader's, so it is sent twice: a stripped ASCII form for old parsers
 *     and RFC 5987 `filename*` for everything since. Quotes and backslashes are
 *     removed rather than escaped, because a filename is not worth a
 *     header-injection bug.
 *
 *   X-Content-Type-Options: nosniff — UNCHANGED, and it matters MORE now, not
 *     less. It is what stops a browser ignoring the declared type and guessing
 *     from the content, which is how a "PDF" full of HTML gets rendered as HTML.
 *     Inline without nosniff would be the bug I was told not to write.
 *
 *   Content-Security-Policy: default-src 'none'; sandbox — UNCHANGED. If a file
 *     is rendered, it may load nothing and run nothing, and `sandbox` with no
 *     tokens puts it in a unique opaque origin, so it is not this site and has
 *     no access to this site's cookies or data. This is the header that makes
 *     inline survivable even if the type check were somehow wrong.
 *
 *   X-Frame-Options: DENY — UNCHANGED. Nothing here is framed, so it cannot be
 *     used to dress up another page. It is also why a PDF gets a link and not an
 *     `<object>`/`<iframe>` preview: the header forbids framing, and keeping the
 *     header is worth more than an embedded PDF.
 *
 * The type itself is re-checked against the accept table, never reflected from
 * the row. Cache-Control is private and no-store: this is one carrier's medical
 * certificate and it has no business in a shared cache. The /app middleware sets
 * the same thing; it is repeated here so a future route change cannot quietly
 * drop it.
 */
export function serveHeaders(
  doc: {
    content_type: string | null
    file_name: string | null
    byte_size?: number | null
  },
  opts: { download?: boolean } = {},
): Headers {
  const name = safeFileName(doc.file_name) ?? 'document'
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')
  const disposition = dispositionFor(doc.content_type, opts.download === true)
  const headers = new Headers({
    'Content-Type': servableType(doc.content_type),
    'Content-Disposition': `${disposition}; filename="${ascii || 'document'}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'private, no-store',
  })
  return headers
}

/**
 * Serve it as a download, whatever it is.
 *
 * The Save link and every type that is not safe to render both end here. Kept as
 * its own export because "send this as an attachment" is a thing a caller should
 * be able to ask for in one word, and because the tests that pin the download
 * headers are testing a real path, not a historical one.
 */
export function downloadHeaders(doc: {
  content_type: string | null
  file_name: string | null
  byte_size?: number | null
}): Headers {
  return serveHeaders(doc, { download: true })
}

// ---------------------------------------------------------------------------
// The bucket
// ---------------------------------------------------------------------------

/**
 * The R2 bucket bound as DOCUMENTS, or null.
 *
 * Reached through `cloudflare:workers` exactly like every other runtime value in
 * this app — `Astro.locals.runtime.env` was removed in Astro v6, and the module
 * does not exist outside the Worker runtime, hence the dynamic import and the
 * catch. There is no `process.env` fallback and there cannot be one: a bucket is
 * an object with methods, not a string, so an environment that has no binding
 * has no bucket.
 *
 * `import.meta.env` IS NOT USED HERE AND MUST NEVER BE. Vite replaces that whole
 * expression, so indexing it with a variable inlines every secret on the build
 * machine into dist/. tests/env-inlining.test.ts enforces it; the reason is in
 * src/lib/billing/config.ts.
 *
 * Null is returned rather than thrown so the caller can say a sentence an owner
 * can act on instead of showing him a stack trace.
 */
export async function documentBucket(): Promise<R2Bucket | null> {
  let workerEnv: Record<string, unknown> = {}
  try {
    workerEnv = (await import('cloudflare:workers')).env as unknown as Record<string, unknown>
  } catch {
    // Not the Worker runtime. There is no bucket to find.
  }
  const bucket = workerEnv.DOCUMENTS as R2Bucket | undefined
  if (!bucket || typeof bucket.put !== 'function' || typeof bucket.get !== 'function') return null
  return bucket
}

/** Shown when the binding is missing. Says what is wrong and who can fix it. */
export const NO_BUCKET_MESSAGE =
  'File storage is not switched on for this site, so nothing was saved. Tell us and we will fix it.'

// ---------------------------------------------------------------------------
// Writing one
// ---------------------------------------------------------------------------

export type StoreResult =
  | { ok: true; id: string; warning?: string }
  | { ok: false; message: string }

export interface StoreArgs {
  supabase: SupabaseClient
  bucket: R2Bucket
  carrierId: string
  userId: string | null
  subjectType: DocumentSubject
  subjectId: string
  kind: string
  issuedRaw: unknown
  expiresRaw: unknown
  file: File
  /** The document this one replaces, from the form. Null for a first upload. */
  replacesId: string | null
}

/**
 * Store one document: check it, put the object, write the row.
 *
 * THE ORDER IS R2 FIRST, POSTGRES SECOND, AND IT IS NOT ARBITRARY.
 *
 * There is no transaction across the two. One of them can succeed while the
 * other fails, and the two failures are not equally bad:
 *
 *   ROW FIRST would mean a window where a document is listed, with its kind and
 *   its dates, and the file behind it does not exist. The owner sees a medical
 *   card on the screen, believes it is filed, and finds out it is not on the
 *   morning an investigator asks. The row is a promise about a file, so it must
 *   never be written before the file is there.
 *
 *   OBJECT FIRST can leave an orphan object — bytes in a bucket that no row
 *   points at. Nothing lists it, nothing serves it, and it costs a fraction of a
 *   cent. That is the failure we choose.
 *
 * So: put the object, then insert the row. If the insert fails, delete the
 * object we just wrote, and if THAT delete also fails, give up and leave the
 * orphan — an unreferenced object is still the harmless side. Either way the
 * owner is told nothing was saved, which is true, because no row exists.
 *
 * The supersede comes LAST, after the new row is safely in. If it fails, the old
 * document keeps showing as current beside the new one: two current documents,
 * both real, both openable, and a message saying so. That is visible and
 * correctable. Superseding first would have left a moment where the driver had
 * no current medical card at all.
 */
export async function storeDocument(args: StoreArgs): Promise<StoreResult> {
  const kinds = kindsFor(args.subjectType)
  if (!kinds.some((k) => k.key === args.kind)) {
    return { ok: false, message: 'Pick what kind of paper this is.' }
  }

  const dates = checkDates(args.issuedRaw, args.expiresRaw)
  if (!dates.ok) return { ok: false, message: dates.message }

  // Not a File: the field was left empty, or something other than a file was
  // posted under that name.
  if (!(args.file instanceof File) || args.file.size === 0) {
    return { ok: false, message: 'Choose a file first.' }
  }
  if (args.file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      message: `That file is too big. The limit is ${MAX_UPLOAD_LABEL}. Take a new photo, or send a smaller file.`,
    }
  }

  // Read once. The size is now the real one, measured here, not the one the
  // request claimed in a header.
  const bytes = new Uint8Array(await args.file.arrayBuffer())
  const check = checkFile({
    name: args.file.name,
    size: bytes.byteLength,
    head: bytes.slice(0, 32),
  })
  if (!check.ok) return { ok: false, message: check.message }

  // The replacement is decided BEFORE anything is written, so a bad replace id
  // costs nothing and leaves no object behind.
  let supersedeId: string | null = null
  if (args.replacesId !== null) {
    if (!UUID.test(args.replacesId)) {
      return {
        ok: false,
        message: 'We cannot find the document you are replacing. Nothing changed.',
      }
    }
    // RLS scopes this: another carrier's document simply is not here.
    const { data: existing } = await args.supabase
      .from('documents')
      .select('id, subject_type, subject_id, superseded_at')
      .eq('id', args.replacesId)
      .maybeSingle()

    const plan = planReplacement({
      existing: (existing as DocumentRow | null) ?? null,
      subjectType: args.subjectType,
      subjectId: args.subjectId,
    })
    if (!plan.ok) return { ok: false, message: plan.message }
    supersedeId = plan.supersedeId
  }

  const storageKey = newStorageKey(args.carrierId, check.type.ext)

  // 1. The object.
  try {
    await args.bucket.put(storageKey, bytes, {
      httpMetadata: {
        contentType: check.type.mime,
        // Belt and braces on the object itself. Our own route sets this header
        // on every response; this makes it true even if the bucket is ever
        // exposed some other way.
        contentDisposition: 'attachment',
      },
      // Enough to trace an object back to a tenant during an incident without
      // putting anything private in the key.
      customMetadata: { carrierId: args.carrierId, subjectType: args.subjectType },
    })
  } catch (e) {
    return {
      ok: false,
      message: `We could not save that file. Nothing was saved. Try again. (${message(e)})`,
    }
  }

  // 2. The row.
  const { data: inserted, error } = await args.supabase
    .from('documents')
    .insert({
      carrier_id: args.carrierId,
      subject_type: args.subjectType,
      subject_id: args.subjectId,
      kind: args.kind,
      storage_key: storageKey,
      file_name: safeFileName(args.file.name),
      content_type: check.type.mime,
      byte_size: bytes.byteLength,
      issued_on: dates.issuedOn,
      expires_on: dates.expiresOn,
      uploaded_by: args.userId,
    })
    .select('id')
    .maybeSingle()

  if (error || !inserted) {
    // Take the object back out. Best effort: if this fails too, the object is an
    // orphan nothing points at, which is the side of the failure we chose.
    await args.bucket.delete(storageKey).catch(() => {})
    return { ok: false, message: insertMessage(error?.message ?? 'no row returned') }
  }
  const id = String((inserted as { id: string }).id)

  // 3. The supersede, last.
  if (supersedeId) {
    const { error: supersedeError } = await args.supabase
      .from('documents')
      .update({ superseded_at: new Date().toISOString(), superseded_by: id })
      .eq('id', supersedeId)
      // Stops a double submit moving the time on a row that was already replaced.
      .is('superseded_at', null)
    if (supersedeError) {
      return {
        ok: true,
        id,
        warning:
          'The new file is saved. We could not mark the old one as replaced, so both are listed. Try Replace again on the old one.',
      }
    }
  }

  return { ok: true, id }
}

/**
 * The whole POST, from a form to the query string the page redirects with.
 *
 * Both subject pages call this and do nothing else, so there is one upload path
 * and not two that drift. It always returns a query string — never throws, never
 * a Response — because the page owns its own redirect and its own URL shape.
 *
 * `#documents` is on every answer so the browser lands back on this section
 * rather than at the top of a long page, where the message would be off screen.
 */
export async function uploadFromForm(args: {
  form: FormData
  supabase: SupabaseClient
  carrierId: string
  userId: string | null
  subjectType: DocumentSubject
  subjectId: string
}): Promise<string> {
  const fail = (m: string) => `doc_error=${encodeURIComponent(m)}#documents`

  // The page already knows what it is. These posted fields exist only so a form
  // aimed at the wrong page is refused instead of quietly filing a document on
  // whatever page it landed on.
  const postedType = String(args.form.get('subject_type') ?? '')
  const postedId = String(args.form.get('subject_id') ?? '')
  if (postedType !== args.subjectType || postedId !== args.subjectId) {
    return fail('That form was for a different page. Nothing was saved. Try again.')
  }

  const bucket = await documentBucket()
  if (!bucket) return fail(NO_BUCKET_MESSAGE)

  const file = args.form.get('file')
  const replaces = String(args.form.get('replaces') ?? '').trim()

  const result = await storeDocument({
    supabase: args.supabase,
    bucket,
    carrierId: args.carrierId,
    userId: args.userId,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    kind: String(args.form.get('kind') ?? ''),
    issuedRaw: args.form.get('issued_on'),
    expiresRaw: args.form.get('expires_on'),
    file: file as File,
    replacesId: replaces === '' ? null : replaces,
  })

  if (!result.ok) return fail(result.message)
  if (result.warning) {
    return `doc_saved=1&doc_warning=${encodeURIComponent(result.warning)}#documents`
  }
  return 'doc_saved=1#documents'
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Postgres speaks to the office manager here, so translate it.
 *
 * The subject trigger in 0003 raises a sentence with two uuids in it when the
 * driver or the truck is not in this carrier — which is what a hand-edited URL
 * produces. Showing that raw would put two uuids and the word "carrier" across
 * the screen of somebody who was filing a medical card.
 */
function insertMessage(raw: string): string {
  if (raw.includes('does not belong to carrier')) {
    return 'That driver or truck is not in your fleet. Nothing was saved.'
  }
  if (raw.includes('row-level security') || raw.includes('violates row-level')) {
    return 'You cannot file a document there. Nothing was saved.'
  }
  return `We could not save that file. Nothing was saved. Try again. (${raw})`
}
