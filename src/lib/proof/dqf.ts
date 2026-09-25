/**
 * The driver qualification file, assembled in the order an investigator reads it.
 *
 * 49 CFR 391.51(b) lists eight items. An auditor works down that list, and a
 * binder in any other order makes them hunt — which is the entire reason this
 * exists rather than a generic document list.
 *
 * What this produces is a statement of what WE HOLD and what we OBSERVED, item
 * by item, with the citation beside each. It deliberately produces no overall
 * verdict: see the note on `summarise` below.
 *
 * THERE IS ONE DEFINITION OF A DRIVER FILE, AND IT IS THIS ONE.
 *
 * Four surfaces score the same driver — the printed binder, the roster ring,
 * the driver's own page, and the link a broker opens — and for a while only the
 * binder was right. Three corrections had grown inside the binder's own page
 * and stayed there: which paragraphs a given driver is even expected to hold,
 * the hire date that lives on the driver row rather than in compliance_records,
 * and whether there is paper behind a typed date. The other three surfaces had
 * none of them, so the page a carrier SENDS OUT reported more gaps than the
 * page he read himself — he tells a broker the record is clean, the broker's
 * own link says five items need attention, and the carrier looks either
 * careless or dishonest.
 *
 * All three live here now. tests/proof-parity.test.ts is the guard: it feeds
 * one driver through the owner's path and the broker's path and fails if they
 * print different words or different counts.
 */
import { DRIVER_ANCHORS_FROM_DRIVER_COLUMNS } from '../rules/driver-anchors.ts'
import type { DeadlineItem } from '../rules/index.ts'

export type ItemState = 'present' | 'expiring' | 'expired' | 'missing' | 'unknown'

/**
 * Whether we hold paper behind an item.
 *
 * `unseen` IS NOT `none`. A surface that cannot read the documents table must
 * not print "no document" against every item in the file — that is a different
 * and far more alarming claim than "we did not look". The broker's shared link
 * is `unseen` today: the four share_* functions return a carrier, a driver,
 * anchors and counts, and none of them returns a document kind.
 */
export type PaperBacking = 'held' | 'none' | 'unseen'

export interface DqfItem {
  /** 391.51(b)(n) — printed, because the reader is working down the statute. */
  paragraph: string
  title: string
  citation: string
  state: ItemState
  /** What we hold, if anything. */
  detail?: string
  date?: Date
  /** Which rules in the catalogue speak to this item. */
  ruleCodes: readonly string[]
  /** Only for items where the regulation itself carries a caveat worth printing. */
  note?: string
  /**
   * Why this driver's file is not expected to hold this item, or undefined when
   * it is. Set only where the caller gave us the facts to decide — see
   * `AssembleArgs.driver`. Everything that counts skips these: `expected`.
   */
  notApplicable?: string
  /** Whether a document of a matching kind is uploaded behind the date. */
  paper: PaperBacking
}

/**
 * The eight items, in statutory order.
 *
 * `ruleCodes` is how each item is scored: the worst standing among its rules
 * becomes the item's state. Items with no rule behind them are scored from the
 * documents we hold instead, which is why they are listed separately.
 */
const DQF_STRUCTURE: readonly Omit<
  DqfItem,
  'state' | 'detail' | 'date' | 'notApplicable' | 'paper'
