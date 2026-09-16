/**
 * Feeding the eligibility engine from the database.
 *
 * Kept apart from eligibility.ts so the decision logic stays pure and testable:
 * the question "may this driver take this load" must be answerable without a
 * database, or it cannot be tested properly — and it is the one answer in this
 * product that must never be wrong by accident.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadDeadlines } from '../deadlines.ts'
import type { DeadlineItem } from '../rules/index.ts'
import { conflicts, eligibility, type EligibilityIssue, type OpenLoad } from './eligibility.ts'

export interface AssignmentCheck {
  issues: EligibilityIssue[]
  blocked: boolean
}

/** Every deadline item belonging to one subject. */
function itemsFor(
  items: readonly DeadlineItem[],
  subjectId: string | null,
): readonly DeadlineItem[] {
  if (!subjectId) return []
  return items.filter((i) => i.subjectId === subjectId)
}

/**
 * Loads still open for a driver or a vehicle.
 *
 * "Open" is an assignment row with no unassigned_at, on a load that has not
 * reached delivered. A delivered load holding a driver would double-book him
 * forever.
 */
async function openLoadsFor(
  supabase: SupabaseClient,
  column: 'driver_id' | 'tractor_id' | 'trailer_id',
  id: string | null,
): Promise<OpenLoad[]> {
  if (!id) return []
  const { data } = await supabase
    .from('load_assignments')
    .select('load_id, loads(load_number, broker_reference, status)')
    .eq(column, id)
    .is('unassigned_at', null)

  return (data ?? [])
    .filter((r) => {
      const l = Array.isArray(r.loads) ? r.loads[0] : r.loads
      return l && l.status !== 'delivered' && l.status !== 'pod_received'
    })
    .map((r) => {
      const l = (Array.isArray(r.loads) ? r.loads[0] : r.loads) as {
        load_number?: string
        broker_reference?: string
      } | null
      return {
        loadId: r.load_id as string,
        loadLabel: l?.load_number || l?.broker_reference || 'an open load',
      }
    })
}

export async function checkAssignment(args: {
  supabase: SupabaseClient
  carrierId: string
  loadId: string
  driverId: string | null
  coDriverId?: string | null
  tractorId: string | null
  trailerId: string | null
  labels: Readonly<Record<string, string>>
  today?: Date
}): Promise<AssignmentCheck> {
  const { supabase, carrierId, loadId, driverId, coDriverId, tractorId, trailerId, labels } = args

  const items = await loadDeadlines(supabase, carrierId, args.today ?? new Date())

  const issues: EligibilityIssue[] = []
  for (const [id, fallback] of [
    [driverId, 'This driver'],
    [coDriverId ?? null, 'The co-driver'],
    [tractorId, 'This tractor'],
    [trailerId, 'This trailer'],
  ] as const) {
    if (!id) continue
    issues.push(
      ...eligibility({ items: itemsFor(items, id), label: labels[id] ?? fallback }),
    )
  }

  const [driverOpen, tractorOpen, trailerOpen] = await Promise.all([
    openLoadsFor(supabase, 'driver_id', driverId),
    openLoadsFor(supabase, 'tractor_id', tractorId),
    openLoadsFor(supabase, 'trailer_id', trailerId),
  ])

  issues.push(
    ...conflicts({
      openDriverLoads: driverOpen,
      openTractorLoads: tractorOpen,
      openTrailerLoads: trailerOpen,
      thisLoadId: loadId,
    }),
  )

  return { issues, blocked: issues.some((i) => i.severity === 'block') }
}
