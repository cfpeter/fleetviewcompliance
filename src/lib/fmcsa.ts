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
  hm_ind?: string
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
  const raw = (input ?? '').trim().toUpperCase().replace(/[\s\-_.]/g, '')
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
