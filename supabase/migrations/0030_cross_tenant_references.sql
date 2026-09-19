-- A load could point at another carrier's customer. An assignment could point
-- at another carrier's driver or unit.
--
-- 0011 closed the parent side: a stop or an assignment must hang off a load in
-- the same carrier. It left the OTHER foreign keys alone. `loads.customer_id`,
-- `load_assignments.driver_id`, `co_driver_id`, `tractor_id` and `trailer_id`
-- are plain references, and a foreign-key check runs as the table owner, not
-- as the caller — so RLS on customers, drivers and vehicles does not apply to
-- it. A crafted POST carrying MY carrier_id and YOUR customer id passes the
-- policy on loads and the FK on customers both, and the row is written.
--
-- Proved on the dev database on 2026-09-18: `POST /app/loads/new` with
-- `customer_id` set to a customer of a different carrier created the load.
-- Nothing leaked back — RLS hides the customer's name from the page — but the
-- record now says that carrier's broker booked this carrier's load, and the
-- page handler was the only thing that could have stopped it. A rule that lives
-- only in a page handler is a rule that a direct PostgREST call skips.
--
-- Same shape as 0011: SECURITY INVOKER, so the lookup is subject to the
-- caller's own RLS and a row in another carrier is simply invisible.

create or replace function load_customer_belongs_to_carrier()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.customer_id is null then
    return new;
  end if;
  if not exists (
    select 1 from customers
     where id = new.customer_id
       and carrier_id = new.carrier_id
  ) then
    raise exception 'customer % does not belong to carrier %', new.customer_id, new.carrier_id;
  end if;
  return new;
end;
$$;

create trigger loads_customer_check
  before insert or update of customer_id, carrier_id on loads
  for each row execute function load_customer_belongs_to_carrier();

create or replace function assignment_roster_belongs_to_carrier()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.driver_id is not null and not exists (
    select 1 from drivers where id = new.driver_id and carrier_id = new.carrier_id
  ) then
    raise exception 'driver % does not belong to carrier %', new.driver_id, new.carrier_id;
  end if;
  if new.co_driver_id is not null and not exists (
    select 1 from drivers where id = new.co_driver_id and carrier_id = new.carrier_id
  ) then
    raise exception 'driver % does not belong to carrier %', new.co_driver_id, new.carrier_id;
  end if;
  if new.tractor_id is not null and not exists (
    select 1 from vehicles where id = new.tractor_id and carrier_id = new.carrier_id
  ) then
    raise exception 'vehicle % does not belong to carrier %', new.tractor_id, new.carrier_id;
  end if;
  if new.trailer_id is not null and not exists (
    select 1 from vehicles where id = new.trailer_id and carrier_id = new.carrier_id
  ) then
    raise exception 'vehicle % does not belong to carrier %', new.trailer_id, new.carrier_id;
  end if;
  return new;
end;
$$;

create trigger load_assignments_roster_check
  before insert or update on load_assignments
  for each row execute function assignment_roster_belongs_to_carrier();
