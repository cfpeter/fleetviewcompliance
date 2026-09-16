-- A message we recorded as sent, that nobody ever received.
--
-- THE BUG. Resend's `POST /emails` returns HTTP 200 with `{"id": "..."}` for an
-- address it has SUPPRESSED, and then drops the message. `send()` checked
-- `res.ok`, wrote `status = 'sent'`, and the digest reported a clean run. A
-- carrier stops getting deadline warnings and nobody — not him, not us — ever
-- finds out. For a product whose entire promise is "we tell you before it
-- bites", a silent delivery failure is the worst outcome in the system: every
-- other failure at least announces itself.
--
-- WHAT WAS MEASURED against the live API, and what it forces:
--   * `POST /emails` carries NO delivery signal whatsoever. Acceptance only.
--   * `GET /emails/{id}` carries `last_event`. On a known-suppressed address:
--     `queued` at +0s, then `suppressed` at +2s and +6s. Knowable in seconds,
--     but NOT synchronously — so the answer has to be fetched on a LATER pass,
--     which means the message id must be on the row. Hence provider_message_id.
--   * `GET /suppressions` exists and is worth checking before sending, but it is
--     INCOMPLETE: an address that reliably reports `suppressed` from the id
--     lookup does not appear on it. A pre-send list check therefore cannot be
--     the only defence, which is why this migration exists at all rather than
--     the fix being "look at the list first".
--
-- The matching TypeScript is src/lib/notify/suppression.ts and the pass that
-- writes these columns is at the top of src/pages/api/cron/digest.ts.

-- --------------------------------------------------------------- the columns

-- The provider's own id for the message. Null for rows written before this
-- migration, for anything skipped or failed, and for the no-provider sink — all
-- of which are correctly un-reconcilable, and the partial index below excludes
-- them rather than making the job ask about ids that do not exist.
alter table notification_log add column provider_message_id text;

-- DELIBERATELY NOT `status`, and this is the whole point of the migration.
--
-- `status` records what the send ATTEMPT returned, at the moment it returned it.
-- Resend genuinely did accept the message; overwriting that column later would
-- destroy the only record of what we actually observed and would make the log
-- disagree with itself about a fact that was true. Delivery is a SECOND, later
-- fact about the same row — whether the thing the provider accepted ever reached
-- a person — and it gets its own column so both can be true at once.
--
--   unknown      — not resolved yet, or an event we do not recognise. The
--                  default, because a row starts life un-reconciled and a row we
--                  have never asked about must not read as delivered.
--   delivered    — the provider says it landed.
--   undelivered  — bounced, suppressed, cancelled. It did NOT land.
--   complained   — it landed, and the reader marked it as spam.
--
-- `undelivered` and `complained` are kept apart because they demand opposite
-- responses. An undelivered message should go again once the address is fixed;
-- re-sending to somebody who pressed "spam" is how a sending domain is burned,
-- and it is the exact muting failure notification_preferences exists to avoid.
alter table notification_log
  add column delivery_state text not null default 'unknown';

-- The provider's own word — `bounced` and `suppressed` both mean undelivered and
-- have entirely different fixes (their mailbox versus our account's list). A
-- support question that can only be answered as "undelivered" cannot be acted on.
alter table notification_log add column delivery_detail text;

-- When we last asked. Without it there is no way to distinguish "we looked and
-- it was still in flight" from "we have never looked" — and those are the two
-- readings of `unknown` that matter most when somebody asks why a warning never
-- arrived.
alter table notification_log add column delivery_checked_at timestamptz;

-- A spelling nobody expected is a state nothing knows how to count, and it would
-- land in the log looking like a real answer. The set is small and closed;
-- widening it is a migration, which is the right amount of friction.
alter table notification_log
  add constraint notification_log_delivery_state_valid
  check (delivery_state in ('unknown', 'delivered', 'undelivered', 'complained'));

-- --------------------------------------------------------------- the scan

-- THE BOUND. The reconciliation pass runs at the start of every digest, three
-- times a day, forever — so the query behind it must not grow with the log. This
-- partial index holds ONLY the rows that pass could act on: email, unresolved,
-- and actually carrying an id to ask about. Everything else — every delivered
-- row, every SMS, every skip — is not in the index at all, so the index stays
-- roughly the size of one day's unresolved sends however large the table gets.
--
-- `sent_at desc` matches the job's ordering: newest first, because a delivery
-- failure found today is one somebody can still do something about.
create index notification_log_unreconciled_idx
  on notification_log (sent_at desc)
  where delivery_state = 'unknown'
    and provider_message_id is not null
    and channel = 'email';

-- --------------------------------------------------------------- RLS / grants

-- Nothing to do, and it is worth writing down WHY rather than leaving the next
-- reader to wonder whether it was forgotten.
--
-- RLS: 0008 already has ENABLE + FORCE on notification_log and a select-only
-- policy scoped to the reader's carriers. Policies are per-ROW, not per-column,
-- so columns added here are covered by notification_log_read exactly as the
-- existing ones are. A new policy would be a second rule about the same rows.
--
-- GRANTS: 0008's `grant select on notification_log to authenticated` is a
-- TABLE-level grant, which in Postgres covers columns added afterwards. (A
-- column-list grant — the shape 0021 uses on carrier_claims, to keep `code_hash`
-- out of reach — would NOT, and would need re-granting here. This table has no
-- such column: the log is evidence the carrier is entitled to read.)
--
-- Still no INSERT or UPDATE for `authenticated`. The log is evidence of what we
-- sent; the digest writes it with the service key, and a carrier who could edit
-- his own delivery record could edit away the proof that we told him.
