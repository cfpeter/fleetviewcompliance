/**
 * The daily digest job.
 *
 * Runs once a morning per carrier timezone, decides what each person should be
 * told, sends it, and records what it sent. Everything it does is idempotent:
 * running it twice sends nothing twice, because every message carries a dedup
 * key and the log has a unique index on it.
 *
 * Messages held by the recipient's quiet hours are the one exception to "records
 * what it did", and deliberately: a held message writes NO log row, because the
 * dedup key it would write is the same key that would then suppress it forever.
 * They are counted in the response summary as `held` and reconsidered next run.
 *
 * Invoked by a Cloudflare cron trigger, or by hand with the shared secret.
 */

import { createClient } from '@supabase/supabase-js'
import type { APIRoute } from 'astro'
import { loadDeadlines } from '../../../lib/deadlines.ts'
import { minutesOfDayInZone, parseClockTime } from '../../../lib/notify/guard.ts'
import { DEFAULT_LEAD_DAYS } from '../../../lib/notify/preferences.ts'
import {
  type CategoryPreference,
  deservesSms,
  type Preference,
  selectForRecipient,
  splitForQuietHours,
} from '../../../lib/notify/select.ts'
import { send, smsBody } from '../../../lib/notify/send.ts'
import type { Subject } from '../../../lib/rules/types.ts'

interface Profile {
  id: string
  email?: string
  phone?: string
  /**
   * Nullable since 0010. NULL means "never chose", and the carrier's zone is the
   * fallback — which is the whole reason carriers.timezone is written at signup.
   */
  timezone?: string | null
  quiet_from?: string | null
  quiet_to?: string | null
  quiet_allow_critical?: boolean | null
}

/**
 * Timing-safe comparison.
 *
 * A plain `!==` on a secret leaks its length and then its content, one request
 * at a time, to anyone patient enough to measure the difference.
 */
