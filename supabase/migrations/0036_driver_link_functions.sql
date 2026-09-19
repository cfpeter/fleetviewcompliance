-- The only two doors an anonymous driver has, and everything they refuse.
--
-- BEFORE THIS FILE, the `anon` role could reach exactly six functions — the
-- share functions from 0013/0026 — and every one of them is read-only.
-- tests/share-scope.test.ts asserts they are the only door. This file adds two
-- more and one of them WRITES, so it is worth being explicit about what keeps
-- that safe:
--
--   - Each takes the token and NOTHING ELSE. No carrier id, no driver id, no
--     table name. The same property that makes record_share_view safe. A
--     signature like driver_link_submit(token, driver_id, ...) would hand the
--     caller something to tamper with, and "we only ever pass the right one"
--     is a statement about our page, not about the endpoint.
--   - The WHERE clause IS the authorisation. It is not a filter applied after
--     an authorisation step; there is no authorisation step.
--   - The write reaches ONE table — driver_submissions — which the rule engine,
--     the dashboard, the digest and the proof page all ignore. See 0035.
--
-- SECURITY DEFINER because the caller has no session at all. The definer is the
-- migration role, which owns these tables; FORCE row level security is
-- effectively inert for it, which is exactly why these functions have to do
-- their own fencing and why they are this narrow.

-- ---------------------------------------------------------------- the read

-- What the driver sees, which is almost nothing.
--
-- HIS FIRST NAME AND THE LIST OF THINGS TO SEND. Not his licence number, not
-- the dates already on file, not the carrier's legal name — the message that
-- carried the link names the carrier, and the message is not the thing that
-- gets forwarded, screenshotted or left on a phone somebody else picks up.
--
-- `on_file` is a list of asks we already hold SOMETHING for. A boolean, never a
-- value: enough for him to tell whether the office is missing it, not enough to
-- read his own file off a link.
--
-- 49 CFR 40.307(g) — THE ONE THAT IS NOT A PREFERENCE. The employer, the SAP and
-- any service agent are forbidden from showing a driver his return-to-duty
-- follow-up testing schedule. docs/REQUIREMENTS.md:280, compliance-part40.md:64,
-- driver-anchors.ts:136 and federal-driver.ts:226 all say the same thing and all
-- say it the same way: in the policy, not the UI. Two things enforce it here:
--
--   1. `driver_links_asks_known` in 0034 refuses to store an ask outside the six
--      below, so the key cannot arrive.
--   2. This function reads nothing but the asks. Even a hand-written row with a
--      forbidden ask would get past nothing, because there is no branch for it.
--
-- share_anchors() must never be reused for this. Its driver_file branch returns
-- EVERY subject_type='driver' anchor for the driver, including
-- return_to_duty_test_date — correct for a broker holding a proof link, illegal
-- for the driver himself.
--
-- VOLATILE, and it stamps `opened_at`. One round trip for the page instead of
-- two, and it answers "did he ever get it" when a card lapses and the driver
-- says nobody asked him. Best effort: the stamp is part of the same statement,
-- so a link that resolves is a link that is recorded as opened.
create or replace function driver_link_view(p_token text)
returns table (first_name text, asks text[], on_file text[])
language sql
security definer
set search_path = public, pg_temp
as $$
  with live as (
    update driver_links l
       set opened_at = coalesce(l.opened_at, now())
     where l.token_hash = share_token_hash(p_token)
       and l.revoked_at is null
       and l.used_at is null
       and l.expires_at > now()
    returning l.driver_id, l.carrier_id, l.asks
  )
  select
    d.first_name,
    live.asks,
    coalesce(
      array(
        select t.ask from unnest(live.asks) as t(ask)
         where (t.ask = 'cdl' and d.cdl_expires_on is not null)
            or (t.ask = 'medical' and exists (
                  select 1 from current_compliance_anchors a
                   where a.subject_type = 'driver' and a.subject_id = live.driver_id
                     and a.anchor_key = 'medical_certificate_expires'))
            or (t.ask = 'spe' and exists (
                  select 1 from current_compliance_anchors a
                   where a.subject_type = 'driver' and a.subject_id = live.driver_id
                     and a.anchor_key = 'spe_certificate_expiry'))
            or (t.ask = 'intracity' and exists (
                  select 1 from current_compliance_anchors a
                   where a.subject_type = 'driver' and a.subject_id = live.driver_id
                     and a.anchor_key = 'intracity_zone_exemption_issued'))
            or (t.ask = 'diabetes' and exists (
                  select 1 from current_compliance_anchors a
                   where a.subject_type = 'driver' and a.subject_id = live.driver_id
                     and a.anchor_key = 'insulin_treated_diabetes_assessment'))
            or (t.ask = 'vision' and exists (
                  select 1 from current_compliance_anchors a
                   where a.subject_type = 'driver' and a.subject_id = live.driver_id
                     and a.anchor_key = 'alternative_vision_evaluation'))
      ),
      array[]::text[]
    )
  from live
  join drivers d on d.id = live.driver_id and d.carrier_id = live.carrier_id
$$;

-- ---------------------------------------------------------------- the write

-- One statement: spend the link and record the claim.
--
-- THE SPEND AND THE INSERT ARE THE SAME STATEMENT, and that closes a race the
-- predecessor had. It read revoked_at and expires_at in a SELECT, then
-- re-checked only consumed_at on the UPDATE — so a link the owner revoked in
-- between still consumed and still recorded a submission. Here the full
-- predicate is on the UPDATE, and the INSERT reads from its RETURNING, so a link
-- that is revoked, expired or already spent produces no row anywhere.
--
-- THE PAYLOAD IS NARROWED TO WHAT THIS LINK ASKED FOR. A crafted POST carrying
-- keys the owner never ticked is not refused — those keys are never read, which
-- is the only version of that defence with no list to keep up to date. The same
-- doctrine readTypedDates() applies on the dashboard.
--
-- Returns the submission id, or no row at all. No row means the link was dead,
-- and the page says the same thing for that as for a token that never existed.
create or replace function driver_link_submit(
  p_token text,
  p_payload jsonb,
  p_keys text[],
  p_ip_hash text
)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  with spent as (
    update driver_links l
       set used_at = now()
     where l.token_hash = share_token_hash(p_token)
       and l.revoked_at is null
       and l.used_at is null
       and l.expires_at > now()
    returning l.id, l.carrier_id, l.driver_id, l.asks
  )
  insert into driver_submissions (
    carrier_id, driver_link_id, driver_id, payload, storage_keys, ip_hash
  )
  select
    spent.carrier_id,
    spent.id,
    spent.driver_id,
    coalesce(
      -- `as e(k, v)` because jsonb_each names its columns `key` and `value`,
      -- and `key` is a reserved-ish word that reads badly next to `any()`.
      (select jsonb_object_agg(e.k, e.v)
         from jsonb_each(coalesce(p_payload, '{}'::jsonb)) as e(k, v)
        where e.k = any(spent.asks)),
      '{}'::jsonb
    ),
    coalesce(p_keys, array[]::text[]),
    p_ip_hash
  from spent
  returning id
$$;

-- ---------------------------------------------------------------- the grants

revoke all on function driver_link_view(text) from public;
revoke all on function driver_link_submit(text, jsonb, text[], text) from public;

grant execute on function driver_link_view(text) to anon, authenticated;
grant execute on function driver_link_submit(text, jsonb, text[], text) to anon, authenticated;
