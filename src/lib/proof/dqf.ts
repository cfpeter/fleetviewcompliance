/**
 * The driver qualification file, assembled in the order an investigator reads it.
 *
 * 49 CFR 391.51(b) lists eight items. An auditor works down that list, and a
 * binder in any other order makes them hunt — which is the entire reason this
 * exists rather than a generic document list.
 *
 * What this produces is a statement of what WE HOLD and what we OBSERVED, item
 * by item, with the citation beside each. It deliberately produces no overall
 * verdict: see the note in verdict() below.
 */
import type { DeadlineItem } from '../rules/index.ts'

export type ItemState = 'present' | 'expiring' | 'expired' | 'missing' | 'unknown'

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
}

/**
 * The eight items, in statutory order.
 *
 * `ruleCodes` is how each item is scored: the worst standing among its rules
 * becomes the item's state. Items with no rule behind them are scored from the
 * documents we hold instead, which is why they are listed separately.
 */
const DQF_STRUCTURE: readonly Omit<DqfItem, 'state' | 'detail' | 'date'>[] = [
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

/** Worst wins: a file is only as good as its weakest item. */
const STATE_RANK: Record<ItemState, number> = {
  expired: 0,
  missing: 1,
  unknown: 2,
  expiring: 3,
  present: 4,
}

function stateFromStanding(item: DeadlineItem, soonDays: number): ItemState {
  switch (item.status.standing) {
    case 'overdue':
      return 'expired'
    case 'unknown':
      return 'unknown'
    case 'current':
      return (item.daysUntil ?? 999) <= soonDays ? 'expiring' : 'present'
    default:
      // not_applicable and unsupported both mean "this rule is not telling us
      // anything about this item", which is not evidence that we hold it.
      return 'unknown'
  }
}

export interface AssembleArgs {
  /** Deadline items already filtered to one driver. */
  items: readonly DeadlineItem[]
  /** Document kinds we actually hold for this driver. */
  heldDocumentKinds?: ReadonlySet<string>
  soonDays?: number
}

export function assembleDqf(args: AssembleArgs): DqfItem[] {
  const soon = args.soonDays ?? 45

  return DQF_STRUCTURE.map((row) => {
    const relevant = args.items.filter((i) => row.ruleCodes.includes(i.rule.code))

    if (relevant.length === 0) {
      // No rule speaks to this item. Fall back to whether a document of a
      // matching kind exists — and if not, say MISSING rather than present.
      const held = args.heldDocumentKinds?.has(row.paragraph)
      return { ...row, state: held ? ('present' as const) : ('missing' as const) }
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

    const detail = relevant
      .map((i) => `${i.rule.title}: ${i.status.standing}`)
      .join(' · ')

    return { ...row, state: worst, detail, date }
  })
}

/** The gap report that goes on page one, because that is what gets read. */
export function gaps(items: readonly DqfItem[]): DqfItem[] {
  return items
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
  return {
    present: items.filter((i) => i.state === 'present').length,
    expiring: items.filter((i) => i.state === 'expiring').length,
    attention: gaps(items).length,
    total: items.length,
    observedAt,
  }
}
