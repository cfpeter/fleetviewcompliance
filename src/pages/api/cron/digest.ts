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
 * A message skipped because its recipient is suppressed at the provider follows
 * that same precedent for that same reason — see `suppressed` below.
 *
 * Invoked by a Cloudflare cron trigger, or by hand with the shared secret.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
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
import { CEILING, sendOrCeiling, smsBody } from '../../../lib/notify/send.ts'
import { fetchDeliveryEvent, fetchSuppressions } from '../../../lib/notify/suppression.ts'
import {
  loadReminders,
  REMINDER_CATEGORY,
  reminderEmailLine,
  selectReminders,
} from '../../../lib/reminders.ts'
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

/**
 * How far back the reconciliation pass looks.
 *
 * `last_event` settles within seconds of the send (measured: `queued` at +0s,
 * `suppressed` at +2s), and this job runs three times a day — so 48 hours gives
 * every message roughly six chances to be resolved while keeping the query a
 * fixed-size window rather than a scan that grows with the log forever. A row
 * still `unknown` after two days is one the provider is never going to answer
 * about, and re-asking about it daily for a year buys nothing.
 */
const RECONCILE_WINDOW_HOURS = 48

/**
 * The hard ceiling on lookups per run.
 *
 * Every lookup is one Cloudflare subrequest, and a Worker has a per-request
 * budget for those (50 on the free plan, 1000 on paid) that this job already
 * spends against for every carrier it reads. An unbounded pass would eventually
 * exhaust it and take the whole digest down with it — trading a silent delivery
 * failure for a silent digest, which is the worse of the two.
 *
 * Newest first, so the messages somebody could still act on are the ones
 * resolved when the ceiling bites. `DIGEST_RECONCILE_LIMIT` raises it for a
 * deployment that genuinely sends more than this in one run.
 */
const RECONCILE_LIMIT = 50

/** Lookups in flight at once. Enough to keep the pass quick, few enough not to
 *  look like a burst to the provider's rate limiter. */
const RECONCILE_CONCURRENCY = 6

interface ReconcileSummary {
  /** Rows we asked the provider about. */
  checked: number
  /** Rows that moved off `unknown` — the number that actually learned something. */
  resolved: number
  /** Rows the provider says never reached a person. These make the run go red. */
  undelivered: number
  /** Rows that DID arrive and were marked as spam. Not a delivery failure. */
  complained: number
}

/**
 * Correct the record on messages we reported as sent.
 *
 * THE HALF THAT CANNOT BE DONE AT SEND TIME. `POST /emails` returns only an id,
 * and `last_event` reads `queued` for the first couple of seconds — so the truth
 * about a message is knowable within seconds of sending it and not within the
 * request that sent it. This pass is where that truth is collected.
 *
 * It runs first in the digest, before any candidate is derived, so that a
 * message discovered undelivered is re-derived and re-sent in THIS run rather
 * than eight hours later in the next one.
 *
 * It writes ONLY the delivery columns. `status` stays exactly as the send
 * reported it, because Resend really did accept the message and rewriting that
 * would destroy the record of what we observed at the time. What un-spends the
 * dedup key is the `delivery_state` filter on the `alreadySent` read below — one
 * rule, in one place: a log row silences its key only when it represents a
 * message that actually arrived.
 */
