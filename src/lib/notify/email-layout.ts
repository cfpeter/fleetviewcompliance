/**
 * The one HTML layout every email this product sends is built with.
 *
 * WHY ONE MODULE. The login email and the morning deadline list are the only two
 * things most carriers ever see from us. They have to look like the same company
 * wrote them, and the way to guarantee that is to leave exactly one place where
 * an email's markup is decided — the same discipline as src/lib/notify/guard.ts,
 * which is the one place a recipient is decided.
 *
 * EMAIL HTML IS NOT WEB HTML, and everything below follows from that:
 *
 *   * INLINE STYLES ON EVERY ELEMENT. Gmail strips <head> stylesheets in several
 *     contexts and no class survives a forwarded message. There is no Tailwind
 *     here and there cannot be.
 *   * TABLES FOR LAYOUT. Outlook renders through Word, which has no flexbox, no
 *     grid and no `position`. The <div>s below only stack text inside a cell —
 *     every column, every centring, every panel is a table.
 *   * NO IMAGES AT ALL, and therefore NO TRACKING PIXEL. Most clients block
 *     images by default, so the wordmark is text. The pixel is refused for a
 *     harder reason: this product's promise is that it does not watch people,
 *     and an open-tracking beacon would break that promise in the one place a
 *     carrier's IT person would notice. tests/email-layout.test.ts pins it.
 *   * LEAN MARKUP. Gmail clips a message past roughly 102KB and hides the rest
 *     behind "View entire message" — which on the digest would hide deadlines.
 *     No repeated <style> blocks, no decoration that costs bytes.
 *   * BOTH background-color AND color, explicitly, on anything that matters.
 *     Some clients invert colours for dark mode, and a cell that only sets one
 *     of the pair ends up white on white.
 *
 * THE COLOURS ARE THE PRODUCT, NOT DECORATION. Red is overdue, amber is due
 * inside 45 days, green is on track, grey is "we do not have this date". Grey is
 * never green and is never dropped, and NO colour ever appears without the word
 * beside it — a colourblind reader and a text-only client have to reach the same
 * answer as everybody else. That is why a tone's colours are only ever emitted
 * by `groupHeading`, which prints the tone's word in the same cell.
 */

/** The app's own tokens, from src/styles/global.css. Hex, because email.
 *  brand700 is Emerald Ink, the brand; champagne is the warm tint it sits on.
 *  Change a value there, change it here — tests/brand-tokens.test.ts holds
 *  the two files to the same numbers. */
export const PALETTE = {
  brand500: '#0e8264',
  brand600: '#00694f',
  brand700: '#064e3b',
  brand800: '#003f2c',
  champagne: '#f8e7c9',
  ink50: '#f6f7f8',
  ink100: '#eaecef',
  ink500: '#6b7480',
  ink700: '#39414c',
  ink900: '#171b21',
  white: '#ffffff',
} as const

/**
 * One stack, repeated on every cell that holds text.
 *
 * Repeated rather than set once on a wrapper because Word does not inherit a
 * font into table cells, and a digest rendered in Times New Roman is a digest
 * that looks like somebody else sent it. Single quotes inside, because this
 * string lives in a double-quoted `style` attribute.
 */
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

/** 16px everywhere, and nothing anywhere is smaller than 14px. */
const BODY_SIZE = '16px'
const SMALL_SIZE = '14px'

/**
 * The four urgency states, plus the owner's own reminders.
 *
 * `word` is not optional and not decoration: it is what makes the colour
 * readable. Every tint/ink pair here is at or above 7:1, which clears the app's
 * own floor for text on a tinted panel (ink-700) with room to spare.
 *
 * The hex values are the app's status tokens from src/styles/global.css:
 * emerald-100/800/700 for on track, amber-100/800/700 for due soon, red for
 * overdue, ink for no record. The green is a grass green and not the brand's
 * Emerald Ink, and "your own reminders" — the one group that IS the brand
 * talking — sits on Champagne with Ink text, so nothing brand-coloured can be
 * read as a deadline state and nothing deadline-coloured can be read as us.
 *
 *   ontrack  #006017 on #d2fdda  7.00:1     soon  #823501 on #ffef93  7.33:1
 *   overdue  #991b1b on #fee2e2  6.87:1     own   #064e3b on #f8e7c9  7.99:1
 */
export type Tone = 'overdue' | 'nodate' | 'soon' | 'ontrack' | 'own'

