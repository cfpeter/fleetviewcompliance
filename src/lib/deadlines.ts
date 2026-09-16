/**
 * Loading a carrier's world out of the database and handing it to the engine.
 *
 * Kept separate from src/lib/rules/ on purpose: the rules know nothing about
 * Postgres, and this file knows nothing about the regulations.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { DRIVER_ANCHORS_FROM_DRIVER_COLUMNS } from './rules/driver-anchors.ts'
import { evaluate, type DeadlineItem, type EvaluationSubject } from './rules/index.ts'

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
  const [carrier, drivers, vehicles, anchors] = await Promise.all([
    supabase.from('carriers').select('*').eq('id', carrierId).single(),
    supabase.from('drivers').select('*').eq('status', 'active'),
    supabase.from('vehicles').select('*').neq('status', 'sold'),
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

  subjects.push({
    type: 'carrier',
    id: carrierId,
    label: c?.legal_name ?? 'This carrier',
    context: {
      dotNumber: c?.dot_number ?? undefined,
      carrierOperation: c?.carrier_operation ?? undefined,
      registrationState: carrierState,
      fleetSize: (vehicles.data ?? []).filter((v) => v.kind === 'power_unit').length,
    },
    anchors: anchorsFor('carrier', carrierId),
  })

  for (const d of drivers.data ?? []) {
    const a = anchorsFor('driver', d.id)

    // Some dates live on the driver ROW rather than in compliance_records,
    // because they are identity rather than compliance events — you do not
    // "perform" a hire date. Project them in so a rule never has to know which
    // table a fact happens to sit in.
    //
    // This is load-bearing, not tidiness: five federal rules hang off
    // `hire_date` (the DQF itself, the hire-time MVR, the safety-history
    // investigation, the road test, and the pre-employment Clearinghouse
    // query). Without this projection all five report "we need a date from you"
    // for every driver — while the hire date sits on the driver's own page
    // looking perfectly well answered. The anchor-to-column map is exported
    // alongside the anchor constants so the two cannot drift apart.
    for (const [anchorKey, column] of Object.entries(DRIVER_ANCHORS_FROM_DRIVER_COLUMNS)) {
      if (a[anchorKey]) continue // an explicitly recorded date always wins
      const fromColumn = parseDate(d[column as keyof typeof d] as string | null)
      if (fromColumn) a[anchorKey] = fromColumn
    }

    // The CDL expiry is the same shape of fact.
    const cdl = parseDate(d.cdl_expires_on)
    if (cdl && !a.cdl_expires) a.cdl_expires = cdl

    subjects.push({
      type: 'driver',
      id: d.id,
      label: `${d.first_name} ${d.last_name}`.trim(),
      context: { cdl: Boolean(d.cdl_number), registrationState: carrierState },
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