async function reconcileDeliveries(
  db: SupabaseClient,
  apiKey: string | undefined,
  limit: number,
): Promise<ReconcileSummary> {
  const out: ReconcileSummary = { checked: 0, resolved: 0, undelivered: 0, complained: 0 }
  if (!apiKey) return out

  const since = new Date(Date.now() - RECONCILE_WINDOW_HOURS * 3_600_000).toISOString()
  // Every clause here is also in notification_log_unreconciled_idx (0022), so
  // this is an index scan over one window's unresolved sends and not a walk of
  // the log. Email only: Resend is the only provider whose delivery API has been
  // measured, and a Twilio sid asked of `GET /emails/{id}` is a guaranteed 404.
  const { data } = await db
    .from('notification_log')
    .select('id, provider_message_id')
    .eq('channel', 'email')
    .eq('delivery_state', 'unknown')
    .not('provider_message_id', 'is', null)
    .gte('sent_at', since)
    .order('sent_at', { ascending: false })
    .limit(limit)

  const rows = (data ?? []) as { id: string; provider_message_id: string }[]
  if (rows.length === 0) return out

  // Grouped by the answer rather than written row by row. Only a handful of
  // distinct `last_event` values can come back, so this turns up to `limit`
  // writes into about three — which matters for the same subrequest budget the
  // ceiling above protects.
  const buckets = new Map<string, { state: string; event: string | null; ids: string[] }>()
  const checkedAt = new Date().toISOString()

  for (let i = 0; i < rows.length; i += RECONCILE_CONCURRENCY) {
    const slice = rows.slice(i, i + RECONCILE_CONCURRENCY)
    const looked = await Promise.all(
      slice.map((r) => fetchDeliveryEvent(apiKey, r.provider_message_id)),
    )
    for (let j = 0; j < slice.length; j++) {
      out.checked++
      const found = looked[j]
      // A lookup that errored tells us nothing, and writing `unknown` over
      // `unknown` would only move delivery_checked_at forward — making a row we
      // failed to read look like a row we read and could not resolve.
      if (found.error) continue
      const key = `${found.state}|${found.event ?? ''}`
      const bucket = buckets.get(key) ?? { state: found.state, event: found.event, ids: [] }
      bucket.ids.push(slice[j].id)
      buckets.set(key, bucket)
    }
  }

  for (const bucket of buckets.values()) {
    const { error } = await db
      .from('notification_log')
      .update({
        delivery_state: bucket.state,
        delivery_detail: bucket.event,
        delivery_checked_at: checkedAt,
      })
      .in('id', bucket.ids)
    if (error) continue
    if (bucket.state === 'undelivered') out.undelivered += bucket.ids.length
    if (bucket.state === 'complained') out.complained += bucket.ids.length
    if (bucket.state !== 'unknown') out.resolved += bucket.ids.length
  }

  return out
}