export interface ToneStyle {
  /** The word that must appear wherever the colour appears. */
  word: string
  /** The sentence after the count. Plain, and it says what to do. */
  note: string
  tint: string
  ink: string
  bar: string
}

export const TONES: Record<Tone, ToneStyle> = {
  overdue: {
    word: 'Overdue',
    note: 'fix these first',
    tint: '#fee2e2',
    ink: '#991b1b',
    bar: '#b91c1c',
  },
  nodate: {
    word: 'No record',
    note: 'we do not have the last date',
    tint: PALETTE.ink100,
    ink: PALETTE.ink700,
    bar: PALETTE.ink500,
  },
  soon: {
    word: 'Due soon',
    note: 'inside 45 days',
    tint: '#ffef93',
    ink: '#823501',
    bar: '#bb4d00',
  },
  ontrack: {
    word: 'On track',
    note: 'nothing to do today',
    tint: '#d2fdda',
    ink: '#006017',
    bar: '#007925',
  },
  own: {
    word: 'Your own reminders',
    note: 'you wrote these, they are not laws',
    tint: PALETTE.champagne,
    ink: PALETTE.brand700,
    bar: PALETTE.brand500,
  },
}

/** Text and attribute values alike. A carrier name with an ampersand in it must
 *  not be able to close a tag, and a redirect URL carrying `&` must survive. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`

// ---------------------------------------------------------------------------
// The blocks an email is made of
// ---------------------------------------------------------------------------

/** One line of a list: what it is, what it is about, when, and the small print. */
export interface EmailRow {
  title: string
  /** The driver, the truck, or the company. Empty when it is the company. */
  about?: string
  /** Already in plain words — "overdue 12 days", "due in 29 days". */
  when: string
  /** The CFR citation, or the sentence that stands in for one. */
  foot?: string
}

export type EmailBlock =
  /** The answer, first, before anything else on the page. */
  | { kind: 'headline'; text: string; sub?: string }
  | { kind: 'text'; text: string }
  /** A table cell with a background colour. Never a styled div. */
  | { kind: 'button'; label: string; href: string; showUrl?: boolean }
  /** The 6-digit code emails: the digits big, the sentence under them. */
  | { kind: 'code'; value: string; text?: string }
  | { kind: 'group'; tone: Tone; rows: readonly EmailRow[] }
  | { kind: 'footnote'; text: string }

const td = (style: string, inner: string) => `<tr><td style="${style}">${inner}</td></tr>`

/** The white page the blocks sit on. Both colours, always — see the dark-mode
 *  note at the top of this file. */
const PAD = (top: string) =>
  `padding:${top} 22px 0 22px;background-color:${PALETTE.white};font-family:${FONT};`

function renderHeadline(text: string, sub?: string): string {
  const head = td(
    `${PAD('4px')}font-size:22px;line-height:1.25;font-weight:700;color:${PALETTE.ink900};`,
    escapeHtml(text),
  )
  if (!sub) return head
  return (
    head +
    td(
      `${PAD('4px')}font-size:${BODY_SIZE};line-height:1.45;color:${PALETTE.ink700};`,
      escapeHtml(sub),
    )
  )
}

/** Paragraphs, with a single newline inside one becoming a line break. */
function renderText(text: string): string {
  const html = text
    .split('\n')
    .map((line) => linkify(line))
    .join('<br>')
  return td(`${PAD('14px')}font-size:${BODY_SIZE};line-height:1.55;color:${PALETTE.ink900};`, html)
}

/**
 * A URL or an email address inside a sentence becomes a real link.
 *
 * Bare text is escaped FIRST and the anchor built around the escaped form, so
 * nothing in a message body can introduce markup of its own.
 */
function linkify(line: string): string {
  const escaped = escapeHtml(line)
  return escaped
    .replace(
      /https?:\/\/[^\s<]+/g,
      (url) => `<a href="${url}" style="color:${PALETTE.brand700};">${url}</a>`,
    )
    .replace(
      /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
      (mail) => `<a href="mailto:${mail}" style="color:${PALETTE.brand700};">${mail}</a>`,
    )
}

/**
 * The button.
 *
 * A table cell with a background colour, and the anchor carries that colour too:
 * a client that strips the cell's fill would otherwise leave white text on a
 * white card. The padding makes it a 44px target on a phone.
 */
