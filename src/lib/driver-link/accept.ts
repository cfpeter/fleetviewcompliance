/**
 * Turning a driver's claim into a record the carrier stands on.
 *
 * THIS IS THE ONLY PLACE A DRIVER SUBMISSION REACHES A COMPLIANCE SURFACE, and
 * it runs signed in, through RLS, as the owner. Everything on the anonymous side
 * writes one row to `driver_submissions` and stops. The person who gets pulled
 * over at a scale is the carrier, not the driver who typed the date, so the
 * carrier is the one who says a date is true.
 *
 * `source = 'driver'` (0037) is stamped on every row this writes. Months later
 * the question "did I type this, or did Aram send it in from his phone?" has an
 * answer on the record itself, which is the entire reason the enum value exists.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { anchorSlot, planAnchorWrites } from '../anchors/plan.ts'
import { ACCEPTED_TYPES, documentBucket, NO_BUCKET_MESSAGE, newStorageKey } from '../documents.ts'
import { DRIVER_ASKS } from './asks.ts'

export interface AcceptArgs {
  supabase: SupabaseClient
  carrierId: string
  userId: string | null
  driverId: string
  /** `{ medical: '2027-03-04' }` — keys are ask keys, already narrowed by 0036. */
  payload: Record<string, string>
  storageKeys: string[]
}

export type AcceptResult =
  | { ok: true; dates: number; files: number }
  | { ok: false; message: string }

