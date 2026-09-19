/**
 * The email layout, and the two promises it has to keep.
 *
 * THE FIRST IS THAT NOTHING IS EVER SENT AS HTML ALONE. Every message this
 * product puts on the wire carries a `text` part and an `html` part. The text
 * part is not a leftover: some people read mail as text, every spam filter
 * worth the name scores a message without one worse, and it is the fallback
 * that proves the markup is honest — every link drawn as a button appears in it
 * as an address a person can read.
 *
 * THE SECOND IS THAT THE COLOURS DO NOT CARRY MEANING BY THEMSELVES. Red is
 * overdue, amber is due inside 45 days, green is on track and grey is "we do not
 * have this date" — and every one of them is printed with its word beside it, in
 * the same cell, because a colourblind owner and a text-only client have to
 * reach the same answer as everybody else. Grey is a state of its own: it is
 * never quietly folded into green and never left out.
 *
 * And there is no tracking pixel. There is no image at all. This product sells
 * the promise that it does not watch people, and an open-tracking beacon would
 * break that promise in the one place a carrier would notice.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composeAuthEmails } from '../src/lib/auth/email-hook.ts'
import { composeDigestEmail, deadlineWhen, toneOf } from '../src/lib/notify/digest-email.ts'
import {
  type EmailBlock,
  htmlFromText,
  renderEmailHtml,
  TONES,
  type Tone,
} from '../src/lib/notify/email-layout.ts'
import { send } from '../src/lib/notify/send.ts'
import type { ReminderItem } from '../src/lib/reminders.ts'
import type { DeadlineItem } from '../src/lib/rules/index.ts'
import type { RuleDefinition } from '../src/lib/rules/types.ts'

const SITE = 'https://app.fleetviewcompliance.com'
const SUPABASE_URL = 'https://abcdefghij.supabase.co'
const CALLBACK = 'https://app.fleetviewcompliance.com/auth/callback'
const TODAY = new Date('2026-09-17T00:00:00Z')

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`)

function rule(code: string, title: string, citation: string): RuleDefinition {
  return {
    code,
    title,
    jurisdiction: 'federal',
    subject: 'driver',
    citation,
    sourceUrl: 'https://www.ecfr.gov/current/title-49',
    recurrence: { type: 'expiry', anchor: 'medical_card_expiry' },
    warningDays: [30, 7, 1, -1],
    evidence: 'the card itself',
    consequence: 'the driver may not drive',
    // Every rule row this helper stands in for is a medical certificate, which
    // stops the person and not the fleet.
    impact: 'driver',
  }
}

function deadline(over: Partial<DeadlineItem> & { status: DeadlineItem['status'] }): DeadlineItem {
  return {
    rule: rule('medical_certificate', 'Medical certificate', '49 CFR 391.45'),
    subjectType: 'driver',
    subjectId: 'd1',
    subjectLabel: 'Juan Perez',
    ...over,
  }
}

/** One of each colour, so a rendered digest exercises every tone at once. */
const OVERDUE = {
  item: deadline({
    status: { standing: 'overdue', nextDue: utc('2026-09-05'), lastDue: utc('2026-09-05') },
    daysUntil: -12,
  }),
}
const NODATE = {
  item: deadline({
    rule: rule('ifta_return', 'IFTA quarterly return', '49 CFR 367'),
    subjectLabel: 'Whole company',
    status: { standing: 'unknown', nextDue: utc('2026-10-31') },
    daysUntil: 44,
  }),
}
const SOON = {
  item: deadline({
    rule: rule('mvr_review', 'Annual driving record review', '49 CFR 391.25'),
    subjectLabel: 'Maria Gomez',
    status: { standing: 'current', nextDue: utc('2026-10-16') },
    daysUntil: 29,
  }),
}
const ONTRACK = {
  item: deadline({
    rule: rule('irp_renewal', 'IRP registration', '49 CFR 367'),
    subjectLabel: 'Unit 204',
    status: { standing: 'current', nextDue: utc('2027-03-01') },
    daysUntil: 165,
  }),
}

