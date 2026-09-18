/**
 * The dates a detail page is asked for and has no box for.
 *
 * THE SHAPE OF THE DEFECT THIS EXISTS FOR.
 *
 * A truck page renders `anchorsForKind` — six boxes — and a driver page renders
 * `DRIVER_ANCHORS` — twelve. Both lists are FACTS ABOUT THE SUBJECT: when the
 * unit was first used on public highways, when the card expires. The engine asks
 * for more than that. `answerKeyFor` (../rules/answer.ts) files a rule's last
 * COMPLETION under the rule's own code whenever the recurrence names no anchor,
 * so a `computed` schedule — Form 2290, keeping the § 396.21 report, the DQF
 * being opened — comes back asking for a key that is a rule code and that no
 * hand-written catalogue contains.
 *
 * Those rows only appear AFTER the owner answers. An empty truck asks for six
 * anchors; a truck with all six on file asks for three more that nothing on the
 * page could type. He typed what we asked for, and the reward was three grey
 * rows with no way in. His words, on the Form 2290 row: "i dont see those date
 * input".
 *
 * The dashboard could already ask all of them, because `resolveAnchor` falls
 * back to the rule's own `title` and `evidence` for a key it has no entry for.
 * So the question exists, the words for it exist, and the write path
 * (`planAnchorWrites`) is shared. Only the two detail pages could not ask.
 *
 * EVERYTHING HERE COMES OUT OF THE REGISTRY, NOT OUT OF A SECOND CATALOGUE.
 * The label, the sentence under the box, the direction the date points and
 * whether a normal carrier is expected to have it are all read from
 * `resolveAnchor`, which is the same function src/lib/dashboard-dates.ts reads
 * them from. The two surfaces therefore cannot disagree about what is being
 * asked, what it is called, or which way it points — there is one answer to each
 * of those, in ../rules/anchors.ts, and both screens read it.
 *
 * WHAT MAY BE POSTED IS WIDER THAN WHAT IS DRAWN, AND THAT IS DELIBERATE.
 * `unboxedSlots` is a pure function of the rule catalogue: no database, no
 * engine run, so a POST handler can list exactly what it will read back without
 * paying for a second evaluation. `unboxedQuestions` narrows that list to the
 * rows the engine is asking about right now, plus anything already on file so a
 * typo stays correctable. Drawn is always a subset of readable, which is the
 * property that keeps a box on screen from being a box that saves nothing.
 */
import {
  type AnchorExpectation,
  type AnchorKind,
  resolveAnchor,
  UNWRITABLE_ANCHOR_KEYS,
} from '../rules/anchors.ts'
import { answerKeyFor } from '../rules/answer.ts'
import { rulesFor } from '../rules/index.ts'
import type { Subject } from '../rules/types.ts'

/** What may be posted: the key, and enough to write an error message about it. */
export interface UnboxedSlot {
  /** Written verbatim into `compliance_records.anchor_key`. */
  key: string
  /** Names the box in a refusal, so the message points at a box on screen. */
  label: string
  kind: AnchorKind
  expected: AnchorExpectation
  /** The form field name. The same convention all three date screens use. */
  field: string
}

/**
 * Every answer key a rule for this subject files its own completion under, that
 * the page's own catalogue has no box for.
 *
 * `boxed` is what the page already draws — `anchorsForKind(kind)` on the truck
 * page, `DRIVER_ANCHORS` on the driver page. Passed in rather than imported
 * because this file must not pick a side: a trailer draws two of the six vehicle
 * anchors, and a list built from the wrong one would offer a trailer a box for
 * Form 2290.
 *
 * THE DENY-LIST IS OBEYED HERE TOO. `hire_date`, `cdl_expires` and `dot_number`
 * are never slots, whatever the catalogue says. deadlines.ts projects the first
 * two out of the driver's own columns with `if (a[anchorKey]) continue`, so a
 * compliance record SILENTLY OUTRANKS the column — a typo typed under one would
 * move five federal rules onto wrong dates and leave the driver's own page still
 * showing the right one. A row for one of those keys is answered by opening the
 * record that owns it, which is the page's job, not this one's.
 *
 * Ordering is catalogue order, and it is the only order in play: a page that
 * sorted these would be a second ranking of the same rows with nothing checking
 * it against the first.
 */