export async function acceptSubmission(args: AcceptArgs): Promise<AcceptResult> {
  const asked = DRIVER_ASKS.filter((a) => typeof args.payload[a.key] === 'string')

  // ------------------------------------------------------------- the columns
  //
  // A CDL expiry lives on the driver row and not in a compliance record. Writing
  // it as a record would file it under `cdl_expires`, which is on the unwritable
  // list in src/lib/rules/anchors.ts precisely because such a record SILENTLY
  // OUTRANKS the column — the driver's own page would keep showing the right
  // date while five federal rules ran off the wrong one.
  const columns: Record<string, string> = {}
  for (const ask of asked) {
    if (ask.target.via === 'column') columns[ask.target.column] = args.payload[ask.key]
  }
  if (Object.keys(columns).length > 0) {
    const { error } = await args.supabase
      .from('drivers')
      .update({ ...columns, source: 'driver' })
      .eq('id', args.driverId)
    if (error) return { ok: false, message: 'We could not save that date. Try again.' }
  }

  // ------------------------------------------------------------- the anchors
  const entries = asked
    .filter((a) => a.target.via === 'anchor')
    .map((a) => ({
      subject: 'driver' as const,
      subjectId: args.driverId,
      anchorKey: (a.target as { anchorKey: string }).anchorKey,
      on: args.payload[a.key],
    }))

  let inserted = 0
  if (entries.length > 0) {
    const { data: currentRows, error: readError } = await args.supabase
      .from('current_compliance_anchors')
      .select('id, anchor_key, occurred_on')
      .eq('subject_type', 'driver')
      .eq('subject_id', args.driverId)
    if (readError) return { ok: false, message: 'We could not save that date. Try again.' }

    const current = new Map(
      (currentRows ?? []).map((r) => [
        anchorSlot('driver', args.driverId, String(r.anchor_key)),
        { id: String(r.id), occurred_on: String(r.occurred_on).slice(0, 10) },
      ]),
    )

    const recordedAt = new Date().toISOString()
    const { supersede, inserts, conflicts } = planAnchorWrites({
      entries,
      current,
      carrierId: args.carrierId,
      userId: args.userId,
      recordedAt,
    })
    // One box per ask on the driver's form, so two entries cannot name one slot.
    if (conflicts.length > 0) return { ok: false, message: 'Those dates disagree with each other.' }

    if (supersede.length > 0) {
      const { error } = await args.supabase
        .from('compliance_records')
        .update({ superseded_at: recordedAt })
        .in('id', supersede)
      if (error) return { ok: false, message: 'We could not save that date. Try again.' }
    }
    if (inserts.length > 0) {
      const { error } = await args.supabase
        .from('compliance_records')
        .insert(inserts.map((row) => ({ ...row, source: 'driver' })))
      if (error) return { ok: false, message: 'We could not save that date. Try again.' }
      inserted = inserts.length
    }
  }

  // --------------------------------------------------------------- the files
  //
  // THE STAGED OBJECT IS COPIED TO A PROPER DOCUMENT KEY, not reused where it
  // lies. I built it the other way first — the predecessor reuses its staged
  // path, and keeping one key made the submission and the document joinable —
  // and it was wrong: `isStorageKey` enforces `documents/<carrierId>/<hex>.<ext>`
  // and the serving route checks it before the key ever reaches the bucket. A
  // `driver-submissions/…` key is refused there, so every accepted photo
  // answered "We cannot find that file."
  //
  // The provenance that motivated reusing it is not lost. The submission row
  // keeps its own keys, its timestamp, who decided it and when, so "where did
  // this photo come from" is answered by the row rather than by the filename.
  let files = 0
  if (args.storageKeys.length > 0) {
    const bucket = await documentBucket()
    if (!bucket) return { ok: false, message: NO_BUCKET_MESSAGE }

    const rows: Record<string, unknown>[] = []

    for (const staged of args.storageKeys) {
      const object = await bucket.get(staged)
      // Already gone — a half-finished accept, or a reject that raced. Skipping
      // is right: there is nothing to file and nothing to report.
      if (!object) continue

      const bytes = new Uint8Array(await object.arrayBuffer())
      const ext = staged.split('.').pop() ?? ''
      const type = ACCEPTED_TYPES.find((t) => t.ext === ext)
      // The extension was written by `newSubmissionKey` from a magic-byte sniff
      // at submit time, so an unknown one here means somebody wrote a key by
      // hand. Skip rather than guess a content type onto it.
      if (!type) continue

      /*
       * WHICH BOX THIS CAME OUT OF, carried on the object since the submit.
       *
       * The first version had one kind for the whole submission and fell back to
       * 'other' whenever more than one file arrived — so an owner who asked for
       * an intracity exemption, and got exactly that, read "Other paper" on his
       * own screen. Guessing was the right instinct to avoid and the wrong
       * mechanism: the form already knew, and threw it away.
       *
       * An empty ask is the "Anything else to send?" box, where 'other' is the
       * honest answer rather than a guess.
       */
      const from = DRIVER_ASKS.find((a) => a.key === object.customMetadata?.ask)
      const typed = from ? args.payload[from.key] : undefined

      rows.push({
        carrier_id: args.carrierId,
        subject_type: 'driver',
        subject_id: args.driverId,
        kind: from?.documentKind ?? 'other',
        storage_key: newStorageKey(args.carrierId, type.ext),
        // What he called it, carried on the staged object because there was no
        // other channel for it. Without this every accepted photo lands in the
        // document list as a nameless "File".
        file_name: object.customMetadata?.name ?? null,
        // Measured from the bytes, not claimed by anybody. Without these the
        // row renders with no size beside it.
        content_type: type.mime,
        byte_size: bytes.byteLength,
        /*
         * THE DATE HE TYPED GOES ON THE PAPER TOO.
         *
         * It was going only onto the compliance record, so the document list
         * said "No date on this paper" beside a photo whose date the driver had
         * just sent. The two halves of one answer belong together: the date says
         * the card is good until March, the photo is the card.
         *
         * Which column depends on the ask and never on a guess — a medical card
         * and an SPE certificate carry an expiry; a zone exemption and an
         * assessment carry the day they happened.
         */
        expires_on: from?.dateIs === 'expires' ? (typed ?? null) : null,
        issued_on: from?.dateIs === 'issued' ? (typed ?? null) : null,
        uploaded_by: args.userId,
      })

      await bucket.put(rows[rows.length - 1].storage_key as string, bytes, {
        httpMetadata: { contentType: type.mime, contentDisposition: 'attachment' },
        customMetadata: { carrierId: args.carrierId, subjectType: 'driver' },
      })
      // The staging copy goes only after the new one is written.
      await bucket.delete(staged).catch(() => undefined)
    }

    if (rows.length > 0) {
      const { error } = await args.supabase.from('documents').insert(rows)
      if (error) return { ok: false, message: 'The date was saved, but the photo was not.' }
      files = rows.length
    }
  }

  return { ok: true, dates: inserted + Object.keys(columns).length, files }
}
