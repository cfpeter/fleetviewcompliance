-- Deleting a truck or a driver, and the evidence that must survive it.
--
-- WHY THIS IS IN THE DATABASE AND NOT ONLY IN THE PAGE. /app/vehicles/[id] and
-- /app/drivers/[id] now offer a delete, and they check first (see
-- src/lib/fleet/remove.ts). But `grant delete on drivers, vehicles to
-- authenticated` has been there since 0002, PostgREST publishes both tables, and
-- an app-side check in front of a privilege the role actually holds is a
-- suggestion. The thing being protected here is a federal retention obligation,
-- so it gets a trigger.
--
-- NO GRANT IS ADDED AND NONE IS REMOVED. `documents` and `compliance_records`
-- still have no DELETE privilege at all — 0003 and 0005 say why, and this
-- migration does not touch them. It also does not need to: neither table has a
-- foreign key to drivers or vehicles.
--
-- WHICH IS THE ACTUAL DANGER, and it is not a cascade. They are polymorphic
-- (subject_type, subject_id) with no FK, so deleting a driver SUCCEEDS and
-- leaves his medical card and his MVR pointing at an id that no longer names
-- anybody. Nothing errors. The file is still on disk and is no longer a file.
-- An auditor asking for the DQF of a driver who worked here two years ago gets
-- rows nobody can attach to a person.
--
-- The real cascades and set-nulls, all of them checked below:
--
--   load_assignments.driver_id/co_driver_id/tractor_id/trailer_id  SET NULL
--       (0009) — the load survives and forgets who drove it.
--   fuel_purchases.vehicle_id, jurisdiction_miles.vehicle_id       SET NULL
--       (0015) — IFTA receipts are kept four years and the return is computed
--       per unit. A null vehicle cannot be reconstructed.
--   pay_agreements.driver_id                                       CASCADE
--       (0016) — the rate he was promised, gone.
--   settlements.driver_id                                          RESTRICT
--       (0018, after a cascade destroyed a paid settlement and the lock trigger
--       fell through because the parent row was already gone). Already refuses;
--       checked here anyway so the owner gets a sentence instead of an FK error.
--   reminders.driver_id/vehicle_id                                 CASCADE
--       (0023) — DELIBERATELY NOT CHECKED. A reminder is the owner's own to-do
--       list, not evidence; 0023 argues the case and chose CASCADE knowingly.
--       The confirmation screen names the reminders that will go with the row.
--
-- WHAT IS STILL ALLOWED: a row carrying none of the above. The mistyped unit
-- number, the duplicate VIN, the driver somebody added twice. Those are the only
-- rows this feature exists for, and they are exactly the rows with nothing to
-- lose.

create or replace function fleet_row_has_no_history()
returns trigger
language plpgsql
-- SECURITY INVOKER, like every other integrity trigger in this schema. The
-- lookups below then run under the caller's own RLS, which is what we want: a
-- carrier deleting his own truck can see his own children, and nothing in here
-- can be turned into a way to count another tenant's rows.
security invoker
set search_path = public, pg_temp
as $$
declare
  held text;
begin
  -- THE CARRIER IS GONE, SO THIS IS A CASCADE, NOT A DELETE.
  --
  -- `drivers.carrier_id`/`vehicles.carrier_id` are ON DELETE CASCADE from
  -- carriers (0002). Postgres runs that as a delete on the child AFTER the
  -- parent row has already gone — the same fact 0018 documents, where a lock
  -- trigger read NULL out of a parent that no longer existed and fell open.
  -- Here it is load-bearing in the other direction: closing an account must not
  -- be refused by a guard meant for one truck, and a carrier's whole history
  -- going with the carrier is what "delete my account" means.
  if not exists (select 1 from carriers where id = old.carrier_id) then
    return old;
  end if;

  if tg_table_name = 'vehicles' then
    select string_agg(label, ', ' order by label) into held from (
      select 'compliance dates'::text as label where exists (
        select 1 from compliance_records
         where subject_type = 'vehicle' and subject_id = old.id)
      union all
      select 'documents' where exists (
        select 1 from documents
         where subject_type = 'vehicle' and subject_id = old.id)
      union all
      select 'loads' where exists (
        select 1 from load_assignments
         where tractor_id = old.id or trailer_id = old.id)
      union all
      select 'fuel receipts' where exists (
        select 1 from fuel_purchases where vehicle_id = old.id)
      union all
      select 'IFTA miles' where exists (
        select 1 from jurisdiction_miles where vehicle_id = old.id)
    ) as found;
  else
    select string_agg(label, ', ' order by label) into held from (
      select 'compliance dates'::text as label where exists (
        select 1 from compliance_records
         where subject_type = 'driver' and subject_id = old.id)
      union all
      select 'documents' where exists (
        select 1 from documents
         where subject_type = 'driver' and subject_id = old.id)
      union all
      select 'loads' where exists (
        select 1 from load_assignments
         where driver_id = old.id or co_driver_id = old.id)
      union all
      select 'settlements' where exists (
        select 1 from settlements where driver_id = old.id)
      union all
      select 'pay agreements' where exists (
        select 1 from pay_agreements where driver_id = old.id)
    ) as found;
  end if;

  if held is not null then
    -- 23001 is restrict_violation, which is what this is: a delete refused
    -- because something depends on the row. The message is read by whoever is
    -- debugging, not by the owner — the page has already said the same thing in
    -- his words and offered the status change instead.
    raise exception
      'cannot delete this % because it still has %; mark it not active instead',
      tg_table_name, held
      using errcode = '23001';
  end if;

  return old;
end;
$$;

create trigger vehicles_no_delete_with_history
  before delete on vehicles
  for each row execute function fleet_row_has_no_history();

create trigger drivers_no_delete_with_history
  before delete on drivers
  for each row execute function fleet_row_has_no_history();

comment on function fleet_row_has_no_history() is
  'Refuses to delete a driver or vehicle that still has compliance records, documents, load assignments, IFTA rows, settlements or pay agreements. documents and compliance_records have NO foreign key to these tables, so without this the delete succeeds and orphans the evidence 49 CFR 391.51(c) requires be kept. Cascades from carriers are allowed through on purpose.';
