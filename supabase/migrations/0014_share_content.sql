-- Content for an anonymous reader.
--
-- 0013 resolved a token to ids and stopped, on the theory that the caller would
-- read content "through views". It cannot: `anon` has no grant on carriers,
-- drivers or compliance_records, and correctly so — revoking anon is a floor
-- beneath the policies, not a formality.
--
-- So the content comes from SECURITY DEFINER functions, and every one of them
-- takes THE TOKEN AND NOTHING ELSE. That is the important property. A function
-- taking (token, driver_id) would let the holder of a valid carrier_summary
-- token read any driver by guessing ids; a function taking only a token cannot
-- be pointed at anything its own scope does not already allow.
--
-- Scope is therefore enforced HERE, in the database, not in the page. A mistake
-- in an .astro file cannot widen what a token grants.

/** Carrier identity. Safe for both scopes — it is on the public federal record anyway. */
create or replace function share_carrier(p_token text)
returns table (legal_name text, dba_name text, dot_number text, phy_city text, phy_state text)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select c.legal_name, c.dba_name, c.dot_number, c.phy_city, c.phy_state
    from share_links s
    join carriers c on c.id = s.carrier_id
   where s.token = p_token
     and s.revoked_at is null
     and s.expires_at > now()
$$;

/**
 * The driver named by a driver_file token. Returns nothing for any other scope.
 *
 * `s.scope = 'driver_file'` is the load-bearing line: without it a
 * carrier_summary token would read a driver row, and the page would have no way
 * to know it had been handed one.
 */
create or replace function share_driver(p_token text)
returns table (id uuid, first_name text, last_name text, cdl_number text, cdl_state text,
               cdl_expires_on date, hired_on date)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select d.id, d.first_name, d.last_name, d.cdl_number, d.cdl_state,
         d.cdl_expires_on, d.hired_on
    from share_links s
    join drivers d on d.id = s.subject_id and d.carrier_id = s.carrier_id
   where s.token = p_token
     and s.scope = 'driver_file'
     and s.revoked_at is null
     and s.expires_at > now()
$$;

/**
 * Compliance anchors, scoped to exactly what the token covers.
 *
 * driver_file      -> that one driver's anchors, and nothing else
 * carrier_summary  -> carrier-level anchors only, never any driver's
 *
 * The scope test is inside the WHERE clause rather than applied by the caller,
 * so there is no arrangement of page code that can read across it.
 */
create or replace function share_anchors(p_token text)
returns table (subject_type document_subject, subject_id uuid, anchor_key text, occurred_on date)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select a.subject_type, a.subject_id, a.anchor_key, a.occurred_on
    from share_links s
    join current_compliance_anchors a on a.carrier_id = s.carrier_id
   where s.token = p_token
     and s.revoked_at is null
     and s.expires_at > now()
     and (
       (s.scope = 'driver_file'
          and a.subject_type = 'driver'
          and a.subject_id = s.subject_id)
       or
       (s.scope = 'carrier_summary'
          and a.subject_type = 'carrier')
     )
$$;

/**
 * Fleet size for a carrier_summary. Counts only — never names.
 *
 * A broker checking whether to haul for somebody has a legitimate interest in
 * how big the fleet is. He has no business knowing who drives for it, so this
 * returns integers and there is no function that would give him more.
 */
create or replace function share_fleet_counts(p_token text)
returns table (active_drivers int, power_units int, trailers int)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    (select count(*)::int from drivers d
      where d.carrier_id = s.carrier_id and d.status = 'active'),
    (select count(*)::int from vehicles v
      where v.carrier_id = s.carrier_id and v.kind = 'power_unit' and v.status <> 'sold'),
    (select count(*)::int from vehicles v
      where v.carrier_id = s.carrier_id and v.kind = 'trailer' and v.status <> 'sold')
  from share_links s
  where s.token = p_token
    and s.scope = 'carrier_summary'
    and s.revoked_at is null
    and s.expires_at > now()
$$;

revoke all on function share_carrier(text) from public;
revoke all on function share_driver(text) from public;
revoke all on function share_anchors(text) from public;
revoke all on function share_fleet_counts(text) from public;

grant execute on function share_carrier(text)      to anon, authenticated;
grant execute on function share_driver(text)       to anon, authenticated;
grant execute on function share_anchors(text)      to anon, authenticated;
grant execute on function share_fleet_counts(text) to anon, authenticated;