>[] = [
  {
    paragraph: '(b)(1)',
    title: 'Application for employment',
    citation: '49 CFR 391.21',
    ruleCodes: ['dqf_maintained'],
    note:
      'For a CDL driver the application must reach back TEN years of employment — ' +
      'three years under 391.21(b)(10) plus the seven preceding years under (b)(11). ' +
      'Capturing only three is a common defect.',
  },
  {
    paragraph: '(b)(2)',
    title: 'Driving record obtained at hire',
    citation: '49 CFR 391.23(a)(1), (b)',
    ruleCodes: ['mvr_inquiry_at_hire'],
    note: 'Due within 30 days of the date employment begins, from every licensing authority.',
  },
  {
    paragraph: '(b)(3)',
    title: 'Road test certificate, or an accepted equivalent',
    citation: '49 CFR 391.31(e), 391.33',
    ruleCodes: ['road_test_or_equivalent'],
    note:
      'A CDL may stand in for the road test — but NOT for double/triple trailer or ' +
      'tank endorsements, and a prior carrier’s certificate expires after 3 years.',
  },
  {
    paragraph: '(b)(4)',
    title: 'Annual driving record inquiry',
    citation: '49 CFR 391.25(a)',
    ruleCodes: ['mvr_inquiry_annual'],
    note: 'At least once every 12 months — a rolling interval, not a calendar year.',
  },
  {
    paragraph: '(b)(5)',
    title: 'Annual review of the driving record',
    citation: '49 CFR 391.25(c)(2)',
    ruleCodes: ['driving_record_review_annual'],
    note:
      'A separate obligation from (b)(4). The note must carry the name of the person ' +
      'who performed the review and the date they did it.',
  },
  {
    paragraph: '(b)(6)',
    title: 'Medical examiner’s certificate',
    citation: '49 CFR 391.43(g), 391.51(b)(6)',
    ruleCodes: [
      'medical_certificate_general',
      'medical_certificate_by_exam_date',
      'medical_certificate_intracity_zone',
      'medical_certificate_insulin_treated',
      'medical_certificate_alternative_vision',
    ],
    note:
      'For a CDL holder the DQF item is the CDLIS motor vehicle record from the current ' +
      'licensing state, not the paper card (391.51(b)(6)(ii)). A nationwide exemption ' +
      'permitting a paper copy up to 60 days old expires 2026-10-11 and must be ' +
      're-checked, not assumed.',
  },
  {
    paragraph: '(b)(7)',
    title: 'Skill Performance Evaluation certificate or medical variance',
    citation: '49 CFR 391.49, 49 CFR part 381',
    ruleCodes: ['spe_certificate_renewal'],
    note: 'Only where one applies. An SPE runs for at most 2 years and renews 30 days ahead.',
  },
  {
    paragraph: '(b)(8)',
    title: 'National Registry verification note',
    citation: '49 CFR 391.23(m)',
    ruleCodes: [],
    note:
      'Required for NON-CDL drivers. The equivalent requirement for CDL drivers ' +
      'sunset on 2025-06-22 and should not be expected in a CDL driver’s file.',
  },
]

/**
 * THE PAPER THAT WOULD BACK EACH PARAGRAPH.
 *
 * "On file" is printed only where a document of that kind is uploaded. A typed
 * date with nothing behind it prints "Date recorded, no document", because that
 * is all it is, and it is the first thing an officer tests.
 *
 * The values are `documents.kind` keys — DRIVER_DOCUMENT_KINDS in
 * src/lib/documents.ts. (b)(8) has no paper of its own here.
 */
export const PAPER_FOR: Record<string, readonly string[]> = {
  '(b)(1)': ['employment_application'],
  '(b)(2)': ['mvr'],
  '(b)(3)': ['road_test', 'cdl'],
  '(b)(4)': ['mvr'],
  '(b)(5)': ['annual_review'],
  '(b)(6)': ['medical_certificate'],
  '(b)(7)': ['spe_certificate'],
}

/**
 * The words printed for each state, on every surface that prints them.
 *
 * `unknown` says "Not known" rather than "N/A" or a dash on purpose: to
 * somebody skimming a printout, both of those read as "nothing to do here",
 * which is the opposite of what an absent date means.
 */
export const STATE_WORDS: Record<ItemState, string> = {
  present: 'On file',
  expiring: 'Expires soon',
  expired: 'Expired',
  missing: 'Not on file',
  unknown: 'Not known',
}

/**
 * The word beside an item.
 *
 * It is the state's word, except where we hold a date and no paper — then it
 * says so, because "On file" would be claiming half of something as the whole.
 * `unseen` prints the plain word: a surface that cannot read the documents
 * table has not found the paper missing, it has not looked.
 */
export function stateWord(item: DqfItem): string {
  return item.state === 'present' && item.paper === 'none'
    ? 'Date recorded, no document'
    : STATE_WORDS[item.state]
}

/** Worst wins: a file is only as good as its weakest item. */
const STATE_RANK: Record<ItemState, number> = {
  expired: 0,
  missing: 1,
  unknown: 2,
  expiring: 3,
  present: 4,
}

/**
 * The anchors one driver's file is scored from.
 *
 * Some dates live on the driver ROW rather than in compliance_records, because
 * they are identity rather than compliance events — you do not "perform" a hire
 * date. They are projected in here so that a rule never has to know which table
 * a fact happens to sit in.
 *
 * THIS IS LOAD-BEARING, NOT TIDINESS. Five federal rules hang off `hire_date`:
 * the DQF itself, the hire-time MVR, the safety-history investigation, the road
 * test, and the pre-employment Clearinghouse query. Skip the projection and all
 * five report "we need a date from you" — while the hire date sits on the
 * driver's own page looking perfectly well answered.
 *
 * That is exactly what the broker's shared link did. `share_driver` returns
 * `hired_on` and has since 0026; the page read it and never used it, so (b)(1),
 * (b)(2) and (b)(3) printed "Not known" on the one document a carrier hands to
 * somebody checking up on him.
 *
 * `fromRow` is keyed by COLUMN name and its keys are REQUIRED, derived from
 * `DRIVER_ANCHORS_FROM_DRIVER_COLUMNS` itself. Add a column to that map and
 * every caller stops compiling until it selects and passes the new column —
 * which is the drift the map was exported to prevent, now caught by the
 * compiler instead of by a silent no-op.
 */
