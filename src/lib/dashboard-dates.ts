/**
 * The dashboard's "we need a date from you" rows, turned into something typeable.
 *
 * Everything on this page is derivation, and all of it lives here rather than in
 * src/pages/app/index.astro. Not tidiness: the page cannot be tested, and three
 * of the decisions below are the kind that fail silently and expensively.
 *
 *   1. ONE INPUT PER DISTINCT (subjectType, subjectId, answerKey). Two rules can
 *      want the same date — `periodic_inspection_date` answers two rules on every
 *      vehicle — and two boxes for one date is two chances to disagree, with the
 *      planner refusing the whole submit as a conflict when they do. Deduping
 *      alone would make the second rule vanish from a list whose entire promise
 *      is that it gets shorter, so the rules a date settles are carried on the
 *      question and rendered under the box.
 *
 *   2. `min`/`max` COME FROM THE REGISTRY'S `kind`, never from the recurrence.
 *      `last_done` takes `max = today`: compute.ts walks forward from the anchor
 *      until it passes today, so a future date makes it step straight past the
 *      occurrence just reported and answer with the one after — the deadline
 *      moves LATER, the one direction this domain refuses to be wrong in.
 *      `expires` takes no lower bound: a medical card that lapsed last month is a
 *      real and urgent fact, and compute.ts exists to turn it into `overdue`.
 *
 *   3. THE DENY-LIST IS OBEYED HERE, ONCE. deadlines.ts projects `hire_date` and
 *      `cdl_expires` out of the driver's own columns with `if (a[key]) continue`,
 *      so a compliance record silently OUTRANKS the column. A typo typed into
 *      either would permanently override a correct date, move five federal rules,
 *      and leave the driver's own page still showing the right one. Those keys
 *      become a link to where the answer really lives, never a box.
 *
 * Ordering is first appearance in the array handed in, at every level — subjects,
 * questions within a subject, rules within a question. The dashboard's order IS
 * the product (unknown ranks with overdue, soonest first), and anything here that
 * sorted would be a second ranking of the same rows that nothing checks against
 * the first. See the doctrine in src/lib/dashboard.ts: a view may only ever HIDE.
 */
import { isStorableDate, type RecordSubject, recordSubjectFor } from './anchors/plan.ts'
import {
  type AnchorExpectation,
  type AnchorKind,
  answerLink,
  resolveAnchor,
  UNWRITABLE_ANCHOR_KEYS,
} from './rules/anchors.ts'
import type { Subject } from './rules/types.ts'

/**
 * The part of a dashboard row this module reads.
 *
 * Narrower than `DeadlineItem` on purpose — `DeadlineItem` satisfies it, so the
 * page passes its `unknown` array straight in, and a test can build a row out of
 * four fields instead of a whole rule definition.
 */
export interface UnknownRow {
  rule: { code: string; title: string; citation: string; sourceUrl: string }
  subjectType: Subject
  subjectId: string | null
  subjectLabel: string
  /** `Status.answerKey` — where a typed date goes. NEVER derived on the page. */
  status: { answerKey?: string }
}

/** One dashboard row that a single typed date takes off the list. */
export interface SettledRule {
  code: string
  title: string
  citation: string
  sourceUrl: string
}

export interface DateQuestion {
  /** `compliance_records.anchor_key`, verbatim from `Status.answerKey`. */
  answerKey: string
  /** The form field name. Unique within a subject because the questions are. */
  field: string
  label: string
  help: string
  kind: AnchorKind
  expected: AnchorExpectation
  /** False when a date typed here would do damage or nothing. */
  writable: boolean
  /** Present exactly when `writable` is false. `href` is null when we cannot build one. */
  elsewhere?: { where: string; href: string | null }
  /** Every row this one date settles, in dashboard order. Never empty. */
  settles: SettledRule[]
}

export type SubjectGroupKey = RecordSubject

export interface DateSubject {
  /** What `?s=` carries. */
  id: string
  type: Subject
  recordSubject: RecordSubject
  group: SubjectGroupKey
  label: string
  /** 'Driver', 'Power unit', 'Trailer', 'Carrier'. */
  noun: string
  href: string
  /** Every question, in first-appearance order. What the save handler reads. */
  questions: DateQuestion[]
  /** `expected: 'always'` — the boxes a normal carrier is expected to fill. */
  asked: DateQuestion[]
  /** `expected: 'only_if_it_applies'` — behind a disclosure, out of the count. */
  onlyIfItApplies: DateQuestion[]
  /** Distinct questions. What the card shows, and it is not the row count. */
  questionCount: number
  /** Dashboard rows behind those questions. Always >= questionCount. */
  rowCount: number
}

export interface DateGroup {
  key: SubjectGroupKey
  title: string
  subjects: DateSubject[]
}

