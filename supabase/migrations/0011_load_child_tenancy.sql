-- A child row could be attached to another carrier's parent.
--
-- The RLS policies on load_stops and load_assignments check `carrier_id`, which
-- stops a user writing rows labelled as another carrier's. What they do NOT
-- check is that `load_id` points at a load belonging to that same carrier.
--
-- So a crafted POST carrying MY carrier_id and YOUR load_id passes the policy —
-- the row is mine by the policy's reckoning — and lands on your load. RLS on the
-- loads table then hides the result from me, which is worse rather than better:
-- I have written into your record and cannot see what I did.
--
-- `compliance_records` already guards exactly this with a trigger. These two
-- tables were written later and did not get the same treatment.

create or replace function load_child_belongs_to_carrier()
returns trigger
language plpgsql
-- INVOKER, so the lookup is subject to the caller's own RLS. A load in another
-- carrier is simply invisible and the check fails for the right reason — the
-- same shape as documents_subject_belongs_to_carrier().
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from loads
     where id = new.load_id
       and carrier_id = new.carrier_id
  ) then
    raise exception 'load % does not belong to carrier %', new.load_id, new.carrier_id;
  end if;
  return new;
end;
$$;

create trigger load_stops_parent_check
  before insert or update on load_stops
  for each row execute function load_child_belongs_to_carrier();

create trigger load_assignments_parent_check
  before insert or update on load_assignments
  for each row execute function load_child_belongs_to_carrier();

-- While here: nothing in the database required a load to be identifiable.
-- Both reference numbers are nullable with no constraint, so an import or a
-- psql session could create a row that the search box can never return and that
-- no dispatcher can name on the phone. The rule lived in two page handlers only.
alter table loads
  add constraint loads_identifiable
  check (num_nonnulls(load_number, broker_reference) > 0);