type DriverRowDate =
  | (typeof DRIVER_ANCHORS_FROM_DRIVER_COLUMNS)[keyof typeof DRIVER_ANCHORS_FROM_DRIVER_COLUMNS]
  | 'cdl_expires_on'

export function driverFileAnchors(
  recorded: Readonly<Record<string, Date | undefined>>,
  fromRow: Readonly<Record<DriverRowDate, Date | undefined>>,
): Record<string, Date | undefined> {
  const anchors: Record<string, Date | undefined> = { ...recorded }

  for (const [anchorKey, column] of Object.entries(DRIVER_ANCHORS_FROM_DRIVER_COLUMNS)) {
    if (anchors[anchorKey]) continue // an explicitly recorded date always wins
    const fromColumn = fromRow[column]
    if (fromColumn) anchors[anchorKey] = fromColumn
  }

  // The CDL expiry is the same shape of fact, but it IS a collectable anchor —
  // it has a row under Compliance dates — so it is not in the map above. The
  // column is the fallback for the carriers who only ever typed it on the
  // driver's record.
  if (fromRow.cdl_expires_on && !anchors.cdl_expires) {
    anchors.cdl_expires = fromRow.cdl_expires_on
  }

  return anchors
}

/**
 * Whether an SPE certificate or a medical variance is on this driver's record.
 *
 * Read off the evaluated items rather than asked for a second time: `evaluate`
 * drops a rule that does not apply, so the SPE row is simply absent for the
 * well over 99% of drivers who hold none. Asking the caller would mean holding
 * two answers to one question with nothing to say which is right.
 */
export function holdsSpe(items: readonly DeadlineItem[]): boolean {
  return items.some(
    (i) =>
      i.rule.code === 'spe_certificate_renewal' &&
      i.status.standing !== 'not_applicable' &&
      i.status.standing !== 'unsupported',
  )
}

/** The driver's own facts, in the only two respects the file's shape depends on. */
export interface DriverFacts {
  /** Holds a CDL. (b)(8) is a non-CDL requirement. */
  cdl?: boolean
  /** Holds an SPE certificate or a medical variance. `holdsSpe` derives it. */
  spe?: boolean
}

/**
 * WHICH OF THE EIGHT THIS DRIVER'S FILE IS EXPECTED TO HOLD.
 *
 * Two of them do not apply to most drivers. (b)(8) is required for NON-CDL
 * drivers; the CDL equivalent sunset on 2025-06-22. (b)(7) exists only where an
 * SPE or a medical variance does. Counting them against every driver is how a
 * well-kept file comes out reading "3 needing attention" — and an auditor who
 * chases three and finds one decides the carrier cannot count.
 *
 * BOTH ARE DECIDED FROM A FACT WE WERE GIVEN, never from silence. Undefined is
 * unknown, and an item we cannot rule out stays in the file — the same way the
 * rule engine treats every fact it has not been told.
 */
function notApplicableFor(paragraph: string, driver?: DriverFacts): string | undefined {
  if (paragraph === '(b)(8)' && driver?.cdl === true) {
    return 'This driver holds a CDL. The note is required for non-CDL drivers only.'
  }
  if (paragraph === '(b)(7)' && driver?.spe === false) {
    return 'No SPE certificate or medical variance is recorded for this driver.'
  }
  return undefined
}

function stateFromStanding(item: DeadlineItem, soonDays: number): ItemState {
  switch (item.status.standing) {
    case 'overdue':
      return 'expired'
    case 'unknown':
      return 'unknown'
    case 'current':
      // A DATE THAT HAS ALREADY PASSED IS NOT A DATE THAT IS COMING UP.
      //
      // `daysUntil` is negative for a one-time obligation that has been
      // satisfied: the road test's only due date was the day it was due, so a
      // road test passed 618 days ago comes back `current` with `daysUntil`
      // -618. The old test was `<= soonDays`, which -618 passes, so every
      // one-time item in a well-kept file — the application, the hire-time MVR,
      // the road test — printed "Expires soon" for the rest of the driver's
      // employment. Three of the eight items, permanently amber, on the files
      // with nothing wrong with them.
      //
      // An item that is genuinely running out still lands here: `current` with
      // a due date ahead of us. Anything already past its date and still
      // `current` is a one-off the engine considers done, which is `present`.
      // Nothing moves the other way — no state that used to be a gap becomes
      // present, because `overdue`, `unknown` and the rest never reach this arm.
      return item.daysUntil !== undefined && item.daysUntil >= 0 && item.daysUntil <= soonDays
        ? 'expiring'
        : 'present'
    default:
      // not_applicable and unsupported both mean "this rule is not telling us
      // anything about this item", which is not evidence that we hold it.
      return 'unknown'
  }
}

