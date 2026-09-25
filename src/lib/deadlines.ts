/**
 * Loading a carrier's world out of the database and handing it to the engine.
 *
 * Kept separate from src/lib/rules/ on purpose: the rules know nothing about
 * Postgres, and this file knows nothing about the regulations.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTIVE_DRIVER_STATUS, ACTIVE_VEHICLE_STATUS } from './fleet/active.ts'
import { effectiveOperation } from './fmcsa.ts'
import { driverFileAnchors } from './proof/dqf.ts'
import { type DeadlineItem, type EvaluationSubject, evaluate } from './rules/index.ts'

/** 'YYYY-MM-DD' from Postgres -> a UTC midnight Date. */
function parseDate(v: string | null | undefined): Date | undefined {
  if (!v) return undefined
  const [y, m, d] = v.split('-').map(Number)
  if (!y || !m || !d) return undefined
  return new Date(Date.UTC(y, m - 1, d))
}

interface AnchorRow {
  subject_type: string
  subject_id: string | null
  anchor_key: string
  occurred_on: string
}

export async function loadDeadlines(
  supabase: SupabaseClient,
  carrierId: string,
  today = new Date(),
): Promise<DeadlineItem[]> {
  // RLS scopes all four of these to the signed-in user's carrier, so there is
  // no carrier_id filter here. Adding one would imply the policy might not hold.
  //
  // BOTH STATUS FILTERS COME FROM src/lib/fleet/active.ts, AND SO DOES BILLING.
  // This line used to read `.neq('status', 'sold')` for vehicles against
  // `.eq('status', 'active')` for drivers — an asymmetry nobody chose. It meant
  // an out-of-service truck kept generating reminders and kept costing $6 a
  // month, while an inactive driver silently left the dashboard. One shared
  // predicate is what makes "you pay for the trucks we watch" true again, and
  // the only way to change one side now is to change both.
  const [carrier, drivers, vehicles, anchors] = await Promise.all([
    supabase.from('carriers').select('*').eq('id', carrierId).single(),
    supabase.from('drivers').select('*').eq('status', ACTIVE_DRIVER_STATUS),
    supabase.from('vehicles').select('*').eq('status', ACTIVE_VEHICLE_STATUS),
    supabase.from('current_compliance_anchors').select('*'),
  ])

  const rows: AnchorRow[] = anchors.data ?? []

  /** Anchors for one subject, as the engine wants them. */
  const anchorsFor = (type: string, id: string | null) => {
    const out: Record<string, Date | undefined> = {}
    for (const r of rows) {
      if (r.subject_type !== type) continue
      if (type !== 'carrier' && r.subject_id !== id) continue
      const d = parseDate(r.occurred_on)
      if (d) out[r.anchor_key] = d
    }
    return out
  }

  const c = carrier.data
  const subjects: EvaluationSubject[] = []

  /**
   * The carrier's state, put on EVERY subject rather than only on the carrier.
   *
   * The state gate in rules/index.ts asks the context where this carrier is
   * registered, and a truck is not registered anywhere on its own — it belongs
   * to the carrier that owns it. Set only on the carrier subject, the gate
   * worked for carrier-level rules like the Motor Carrier Permit and silently
   * did nothing for vehicle-level ones: a Texas carrier stopped seeing the MCP
   * and went on being told his trucks owed California CVRA weight decals. Half
   * a fix reads exactly like a whole one from the dashboard.
   */
  const carrierState = c?.phy_state ?? undefined

  /**
   * The three facts that decide which half of the catalogue applies, read
   * off the columns 0031 added and put on EVERY subject for the same reason
   * as the state above: `interstateDriver` reads `carrierOperation` on the
   * DRIVER subject, `isCmv` and the hazmat training row read `hazmat` on
   * the vehicle and driver subjects, and a fact set only on the carrier
   * subject would leave those gates failing open exactly as they did before
   * the column existed.
   *
   * WHERE A NULL COLUMN NOW GOES BEFORE IT BECOMES UNKNOWN. `effectiveOperation`
   * (0040) reads the owner's answer first and the carrier's own federal record
   * second, per fact. Only where neither settles it does the value reach the
   * engine as undefined, which is UNKNOWN, which keeps the rule on the board.
   * It must still never become `false` here — false is the one value that can
   * take an obligation away, and this file is not where that is decided.
   */
  const facts = effectiveOperation(c)
  const operation = {
    carrierOperation: facts.carrier_operation ?? undefined,
    forHire: facts.for_hire ?? undefined,
    hazmat: facts.hazmat ?? undefined,
  }

  subjects.push({
    type: 'carrier',
    id: carrierId,
    label: c?.legal_name ?? 'This carrier',
    context: {
      dotNumber: c?.dot_number ?? undefined,
      ...operation,
      registrationState: carrierState,
      // Active power units — the same population billing charges for and the
      // same number the dashboard's roster tile counts, because the query above
      // now shares its filter with both. Three screens, one count.
      fleetSize: (vehicles.data ?? []).filter((v) => v.kind === 'power_unit').length,
    },
    anchors: anchorsFor('carrier', carrierId),
  })

  for (const d of drivers.data ?? []) {
    // Some dates live on the driver ROW rather than in compliance_records,
    // because they are identity rather than compliance events — you do not
    // "perform" a hire date. `driverFileAnchors` projects them in so a rule
    // never has to know which table a fact happens to sit in, and it is SHARED
    // with the driver file in src/lib/proof/dqf.ts: the dashboard this feeds
    // and the link a carrier shares are scored from one set of anchors, which
    // is the only reason they agree. The reason it is load-bearing, and what
    // broke while it was not shared, is written down there.
    const a = driverFileAnchors(anchorsFor('driver', d.id), {
      hired_on: parseDate(d.hired_on),
      cdl_expires_on: parseDate(d.cdl_expires_on),
    })

    subjects.push({
      type: 'driver',
      id: d.id,
      label: `${d.first_name} ${d.last_name}`.trim(),
      context: { cdl: Boolean(d.cdl_number), registrationState: carrierState, ...operation },
      anchors: a,
    })
  }

  for (const v of vehicles.data ?? []) {
    subjects.push({
      type: v.kind === 'trailer' ? 'trailer' : 'power_unit',
      id: v.id,
      label: v.unit_number || v.vin || 'Unnumbered unit',
      context: {
        registrationState: carrierState,
        ...operation,
        // NULL GVWR stays undefined, which the engine reads as UNKNOWN and
        // therefore as fully regulated. It must never become a 0 here — that
        // would read as "under every weight threshold" and exempt the truck.
        gvwrLbs: v.gvwr_lbs ?? undefined,
        modelYear: v.model_year ?? undefined,
        vin: v.vin ?? undefined,
      },
      anchors: anchorsFor('vehicle', v.id),
    })
  }

  return evaluate(subjects, today)
}