export interface DateEditor {
  /** Non-empty groups, in catalogue order. */
  groups: DateGroup[]
  /** Every subject, flat, in first-appearance order. */
  subjects: DateSubject[]
  subjectCount: number
  questionCount: number
  rowCount: number
  /**
   * Rows whose subject cannot hold a compliance record at all — `employee` and
   * `terminal` rules, and anything with no subject id.
   *
   * Counted rather than dropped. `recordSubjectFor` returns null for both, so
   * there is no table to file the date in; coercing them to 'carrier' would put
   * one person's harassment-training date against the whole company. The page
   * says out loud that they are not on this surface, because a row he can see on
   * the dashboard and cannot find here is a list he stops believing.
   */
  unrecordable: number
  /**
   * Rows the engine gave no `answerKey` for, or whose key has no words in the
   * registry. Both are upstream bugs — tests/anchors-registry.test.ts exists to
   * make sure neither can happen — and both are counted rather than hidden.
   */
  unaskable: number
}

const GROUP_TITLES: Record<SubjectGroupKey, string> = {
  carrier: 'Your carrier',
  driver: 'Drivers',
  vehicle: 'Trucks and trailers',
}

/** Catalogue order for the groups, and the only place it is written down. */
export const SUBJECT_GROUPS: readonly SubjectGroupKey[] = ['carrier', 'driver', 'vehicle']

function nounFor(type: Subject): string {
  switch (type) {
    case 'carrier':
      return 'Carrier'
    case 'driver':
      return 'Driver'
    case 'power_unit':
      return 'Power unit'
    case 'trailer':
      return 'Trailer'
    case 'employee':
      return 'Employee'
    case 'terminal':
      return 'Terminal'
  }
}

export function subjectHrefFor(subjectId: string): string {
  return `/app?show=unknown&s=${encodeURIComponent(subjectId)}`
}

/**
 * Build the whole editor from the dashboard's `unknown` array.
 *
 * The SAME array the tiles and the table are built from, in the SAME order. A
 * second query here — or a sort — would be a second answer to "what is missing",
 * and the two would drift the first time a rule changed.
 */
export function buildDateEditor(rows: readonly UnknownRow[]): DateEditor {
  const subjects: DateSubject[] = []
  const bySubject = new Map<string, DateSubject>()
  const questionsBySubject = new Map<string, Map<string, DateQuestion>>()
  let unrecordable = 0
  let unaskable = 0

  for (const row of rows) {
    const answerKey = row.status.answerKey
    if (!answerKey) {
      unaskable++
      continue
    }

    const recordSubject = recordSubjectFor(row.subjectType)
    if (!recordSubject || !row.subjectId) {
      unrecordable++
      continue
    }

    const entry = resolveAnchor(answerKey)
    if (!entry) {
      unaskable++
      continue
    }

    // Keyed on the subject id alone, not on type + id. A vehicle is a power unit
    // or a trailer and never both, so an id names exactly one subject — and the
    // id is what `?s=` carries, so two subjects sharing one would mean two cards
    // pointing at the same page.
    const subjectId = row.subjectId
    let subject = bySubject.get(subjectId)
    if (!subject) {
      subject = {
        id: subjectId,
        type: row.subjectType,
        recordSubject,
        group: recordSubject,
        label: row.subjectLabel,
        noun: nounFor(row.subjectType),
        href: subjectHrefFor(subjectId),
        questions: [],
        asked: [],
        onlyIfItApplies: [],
        questionCount: 0,
        rowCount: 0,
      }
      bySubject.set(subjectId, subject)
      questionsBySubject.set(subjectId, new Map())
      subjects.push(subject)
    }

    const questions = questionsBySubject.get(subjectId)!
    let question = questions.get(answerKey)
    if (!question) {
      const writable = !UNWRITABLE_ANCHOR_KEYS.has(answerKey)
      question = {
        answerKey,
        // Same field naming as the driver and vehicle screens. Three pages that
        // collect the same dates should not need three conventions.
        field: `date_${answerKey}`,
        label: entry.label,
        help: entry.help,
        kind: entry.kind,
        expected: entry.expected,
        writable,
        elsewhere: writable
          ? undefined
          : {
              where: entry.answeredElsewhere?.where ?? 'the record it belongs to',
              href: answerLink(entry, subjectId),
            },
        settles: [],
      }
      questions.set(answerKey, question)
      subject.questions.push(question)
      if (question.expected === 'always') subject.asked.push(question)
      else subject.onlyIfItApplies.push(question)
      subject.questionCount++
    }

    question.settles.push({
      code: row.rule.code,
      title: row.rule.title,
      citation: row.rule.citation,
      sourceUrl: row.rule.sourceUrl,
    })
    subject.rowCount++
  }

  const groups = SUBJECT_GROUPS.map((key) => ({
    key,
    title: GROUP_TITLES[key],
    subjects: subjects.filter((s) => s.group === key),
  })).filter((g) => g.subjects.length > 0)

  return {
    groups,
    subjects,
    subjectCount: subjects.length,
    questionCount: subjects.reduce((n, s) => n + s.questionCount, 0),
    rowCount: subjects.reduce((n, s) => n + s.rowCount, 0),
    unrecordable,
    unaskable,
  }
}