function reminder(over: Partial<ReminderItem> = {}): { item: ReminderItem } {
  return {
    item: {
      id: 'r1',
      title: 'Pay the insurance',
      note: null,
      dueOn: utc('2026-08-01'),
      repeatMonths: 12,
      leadDays: 7,
      subject: { kind: 'carrier', id: null, label: 'Whole company', href: null },
      status: { standing: 'overdue', nextDue: utc('2026-08-01'), lastDue: utc('2026-08-01') },
      daysUntil: -47,
      lastDoneOn: null,
      completedAt: null,
      ...over,
    },
  }
}

const fullDigest = () =>
  composeDigestEmail({
    carrierName: 'Perez Trucking LLC',
    deadlines: [OVERDUE, NODATE, SOON, ONTRACK],
    reminders: [reminder()],
    siteUrl: SITE,
    today: TODAY,
  })

/** Every auth email Supabase can make us send, composed for real. */
function authMessages(): { action: string; subject: string; text: string; html: string }[] {
  const out: { action: string; subject: string; text: string; html: string }[] = []
  for (const action of [
    'signup',
    'recovery',
    'magiclink',
    'invite',
    'email_change',
    'email',
    'reauthentication',
    'password_changed_notification',
  ]) {
    const composed = composeAuthEmails(
      {
        user: { id: 'u', email: 'owner@carrier.example', new_email: 'new@carrier.example' },
        email_data: {
          token: '123456',
          token_hash: 'pkce_9f1c2d3e4a5b6c7d',
          token_hash_new: 'pkce_current_address_token',
          redirect_to: CALLBACK,
          email_action_type: action,
          old_email: 'old@carrier.example',
        },
      },
      { supabaseUrl: SUPABASE_URL },
    )
    assert.ok(composed.ok, `${action} composed nothing`)
    for (const m of composed.messages) {
      // EXACTLY what send() does with a message nobody pre-rendered. Testing the
      // same call rather than a copy of it is what keeps this honest.
      out.push({ action, subject: m.subject, text: m.body, html: htmlFromText(m.body) })
    }
  }
  return out
}

// --- small readers over the rendered markup ---------------------------------

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const decode = (value: string) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]))
}

function textLinks(text: string): string[] {
  return [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0].replace(/[.,]$/, ''))
}

/**
 * Every `<td>` in the document, as its style and its visible words.
 *
 * Counted with a stack rather than a non-greedy regex, because the layout nests
 * tables inside cells: `([\s\S]*?)</td>` stops at the FIRST closing tag, which
 * belongs to an inner cell, and every outer cell then swallows the inner one's
 * opening tag so its style is never examined at all. That is how a colour with
 * no word beside it would have slipped past this file.
 */
function cells(html: string): { style: string; words: string }[] {
  const out: { style: string; words: string }[] = []
  const open: { style: string; from: number }[] = []
  for (const token of html.matchAll(/<td\b([^>]*)>|<\/td>/g)) {
    const at = token.index ?? 0
    if (token[0].startsWith('</')) {
      const cell = open.pop()
      if (cell) out.push({ style: cell.style, words: strip(html.slice(cell.from, at)) })
      continue
    }
    open.push({
      style: /style="([^"]*)"/.exec(token[1] ?? '')?.[1] ?? '',
      from: at + token[0].length,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Both parts, on every message
// ---------------------------------------------------------------------------

/** Capture what would go to Resend or Twilio, without going anywhere. */
async function onTheWire(message: Parameters<typeof send>[0]): Promise<Record<string, unknown>> {
  const real = globalThis.fetch
  let body: Record<string, unknown> = {}
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 })
  }) as typeof fetch
  try {
    const result = await send(
      message,
      { mode: 'production' },
      {
        resendApiKey: 'k',
        fromEmail: 'info@fleetviewcompliance.com',
        twilioSid: 'AC1',
        twilioToken: 't',
        twilioFrom: '+15550000000',
      },
    )
    assert.equal(result.status, 'sent')
  } finally {
    globalThis.fetch = real
  }
  return body
}

