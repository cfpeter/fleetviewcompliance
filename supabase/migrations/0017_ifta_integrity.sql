-- Two ways a quarter's miles could be silently wrong.
--
-- Both produce a filing that is short or doubled with no error anywhere, which
-- is the worst shape a bug can have in a table that feeds a tax return.

-- ---------------------------------------------------------------- 1. NULL is distinct

-- `unique (carrier_id, vehicle_id, period_start, jurisdiction)` does NOT do what
-- it looks like when vehicle_id is NULL.
--
-- In a standard Postgres unique constraint two NULLs are DISTINCT, so a row with
-- no truck never conflicts with the row it is meant to replace. An upsert then
-- inserts another copy on every save — no error, no warning — and a quarter's
-- miles double, then triple. Proven against this database: two identical rows,
-- no error raised.
--
-- NULLS NOT DISTINCT (Postgres 15+; this project is on 17.6) makes the
-- constraint mean what it reads as. Chosen over `vehicle_id not null` because a
-- carrier reconstructing a quarter from trip sheets legitimately has fleet-level
-- totals and no per-truck split, and forcing a truck would make them enter
-- nothing at all.
-- Looked up rather than named: Postgres generates this name and truncates it at
-- 63 characters, so the exact spelling is not something to guess at.
do $$
declare
  n text;
begin
  select conname into n
    from pg_constraint
   where conrelid = 'jurisdiction_miles'::regclass
     and contype = 'u';
  if n is not null then
    execute format('alter table jurisdiction_miles drop constraint %I', n);
  end if;
end
$$;

-- Deduplicate before re-adding, or the new constraint cannot be created. Keeps
-- the most recently updated row per key: a correction typed later is the one
-- the office meant.
delete from jurisdiction_miles a
 using jurisdiction_miles b
 where a.carrier_id = b.carrier_id
   and a.period_start = b.period_start
   and a.jurisdiction = b.jurisdiction
   and a.vehicle_id is not distinct from b.vehicle_id
   and (a.updated_at, a.id) < (b.updated_at, b.id);

alter table jurisdiction_miles
  add constraint jurisdiction_miles_period_key
  unique nulls not distinct (carrier_id, vehicle_id, period_start, jurisdiction);

-- ---------------------------------------------------------------- 2. free-text jurisdictions

-- `jurisdiction` was plain text with no constraint, so "Californa" stored
-- happily and then appeared as its own line on the return — splitting one
-- state's miles across two rows and reporting BOTH short.
--
-- The app already gates this, but a typo that only app code can catch is a typo
-- an import or a psql session walks straight past.
--
-- The 58 IFTA member jurisdictions: 48 contiguous US states plus DC, and 10
-- Canadian provinces. Alaska and Hawaii are deliberately absent — they are not
-- IFTA members.
create domain ifta_jurisdiction as text
  check (value in (
    'AL','AR','AZ','CA','CO','CT','DC','DE','FL','GA','IA','ID','IL','IN','KS',
    'KY','LA','MA','MD','ME','MI','MN','MO','MS','MT','NC','ND','NE','NH','NJ',
    'NM','NV','NY','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VA','VT',
    'WA','WI','WV','WY',
    'AB','BC','MB','NB','NL','NS','ON','PE','QC','SK'
  ));

alter table jurisdiction_miles
  alter column jurisdiction type ifta_jurisdiction using jurisdiction::ifta_jurisdiction;

alter table fuel_purchases
  alter column jurisdiction type ifta_jurisdiction using jurisdiction::ifta_jurisdiction;
