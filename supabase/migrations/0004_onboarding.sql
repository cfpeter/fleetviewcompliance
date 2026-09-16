-- Creating a carrier.
--
-- `authenticated` has no INSERT on carriers or memberships. A signed-in user
-- cannot write either row directly, because "who may join which carrier" is a
-- rule, and a rule expressed as two separate table grants is a rule that can be
-- half-applied — a carrier with no members, or worse, a membership row pointing
-- at somebody else's carrier.
--
-- One function, one transaction, one place to read.

create or replace function create_carrier(
  p_dot_number text,
  p_legal_name text,
  p_dba_name   text default null,
  p_timezone   text default 'America/Los_Angeles'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_carrier_id uuid;
  v_user_id    uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'not signed in';
  end if;

  if coalesce(trim(p_legal_name), '') = '' then
    raise exception 'legal_name is required';
  end if;

  -- One account per DOT number. Two carriers claiming the same USDOT is a
  -- support problem we would rather discover here than later.
  insert into carriers (dot_number, legal_name, dba_name, timezone)
  values (nullif(trim(p_dot_number), ''), trim(p_legal_name),
          nullif(trim(p_dba_name), ''), p_timezone)
  returning id into v_carrier_id;

  insert into memberships (user_id, carrier_id, role)
  values (v_user_id, v_carrier_id, 'owner');

  return v_carrier_id;
end;
$$;

revoke all on function create_carrier(text, text, text, text) from public, anon;
grant execute on function create_carrier(text, text, text, text) to authenticated;