test('an email goes out with a text part AND an html part, never one or the other', async () => {
  const body = await onTheWire({
    channel: 'email',
    to: 'owner@carrier.example',
    subject: 'Confirm your email address',
    body: 'Open this link to confirm your email address:\n\nhttps://example.test/go\n',
  })
  assert.equal(typeof body.text, 'string')
  assert.ok(String(body.text).trim().length > 0, 'the text part is missing')
  assert.equal(typeof body.html, 'string')
  assert.match(String(body.html), /^<!doctype html>/)
  // The text part is the one that was written. It is not derived from the
  // markup and must never be replaced by it.
  assert.match(String(body.text), /Open this link to confirm/)
})

test('a caller that built its own html keeps it', async () => {
  // The digest composes markup the plain text cannot express — groups, colours,
  // a button. send() must not overwrite it with a re-render of the text.
  const mail = fullDigest()
  const body = await onTheWire({
    channel: 'email',
    to: 'owner@carrier.example',
    subject: mail.subject,
    body: mail.text,
    html: mail.html,
  })
  assert.equal(body.html, mail.html)
  assert.equal(body.text, mail.text)
})

test('sms is untouched — there is no html part on a text message', async () => {
  const real = globalThis.fetch
  let form = ''
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    form = String(init?.body ?? '')
    return new Response(JSON.stringify({ sid: 'SM1' }), { status: 200 })
  }) as typeof fetch
  try {
    const result = await send(
      { channel: 'sms', to: '+15551230000', body: 'Perez Trucking LLC: medical card overdue' },
      { mode: 'production' },
      { twilioSid: 'AC1', twilioToken: 't', twilioFrom: '+15550000000' },
    )
    assert.equal(result.status, 'sent')
  } finally {
    globalThis.fetch = real
  }
  assert.match(form, /Body=/)
  assert.doesNotMatch(form, /html/i)
})

test('every auth email and the digest carry a text part', () => {
  for (const m of authMessages()) {
    assert.ok(m.text.trim().length > 0, `${m.action} lost its text part`)
    assert.ok(m.html.length > 0, `${m.action} has no html part`)
  }
  const mail = fullDigest()
  assert.ok(mail.text.trim().length > 0)
  assert.ok(mail.html.length > 0)
})

// ---------------------------------------------------------------------------
// No pixel, no image
// ---------------------------------------------------------------------------