export function unboxedSlots(subject: Subject, boxed: Iterable<string>): readonly UnboxedSlot[] {
  const drawn = new Set(boxed)
  const slots: UnboxedSlot[] = []
  const seen = new Set<string>()

  for (const rule of rulesFor(subject)) {
    const key = answerKeyFor(rule)
    if (drawn.has(key) || UNWRITABLE_ANCHOR_KEYS.has(key) || seen.has(key)) continue

    const entry = resolveAnchor(key)
    // Unreachable while the registry test passes: a key with no entry is a
    // question with no words. Skipped rather than rendered raw, because a box
    // labelled `fed.396.21.inspection-report-retention.power-unit` teaches the
    // owner that this screen is not for him.
    if (!entry) continue

    seen.add(key)
    slots.push({
      key,
      label: entry.label,
      kind: entry.kind,
      expected: entry.expected,
      field: `date_${key}`,
    })
  }

  return slots
}

/** One box the page draws, with everything it needs to draw it. */
export interface UnboxedQuestion extends UnboxedSlot {
  /** One sentence under the box, in the owner's language. */
  help: string
  /** The `id` a link lands on. Same string as `field`, named for its other job. */
  domId: string
  /** 'YYYY-MM-DD' already on file, or '' — so the box shows what it holds. */
  on: string
  /** The rows this one date takes off the list, in the order handed in. */
  settles: { code: string; title: string; citation: string }[]
}

/** The part of a `DeadlineItem` this module reads. `DeadlineItem` satisfies it. */
export interface AskedRow {
  rule: { code: string; title: string; citation: string }
  subjectId: string | null
  status: { standing: string; answerKey?: string }
}

export interface UnboxedQuestionsInput {
  subject: Subject
  /** The keys the page's own form already draws. */
  boxed: Iterable<string>
  /** This subject's rows, in the engine's order. */
  rows: readonly AskedRow[]
  /** The date on file under a key, '' when there is none. */
  onFile: (key: string) => string
}

/**
 * The boxes to add to this page's date form, in the engine's own order.
 *
 * TWO REASONS A QUESTION IS DRAWN, AND BOTH ARE NEEDED.
 *
 *   1. The engine is asking. `status.standing === 'unknown'` is the grey row the
 *      owner is looking at, and `status.answerKey` is set on both of the unknown
 *      branches in ../rules/compute.ts, so the key is read off the row rather
 *      than worked out again here.
 *   2. A date is already on file under the key. Without this, answering a
 *      question deletes the box that answered it — and a year typed wrong could
 *      then only be undone through Withdraw in the history, which is the exact
 *      dead end the truck page had before `save_dates` learned to supersede.
 *
 * Rows for other subjects are ignored rather than trusted to have been filtered,
 * because one key on the wrong subject is a date filed against the wrong truck
 * and nothing on screen would look broken.
 */
export function unboxedQuestions(input: UnboxedQuestionsInput): UnboxedQuestion[] {
  const slots = new Map(unboxedSlots(input.subject, input.boxed).map((s) => [s.key, s]))
  const questions = new Map<string, UnboxedQuestion>()

  const add = (slot: UnboxedSlot): UnboxedQuestion => {
    const existing = questions.get(slot.key)
    if (existing) return existing
    const entry = resolveAnchor(slot.key)
    const question: UnboxedQuestion = {
      ...slot,
      help: entry?.help ?? '',
      domId: slot.field,
      on: input.onFile(slot.key),
      settles: [],
    }
    questions.set(slot.key, question)
    return question
  }

  for (const row of input.rows) {
    if (row.status.standing !== 'unknown') continue
    const key = row.status.answerKey
    if (!key) continue
    const slot = slots.get(key)
    if (!slot) continue
    add(slot).settles.push({
      code: row.rule.code,
      title: row.rule.title,
      citation: row.rule.citation,
    })
  }

  // Answered ones last, in catalogue order. They are not what the page is
  // shouting about any more; they are here so a wrong one can be retyped.
  for (const slot of slots.values()) {
    if (input.onFile(slot.key) !== '') add(slot)
  }

  return [...questions.values()]
}

