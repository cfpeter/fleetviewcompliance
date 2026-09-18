/**
 * The morning digest, as one email.
 *
 * THIS IS THE EMAIL THAT MATTERS. It is the only thing most owners ever read
 * from this product, at six in the morning, on a phone, before the first truck
 * moves. Its job is three sentences long: what is late, what is coming, and
 * what to do about it. One glance has to answer "is today a problem".
 *
 * So: the answer first, then the list grouped by urgency with the word spelled
 * out beside every colour, then ONE link to the app. It is deliberately not a
 * dashboard — nothing here is a chart, nothing is a second navigation, and no
 * row is individually clickable, because an inbox is not a screen to work in.
 *
 * WHY IT LIVES HERE AND NOT IN THE CRON ROUTE. src/pages/api/cron/digest.ts
 * cannot be called without a Worker runtime and a database, so anything composed
 * inside it is untestable. Everything in this file is pure: the same inputs
 * produce the same subject, the same text and the same HTML, and tests can hold
 * all three side by side and check they say the same thing.
 *
 * BOTH PARTS ALWAYS SAY THE SAME THING. `text` and `html` are built from one set
 * of rows and one set of headings — see `groupHeadingText` and `deadlineWhen` —
 * so a reader on a text-only client and a reader in Gmail get the same answer,
 * the same dates and the same link. They must never be written twice.
 */
import type { ReminderItem } from '../reminders.ts'
import { reminderEmailLine, reminderEmailParts } from '../reminders.ts'
import { daysBetween, toUtcMidnight } from '../rules/dates.ts'
import type { DeadlineItem } from '../rules/index.ts'
import { SOON_DAYS } from '../rules/index.ts'
import {
  type EmailBlock,
  type EmailRow,
  groupHeadingText,
  plural,
  renderEmailHtml,
  type Tone,
} from './email-layout.ts'

/** UTC, always. Every date in the engine is a UTC midnight, and rendering one in
 *  the reader's zone moves half the year's deadlines back a day. */
const DUE_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
}
const onDate = (d: Date) => d.toLocaleDateString('en-US', DUE_FORMAT)

/**
 * Which bucket a deadline belongs in.
 *
 * `unknown` gets its OWN bucket and never joins "on track". An item whose last
 * cycle we have no record of is not a green item — it is a question waiting on
 * the owner — and quietly colouring it green would be the product telling him
 * something it does not know. It sits second, right under overdue, exactly where
 * the dashboard's own sort order puts it.
 */
export function toneOf(item: { status: { standing: string }; daysUntil?: number }): Tone {
  if (item.status.standing === 'overdue') return 'overdue'
  if (item.status.standing === 'unknown') return 'nodate'
  return (item.daysUntil ?? Number.POSITIVE_INFINITY) <= SOON_DAYS ? 'soon' : 'ontrack'
}

/** The order the groups are read in: worst first, and "no record" above
 *  everything that is merely scheduled. */
const TONE_ORDER: readonly Tone[] = ['overdue', 'nodate', 'soon', 'ontrack']

/**
 * When a deadline is due, in words a person says out loud.
 *
 * No "29d", no bare ISO date on its own. The number of days late is counted
 * from `lastDue` and NEVER from `daysUntil`: for an interval rule an overdue
 * item's `nextDue` is the next occurrence in the FUTURE, so `daysUntil` there is
 * a positive number of days until a deadline he has already missed.
 */
export function deadlineWhen(item: DeadlineItem, today: Date): string {
  const s = item.status
  if (s.standing === 'overdue') {
    const due = s.lastDue ?? s.nextDue
    if (!due) return 'overdue'
    const late = daysBetween(toUtcMidnight(due), toUtcMidnight(today))
    return late > 0
      ? `overdue ${plural(late, 'day', 'days')} · was due ${onDate(due)}`
      : `overdue · was due ${onDate(due)}`
  }
  if (s.standing === 'unknown') {
    // The same sentence the dashboard prints. The DATE is real — a statutory
    // quarter end, the MCS-150 formula — and it is the previous cycle we hold no
    // record of, so that is what the line says rather than calling the date a
    // guess.
    return s.nextDue
      ? `due ${onDate(s.nextDue)} · we have no record of the last one`
      : 'we have no record of this one'
  }
  if (!s.nextDue) return 'no date yet'
  const days = item.daysUntil
  if (days === undefined) return `due ${onDate(s.nextDue)}`
  if (days <= 0) return `due today · ${onDate(s.nextDue)}`
  if (days === 1) return `due tomorrow · ${onDate(s.nextDue)}`
  return `due in ${plural(days, 'day', 'days')} · ${onDate(s.nextDue)}`
}

/** One deadline as a row. The citation stays in the small slot, where a
 *  reminder prints the sentence that says it is not a law. */
