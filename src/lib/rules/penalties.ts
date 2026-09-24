/**
 * Civil penalty amounts, as data with a date on them.
 *
 * WHY THIS FILE EXISTS. The amounts used to be sentences — three string
 * constants in federal-driver.ts and a dozen hand-typed copies of "$1,584 a day
 * up to $15,846" across federal-carrier.ts — with the year written into the
 * prose because `consequence` is a bare string with nowhere to put an effective
 * date. Two things follow from that and both are bad: nothing can add them up,
 * and nothing can tell you when they went stale.
 *
 * docs/research/compliance-penalties.md asks for exactly this, in as many words:
 * *"Store penalty amounts as data with an effective date, not as constants in
 * code."* The reason is in the same document — **DOT appears to have skipped the
 * January 2026 adjustment cycle**, confirmed three ways as of 2026-09-14, so
 * these figures are simultaneously the current ones and the stalest they have
 * ever been, and a catch-up rule can land at any time. When it does, this file
 * is the diff.
 *
 * WHAT IS NOT IN HERE, AND WHY NOT. Only amounts the research verified against
 * 49 CFR 386 Appendix B. These figures appear in `consequence` prose and are
 * deliberately absent:
 *
 *   - hazmat, $617–$102,348 and $102,348 per violation. A different authority
 *     (49 CFR 107), not Appendix B, and 89 FR 106282 does not set them. We have
 *     no verified effective date, so there is nothing honest to put in the
 *     field this file makes mandatory.
 *   - financial responsibility, $21,114 a day (387.9). The prose carries no
 *     Appendix B cite and the research table does not list it.
 *   - California's IFTA late filing, "$50 or 10% of net tax due, whichever is
 *     greater". Not a fixed amount at all — it is a formula over a figure only
 *     CDTFA knows. A `maxCents` for it would be an invention.
 *   - MCS-150's "$1,365–$10,269 under App. B(g)(16)". The same appendix, but
 *     (g)(16) was not one of the lines the research pass checked.
 *
 * TWO RULES ASSERT AN AMOUNT THIS FILE WILL NOT BACK. `cdl_expiry` (Part 391)
 * and `fed.396.25.brake-inspector-qualification` (Part 396) both cite $19,246
 * at (a)(3) — which the research records as the **Part 382** line. They may be
 * reaching it through the general civil penalty at 49 U.S.C. 521(b)(2)(A),
 * whose adjusted maximum is the same figure, but nothing verified says so. They
 * keep their prose and carry no `penalty`, and a total therefore counts them as
 * "no figure", not as $19,246. The open question is written up as caveat 3 of
 * docs/research/compliance-penalties.md, with what answering it is worth —
 * `cdl_expiry` blocks dispatch, so it lands on real fleets' overdue lists.
 *
 * They stay as prose on the rule, and anything totalling exposure must report
 * them as "no figure we can stand behind" rather than as zero. Adding one here
 * is a research task, not a typing task.
 *
 * THE MYTH THIS FILE REFUSES TO REPEAT: "$10,000 per day for failing to
 * implement a drug and alcohol testing program." There is no such line item.
 * $10,000 is the unadjusted statutory maximum in 49 U.S.C. 521(b)(2)(A);
 * adjusted it is $19,246, and it is **per violation, not per day**. Only the
 * recordkeeping entry below carries a daily multiplier.
 */

/** How an amount is applied. Appendix B says "per day" only where it means it. */
export type PenaltyUnit = 'per_violation' | 'per_day'

/**
 * WHO PAYS. Appendix B sets different amounts for the same subject matter
 * depending on the person: $19,246 for the employer at (a)(3), $4,812 for the
 * driver at (a)(4). A total on the owner's dashboard that mixed the two would
 * be inflated by money somebody else owes.
 */
export type PenaltyPayer = 'carrier' | 'driver'

export interface Penalty {
  /** Stable machine name, for tests and for grouping identical amounts. */
  key: string
  /**
   * Cents. The MAXIMUM assessable, which is what the statute states — never a
   * prediction of what would actually be billed. Enforcement discretion,
   * severity weighting and settlement all sit between this number and a cheque.
   */
  maxCents: number
  /** Cents. Only where the statute sets a floor as well as a ceiling. */
  minCents?: number
  unit: PenaltyUnit
  /** Cents. Where a per-day amount stops accruing. */
  capCents?: number
  payer: PenaltyPayer
  /** The provision the amount comes from, shown to the owner so he can check us. */
  citation: string
  /** 'YYYY-MM-DD'. The day these amounts took effect. Never hidden from the reader. */
  effectiveOn: string
  /** The rule that set them, for the person who goes looking. */
  source: string
}

const APP_B = '49 CFR 386 App. B'

/**
 * The 2025 adjustment: 89 FR 106282, multiplier 1.02598, effective 2024-12-30.
 * Every amount below was set by it, which is why the date is written once.
 */