export const POST: APIRoute = async ({ request }) => {
  // Astro.locals.runtime.env was REMOVED in Astro v6. Worker bindings and
  // secrets now come from the `cloudflare:workers` module, which does not exist
  // outside the Worker runtime — hence the dynamic import.
  //
  // THE FALLBACK IS `process.env`, AND `import.meta.env` IS FORBIDDEN HERE.
  //
  // It used to be the fallback, indexed with a variable in the belief that a key
  // Vite cannot see is a value Vite cannot replace. The opposite is true: Vite
  // substitutes the `import.meta.env` EXPRESSION, not the property access — so a
  // computed key makes it inline an object literal holding EVERY variable the
  // build machine's .env carried, and then index that at runtime. Measured on
  // this repo's own output: the built bundle contained CRON_SECRET,
  // CLAIM_CODE_PEPPER, SUPABASE_SECRET_KEY and RESEND_API_KEY as plaintext
  // literals. That is this endpoint's entire secret inventory compiled into a
  // file that is uploaded to Cloudflare and left sitting in dist/, where a CI
  // cache or a shared machine is enough to leak it — and CRON_SECRET is the only
  // thing between a stranger and a full run of this job against every carrier.
  //
  // A LITERAL key is safe (`import.meta.env.PUBLIC_SITE_URL` replaces exactly
  // that one value, and PUBLIC_* is public by definition). A COMPUTED key never
  // is. `process.env` is left alone by Vite under a variable key, and the
  // Workers runtime populates it from the real bindings under `nodejs_compat`.
  // Same rule and same reasoning as src/lib/billing/config.ts.
  //
  // WHAT IT COSTS. Nothing in a deployed Worker, where `wrangler secret` is the
  // source and always was. Locally it means this route sees only what actually
  // reaches the Worker env — wrangler.jsonc `vars` plus `.dev.vars` — so a dev
  // value kept only in .env is now invisible and the run answers 503 instead of
  // starting. Put dev values in `.dev.vars`, which is gitignored for that reason.
  let workerEnv: Record<string, string> = {}
  try {
    workerEnv = (await import('cloudflare:workers')).env as unknown as Record<string, string>
  } catch {
    // Not the Worker runtime — plain Node, where process.env is the whole story.
  }
  const processEnv: Record<string, string | undefined> =
    typeof process !== 'undefined' && process.env ? process.env : {}
  const get = (k: string) => workerEnv[k] ?? processEnv[k]

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

  // LITERAL keys, which is the one shape of `import.meta.env` that is safe: Vite
  // replaces `import.meta.env.PUBLIC_SUPABASE_URL` with that single value and
  // nothing else, and PUBLIC_* is public by definition — this exact URL is
  // already inlined by src/lib/supabase/server.ts on every page. Kept as the
  // fallback so that dropping the old computed-key read does not silently take
  // the digest down: these two never were Worker secrets, they arrived in the
  // inlined object, and a scheduled job that 503s because a PUBLIC url went
  // missing is a fix that breaks the thing it was protecting. A Worker var still
  // wins where one is set.
  const url = get('PUBLIC_SUPABASE_URL') ?? import.meta.env.PUBLIC_SUPABASE_URL
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

  // BOTH HALVES OF THE SUPPRESSION DEFENCE, BEFORE A SINGLE CANDIDATE IS
  // DERIVED. Neither one closes the hole alone and the ordering is load-bearing.
  //
  // The list catches addresses the provider already admits to suppressing, for
  // one HTTP call rather than one per message. It is MEASURABLY INCOMPLETE — an
  // address that reliably reports `suppressed` from the id lookup is absent from
  // it — so the reconciliation below is what catches the rest, one run late.
  //
  // Reconciliation runs HERE, ahead of the carrier loop, so that a message it
  // finds undelivered has its dedup key freed before this run reads
  // `alreadySent`. Run it afterwards and every correction waits eight hours for
  // the next job.
  // Concurrently, because the two are independent and the digest has a Worker
  // time budget to finish inside. What is NOT optional is that both complete
  // before the loop below.
  const limitOverride = Number(get('DIGEST_RECONCILE_LIMIT'))
  const [reconciled, suppression] = await Promise.all([
    reconcileDeliveries(
      db,
      providers.resendApiKey,
      Number.isFinite(limitOverride) && limitOverride > 0 ? limitOverride : RECONCILE_LIMIT,
    ),
    fetchSuppressions(providers.resendApiKey),
  ])

  // `timezone` is selected because it is this carrier's fallback for anyone who
  // has not chosen one of their own. Before 0010 the column was written at
  // signup and read by nothing at all, while this job used a hard-coded
  // 'America/Los_Angeles' — so a Phoenix carrier's office manager had her quiet
  // hours measured on a clock an hour out from the one on her wall.
  const { data: carriers, error: carriersError } = await db
    .from('carriers')
    .select('id, legal_name, timezone')

  // A READ THAT FAILED IS NOT AN EMPTY FLEET. This used to discard the error and
  // fall through to `carriers ?? []`, so any failure here — a bad key, a
  // subrequest limit, a network blip — produced a run that iterated nobody,
  // reported `ok: true, carriers: 0, sent: 0`, and exited zero. The scheduled
  // job would have gone on "succeeding" every eight hours while every carrier
  // silently received nothing, which is precisely the failure this product
  // exists to prevent. Refuse loudly instead: the workflow fails, somebody
  // looks, and the message is still owed rather than quietly written off.
  if (carriersError) {
    return json({ error: 'could not read the carrier list', detail: carriersError.message }, 502)
  }
  // `held` is its own number, not folded into `skipped`. They are different
  // events with different fixes: skipped means we tried and could not, held
  // means we deliberately waited and will try again.
  //
  // `suppressed` is its own number for the same reason, and NOT folded into
  // `failed`. `failed` means we reached a provider and it refused — visible,
  // already loud, fix the provider. `suppressed` means the provider took the
  // message and dropped it, or would have: the address itself is the fault, the
  // fix is the address, and the message is still owed to the carrier. Counting
  // them together would put two problems with two different fixes behind one
  // number. It IS counted in the red: the workflow exits non-zero on it, because
  // a suppressed recipient that only showed up as a notice is a carrier quietly
  // receiving nothing, which is the failure this whole product exists to prevent.
  const summary = {
    carriers: 0,
    considered: 0,
    sent: 0,
    held: 0,
    skipped: 0,
    suppressed: reconciled.undelivered,
    failed: 0,
    logErrors: 0,
    /** True when the run stopped early on the Worker's subrequest budget. */
    exhausted: false,
  }

  carriers: for (const carrier of carriers ?? []) {
    summary.carriers++

    const [
      items,
      reminderItems,
      { data: members },
      { data: prefs },
      { data: catPrefs },
      { data: snoozeRows },
    ] = await Promise.all([
      loadDeadlines(db, carrier.id, today),
      // The owner's own reminders, loaded beside the regulations and kept in
      // their own list. They share the morning email and nothing else: no
      // citation, their own lead time, their own category on the way out.
      loadReminders(db, carrier.id, today),
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
        : [
            { category: 'compliance', channel: 'email', enabled: true },
            // His own reminders are in the default too. A person who has never
            // opened settings and types a reminder means to be told about it;
            // anything else makes the feature ship switched off and silent.
            { category: REMINDER_CATEGORY, channel: 'email', enabled: true },
          ]

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
        // AND ACTUALLY DELIVERED. `status` says the provider accepted it, which
        // it does even for an address it silently drops — so on its own this
        // filter treats a message nobody received as one already handled, and
        // the key stays spent forever. The reconciliation pass above marks those
        // rows `undelivered`; excluding them here is what lets the message go
        // again once the address is fixed. One rule, in one place: a log row
        // silences its key only when it represents a message that arrived.
        .neq('delivery_state', 'undelivered')
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
      // His own reminders, chosen the same way and with the same dedup
      // discipline. Separate call rather than more items in `selectForRecipient`
      // because the two carry different lead times — one array for the whole
      // category, one number per reminder — and because a DeadlineItem has a
      // citation that a reminder must never be given.
      const reminderCandidates = selectReminders({
        items: reminderItems,
        recipient: { userId: profile.id, email: profile.email },
        preferences,
        alreadySent,
      })

      summary.considered += candidates.length + reminderCandidates.length
      if (candidates.length === 0 && reminderCandidates.length === 0) continue

      // Quiet hours, finally obeyed.
      //
      // They were collected by the settings page and checked by a tested
      // function, and this job never called it — so the screen promised silence
      // it did not deliver. The critical breakthrough uses `isCritical`, which is
      // `deservesSms` under another name, so "already overdue or due tomorrow"
      // has exactly one definition and the settings copy stays true.
      const quiet = {
        fromMinutes: parseClockTime(profile.quiet_from),
        toMinutes: parseClockTime(profile.quiet_to),
        allowCritical: profile.quiet_allow_critical ?? true,
        nowLocalMinutes: minutesOfDayInZone(today, zone),
      }
      const { deliver, held } = splitForQuietHours(candidates, quiet)

      // REMINDERS NEVER BREAK THROUGH QUIET HOURS, whatever the breakthrough
      // setting says — hence `allowCritical: false` here and nowhere else.
      //
      // The breakthrough exists for a truck that cannot roll in the morning. A
      // line the owner typed for himself is not that, however late it is, and
      // waking him at 2am about his own note is exactly how a person decides to
      // turn everything off. Held, not dropped: no log row is written, so the
      // next run outside the window sends it.
      const reminderSplit = splitForQuietHours(reminderCandidates, {
        ...quiet,
        allowCritical: false,
      })

      // Counted, and written NOWHERE ELSE. A held message must not reach
      // notification_log: `dedup_key` is unique and `alreadySent` above matches
      // on the key alone, so a logged hold burns the key and the message never
      // arrives at all — not late, never. The hold is re-derived from scratch on
      // the next run, which is precisely what lets it eventually go out.
      summary.held += held.length + reminderSplit.held.length
      if (deliver.length === 0 && reminderSplit.deliver.length === 0) continue

      // One email carrying everything, rather than one per item. Fourteen
      // separate emails about fourteen expiring items is how we get muted, and
      // then the one that mattered arrives into silence.
      const emailItems = deliver.filter((c) => c.channel === 'email')
      // Reminders are email-only by construction (see `selectReminders`), so
      // there is nothing to filter here — and nothing can be silently dropped.
      const reminderEmails = reminderSplit.deliver
      if ((emailItems.length || reminderEmails.length) && profile.email) {
        const lines = emailItems.map((c) => {
          const when =
            c.item.status.standing === 'overdue'
              ? `OVERDUE since ${c.item.status.lastDue?.toISOString().slice(0, 10) ?? 'recently'}`
              : `due ${c.item.status.nextDue?.toISOString().slice(0, 10)} (${c.item.daysUntil} days)`
          return `• ${c.item.rule.title} — ${c.item.subjectLabel} — ${when}\n  ${c.item.rule.citation}`
        })

        // His own reminders go UNDER the deadlines, behind a heading that says
        // whose they are. Same email, because he has one morning; separate
        // block, because the lines above each carry a CFR citation and these
        // carry the words "Your reminder, not a rule" in the same slot. An
        // owner skimming an email on a phone must never read his own note as
        // something the government sent him.
        if (reminderEmails.length > 0) {
          lines.push(`YOUR OWN REMINDERS (not laws)\n${'—'.repeat(28)}`)
          for (const c of reminderEmails) lines.push(reminderEmailLine(c.item))
        }

        const overdueCount =
          emailItems.filter((c) => c.item.status.standing === 'overdue').length +
          reminderEmails.filter((c) => c.item.status.standing === 'overdue').length
        const total = emailItems.length + reminderEmails.length
        const subject = overdueCount
          ? `${overdueCount} overdue · ${carrier.legal_name}`
          : `${total} coming up · ${carrier.legal_name}`

        const result = await sendOrCeiling(
          {
            channel: 'email',
            to: profile.email,
            subject,
            // Worker var first, build-time value second — a literal key, so only
            // this one public string is replaced. There is no request origin to
            // build from here (a cron POST's origin is the scheduler's), so an
            // empty string would put a bare "/app" in somebody's email.
            body: `${lines.join('\n\n')}\n\nSee everything: ${get('PUBLIC_SITE_URL') ?? import.meta.env.PUBLIC_SITE_URL ?? ''}/app\n`,
          },
          guardConfig,
          providers,
          // The set, not the fetch. One lookup serves the whole run; send() does
          // the matching AFTER the guard, against the address the message is
          // actually going to — which on dev is the developer's, not the
          // carrier's.
          { suppressedEmails: suppression.list },
        )

        // Out of budget, so stop the whole run rather than grinding the
        // remaining carriers into the same wall. Held, not failed: no log row,
        // so every key here is unspent and the next run sends them.
        if (result === CEILING) {
          summary.held += emailItems.length + reminderEmails.length
          summary.exhausted = true
          break carriers
        }

        // FOLLOWING THE `held` PRECEDENT EXACTLY, and for the identical reason.
        //
        // A suppressed recipient writes NO log row. `dedup_key` is unique and
        // `alreadySent` above matches on the key, so a row written here spends
        // the key on a send that never happened — and the carrier can then never
        // be told about this deadline, not even after the address is fixed. Not
        // late. Never. The candidate is re-derived from scratch on the next run,
        // which is precisely what lets it eventually go out.
        //
        // Counted and then nothing else happens for email — but the SMS branch
        // below still runs, because a bounced mailbox is not a reason to stop
        // texting somebody about a truck that cannot roll tomorrow.
        if (result.status === 'suppressed') {
          summary.suppressed += emailItems.length + reminderEmails.length
        } else {
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
          //
          // ONE ROW PER ITEM, each under its OWN category. The reminder lines
          // rode in the same email, but they are not compliance news and the log
          // is what answers "why did we tell him that" a year later. Logging
          // them as 'compliance' would put an errand he typed into the record of
          // what we told him about federal law.
          const logged = await db.from('notification_log').upsert(
            [
              ...emailItems.map((c) => ({ dedupKey: c.dedupKey, category: 'compliance' })),
              ...reminderEmails.map((c) => ({
                dedupKey: c.dedupKey,
                category: REMINDER_CATEGORY,
              })),
            ].map((c) => ({
              carrier_id: carrier.id,
              user_id: profile.id,
              channel: 'email',
              category: c.category,
              destination: result.destination,
              subject,
              body: null,
              dedup_key: c.dedupKey,
              status: result.status,
              error: result.detail ?? null,
              // The handle the reconciliation pass works from. Written on every
              // attempt, including a retry of a row that was previously
              // undelivered — the columns are reset together so a stale
              // `undelivered` from the last attempt cannot outlive the id it
              // belonged to and keep freeing a key that is now genuinely spent.
              provider_message_id: result.providerMessageId ?? null,
              delivery_state: 'unknown',
              delivery_detail: null,
              delivery_checked_at: null,
            })),
            { onConflict: 'dedup_key' },
          )
          if (logged.error) {
            // A send we cannot record is worse than one we did not make: the
            // next run has no way to know it happened. Surfaced in the summary
            // rather than discarded.
            summary.logErrors++
          }
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
        const result = await sendOrCeiling(
          { channel: 'sms', to: profile.phone, body },
          guardConfig,
          providers,
        )
        if (result === CEILING) {
          summary.held += smsItems.length
          summary.exhausted = true
          break carriers
        }
        // No `suppressed` branch, because the channel cannot produce one.
        // Twilio refuses a number that replied STOP synchronously — HTTP 400,
        // error 21610 — so its version of a suppression arrives as `failed`,
        // already counted and already red. See the note in send.ts for the half
        // Twilio does share and why it is not reconciled here.
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
            // The Twilio sid, stored but not yet acted on. Recording it costs
            // nothing today and is the difference between being able to
            // reconcile SMS when 10DLC goes live and having no handle at all on
            // every message sent before somebody thought to add one.
            provider_message_id: result.providerMessageId ?? null,
            delivery_state: 'unknown',
            delivery_detail: null,
            delivery_checked_at: null,
          })),
          { onConflict: 'dedup_key' },
        )
        if (smsLogged.error) summary.logErrors++
      }
    }
  }

  return json({
    ok: true,
    ...summary,
    /** Messages whose delivery this run finally resolved, either way. */
    reconciled: reconciled.resolved,
    /**
     * Arrived, then marked as spam. Reported and NOT counted in `suppressed`:
     * the message was delivered, so nothing is owed, and re-sending to somebody
     * who pressed "spam" is the muting failure this product fears most.
     */
    complaints: reconciled.complained,
    /**
     * Whether the pre-send half was actually available. `unavailable` is not a
     * failure — we send anyway rather than letting one provider blip silence
     * every deadline warning — but it means this run leaned entirely on
     * reconciliation, which finds a bad address one run LATE. A run that keeps
     * saying this is one where half the defence is off.
     */
    suppressionList: !providers.resendApiKey ? 'off' : suppression.list ? 'ok' : 'unavailable',
  })
}

// A GET would let a browser preload or a link prefetch trigger the whole run.
export const GET: APIRoute = () => json({ error: 'use POST' }, 405)

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