function secretMatches(given: string | null, expected: string): boolean {
  if (!given || given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

export const POST: APIRoute = async ({ request }) => {
  // Astro.locals.runtime.env was REMOVED in Astro v6. Worker bindings and
  // secrets now come from the `cloudflare:workers` module, which does not exist
  // outside the Worker runtime — hence the dynamic import and the fallback to
  // import.meta.env for `astro dev` and for tests.
  let workerEnv: Record<string, string> = {}
  try {
    workerEnv = (await import('cloudflare:workers')).env as unknown as Record<string, string>
  } catch {
    // Not running in the Worker runtime; import.meta.env carries the values.
  }
  const get = (k: string) =>
    workerEnv[k] ?? (import.meta.env as unknown as Record<string, string>)[k]

  const expected = get('CRON_SECRET')
  if (!expected) {
    // No secret configured means this endpoint is wide open, so it refuses to
    // run at all rather than defaulting to unauthenticated.
    return json({ error: 'CRON_SECRET is not configured' }, 503)
  }

  const provided =
    request.headers.get('x-cron-secret') ??
    (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')

  if (!secretMatches(provided, expected)) {
    return json({ error: 'unauthorized' }, 401)
  }

  const url = get('PUBLIC_SUPABASE_URL')
  const key = get('SUPABASE_SECRET_KEY')
  if (!url || !key) {
    // This is the ONE place a privileged key is legitimate: a scheduled job has
    // no signed-in user to act as, and it must read across every carrier. It is
    // read from the environment here and never imported into request-handling
    // code, so a mistake in a page cannot reach it.
    return json({ error: 'scheduled jobs need SUPABASE_SECRET_KEY configured' }, 503)
  }

  const db = createClient(url, key, { auth: { persistSession: false } })
  const today = new Date()
  const providers = {
    resendApiKey: get('RESEND_API_KEY'),
    fromEmail: get('DIGEST_FROM_EMAIL'),
    twilioSid: get('TWILIO_ACCOUNT_SID'),
    twilioToken: get('TWILIO_AUTH_TOKEN'),
    twilioFrom: get('TWILIO_FROM_NUMBER'),
  }
  const guardConfig = {
    mode: get('DEPLOY_ENV'),
    redirectEmail: get('DEV_REDIRECT_EMAIL'),
    redirectPhone: get('DEV_REDIRECT_PHONE'),
  }

  // `timezone` is selected because it is this carrier's fallback for anyone who
  // has not chosen one of their own. Before 0010 the column was written at
  // signup and read by nothing at all, while this job used a hard-coded
  // 'America/Los_Angeles' — so a Phoenix carrier's office manager had her quiet
  // hours measured on a clock an hour out from the one on her wall.
  const { data: carriers } = await db.from('carriers').select('id, legal_name, timezone')
  // `held` is its own number, not folded into `skipped`. They are different
  // events with different fixes: skipped means we tried and could not, held
  // means we deliberately waited and will try again.
  const summary = { carriers: 0, considered: 0, sent: 0, held: 0, skipped: 0, failed: 0, logErrors: 0 }

  for (const carrier of carriers ?? []) {
    summary.carriers++

    const [items, { data: members }, { data: prefs }, { data: catPrefs }, { data: snoozeRows }] =
      await Promise.all([
        loadDeadlines(db, carrier.id, today),
        db
          .from('memberships')
          .select(
            'user_id, profiles(id, email, phone, timezone, quiet_from, quiet_to, quiet_allow_critical)',
          )
          .eq('carrier_id', carrier.id),
        db.from('notification_preferences').select('*').eq('carrier_id', carrier.id),
        // Lead times live on their own table since 0010. They are per-CATEGORY
        // facts; hanging them off the channel row meant one category kept three
        // copies of the same array, free to disagree, with no screen able to
        // show the disagreement.
        db
          .from('notification_category_preferences')
          .select('user_id, category, lead_days, digest')
          .eq('carrier_id', carrier.id),
        db
          .from('notification_snoozes')
          .select('rule_code, subject_type, subject_id, until')
          .eq('carrier_id', carrier.id),
      ])

    const snoozes = (snoozeRows ?? []).map((s) => ({
      ruleCode: s.rule_code as string,
      // The column is the `rule_subject` enum since 0010, which mirrors the
      // engine's own Subject union — so this is a straight read, not a
      // translation. It used to be `document_subject` ('vehicle' where the
      // engine says 'power_unit'), which is why isSnoozed ignored it entirely.
      subjectType: s.subject_type as Subject,
      subjectId: (s.subject_id as string | null) ?? null,
      until: new Date(`${s.until}T00:00:00Z`),
    }))

    for (const m of members ?? []) {
      // PostgREST returns an embedded relation as an ARRAY even when the
      // relationship is many-to-one, and the shape has changed between
      // versions. Accepting both is cheaper than being broken by an upgrade.
      const embedded = (m as { profiles?: Profile | Profile[] }).profiles
      const profile = Array.isArray(embedded) ? embedded[0] : embedded
      if (!profile?.id) continue

      const mine = (prefs ?? []).filter((p) => p.user_id === profile.id)
      // Somebody who has never opened settings still needs telling. The default
      // is email-only: real, useful, and impossible to experience as spam.
      const preferences: Preference[] = mine.length
        ? mine.map((p) => ({
            category: p.category,
            channel: p.channel,
            enabled: p.enabled,
          }))
        : [{ category: 'compliance', channel: 'email', enabled: true }]

      // A missing category row means the documented default, not an empty array.
      // `[]` is "warn me never", and reaching it by accident is a deadline that
      // passes in silence while the settings page still shows 30, 7, 1, -1.
      const categoryPreferences: CategoryPreference[] = (catPrefs ?? [])
        .filter((c) => c.user_id === profile.id)
        .map((c) => ({
          category: c.category,
          leadDays: c.lead_days?.length ? c.lead_days : [...DEFAULT_LEAD_DAYS],
          digest: c.digest,
        }))

      // Only this recipient's own already-sent keys matter, and the prefix makes
      // that a cheap index scan rather than loading the whole log.
      const { data: sentRows } = await db
        .from('notification_log')
        .select('dedup_key')
        // ONLY a genuine send consumes the key.
        //
        // The bug this closes: the guard writes `skipped` rows for every message
        // it refuses — which is every message in any non-production environment,
        // and every message while the email provider is unconfigured. Those rows
        // carry real dedup keys. Counting them as handled means that the moment
        // the provider IS configured, the backlog is already deduped away and
        // those deadlines are never emailed. Not late. Never.
        //
        // `skipped` is safe to retry because it means we never contacted the
        // provider at all. `failed` is safe for the same reason in practice: it
        // is only produced by a non-2xx response, which is the provider telling
        // us it did not accept the message.
        .eq('status', 'sent')
        .eq('carrier_id', carrier.id)
        .like('dedup_key', `${profile.id}|%`)
      const alreadySent = new Set((sentRows ?? []).map((r) => r.dedup_key as string))

      // Theirs, then the carrier's, then Pacific. Each step is a real fallback
      // and not a guess dressed up as one: a person who chose a zone gets it, a
      // person who never did gets their employer's, and only an account with
      // neither lands on the constant this company happens to sit in.
      const zone = profile.timezone || carrier.timezone || 'America/Los_Angeles'

      const candidates = selectForRecipient({
        items,
        recipient: {
          userId: profile.id,
          email: profile.email,
          phone: profile.phone,
          timezone: zone,
        },
        preferences,
        categoryPreferences,
        snoozes,
        alreadySent,
        today,
      })
      summary.considered += candidates.length
      if (candidates.length === 0) continue

      // Quiet hours, finally obeyed.
      //
      // They were collected by the settings page and checked by a tested
      // function, and this job never called it — so the screen promised silence
      // it did not deliver. The critical breakthrough uses `isCritical`, which is
      // `deservesSms` under another name, so "already overdue or due tomorrow"
      // has exactly one definition and the settings copy stays true.
      const { deliver, held } = splitForQuietHours(candidates, {
        fromMinutes: parseClockTime(profile.quiet_from),
        toMinutes: parseClockTime(profile.quiet_to),
        allowCritical: profile.quiet_allow_critical ?? true,
        nowLocalMinutes: minutesOfDayInZone(today, zone),
      })

      // Counted, and written NOWHERE ELSE. A held message must not reach
      // notification_log: `dedup_key` is unique and `alreadySent` above matches
      // on the key alone, so a logged hold burns the key and the message never
      // arrives at all — not late, never. The hold is re-derived from scratch on
      // the next run, which is precisely what lets it eventually go out.
      summary.held += held.length
      if (deliver.length === 0) continue

      // One email carrying everything, rather than one per item. Fourteen
      // separate emails about fourteen expiring items is how we get muted, and
      // then the one that mattered arrives into silence.
      const emailItems = deliver.filter((c) => c.channel === 'email')
      if (emailItems.length && profile.email) {
        const lines = emailItems.map((c) => {
          const when =
            c.item.status.standing === 'overdue'
              ? `OVERDUE since ${c.item.status.lastDue?.toISOString().slice(0, 10) ?? 'recently'}`
              : `due ${c.item.status.nextDue?.toISOString().slice(0, 10)} (${c.item.daysUntil} days)`
          return `• ${c.item.rule.title} — ${c.item.subjectLabel} — ${when}\n  ${c.item.rule.citation}`
        })
        const overdueCount = emailItems.filter((c) => c.item.status.standing === 'overdue').length
        const subject = overdueCount
          ? `${overdueCount} overdue · ${carrier.legal_name}`
          : `${emailItems.length} coming up · ${carrier.legal_name}`

        const result = await send(
          {
            channel: 'email',
            to: profile.email,
            subject,
            body: `${lines.join('\n\n')}\n\nSee everything: ${get('PUBLIC_SITE_URL') ?? ''}/app\n`,
          },
          guardConfig,
          providers,
        )
        summary[
          result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : 'skipped'
        ]++

        // Logged whatever happened. A message we tried and failed to send is
        // exactly the thing somebody will later ask about, and a log that only
        // records successes cannot answer.
        // UPSERT, not insert. `dedup_key` is unique, so a retried message —
        // one previously logged as skipped because no provider was configured —
        // collides on the second attempt. As a plain insert that collision was
        // swallowed: supabase-js returns the error in the result rather than
        // throwing, nothing read it, and the log silently stopped recording.
        const logged = await db.from('notification_log').upsert(
          emailItems.map((c) => ({
            carrier_id: carrier.id,
            user_id: profile.id,
            channel: 'email',
            category: 'compliance',
            destination: result.destination,
            subject,
            body: null,
            dedup_key: c.dedupKey,
            status: result.status,
            error: result.detail ?? null,
          })),
          { onConflict: 'dedup_key' },
        )
        if (logged.error) {
          // A send we cannot record is worse than one we did not make: the next
          // run has no way to know it happened. Surfaced in the summary rather
          // than discarded.
          summary.logErrors++
        }
      }

      // SMS is rationed to things already costing money.
      const smsItems = deliver.filter((c) => c.channel === 'sms' && deservesSms(c.item))
      if (smsItems.length && profile.phone) {
        const body = smsBody([
          `${carrier.legal_name}:`,
          ...smsItems.slice(0, 3).map((c) => `${c.item.rule.title} — ${c.item.subjectLabel}`),
          smsItems.length > 3 ? `and ${smsItems.length - 3} more.` : '',
        ])
        const result = await send(
          { channel: 'sms', to: profile.phone, body },
          guardConfig,
          providers,
        )
        summary[
          result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : 'skipped'
        ]++
        const smsLogged = await db.from('notification_log').upsert(
          smsItems.map((c) => ({
            carrier_id: carrier.id,
            user_id: profile.id,
            channel: 'sms',
            category: 'compliance',
            destination: result.destination,
            body,
            dedup_key: c.dedupKey,
            status: result.status,
            error: result.detail ?? null,
          })),
          { onConflict: 'dedup_key' },
        )
        if (smsLogged.error) summary.logErrors++
      }
    }
  }

  return json({ ok: true, ...summary })
}

// A GET would let a browser preload or a link prefetch trigger the whole run.
export const GET: APIRoute = () => json({ error: 'use POST' }, 405)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
