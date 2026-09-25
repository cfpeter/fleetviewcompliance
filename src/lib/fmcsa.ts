/**
 * FMCSA public data.
 *
 * Everything here is unauthenticated and free. There is no API key, no contract
 * and no approval step — which is the whole reason the marketing page can show a
 * stranger their own fleet before asking for an email address.
 *
 * Source: data.transportation.gov (Socrata SODA). A free Socrata app token
 * removes anonymous per-IP throttling; we send one when SOCRATA_APP_TOKEN is set
 * and work without it otherwise.
 */

const CENSUS = 'https://data.transportation.gov/resource/az4n-8mr2.json'
const AUTHORITY = 'https://data.transportation.gov/resource/inys-ebih.json'

/** Socrata returns every column as a string, including numbers and dates. */
export interface CensusRow {
  dot_number?: string
  legal_name?: string
  dba_name?: string
  phy_city?: string
  phy_state?: string
  phy_street?: string
  phy_zip?: string
  phone?: string
  email_address?: string
  /** 'A' active · 'I' inactive · 'P' pending. */
  status_code?: string
  /** 'A' interstate · 'B','C' intrastate. */
  carrier_operation?: string
  /** YYYYMMDD. */
  mcs150_date?: string
  power_units?: string
  total_drivers?: string
  total_cdl?: string
  safety_rating?: string
  safety_rating_date?: string
  /** 'Y' or 'N'. Live on 2026-09-18 the column held nothing else across the whole file. */
  hm_ind?: string
  /**
   * Operation classification, as FMCSA prints it on the SAFER snapshot.
   *
   * Semicolon-separated when a carrier ticked more than one box on the
   * MCS-150. Verified live on 2026-09-18 by grouping the whole census file on
   * this column; the tokens that appear, with row counts, are:
   *
   *   AUTHORIZED FOR HIRE               2,593,968
   *   PRIVATE PROPERTY                  1,792,668
   *   EXEMPT FOR HIRE                     310,620
   *   PRIVATE PASSENGER, BUSINESS          30,791
   *   PRIVATE PASSENGER, NON-BUSINESS      30,428
   *   OTHER-<free text>                    17,797   ("OTHER-APPLYING FOR MC", "OTHER-LEASED", …)
   *   OTHER                                   594
   *   FEDERAL GOVERNMENT / LOCAL GOVERNMENT / STATE GOVERNMENT / MIGRANT /
   *   U. S. MAIL / INDIAN TRIBE / 18 USC §31      a few hundred between them
   *
   * The commonest whole strings: "AUTHORIZED FOR HIRE", "PRIVATE PROPERTY",
   * "PRIVATE PROPERTY;AUTHORIZED FOR HIRE", "AUTHORIZED FOR HIRE;EXEMPT FOR HIRE".
   * See `forHireFromClassdef` for how these become a three-valued answer.
   */
  classdef?: string
}

// ---------------------------------------------------------------------------
// What kind of carrier this is
// ---------------------------------------------------------------------------
//
// Three facts decide which half of the rule catalogue applies to a carrier:
// whether it crosses state lines, whether it hauls for other people for pay,
// and whether it carries placarded hazmat. Every gate in src/lib/rules reads
// them off `RuleContext` as `carrierOperation`, `forHire` and `hazmat`, and
// every gate treats a missing value as UNKNOWN, which keeps the rule on the
// board. So the one rule for everything in this section: a value that cannot
// be read with confidence is `null`, never a guess in either direction. A
// private carrier shown a filing it does not owe costs one wrong row; a
// for-hire carrier told it owes nothing is the failure this product exists to
// prevent.
//
// Column names match `carriers` (0031_carrier_operation.sql) so a row can be
// spread straight into an update.

/** The federal single-letter operation code. */
export type CarrierOperationCode = 'A' | 'B' | 'C'

export interface CarrierOperationFacts {
  /** 'A' interstate · 'B' intrastate hazmat · 'C' intrastate non-hazmat · null unknown. */
  carrier_operation: CarrierOperationCode | null
  /** true hauls for others for pay · false private only · null unknown. */
  for_hire: boolean | null
  /** true placarded hazmat · false none · null unknown. */
  hazmat: boolean | null
}

/** 'A', 'B' or 'C' as the census prints it; anything else — including the
 *  186,115 rows with no code at all — is null. */
export function operationCode(v: string | null | undefined): CarrierOperationCode | null {
  const t = (v ?? '').trim().toUpperCase()
  return t === 'A' || t === 'B' || t === 'C' ? t : null
}

/** 'Y' → true, 'N' → false, anything else → null. */
export function hazmatFromHmInd(v: string | null | undefined): boolean | null {
  const t = (v ?? '').trim().toUpperCase()
  if (t === 'Y') return true
  if (t === 'N') return false
  return null
}