function renderButton(label: string, href: string, showUrl: boolean): string {
  const url = escapeHtml(href)
  const button = td(
    `padding:18px 22px 0 22px;background-color:${PALETTE.white};`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
      `<tr><td bgcolor="${PALETTE.brand700}" style="background-color:${PALETTE.brand700};border-radius:8px;">` +
      `<a href="${url}" style="display:inline-block;padding:13px 24px;font-family:${FONT};` +
      `font-size:${BODY_SIZE};line-height:1.2;font-weight:700;color:${PALETTE.white};` +
      `background-color:${PALETTE.brand700};text-decoration:none;border-radius:8px;">` +
      `${escapeHtml(label)}</a></td></tr></table>`,
  )
  if (!showUrl) return button
  // The same address in full, for a client that will not draw the button and for
  // anyone who would rather see where a link goes before pressing it.
  return (
    button +
    td(
      `${PAD('10px')}font-size:${SMALL_SIZE};line-height:1.5;color:${PALETTE.ink700};`,
      'If the button does not work, open this address:',
    ) +
    td(
      `${PAD('2px')}font-size:${SMALL_SIZE};line-height:1.5;word-break:break-all;color:${PALETTE.ink700};`,
      `<a href="${url}" style="color:${PALETTE.brand700};word-break:break-all;">${url}</a>`,
    )
  )
}

function renderCode(value: string, text?: string): string {
  const panel = td(
    `padding:16px 22px 0 22px;background-color:${PALETTE.white};`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">` +
      `<tr><td align="center" style="background-color:${PALETTE.ink50};border:1px solid ${PALETTE.ink100};` +
      `border-radius:8px;padding:16px 10px;font-family:${FONT};font-size:30px;line-height:1.2;` +
      `font-weight:700;letter-spacing:4px;color:${PALETTE.ink900};">${escapeHtml(value)}</td></tr></table>`,
  )
  return text ? panel + renderText(text) : panel
}

/**
 * The heading of one urgency group — the ONLY place a tone's colours are
 * emitted, and it always prints the tone's word in the same cell.
 *
 * Keep it that way. The moment a colour is used somewhere that carries no word,
 * a reader who cannot see it loses the answer.
 */
export function groupHeadingText(tone: Tone, count: number): string {
  const t = TONES[tone]
  return `${t.word} · ${plural(count, 'item', 'items')} · ${t.note}`
}