const ADJUSTED_2025 = { effectiveOn: '2024-12-30', source: '89 FR 106282' } as const

/**
 * Recordkeeping — the ONE entry in Appendix B with an express daily multiplier,
 * and the reason the "$10,000 a day" myth sounds plausible to people who have
 * seen a real penalty notice.
 */
export const RECORDKEEPING: Penalty = {
  key: 'recordkeeping',
  maxCents: 158_400,
  capCents: 1_584_600,
  unit: 'per_day',
  payer: 'carrier',
  citation: `${APP_B}(a)(1)`,
  ...ADJUSTED_2025,
}

/** Part 382 non-recordkeeping, employer side. The adjusted $10,000 statutory max. */
export const PART382_EMPLOYER: Penalty = {
  key: 'part382_employer',
  maxCents: 1_924_600,
  unit: 'per_violation',
  payer: 'carrier',
  citation: `${APP_B}(a)(3)`,
  ...ADJUSTED_2025,
}

/**
 * The same subject matter, driver side. No rule carries this one yet — it is
 * here because leaving it out is how a carrier total quietly acquires a driver's
 * money the first time somebody attaches (a)(3) to a driver obligation.
 */
export const PART382_DRIVER: Penalty = {
  key: 'part382_driver',
  maxCents: 481_200,
  unit: 'per_violation',
  payer: 'driver',
  citation: `${APP_B}(a)(4)`,
  ...ADJUSTED_2025,
}

/**
 * Clearinghouse, Part 382 subpart G. Sits under (b) and NOT under the (a)(1)
 * recordkeeping line, because (a)(1) covers subparts A–F and excludes G.
 * FMCSA's May 2025 preamble says something in tension with this; how they
 * reconcile it in practice is UNVERIFIED.
 */
export const CLEARINGHOUSE: Penalty = {
  key: 'clearinghouse',
  maxCents: 715_500,
  unit: 'per_violation',
  payer: 'carrier',
  citation: `${APP_B}(b)`,
  ...ADJUSTED_2025,
}

/**
 * Everything defined here, for the tests and for anything totalling exposure.
 *
 * FOUR, AND THAT IS THE POINT. Every entry is a line the research pass checked
 * against eCFR on 2026-09-01. MCS-150's "$1,365–$10,269 under App. B(g)(16)"
 * was left out even though it names the same appendix, because (g)(16) was not
 * one of the lines checked — and a total that mixes verified figures with
 * plausible ones is a total nobody can stand behind, which is the only kind
 * this product must not print.
 */
export const PENALTIES: readonly Penalty[] = [
  RECORDKEEPING,
  PART382_EMPLOYER,
  PART382_DRIVER,
  CLEARINGHOUSE,
]

/**
 * Whole dollars, with separators. Never cents: Appendix B is written in whole
 * dollars and printing "$1,584.00" invents a precision the statute does not have.
 */
export function money(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`
}

/** '2024-12-30' -> '30 Dec 2024'. Unambiguous to a reader on either side of the Atlantic. */
export function effectiveLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][(m ?? 1) - 1]
  return `${d} ${month} ${y}`
}

/**
 * The sentence, built from the amount rather than typed beside it.
 *
 * This is what keeps the prose on a rule and the number in a total from ever
 * disagreeing: there is one figure, and the words are a view of it. The
 * citation and the effective date are always in the sentence, because the
 * research doc is explicit that the credibility of these numbers comes from
 * being checkable — *"and this audience checks."*
 */
/**
 * The amount alone, for a row in a list.
 *
 * `penaltyPhrase` carries the citation and the effective date in the sentence,
 * which is right where the sentence stands on its own — on a rule's own page,
 * in an email, in the catalogue. In a table it is sixty characters that wrap to
 * a second line on every row, and the two facts it is carrying are already on
 * the screen once: the rule's own citation is linked directly above, and the
 * Appendix B cite and the date sit under the total at the top of the page.
 *
 * So this is the short form, and it exists ONLY for that case. Anywhere the
 * figure is shown without those two things somewhere in view, use the phrase.
 */
export function penaltyAmount(p: Penalty): string {
  if (p.unit === 'per_day') {
    const cap = p.capCents ? ` up to ${money(p.capCents)}` : ''
    return `${money(p.maxCents)} a day${cap}`
  }
  if (p.minCents !== undefined) {
    return `${money(p.minCents)}–${money(p.maxCents)}`
  }
  return `${money(p.maxCents)} per violation`
}

export function penaltyPhrase(p: Penalty): string {
  const when = `${p.citation}, in force since ${effectiveLabel(p.effectiveOn)}`

  if (p.unit === 'per_day') {
    const cap = p.capCents ? ` up to ${money(p.capCents)}` : ''
    return `${money(p.maxCents)} a day${cap} (${when})`
  }

  if (p.minCents !== undefined) {
    return `${money(p.minCents)}–${money(p.maxCents)} per violation (${when})`
  }

  return `${money(p.maxCents)} per violation (${when})`
}