export interface AssembleArgs {
  /** Deadline items already filtered to one driver. */
  items: readonly DeadlineItem[]
  /**
   * The driver's own facts, which decide which paragraphs this file is expected
   * to hold. OMIT THEM AND EVERY PARAGRAPH IS EXPECTED, which is the safe
   * answer and the one the rule engine gives to the same question.
   */
  driver?: DriverFacts
  /**
   * Uploaded document kinds for this driver, un-superseded. UNDEFINED MEANS THE
   * CALLER CANNOT SEE THE DOCUMENTS TABLE, which is not the same as holding
   * nothing — see `PaperBacking`.
   */
  uploadedKinds?: ReadonlySet<string>
  soonDays?: number
}

export function assembleDqf(args: AssembleArgs): DqfItem[] {
  const soon = args.soonDays ?? 45
  const uploaded = args.uploadedKinds

  return DQF_STRUCTURE.map((row) => {
    const paper: PaperBacking =
      uploaded === undefined
        ? 'unseen'
        : (PAPER_FOR[row.paragraph] ?? []).some((k) => uploaded.has(k))
          ? 'held'
          : 'none'

    const base = { ...row, paper, notApplicable: notApplicableFor(row.paragraph, args.driver) }
    const relevant = args.items.filter((i) => row.ruleCodes.includes(i.rule.code))

    if (relevant.length === 0) {
      // No rule speaks to this item. Fall back to whether a document of a
      // matching kind exists — and if not, say MISSING rather than present.
      return { ...base, state: paper === 'held' ? ('present' as const) : ('missing' as const) }
    }

    let worst: ItemState = 'present'
    let date: Date | undefined
    for (const i of relevant) {
      const s = stateFromStanding(i, soon)
      if (STATE_RANK[s] < STATE_RANK[worst]) {
        worst = s
        date = i.status.nextDue
      }
    }

    const detail = relevant.map((i) => `${i.rule.title}: ${i.status.standing}`).join(' · ')

    return { ...base, state: worst, detail, date }
  })
}

/**
 * The paragraphs this driver's file is expected to hold.
 *
 * EVERYTHING THAT COUNTS GOES THROUGH HERE — `gaps`, `summarise`, and the ring
 * in src/lib/charts/dq-rings.ts — so a paragraph cannot be counted as a gap on
 * one screen and excluded on another. `assembleDqf` still returns all eight,
 * because the printed binder says out loud which ones it is not expecting and
 * why; a document that silently drops two of the statutory eight is a document
 * an auditor cannot check against the statute.
 */
export function expected(items: readonly DqfItem[]): DqfItem[] {
  return items.filter((i) => i.notApplicable === undefined)
}

/** The gap report that goes on page one, because that is what gets read. */
export function gaps(items: readonly DqfItem[]): DqfItem[] {
  return expected(items)
    .filter((i) => i.state === 'expired' || i.state === 'missing' || i.state === 'unknown')
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state])
}

/**
 * Deliberately NOT a verdict.
 *
 * It would be trivial to return "COMPLIANT" when every item is present, and it
 * would be wrong twice over. First, we only know what we were told: a file can
 * be complete in our records and the underlying document forged, missing, or
 * superseded. Second, a packet a carrier generates about himself carries no
 * weight with the person reading it — brokers and underwriters know that, and a
 * green tick makes the whole document look like marketing.
 *
 * What is useful and defensible is a COUNT of what we observed and when. The
 * reader draws their own conclusion, and the outward links let them check it.
 */
export interface ProofSummary {
  present: number
  expiring: number
  attention: number
  total: number
  observedAt: Date
}

export function summarise(items: readonly DqfItem[], observedAt: Date): ProofSummary {
  // The denominator is what this driver's file is expected to hold, not the
  // statutory eight. "6 of 6" and "6 of 8" are different claims about the same
  // clean file, and only one of them is true.
  const counted = expected(items)

  return {
    present: counted.filter((i) => i.state === 'present').length,
    expiring: counted.filter((i) => i.state === 'expiring').length,
    attention: gaps(counted).length,
    total: counted.length,
    observedAt,
  }
}