function renderGroup(tone: Tone, rows: readonly EmailRow[]): string {
  const t = TONES[tone]
  const heading =
    `<tr><td style="background-color:${t.tint};border-left:4px solid ${t.bar};padding:9px 12px;` +
    `font-family:${FONT};font-size:${SMALL_SIZE};line-height:1.45;color:${t.ink};">` +
    `<strong style="color:${t.ink};">${escapeHtml(t.word)}</strong>` +
    `<span style="color:${t.ink};"> · ${escapeHtml(plural(rows.length, 'item', 'items'))} · ${escapeHtml(t.note)}</span>` +
    `</td></tr>`

  const body = rows
    .map((row, i) => {
      const last = i === rows.length - 1
      const border = last ? '' : `border-bottom:1px solid ${PALETTE.ink100};`
      const about = row.about
        ? `<span style="color:${PALETTE.ink700};"> · ${escapeHtml(row.about)}</span>`
        : ''
      const foot = row.foot
        ? `<div style="font-size:${SMALL_SIZE};line-height:1.45;color:${PALETTE.ink700};">${escapeHtml(row.foot)}</div>`
        : ''
      return (
        `<tr><td style="padding:11px 2px;${border}font-family:${FONT};background-color:${PALETTE.white};color:${PALETTE.ink900};">` +
        `<div style="font-size:${BODY_SIZE};line-height:1.4;font-weight:700;color:${PALETTE.ink900};">${escapeHtml(row.title)}${about}</div>` +
        `<div style="font-size:${BODY_SIZE};line-height:1.45;color:${PALETTE.ink900};">${escapeHtml(row.when)}</div>` +
        `${foot}</td></tr>`
      )
    })
    .join('')

  return td(
    `padding:18px 22px 0 22px;background-color:${PALETTE.white};`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${heading}</table>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${body}</table>`,
  )
}

function renderFootnote(text: string): string {
  return td(
    `padding:20px 22px 0 22px;background-color:${PALETTE.white};font-family:${FONT};` +
      `font-size:${SMALL_SIZE};line-height:1.5;color:${PALETTE.ink700};border-top:1px solid ${PALETTE.ink100};`,
    linkify(text),
  )
}

function renderBlock(block: EmailBlock): string {
  switch (block.kind) {
    case 'headline':
      return renderHeadline(block.text, block.sub)
    case 'text':
      return renderText(block.text)
    case 'button':
      return renderButton(block.label, block.href, block.showUrl ?? false)
    case 'code':
      return renderCode(block.value, block.text)
    case 'group':
      return renderGroup(block.tone, block.rows)
    case 'footnote':
      return renderFootnote(block.text)
  }
}

/** The wordmark. TEXT, never an image — see the note at the top of this file. */
const WORDMARK = td(
  `padding:22px 22px 2px 22px;background-color:${PALETTE.white};font-family:${FONT};` +
    `font-size:${BODY_SIZE};line-height:1.3;font-weight:700;color:${PALETTE.brand700};`,
  'FleetView Compliance',
)

/** The last row, so the card does not end flush against its own border. */
const TAIL = td(
  // `font-size:0` because this row holds no words — only the gap. It is the one
  // place in the document where a size under 14px is not text being shrunk.
  `padding:0 22px 24px 22px;background-color:${PALETTE.white};font-size:0;line-height:0;`,
  '&nbsp;',
)

/**
 * Blocks into a whole message.
 *
 * 600px wide, centred, and fluid below that so it still reads on a 320px phone.
 * The two MSO conditional comments are the standard fix for Outlook, which
 * ignores `max-width` and would otherwise stretch the card across the whole
 * reading pane; every other client ignores the comments.
 */
export function renderEmailHtml(blocks: readonly EmailBlock[]): string {
  return (
    '<!doctype html><html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light">' +
    '<meta name="supported-color-schemes" content="light">' +
    '</head>' +
    `<body style="margin:0;padding:0;width:100%;background-color:${PALETTE.ink50};color:${PALETTE.ink900};">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background-color:${PALETTE.ink50};">` +
    `<tr><td align="center" style="padding:16px 12px;background-color:${PALETTE.ink50};">` +
    '<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->' +
    `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;background-color:${PALETTE.white};border:1px solid ${PALETTE.ink100};border-radius:10px;">` +
    WORDMARK +
    blocks.map(renderBlock).join('') +
    TAIL +
    '</table>' +
    '<!--[if mso]></td></tr></table><![endif]-->' +
    '</td></tr></table></body></html>'
  )
}

// ---------------------------------------------------------------------------
// The fallback: a plain-text body, rendered
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS AND WHEN IT RUNS.
 *
 * `send()` guarantees that no email leaves this product without an HTML part,
 * the same way the guard guarantees no message leaves without a decision about
 * its recipient. A caller that has structure worth showing — the digest — hands
 * `send()` the HTML it built with the blocks above. Every other caller hands
 * over the plain text only, and this turns that text into the same layout.
 *
 * It is not a general Markdown parser and must not become one. The bodies it
 * reads are written in this repository, in one shape: paragraphs separated by a
 * blank line, a link alone on its own line, a code at the start of its sentence.
 * Anything it does not recognise renders as a paragraph, which is correct.
 */
export function blocksFromText(text: string): EmailBlock[] {
  const blocks: EmailBlock[] = []
  for (const raw of text.trim().split(/\n{2,}/)) {
    const paragraph = raw.trim()
    if (!paragraph) continue

    // A link on its own line is the action of the message, so it becomes the
    // button — with the address printed underneath, because these are the
    // emails people are most right to be suspicious of.
    if (/^https?:\/\/\S+$/.test(paragraph)) {
      blocks.push({ kind: 'button', label: 'Open the link', href: paragraph, showUrl: true })
      continue
    }

    // "123456 is your code to sign in." The digits are the whole message, so
    // they are printed big and the sentence keeps its own words underneath.
    const code = /^(\d{4,8})\s+(is your code\b[\s\S]*)$/.exec(paragraph)
    if (code) {
      blocks.push({ kind: 'code', value: code[1], text: code[2] })
      continue
    }

    blocks.push({ kind: 'text', text: paragraph })
  }
  return blocks
}

/** The plain-text body of a message, as HTML. */
export function htmlFromText(text: string): string {
  return renderEmailHtml(blocksFromText(text))
}