test('there is no tracking pixel and no image of any kind', () => {
  const documents = [fullDigest().html, ...authMessages().map((m) => m.html)]
  for (const html of documents) {
    // `src=` is the single check that covers all of it: no <img>, no beacon, no
    // remote anything. A tracking pixel cannot exist without one.
    assert.doesNotMatch(html, /\ssrc=/i, 'something in the email loads a remote resource')
    assert.doesNotMatch(html, /<img|<picture|<svg|<video|<iframe/i)
    assert.doesNotMatch(html, /background-image|url\(/i)
    assert.doesNotMatch(html, /\.(png|gif|jpe?g|webp)\b/i)
    // The classic beacon shape, in case one is ever reintroduced by another name.
    assert.doesNotMatch(html, /width="1"|height="1"|1x1/i)
  }
})

test('the wordmark is text, so it survives a client that blocks images', () => {
  assert.match(strip(fullDigest().html), /^FleetView Compliance/)
})

// ---------------------------------------------------------------------------
// The same link in both parts
// ---------------------------------------------------------------------------

test('the html and the text carry the SAME link', () => {
  for (const m of authMessages()) {
    const inHtml = hrefs(m.html).filter((h) => h.startsWith('http'))
    const inText = textLinks(m.text)
    for (const href of inHtml) {
      assert.ok(inText.includes(href), `${m.action}: ${href} is in the markup and not in the text`)
    }
    for (const link of inText) {
      assert.ok(inHtml.includes(link), `${m.action}: ${link} is in the text and not in the markup`)
    }
  }

  const mail = fullDigest()
  assert.deepEqual([...new Set(hrefs(mail.html))], [`${SITE}/app`])
  assert.deepEqual(textLinks(mail.text), [`${SITE}/app`])
})

test('the auth link is passed through untouched, pkce prefix and all', () => {
  const [signup] = authMessages()
  const link = `${SUPABASE_URL}/auth/v1/verify?token=pkce_9f1c2d3e4a5b6c7d&type=signup&redirect_to=${encodeURIComponent(CALLBACK)}`
  assert.ok(hrefs(signup.html).includes(link), 'the link in the markup is not the link we built')
  assert.ok(signup.text.includes(link))
})

test('a link is a real anchor with a visible address underneath', () => {
  const [signup] = authMessages()
  assert.match(signup.html, /<a href="https:\/\/abcdefghij\.supabase\.co/)
  // The button, then the same address in words, for a client that will not draw
  // the button and for anybody who wants to see where a link goes first.
  assert.match(strip(signup.html), /If the button does not work, open this address/)
})

test('the digest gives exactly one link to the app, and nothing broken when there is none', () => {
  const none = composeDigestEmail({
    carrierName: 'Perez Trucking LLC',
    deadlines: [OVERDUE],
    reminders: [],
    siteUrl: '',
    today: TODAY,
  })
  // A bare "/app" cannot be opened from an inbox. Left out of BOTH parts rather
  // than printed broken in both.
  assert.equal(hrefs(none.html).length, 0)
  assert.doesNotMatch(none.text, /\/app/)
  assert.match(none.text, /Medical certificate/)
})

// ---------------------------------------------------------------------------
// A colour never appears without its word
// ---------------------------------------------------------------------------

/**
 * The colours that MEAN something, and the word each one must be printed with.
 *
 * `nodate` is matched on its bar rather than its tint: the tint is ink-100,
 * which is also the border colour everywhere in the layout, so scanning for it
 * would flag every divider in the document. The bar is grey-500 and appears
 * nowhere else.
 */
const MEANINGFUL: [Tone, string[]][] = [
  ['overdue', [TONES.overdue.tint, TONES.overdue.ink, TONES.overdue.bar]],
  ['nodate', [TONES.nodate.bar]],
  ['soon', [TONES.soon.tint, TONES.soon.ink, TONES.soon.bar]],
  ['ontrack', [TONES.ontrack.tint, TONES.ontrack.ink, TONES.ontrack.bar]],
  ['own', [TONES.own.tint, TONES.own.bar]],
]

test('no colour is ever used without its word in the same cell', () => {
  const html = fullDigest().html
  let found = 0
  for (const { style, words } of cells(html)) {
    for (const [tone, colours] of MEANINGFUL) {
      if (!colours.some((c) => style.includes(c))) continue
      found++
      assert.ok(
        words.toLowerCase().includes(TONES[tone].word.toLowerCase()),
        `a ${tone} colour is painted on a cell that does not say "${TONES[tone].word}": ${words}`,
      )
    }
  }
  // A scan that matched nothing would pass in silence.
  assert.equal(found, MEANINGFUL.length, 'every tone should have been drawn exactly once')
})

test('every group says its word, its count and what to do, in both parts', () => {
  const mail = fullDigest()
  const words = strip(mail.html)
  for (const heading of [
    'Overdue · 1 item · fix these first',
    'No record · 1 item · we do not have the last date',
    'Due soon · 1 item · inside 45 days',
    'On track · 1 item · nothing to do today',
    'Your own reminders · 1 item · you wrote these, they are not laws',
  ]) {
    assert.ok(words.includes(heading), `the markup does not say: ${heading}`)
    assert.ok(mail.text.includes(heading), `the text does not say: ${heading}`)
  }
})

test('grey is its own answer — never green, and never left out', () => {
  // An item whose last cycle we have no record of is a question waiting on the
  // owner, not a green row. It keeps its own group whatever its countdown says.
  assert.equal(toneOf(NODATE.item), 'nodate')
  assert.equal(toneOf({ status: { standing: 'unknown' }, daysUntil: 2 }), 'nodate')
  assert.equal(toneOf({ status: { standing: 'unknown' }, daysUntil: 900 }), 'nodate')

  const mail = composeDigestEmail({
    carrierName: 'Perez Trucking LLC',
    deadlines: [NODATE],
    reminders: [],
    siteUrl: SITE,
    today: TODAY,
  })
  assert.match(mail.text, /No record · 1 item/)
  assert.match(mail.text, /IFTA quarterly return/)
  assert.match(strip(mail.html), /No record/)
  // and it is not wearing the green.
  assert.ok(!mail.html.includes(TONES.ontrack.tint))
})

test('45 days is where amber starts', () => {
  const at = (days: number) => toneOf({ status: { standing: 'current' }, daysUntil: days })
  assert.equal(at(45), 'soon')
  assert.equal(at(46), 'ontrack')
  assert.equal(at(-3), 'soon')
})

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

test('dates are written in plain words, never in shorthand', () => {
  assert.equal(
    deadlineWhen(OVERDUE.item, TODAY),
    'overdue 12 days · was due Sep 5, 2026',
    'an overdue item counts from the date it was due, not from its next cycle',
  )
  assert.equal(deadlineWhen(SOON.item, TODAY), 'due in 29 days · Oct 16, 2026')
  assert.equal(
    deadlineWhen(NODATE.item, TODAY),
    'due Oct 31, 2026 · we have no record of the last one',
  )

  const mail = fullDigest()
  // No "29d", and no day count crushed against a letter anywhere.
  assert.doesNotMatch(mail.text, /\b\d+d\b/)
  assert.doesNotMatch(strip(mail.html), /\b\d+d\b/)
})

test('an overdue interval rule is counted from the deadline it missed', () => {
  // The trap: for an interval rule an overdue item's `nextDue` is the NEXT
  // occurrence, in the future, so `daysUntil` is a positive number of days
  // until a deadline he has already missed. Counting from it would print
  // "overdue 200 days" on something two weeks late.
  const late = deadline({
    status: { standing: 'overdue', nextDue: utc('2027-04-01'), lastDue: utc('2026-09-01') },
    daysUntil: 196,
  })
  assert.equal(deadlineWhen(late, TODAY), 'overdue 16 days · was due Sep 1, 2026')
})

test('one day is one day', () => {
  const tomorrow = deadline({
    status: { standing: 'current', nextDue: utc('2026-09-18') },
    daysUntil: 1,
  })
  assert.equal(deadlineWhen(tomorrow, TODAY), 'due tomorrow · Sep 18, 2026')
  const now = deadline({
    status: { standing: 'current', nextDue: utc('2026-09-17') },
    daysUntil: 0,
  })
  assert.equal(deadlineWhen(now, TODAY), 'due today · Sep 17, 2026')
})

test('the digest leads with the answer and keeps the subject it always had', () => {
  const mail = fullDigest()
  assert.equal(mail.subject, '2 overdue · Perez Trucking LLC')
  assert.match(mail.text, /^2 overdue\. 3 coming up\.\nPerez Trucking LLC/)
  assert.match(
    strip(mail.html),
    /FleetView Compliance 2 overdue\. 3 coming up\. Perez Trucking LLC/,
  )

  const calm = composeDigestEmail({
    carrierName: 'Perez Trucking LLC',
    deadlines: [SOON],
    reminders: [],
    siteUrl: SITE,
    today: TODAY,
  })
  assert.equal(calm.subject, '1 coming up · Perez Trucking LLC')
  assert.match(calm.text, /^1 coming up\./)
})

test("the owner's own reminders never read as something the government sent", () => {
  const mail = fullDigest()
  const words = strip(mail.html)
  assert.ok(words.includes('Your reminder, not a rule.'))
  assert.ok(mail.text.includes('Your reminder, not a rule.'))
  // The regulation above it prints a citation in that same slot.
  assert.ok(words.includes('49 CFR 391.45'))
  // And the reminder block carries no citation of its own.
  const block = mail.text.slice(mail.text.indexOf('Your own reminders'))
  assert.doesNotMatch(block, /CFR/)
})

test('both parts of the digest name every item', () => {
  const mail = fullDigest()
  const words = strip(mail.html)
  for (const label of [
    'Medical certificate',
    'Juan Perez',
    'IFTA quarterly return',
    'Annual driving record review',
    'IRP registration',
    'Pay the insurance',
  ]) {
    assert.ok(mail.text.includes(label), `the text part lost ${label}`)
    assert.ok(words.includes(label), `the markup lost ${label}`)
  }
})

// ---------------------------------------------------------------------------
// The markup itself
// ---------------------------------------------------------------------------

test('there is no class, no stylesheet and no layout that Outlook cannot draw', () => {
  for (const html of [fullDigest().html, ...authMessages().map((m) => m.html)]) {
    assert.doesNotMatch(html, /\sclass=/, 'a class in an email is a style that will not arrive')
    assert.doesNotMatch(html, /<style/i)
    assert.doesNotMatch(html, /display:\s*(flex|grid)|position:\s*(absolute|fixed|relative)/i)
  }
})

test('600px, centred, and still readable on a 320px phone', () => {
  const html = fullDigest().html
  assert.match(html, /max-width:600px/)
  // The only fixed 600 is inside the Outlook-only comment; every other width is
  // a percentage, so a narrow screen is never asked to scroll sideways.
  const outsideMso = html.replace(/<!--\[if mso\][\s\S]*?<!\[endif\]-->/g, '')
  assert.doesNotMatch(outsideMso, /width="600"/)
  // `max-width` is the one that is allowed; a plain `width:600px` is not.
  assert.doesNotMatch(outsideMso, /[^-]width:\s*600px/)
})

test('nothing is smaller than 14px, and the body type is a system stack', () => {
  const html = fullDigest().html
  for (const [, size] of html.matchAll(/font-size:(\d+)px/g)) {
    assert.ok(Number(size) >= 14, `${size}px is below the floor`)
  }
  // The only size under the floor is the spacer row at the bottom of the card,
  // which holds no words at all. If a second one ever appears, it is text.
  assert.equal((html.match(/font-size:0;/g) ?? []).length, 1)
  assert.match(html, /font-family:-apple-system,'Segoe UI'/)
})

test('a cell that sets a text colour sets a background colour too', () => {
  // Some clients invert colours for dark mode. A cell carrying only one of the
  // pair ends up invisible — white on white, or black on black.
  for (const { style } of cells(fullDigest().html)) {
    if (!/(^|;)color:/.test(style)) continue
    assert.match(style, /background-color:/, `a coloured cell has no background: ${style}`)
  }
})

test('the markup stays well under the size Gmail clips at', () => {
  // Past roughly 102KB Gmail hides the rest behind "View entire message" — which
  // on this email would hide deadlines. A forty-truck fleet has to fit.
  const many = Array.from({ length: 60 }, (_, i) => ({
    item: deadline({
      rule: rule(`r${i}`, `Obligation number ${i}`, '49 CFR 396.17'),
      subjectLabel: `Unit ${100 + i}`,
      status: { standing: 'current', nextDue: utc('2026-10-16') },
      daysUntil: 29,
    }),
  }))
  const mail = composeDigestEmail({
    carrierName: 'Perez Trucking LLC',
    deadlines: many,
    reminders: [],
    siteUrl: SITE,
    today: TODAY,
  })
  assert.ok(mail.html.length < 60_000, `60 items rendered ${mail.html.length} bytes`)
})

test('a carrier name with markup in it cannot break out of the layout', () => {
  const mail = composeDigestEmail({
    carrierName: 'Perez <script>alert(1)</script> LLC',
    deadlines: [OVERDUE],
    reminders: [],
    siteUrl: SITE,
    today: TODAY,
  })
  assert.doesNotMatch(mail.html, /<script/)
  assert.match(mail.html, /&lt;script&gt;/)
})

test('the code emails print the code big and say what it is for', () => {
  const codeEmail = authMessages().find((m) => m.action === 'reauthentication')
  assert.ok(codeEmail)
  assert.match(strip(codeEmail.html), /123456 is your code/)
  assert.match(codeEmail.text, /^123456 is your code/)
})

test('an unknown block shape still renders as something readable', () => {
  // The fallback exists so that a body nobody has thought about is a paragraph,
  // never an empty email.
  const html = htmlFromText('One sentence.\n\nAnother one.\n')
  assert.match(strip(html), /One sentence\. Another one\./)
})

test('a headline with no rows is still a whole document', () => {
  const blocks: EmailBlock[] = [{ kind: 'headline', text: 'Nothing due today.' }]
  const html = renderEmailHtml(blocks)
  assert.match(html, /^<!doctype html>/)
  assert.match(html, /<\/html>$/)
  assert.match(strip(html), /Nothing due today\./)
})