/**
 * The classification strings that mean "hauls for other people for pay".
 *
 * EXEMPT FOR HIRE is for-hire: the exemption is from operating authority
 * (49 U.S.C. 13506 commodities), not from being a for-hire carrier, and the
 * only rule that reads `forHire` is the Part 387 insurance filing, which
 * reaches for-hire carriers. Reading "exempt" as "private" would take that
 * row off the board for a carrier who may owe it.
 */
const FOR_HIRE_TOKENS = new Set(['AUTHORIZED FOR HIRE', 'EXEMPT FOR HIRE'])

/** The strings that mean "carries only its own goods or people". */
const PRIVATE_TOKENS = new Set([
  'PRIVATE PROPERTY',
  'PRIVATE PASSENGER, BUSINESS',
  'PRIVATE PASSENGER, NON-BUSINESS',
])

/**
 * `classdef` → for-hire, or null when the federal record does not settle it.
 *
 *   any for-hire token present           → true   ("PRIVATE PROPERTY;AUTHORIZED
 *                                                  FOR HIRE" is for hire)
 *   only private tokens, one or more     → false  ("PRIVATE PROPERTY")
 *   anything else                        → null   empty, absent, "OTHER",
 *                                                  "OTHER-APPLYING FOR MC",
 *                                                  government, "MIGRANT",
 *                                                  "U. S. MAIL", "INDIAN TRIBE",
 *                                                  "18 USC §31", and any private
 *                                                  token mixed with one of those
 *
 * The last line is deliberate. "OTHER-APPLYING FOR MC;PRIVATE PROPERTY" is a
 * carrier in the middle of becoming for-hire, and a government fleet is
 * outside the private/for-hire question altogether. Neither is a "no".
 */
export function forHireFromClassdef(v: string | null | undefined): boolean | null {
  const tokens = (v ?? '')
    .split(';')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t !== '')
  if (tokens.length === 0) return null
  if (tokens.some((t) => FOR_HIRE_TOKENS.has(t))) return true
  if (tokens.every((t) => PRIVATE_TOKENS.has(t))) return false
  return null
}

/**
 * The three facts off one census row, ready to copy onto the carrier.
 *
 * Returns null when the row settles none of them, so the caller can skip the
 * write instead of stamping three NULLs and a source over a row — the same
 * shape as `censusAddress` in onboarding.ts.
 */
export function censusOperation(row: CensusRow | null | undefined): CarrierOperationFacts | null {
  if (!row) return null
  const facts: CarrierOperationFacts = {
    carrier_operation: operationCode(row.carrier_operation),
    for_hire: forHireFromClassdef(row.classdef),
    hazmat: hazmatFromHmInd(row.hm_ind),
  }
  return Object.values(facts).some((v) => v !== null) ? facts : null
}

/** What the settings form can say about each question. */
export type OperationAnswer = 'yes' | 'no' | 'unsure'

export function operationAnswer(v: FormDataEntryValue | null | undefined): OperationAnswer | null {
  const t = typeof v === 'string' ? v.trim() : ''
  return t === 'yes' || t === 'no' || t === 'unsure' ? t : null
}

/**
 * The owner's three answers → the same three columns the census fills.
 *
 * "unsure" stores NULL. That is the whole reason the option exists: an owner
 * who does not know whether he crosses a state line must be able to say so and
 * keep every interstate rule on his board, rather than be forced to pick a
 * side to get past the form.
 *
 * The letter for an intrastate carrier is 'B' when he says he carries placarded
 * hazmat and 'C' otherwise. No rule reads the B/C half of the code — every
 * hazmat gate reads the `hazmat` column, which is stored beside it from the
 * third answer — so a "not sure" on hazmat with a "no" on state lines is
 * stored as 'C' plus a NULL `hazmat`, and the NULL is what the rules see.
 */
export function operationFromAnswers(answers: {
  crossesStateLines: OperationAnswer
  forHire: OperationAnswer
  hazmat: OperationAnswer
}): CarrierOperationFacts {
  const asBool = (a: OperationAnswer): boolean | null =>
    a === 'yes' ? true : a === 'no' ? false : null
  const hazmat = asBool(answers.hazmat)
  let carrier_operation: CarrierOperationCode | null = null
  if (answers.crossesStateLines === 'yes') carrier_operation = 'A'
  else if (answers.crossesStateLines === 'no') carrier_operation = hazmat === true ? 'B' : 'C'
  return { carrier_operation, for_hire: asBool(answers.forHire), hazmat }
}