function deadlineRow(item: DeadlineItem, today: Date): EmailRow {
  return {
    title: item.rule.title,
    about: item.subjectLabel,
    when: deadlineWhen(item, today),
    foot: item.rule.citation,
  }
}

function reminderRow(item: ReminderItem): EmailRow {
  const parts = reminderEmailParts(item)
  return { title: parts.title, about: parts.about, when: parts.when, foot: parts.foot }
}

/** `• Title — About — when` then the citation, indented. The shape the text
 *  digest has always had. */
function textLine(row: EmailRow): string {
  const about = row.about ? ` — ${row.about}` : ''
  return `• ${row.title}${about} — ${row.when}${row.foot ? `\n  ${row.foot}` : ''}`
}

/**
 * The app link, or nothing.
 *
 * PUBLIC_SITE_URL missing used to put a bare "/app" in somebody's email — an
 * address that cannot be opened from an inbox. A link we cannot build honestly
 * is left out of BOTH parts rather than printed broken in both.
 */
export function appLink(siteUrl: string | null | undefined): string | null {
  const base = (siteUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) return null
  try {
    const url = new URL(`${base}/app`)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

export interface DigestInput {
  carrierName: string
  /** The candidates chosen for this recipient. Only `item` is read. */
  deadlines: readonly { item: DeadlineItem }[]
  reminders: readonly { item: ReminderItem }[]
  siteUrl: string | null | undefined
  today: Date
}

export interface DigestEmail {
  subject: string
  /** The plain-text part. Still sent, always — see send.ts. */
  text: string
  html: string
}

/**
 * The line that has to answer the question before he opens anything.
 *
 * "3 overdue. 4 coming up." — two facts, no adjectives. Everything not overdue
 * counts as coming up, and the groups underneath break that down.
 *
 * The word is "overdue" and not "late" because that is the word the subject
 * line uses, the word the red group uses and the word the dashboard's pill uses.
 * One thing, one word, for a reader who is not reading in his first language.
 */
export function digestHeadline(overdue: number, rest: number): string {
  if (overdue > 0 && rest > 0) return `${overdue} overdue. ${rest} coming up.`
  if (overdue > 0) return `${overdue} overdue.`
  return `${rest} coming up.`
}

const isOverdue = (c: { item: { status: { standing: string } } }) =>
  c.item.status.standing === 'overdue'

export function composeDigestEmail(input: DigestInput): DigestEmail {
  const { carrierName, deadlines, reminders, today } = input

  // The subject is unchanged from the first version of this job, deliberately:
  // it is what a person scans in a list of forty emails, and it already works.
  const overdueCount = deadlines.filter(isOverdue).length + reminders.filter(isOverdue).length
  const total = deadlines.length + reminders.length
  const subject = overdueCount
    ? `${overdueCount} overdue · ${carrierName}`
    : `${total} coming up · ${carrierName}`

  const grouped = new Map<Tone, EmailRow[]>()
  for (const c of deadlines) {
    const tone = toneOf(c.item)
    const rows = grouped.get(tone) ?? []
    rows.push(deadlineRow(c.item, today))
    grouped.set(tone, rows)
  }

  const headline = digestHeadline(overdueCount, total - overdueCount)
  const link = appLink(input.siteUrl)
  const footnote = 'You get this email when something is due. Open FleetView to change that.'

  const blocks: EmailBlock[] = [{ kind: 'headline', text: headline, sub: carrierName }]
  if (link) blocks.push({ kind: 'button', label: 'Open FleetView', href: link })

  const textParts: string[] = [`${headline}\n${carrierName}`]

  for (const tone of TONE_ORDER) {
    const rows = grouped.get(tone)
    if (!rows || rows.length === 0) continue
    blocks.push({ kind: 'group', tone, rows })
    textParts.push(groupHeadingText(tone, rows.length))
    for (const row of rows) textParts.push(textLine(row))
  }

  // The owner's own reminders, UNDER the regulations and behind a heading that
  // says whose they are. Same email, because he has one morning; its own group,
  // because every line above carries a CFR citation and these carry the words
  // "Your reminder, not a rule." in that same slot. An owner skimming on a phone
  // must never read his own note as something the government sent him.
  if (reminders.length > 0) {
    const rows = reminders.map((c) => reminderRow(c.item))
    blocks.push({ kind: 'group', tone: 'own', rows })
    textParts.push(groupHeadingText('own', rows.length))
    // The line the reminder itself defines, so the text part keeps the exact
    // wording it has always had while the HTML row is built from the same parts.
    for (const c of reminders) textParts.push(reminderEmailLine(c.item))
  }

  if (link) textParts.push(`See everything: ${link}`)
  textParts.push(footnote)
  blocks.push({ kind: 'footnote', text: footnote })

  return { subject, text: `${textParts.join('\n\n')}\n`, html: renderEmailHtml(blocks) }
}
