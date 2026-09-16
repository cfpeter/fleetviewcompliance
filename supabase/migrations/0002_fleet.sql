-- The fleet: drivers, vehicles, terminals.
--
-- Every table here carries carrier_id and the same four-line RLS block. The
-- repetition is deliberate — a helper that generated these policies would make
-- it harder to read what a given table actually allows, and this is the code
-- where that must be obvious.

-- ------------------------------------------------- shared vocabulary

-- Where a fact came from. "The carrier told us" and "the federal record said"
-- are different claims and must never be merged: when the owner says 9 trucks
-- and FMCSA says 11, we need to be able to show him both and ask.
create type record_source as enum ('owner', 'fmcsa', 'import');

create type driver_status as enum ('active', 'inactive', 'terminated');
create type vehicle_kind  as enum ('power_unit', 'trailer');
create type vehicle_status as enum ('active', 'out_of_service', 'sold', 'inactive');

-- ---------------------------------------------------------------- drivers

create table drivers (
  id               uuid primary key default gen_random_uuid(),
  carrier_id       uuid not null references carriers (id) on delete cascade,
  first_name       text not null,
  last_name        text not null,
  -- Nullable on purpose. The office manager types what she has; a required
  -- field she cannot fill is a field she invents a value for.
  date_of_birth    date,
  phone            text,
  email            text,
  cdl_number       text,
  cdl_state        text,
  cdl_expires_on   date,
  hired_on         date,
  terminated_on    date,
  status           driver_status not null default 'active',
  source           record_source not null default 'owner',
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index drivers_carrier_idx on drivers (carrier_id) where status = 'active';

-- ---------------------------------------------------------------- vehicles

create table vehicles (
  id              uuid primary key default gen_random_uuid(),
  carrier_id      uuid not null references carriers (id) on delete cascade,
  kind            vehicle_kind not null default 'power_unit',
  unit_number     text,
  vin             text,
  make            text,
  model           text,
  model_year      int,
  -- Nullable, and the engine treats NULL as fully regulated rather than exempt.
  -- A truck of unknown weight must fail toward more compliance, not less.
  gvwr_lbs        int,
  plate           text,
  plate_state     text,
  status          vehicle_status not null default 'active',
  source          record_source not null default 'owner',
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index vehicles_carrier_idx on vehicles (carrier_id) where status = 'active';

-- A VIN is unique per carrier, but only when present, and only among vehicles
-- that have not been sold: the same truck can legitimately be re-added.
create unique index vehicles_vin_unique
  on vehicles (carrier_id, vin)
  where vin is not null and status <> 'sold';

comment on column vehicles.gvwr_lbs is
  'NULL means unknown, NOT exempt. Every weight-conditional rule must treat NULL as regulated.';

-- ---------------------------------------------------------------- terminals

-- California's terminal inspection programme attaches to a place, not a truck,
-- so terminals are a first-class entity rather than an address on the carrier.
create table terminals (
  id           uuid primary key default gen_random_uuid(),
  carrier_id   uuid not null references carriers (id) on delete cascade,
  name         text not null,
  street       text,
  city         text,
  state        text,
  zip          text,
  created_at   timestamptz not null default now()
);

create index terminals_carrier_idx on terminals (carrier_id);

-- ---------------------------------------------------------------- updated_at

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger drivers_touch  before update on drivers
  for each row execute function touch_updated_at();
create trigger vehicles_touch before update on vehicles
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- RLS

alter table drivers   enable row level security;
alter table drivers   force  row level security;
alter table vehicles  enable row level security;
alter table vehicles  force  row level security;
alter table terminals enable row level security;
alter table terminals force  row level security;

revoke all on drivers, vehicles, terminals from public, anon, authenticated;
grant select, insert, update, delete on drivers   to authenticated;
grant select, insert, update, delete on vehicles  to authenticated;
grant select, insert, update, delete on terminals to authenticated;

-- USING governs which existing rows are visible or modifiable.
-- WITH CHECK governs what a row may look like after the write — without it a
-- user could UPDATE a row they can see and set carrier_id to someone else's,
-- moving the record out of their own tenancy and into another.
create policy drivers_rw on drivers
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create policy vehicles_rw on vehicles
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create policy terminals_rw on terminals
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));