/** The stored facts → which radio is checked on the settings form. */
export function operationAnswers(row: {
  carrier_operation?: string | null
  for_hire?: boolean | null
  hazmat?: boolean | null
}): { crossesStateLines: OperationAnswer; forHire: OperationAnswer; hazmat: OperationAnswer } {
  const fromBool = (b: boolean | null | undefined): OperationAnswer =>
    b === true ? 'yes' : b === false ? 'no' : 'unsure'
  const code = operationCode(row.carrier_operation)
  return {
    crossesStateLines: code === 'A' ? 'yes' : code === null ? 'unsure' : 'no',
    forHire: fromBool(row.for_hire),
    hazmat: fromBool(row.hazmat),
  }
}

/** The fact keys, in the order the settings form asks the three questions. */
export const OPERATION_FACTS = ['carrier_operation', 'for_hire', 'hazmat'] as const
export type OperationFact = (typeof OPERATION_FACTS)[number]

/** A carrier row, as much of it as the fallback reads. */
export interface OperationRow {
  carrier_operation?: string | null
  for_hire?: boolean | null
  hazmat?: boolean | null
  fmcsa_carrier_operation?: string | null
  fmcsa_for_hire?: boolean | null
  fmcsa_hazmat?: boolean | null
}

export interface EffectiveOperation extends CarrierOperationFacts {
  /**
   * The facts the owner had no answer for, so the census answered. Empty when
   * he answered all three, or when the census settled nothing either.
   */
  federal: OperationFact[]
}

/**
 * The three facts the rules actually run on: the owner's answer where he has
 * one, the federal record where he does not.
 *
 * WHY THIS EXISTS. "I'm not sure" has to store NULL — an owner who does not
 * know whether he crosses a state line must be able to say so rather than pick
 * a side to get past the form. But NULL is also what a rule gate reads as
 * unknown, and unknown keeps every gated rule on the board. So the honest
 * answer to a question produced the worst screen in the product: twenty rows,
 * most of them not his, with no way to tell which.
 *
 * The census row is the way out. It is not our guess about him — it is his own
 * MCS-150, filed over his signature, and the same record a broker and an
 * investigator read about him. Falling back to it is how /check has always
 * answered the same question for a stranger.
 *
 * PER COLUMN, NOT PER ROW. An owner who is sure he is for hire and not sure
 * about hazmat keeps his answer on the first and borrows the federal one on
 * the second. A row-level fallback would throw away the half he knows.
 *
 * The owner's answer ALWAYS wins, including where it contradicts Washington —
 * a stale census row is the ordinary reason he came to correct it. `federal`
 * names what was borrowed so /app/settings can show him, because a fact that
 * silently decides which rules he is shown is a fact he has to be able to see.
 */
/**
 * The census answer as the four census-only columns (0040), ready to spread
 * into an update. One place holds the column names so signup and the backfill
 * script cannot drift apart on them.
 */
export function federalOperationColumns(
  facts: CarrierOperationFacts,
  readAt: Date = new Date(),
): Record<string, string | boolean | null> {
  return {
    fmcsa_carrier_operation: facts.carrier_operation,
    fmcsa_for_hire: facts.for_hire,
    fmcsa_hazmat: facts.hazmat,
    fmcsa_operation_read_at: readAt.toISOString(),
  }
}

export function effectiveOperation(row: OperationRow | null | undefined): EffectiveOperation {
  const federal: OperationFact[] = []

  const pick = <T>(fact: OperationFact, owner: T | null, census: T | null): T | null => {
    if (owner !== null) return owner
    if (census !== null) federal.push(fact)
    return census
  }

  const bool = (v: boolean | null | undefined): boolean | null => v ?? null

  return {
    carrier_operation: pick(
      'carrier_operation',
      operationCode(row?.carrier_operation),
      operationCode(row?.fmcsa_carrier_operation),
    ),
    for_hire: pick('for_hire', bool(row?.for_hire), bool(row?.fmcsa_for_hire)),
    hazmat: pick('hazmat', bool(row?.hazmat), bool(row?.fmcsa_hazmat)),
    federal,
  }
}

export interface AuthorityRow {
  usdot_number?: string
  docket_number?: string
  op_auth_type?: string
  /** Active · Pending · Inactive · Withdrawn. */
  op_auth_status?: string
  /** Required minimum coverage, as a decimal string. */
  min_cov_amount?: string
  /** Bodily-injury/property-damage actually on file. */
  bipd_file?: string
}

/**
 * Empty is not an error.
 *
 * Zero rows means "the federal record says this carrier has no such filing" —
 * a fact worth showing. A failed call means "we do not know". Collapsing the
 * two makes the app confidently assert a clean record for a carrier whose data
 * merely failed to load, which is the single most damaging thing a compliance
 * product can do.
 */
export type FederalResult<T> =
  | { state: 'rows'; rows: T[] }
  | { state: 'empty' }
  | { state: 'error'; message: string }

