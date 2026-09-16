-- Loads, stops and assignment.
--
-- Two modelling decisions carry most of the weight here, and both are places
-- other products in this category are documented to have gone wrong.

-- ---------------------------------------------------------------- customers

create table customers (
  id            uuid primary key default gen_random_uuid(),
  carrier_id    uuid not null references carriers (id) on delete cascade,
  name          text not null,
  mc_number     text,
  dot_number    text,
  contact_name  text,
  phone         text,
  email         text,
  billing_email text,
  billing_address text,
  -- Small carriers care intensely about who pays slowly. It belongs on the
  -- customer, where it informs the decision to take the load at all.
  days_to_pay   int,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index customers_carrier_idx on customers (carrier_id);

-- ---------------------------------------------------------------- loads

-- DECISION ONE: two independent state machines, not one status column.
--
-- A load can be delivered and unbilled. Forcing those onto one linear status is
-- the documented cause of "the reports don't match" complaints across this
-- whole category — the operational truth and the financial truth move at
-- different speeds and neither is a stage of the other.
create type load_status as enum (
  'quoted', 'booked', 'assigned', 'dispatched', 'at_shipper',
  'loaded', 'in_transit', 'at_consignee', 'delivered', 'pod_received'
);

-- Exceptions sit ALONGSIDE the status, never replace it. A detained load is
-- still at_shipper; losing that on the way into 'detained' loses where the truck
-- actually is.
create type load_exception as enum ('detained', 'breakdown', 'late', 'cancelled', 'tonu');

create type billing_status as enum (
  'not_ready', 'ready_to_invoice', 'invoiced', 'submitted_to_factor',
  'funded', 'paid', 'closed', 'short_paid', 'in_dispute', 'written_off'
);

create table loads (
  id             uuid primary key default gen_random_uuid(),
  carrier_id     uuid not null references carriers (id) on delete cascade,

  -- Ours, for our own paperwork.
  load_number    text,
  customer_id    uuid references customers (id) on delete set null,
  -- THEIRS. Carriers search by this, because it is the number printed on the
  -- rate confirmation lying on the desk in front of them.
  broker_reference text,

  status         load_status not null default 'booked',
  exception      load_exception,
  billing        billing_status not null default 'not_ready',

  -- Money in integer cents. Never floats.
  linehaul_cents      int,
  fuel_surcharge_cents int,
  accessorials_cents  int,

  equipment_type text,
  commodity      text,
  weight_lbs     int,
  pieces         int,
  temperature_f  int,
  hazmat         boolean not null default false,

  -- DECISION TWO: detention terms as STRUCTURED FIELDS, not prose in a PDF.
  -- Whether the broker requires pre-approval is where small carriers lose money,
  -- and it cannot be acted on while it is a sentence in an attachment.
  free_hours_pickup   int,
  free_hours_delivery int,
  detention_rate_cents int,
  detention_requires_preapproval boolean,

  factored       boolean not null default false,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index loads_carrier_idx on loads (carrier_id, status);
-- Both reference numbers are searchable, because the one in the dispatcher's
-- hand could be either.
create index loads_refs_idx on loads (carrier_id, broker_reference, load_number);

-- ---------------------------------------------------------------- stops

-- An ordered list, never origin/destination columns. Multi-stop is the normal
-- case for a small carrier, not an upgrade.
create type stop_type as enum ('pickup', 'delivery', 'drop', 'hook', 'fuel', 'scale');

-- Hard appointment vs first-come-first-served is not cosmetic: a missed hard
-- appointment means a refused load or detention, while FCFS is a window. The
-- detention clock and the "running late" alert both key off this.
create type appointment_type as enum ('hard', 'fcfs');

create table load_stops (
  id             uuid primary key default gen_random_uuid(),
  carrier_id     uuid not null references carriers (id) on delete cascade,
  load_id        uuid not null references loads (id) on delete cascade,
  sequence       int not null,

  stop_type      stop_type not null default 'pickup',
  company_name   text,
  street         text,
  city           text,
  state          text,
  zip            text,
  contact_name   text,
  phone          text,

  appointment_type appointment_type,
  window_start   timestamptz,
  window_end     timestamptz,
  arrived_at     timestamptz,
  departed_at    timestamptz,

  -- PO, pickup, delivery, BOL, seal. One free field rather than five columns:
  -- every broker names these differently and a fixed set guarantees a wrong box.
  reference_numbers text,
  instructions   text,
  lumper_required boolean not null default false,

  created_at     timestamptz not null default now(),
  unique (load_id, sequence)
);

create index load_stops_load_idx on load_stops (load_id, sequence);

-- ---------------------------------------------------------------- assignment

-- Driver, tractor and trailer assigned INDEPENDENTLY: trailers get dropped and
-- swapped, and a power-only load has no trailer of ours at all.
create table load_assignments (
  id            uuid primary key default gen_random_uuid(),
  carrier_id    uuid not null references carriers (id) on delete cascade,
  load_id       uuid not null references loads (id) on delete cascade,

  driver_id     uuid references drivers (id) on delete set null,
  co_driver_id  uuid references drivers (id) on delete set null,
  tractor_id    uuid references vehicles (id) on delete set null,
  trailer_id    uuid references vehicles (id) on delete set null,

  assigned_at   timestamptz not null default now(),
  assigned_by   uuid references profiles (id),
  unassigned_at timestamptz,

  -- When dispatch was allowed to proceed over a warning, this records WHO
  -- decided that and WHY. An override nobody can trace is an override that will
  -- be denied later.
  override_reason text,
  override_by   uuid references profiles (id)
);

create index load_assignments_load_idx on load_assignments (load_id)
  where unassigned_at is null;
create index load_assignments_driver_idx on load_assignments (driver_id)
  where unassigned_at is null;

-- ---------------------------------------------------------------- RLS

alter table customers        enable row level security;
alter table customers        force  row level security;
alter table loads            enable row level security;
alter table loads            force  row level security;
alter table load_stops       enable row level security;
alter table load_stops       force  row level security;
alter table load_assignments enable row level security;
alter table load_assignments force  row level security;

revoke all on customers, loads, load_stops, load_assignments
  from public, anon, authenticated;
grant select, insert, update, delete on customers        to authenticated;
grant select, insert, update, delete on loads            to authenticated;
grant select, insert, update, delete on load_stops       to authenticated;
grant select, insert, update        on load_assignments  to authenticated;

create policy customers_rw on customers
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create policy loads_rw on loads
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create policy load_stops_rw on load_stops
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create policy load_assignments_rw on load_assignments
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create trigger customers_touch before update on customers
  for each row execute function touch_updated_at();
create trigger loads_touch before update on loads
  for each row execute function touch_updated_at();