/**
 * The subject `&s=` names, or null.
 *
 * Null for a missing param, a typo, a stale link, and — the one that matters —
 * an id belonging to another carrier or to a subject with nothing outstanding.
 * The caller renders the list instead. Answering any of those differently would
 * turn this parameter into a probe: "that subject has no questions" and "that
 * subject is not yours" must be the same answer, because the difference is
 * exactly what an id-guesser is looking for.
 */
export function findSubject(editor: DateEditor, raw: string | null | undefined): DateSubject | null {
  const id = (raw ?? '').trim()
  if (!id) return null
  return editor.subjects.find((s) => s.id === id) ?? null
}

/** The `max` on a box, from the registry's `kind` and never from the recurrence. */
export function maxFor(question: DateQuestion, today: string): string | undefined {
  return question.kind === 'last_done' ? today : undefined
}

export interface TypedDate {
  question: DateQuestion
  /** 'YYYY-MM-DD'. Blanks never reach here. */
  on: string
}

export type ReadTypedResult =
  | { ok: true; typed: TypedDate[] }
  | { ok: false; message: string }

/**
 * Read back only the questions we derived, and refuse the whole submit on any
 * bad value.
 *
 * NOTHING is read by a field name taken from the body. The loop is over the
 * questions this subject actually has, so an extra `date_hire_date` posted by
 * hand is not rejected — it is never looked at, which is the only version of
 * that defence with no list to keep up to date.
 *
 * All-or-nothing on a bad value, for the same reason the vehicle screen is: a
 * partial save leaves him looking at a screen where some boxes took and some did
 * not, with one error message to explain it.
 */
export function readTypedDates(
  subject: DateSubject,
  read: (field: string) => string | null | undefined,
  today: string,
): ReadTypedResult {
  const typed: TypedDate[] = []

  for (const question of subject.questions) {
    // An unwritable key has no box on the page and must not gain one here. A
    // record written under `hire_date` outranks the driver's own column forever.
    if (!question.writable) continue

    const raw = String(read(question.field) ?? '').trim()
    // Blank means "I still do not know", never "remove what you have". Every
    // question on this surface starts empty, so most of them come back blank on
    // every submit.
    if (raw === '') continue

    if (!isStorableDate(raw)) {
      return { ok: false, message: `${question.label}: that is not a date we can read.` }
    }
    if (raw < '1900-01-01') {
      return { ok: false, message: `${question.label}: that year looks like a typo.` }
    }
    // The `max` attribute is a browser's promise, not a server's. Re-checked
    // here against the same registry `kind` the attribute came from, so the one
    // direction this domain refuses to be wrong in does not depend on the
    // browser honouring an attribute.
    if (question.kind === 'last_done' && raw > today) {
      return {
        ok: false,
        message:
          `${question.label} is in the future. This box wants the last time it happened, ` +
          'not the next time it is due.',
      }
    }

    typed.push({ question, on: raw })
  }

  return { ok: true, typed }
}

/**
 * How many dashboard rows the answered questions take off the list.
 *
 * Not the number of dates typed, and the difference is the whole reason this
 * exists: `periodic_inspection_date` settles two rules on one vehicle, so four
 * dates can clear six rows. A tile that moves by six when he typed four makes
 * the number he checks first look broken, so the page reports BOTH.
 */
export function rowsSettledBy(subject: DateSubject, answerKeys: Iterable<string>): number {
  const wanted = new Set(answerKeys)
  let rows = 0
  for (const question of subject.questions) {
    if (wanted.has(question.answerKey)) rows += question.settles.length
  }
  return rows
}

/** The headline after a save. Reports both numbers, always. */
export function savedHeadline(saved: number, cleared: number): string {
  if (saved === 0) return 'Nothing saved — every box was left blank.'
  const dates = saved === 1 ? '1 date saved' : `${saved} dates saved`
  const rows = cleared === 1 ? '1 item off this list' : `${cleared} items off this list`
  return `${dates} — ${rows}.`
}

/**
 * A stored date, read back in words.
 *
 * Long month rather than the ISO the box held, because this is the one moment he
 * still remembers what he meant to type, and '2027-10-03' is the shape a wrong
 * year hides in.
 */
export function longDate(iso: string | null | undefined): string {
  const s = String(iso ?? '').slice(0, 10)
  if (!isStorableDate(s)) return ''
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Is this `&at=` a timestamp we are willing to query with?
 *
 * The receipt finds the rows it just wrote by their shared `recorded_at`, which
 * arrives back through the URL. RLS decides what it can see either way; this
 * only keeps a hand-edited param from reaching PostgREST as a malformed filter
 * and turning the whole dashboard into a 400.
 */
export function isBatchStamp(value: string | null | undefined): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(String(value ?? ''))
}