async function soda<T>(url: string, token?: string): Promise<T[]> {
  const res = await fetch(url, {
    headers: token ? { 'X-App-Token': token } : {},
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`FMCSA ${res.status}`)
  const body = await res.json()
  // Socrata reports errors as a JSON *object*, not an array, and does it with a
  // 200 in some cases — so an array check is the only reliable success test.
  if (!Array.isArray(body)) throw new Error('FMCSA returned an error object')
  return body as T[]
}

/** Digits only. A pasted "USDOT 1234567" or "1,234,567" should still work. */
export function normalizeDot(input: string): string | null {
  const digits = (input ?? '').replace(/\D/g, '').replace(/^0+/, '')
  if (digits.length < 1 || digits.length > 8) return null
  return digits
}

export async function lookupCarrier(dot: string, token?: string): Promise<CensusRow | null> {
  // Do NOT zero-pad here. The frozen legacy datasets pad dot_number to 8 chars
  // and return an empty array — not an error — when you don't. This dataset
  // does not pad, so padding would break it in exactly the same silent way.
  const rows = await soda<CensusRow>(`${CENSUS}?dot_number=${encodeURIComponent(dot)}`, token)
  return rows[0] ?? null
}

/**
 * Operating authority. A carrier can hold several, so this returns all of them.
 *
 * An empty result does NOT mean "no authority" — the MOTUS datasets cover only a
 * fraction of all USDOT numbers, and intrastate-only carriers never had one.
 * Callers must distinguish "none found" from "none exists" from "we failed to ask".
 */
export async function lookupAuthority(
  dot: string,
  token?: string,
): Promise<FederalResult<AuthorityRow>> {
  try {
    const rows = await soda<AuthorityRow>(
      `${AUTHORITY}?usdot_number=${encodeURIComponent(dot)}&$limit=50`,
      token,
    )
    return rows.length ? { state: 'rows', rows } : { state: 'empty' }
  } catch (e) {
    return { state: 'error', message: e instanceof Error ? e.message : 'unknown' }
  }
}

/** 'YYYYMMDD' -> Date, or null. Socrata hands these over as plain strings. */
export function parseCensusDate(v: string | undefined): Date | null {
  if (!v || !/^\d{8}$/.test(v)) return null
  const y = Number(v.slice(0, 4))
  const m = Number(v.slice(4, 6))
  const d = Number(v.slice(6, 8))
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  return new Date(Date.UTC(y, m - 1, d))
}

export function statusLabel(code: string | undefined): { label: string; tone: string } {
  switch (code) {
    case 'A':
      return { label: 'Active', tone: 'bg-emerald-100 text-emerald-800' }
    case 'I':
      // Worth spelling out wherever this is shown: per 49 CFR 390.19(b)(4) this
      // means the biennial MCS-150 update was not completed. Owners read the
      // word "inactive" as an accusation of something far worse.
      return { label: 'Inactive', tone: 'bg-red-100 text-red-700' }
    case 'P':
      return { label: 'Pending', tone: 'bg-amber-100 text-amber-800' }
    default:
      return { label: 'Unknown', tone: 'bg-ink-100 text-ink-500' }
  }
}

/**
 * Normalise a docket number to the form the federal file actually stores.
 *
 * Verified against live data: `docket_number` is stored WITH its prefix
 * ("MC116200"). Querying the bare digits returns an EMPTY ARRAY, not an error —
 * so a near-miss on format renders as "this broker has no authority record",
 * which is a false negative wearing the costume of a real finding. Exactly the
 * failure mode the census dataset has with zero-padding.
 *
 * Accepts what a person actually types: "MC 116200", "mc-116200", "116200".
 */
export function normalizeDocket(input: string): string | null {
  const raw = (input ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
  if (!raw) return null

  const m = raw.match(/^(MC|MX|FF)?(\d{1,8})$/)
  if (!m) return null

  // An unprefixed number is overwhelmingly an MC docket — that is what a broker
  // puts on a rate confirmation — but it IS an assumption, so callers that need
  // certainty should ask for the prefix.
  const prefix = m[1] ?? 'MC'
  return `${prefix}${m[2]}`
}

/**
 * Authority by docket number, for an entity we know only by their MC.
 *
 * Brokers are more often identified by MC than by USDOT, and a carrier deciding
 * whether to haul for one wants to know if that authority is inactive BEFORE
 * the truck rolls.
 */
export async function lookupAuthorityByDocket(
  docket: string,
  token?: string,
): Promise<FederalResult<AuthorityRow>> {
  const normalized = normalizeDocket(docket)
  if (!normalized) {
    return { state: 'error', message: 'not a recognisable docket number' }
  }
  try {
    const rows = await soda<AuthorityRow>(
      `${AUTHORITY}?docket_number=${encodeURIComponent(normalized)}&$limit=50`,
      token,
    )
    return rows.length ? { state: 'rows', rows } : { state: 'empty' }
  } catch (e) {
    return { state: 'error', message: e instanceof Error ? e.message : 'unknown' }
  }
}