export interface TypedUnboxedDate {
  key: string
  /** 'YYYY-MM-DD', or null for a box left blank. */
  on: string | null
}

export type ReadUnboxedResult =
  | { ok: true; typed: TypedUnboxedDate[] }
  | { ok: false; message: string }

/**
 * Read the posted values back, and refuse the whole submit on any bad one.
 *
 * THE `max` ATTRIBUTE IS A BROWSER'S PROMISE, NOT A SERVER'S, and this is the
 * one direction this domain refuses to be wrong in. compute.ts walks a rolling
 * or anniversary schedule forward from the anchor until it passes today, so a
 * future date makes it step straight past the occurrence just reported and
 * answer with the one after: the deadline moves LATER. Re-checked here against
 * the same registry `kind` the attribute came from.
 *
 * All-or-nothing, for the reason both pages already give: a partial save leaves
 * him looking at a screen where some boxes took and some did not, with one
 * message to explain it.
 *
 * A blank comes back as `null` rather than being dropped. `planAnchorWrites`
 * reads a null entry as "leave what is on file alone", so the caller can hand
 * the whole list straight to it without deciding anything.
 *
 * The wording of every refusal is the dashboard's, verbatim — these are the
 * dashboard's questions, and one question refused in two voices reads as two
 * different problems.
 */
export function readUnboxedDates(
  slots: readonly UnboxedSlot[],
  read: (field: string) => string | null | undefined,
  today: string,
): ReadUnboxedResult {
  const typed: TypedUnboxedDate[] = []

  for (const slot of slots) {
    const raw = String(read(slot.field) ?? '').trim()
    // Blank means "I still do not know", never "remove what you have". There is
    // no DELETE grant on compliance_records, and a superseded date is the
    // evidence the subject was in order during the period it covered.
    if (raw === '') {
      typed.push({ key: slot.key, on: null })
      continue
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return { ok: false, message: `${slot.label}: that is not a date we can read.` }
    }
    if (raw < '1900-01-01') {
      return { ok: false, message: `${slot.label}: that year looks like a typo.` }
    }
    if (slot.kind === 'last_done' && raw > today) {
      return {
        ok: false,
        message:
          `${slot.label} is in the future. This box wants the last time it happened, ` +
          'not the next time it is due.',
      }
    }
    typed.push({ key: slot.key, on: raw })
  }

  return { ok: true, typed }
}

/**
 * The heading and the sentence above these boxes, written once for both pages.
 *
 * THE ROW AND THE BOX ARE NAMED DIFFERENTLY EVERYWHERE ELSE, AND HERE THEY ARE
 * NOT. A timeline row names the obligation — "Form 2290 heavy vehicle use tax" —
 * and a date box names the fact typed into it — "First used on public highways".
 * Both are right and they share no words, which is why the owner read six labels
 * and found none of them. For a rule-code key the label IS the rule's title, so
 * the two match exactly, and the sentence below says so out loud rather than
 * leaving him to notice.
 */
export const UNBOXED_HEADING = 'The last time this was done'

export const UNBOXED_LEAD =
  'We can work out when each of these is due. We cannot see whether it was done. Put in the ' +
  'day it was last done. Each box here has the same name as its row in the list above.'

/** The words on a row that sends him to one of these boxes. */
export const UNBOXED_ROW_LINK = 'Put in: the date you last did this'
