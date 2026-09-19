-- The two anon doors, taught about reminders. Nothing else about them changes.
--
-- 0036 is the file to read first: each function takes the token and nothing
-- else, the WHERE clause IS the authorisation, and the write reaches one table
-- the rule engine ignores. All of that still holds. What is added here is that
-- a link may also name the owner's own reminders (0038), and the driver has to
-- be told what they are or the question is unanswerable.
--
-- DROP AND RECREATE, not `create or replace`: `driver_link_view` gains a column
-- and Postgres refuses to replace a function whose return type changed. The
-- grants go with the old function, so they are written again at the foot.

drop function if exists driver_link_view(text);

-- What the driver sees, which is still almost nothing.
--
-- THE REMINDER TITLES ARE THE ONE PIECE OF FREE TEXT ON THIS PAGE, and they are
-- there because a question with no words is not a question: "send me a photo"
-- of what? The title is the owner's own sentence, chosen by him for this link,
-- the same way the message he sends is. It is worth being clear-eyed about it:
-- this is a URL that gets forwarded and screenshotted, so a title carries as far
-- as the link does. Everything else the page could say — his licence number, the
-- dates on file, the carrier's legal name — is still withheld.
--
-- The reminder rows are NOT re-filtered on `completed_at` here. The owner asked
-- while it was open; a question that vanishes between the text message and the
-- tap is worse than one the owner has since closed and can simply reject. The
-- carrier join stays, because tenancy is never a matter of opinion.
--
-- 49 CFR 40.307(g) is untouched by any of this: reminders are the owner's own
-- rows and carry no anchor, so there is no path from here to a return-to-duty
-- schedule. The two guards in 0036 stand exactly as they were.
create or replace function driver_link_view(p_token text)
returns table (first_name text, asks text[], on_file text[], reminders jsonb)
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
    returning l.driver_id, l.carrier_id, l.asks, l.reminder_ids
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
    ),
    -- Oldest due first, so the thing he is most behind on is the first box.
    coalesce(
      (select jsonb_agg(jsonb_build_object('id', r.id, 'title', r.title) order by r.due_on)
         from reminders r
        where r.id = any (live.reminder_ids)
          and r.carrier_id = live.carrier_id),
      '[]'::jsonb
    )
  from live
  join drivers d on d.id = live.driver_id and d.carrier_id = live.carrier_id
$$;

-- ---------------------------------------------------------------- the write

-- One statement, still: spend the link and record the claim.
--
-- THE PAYLOAD IS NARROWED TO WHAT THIS LINK ASKED FOR, and that now means two
-- lists rather than one. A reminder answer arrives under `reminder:<uuid>`, so
-- the allowed set is the asks plus the link's own reminder ids spelled the same
-- way. A crafted POST naming another carrier's reminder is not refused — the
-- key is never read, which is the only version of that defence with no list to
-- keep up to date.
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
    returning l.id, l.carrier_id, l.driver_id, l.asks, l.reminder_ids
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
        where e.k = any (spent.asks)
           or e.k = any (
                array(select 'reminder:' || t.r::text from unnest(spent.reminder_ids) as t(r))
              )),
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
