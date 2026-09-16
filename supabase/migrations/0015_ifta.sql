-- IFTA: fuel purchases and jurisdictional miles.
--
-- The highest-drudgery item in a small carrier's quarter — four to eight hours
-- of it — and the reason is that the two inputs live in different places: the
-- miles are in the truck and the gallons are in a shoebox of receipts.
--
-- UNITS, and they are not negotiable:
--   gallons   — THOUSANDTHS of a gallon (125.400 gal -> 125400)
--   money     — integer cents
--   tax rates — MILLS, thousandths of a dollar ($0.979/gal -> 979)
--
-- Floats are wrong here twice over: 0.1 + 0.2 is not 0.3 in binary floating
-- point, and a quarter's return is a sum of hundreds of these. A cent of drift
-- per row is a filing that does not reconcile, and IFTA audits reconcile.

create table fuel_purchases (
  id             uuid primary key default gen_random_uuid(),
  carrier_id     uuid not null references carriers (id) on delete cascade,
  vehicle_id     uuid references vehicles (id) on delete set null,

  purchased_on   date not null,
  -- Two-letter jurisdiction. IFTA covers 48 US states plus 10 Canadian
  -- provinces, so this is not a US-states enum.
  jurisdiction   text not null,

  gallons_milli  bigint not null check (gallons_milli > 0),
  total_cents    int check (total_cents >= 0),

  -- Whether jurisdictional fuel tax was paid at the pump. Bulk fuel drawn from
  -- an untaxed farm tank is NOT a tax-paid gallon and claiming it as one is the
  -- classic IFTA audit finding.
  tax_paid       boolean not null default true,

  vendor         text,
  receipt_number text,
  -- 49 CFR-adjacent: IFTA requires receipts be retained FOUR years.
  document_id    uuid references documents (id) on delete set null,

  source         record_source not null default 'owner',
  created_at     timestamptz not null default now()
);

create index fuel_purchases_period_idx
  on fuel_purchases (carrier_id, purchased_on);

-- Miles run in each jurisdiction, per vehicle, per quarter.
--
-- Deliberately a summary row rather than a trip log: the number that goes on
-- the return is the quarter's total, small carriers reconstruct it from trip
-- sheets or an ELD export, and forcing a per-trip breakdown they do not have
-- would mean they enter nothing at all.
create table jurisdiction_miles (
  id            uuid primary key default gen_random_uuid(),
  carrier_id    uuid not null references carriers (id) on delete cascade,
  vehicle_id    uuid references vehicles (id) on delete set null,

  -- The quarter this belongs to, as its first day: 2026-07-01 is Q3 2026.
  period_start  date not null,
  jurisdiction  text not null,
  miles         int not null check (miles >= 0),

  source        record_source not null default 'owner',
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (carrier_id, vehicle_id, period_start, jurisdiction)
);

create index jurisdiction_miles_period_idx
  on jurisdiction_miles (carrier_id, period_start);

-- Tax rates change quarterly, per jurisdiction, per fuel type. Storing them as
-- data with an effective date — rather than constants — is the same discipline
-- the penalty amounts needed: a rate baked into code is a rate nobody updates.
create table ifta_rates (
  jurisdiction  text not null,
  fuel_type     text not null default 'diesel',
  period_start  date not null,
  rate_mills    int not null,
  primary key (jurisdiction, fuel_type, period_start)
);

-- California only, and only the quarter we can cite. Every other jurisdiction
-- is deliberately absent: a missing rate must surface as "we do not have this"
-- rather than quietly computing zero tax owed for a state the truck drove
-- through. See src/lib/ifta/compute.ts.
insert into ifta_rates (jurisdiction, fuel_type, period_start, rate_mills) values
  ('CA', 'diesel', '2026-07-01', 979);

alter table fuel_purchases     enable row level security;
alter table fuel_purchases     force  row level security;
alter table jurisdiction_miles enable row level security;
alter table jurisdiction_miles force  row level security;

revoke all on fuel_purchases, jurisdiction_miles from public, anon, authenticated;
grant select, insert, update, delete on fuel_purchases     to authenticated;
grant select, insert, update, delete on jurisdiction_miles to authenticated;
-- Reference data, identical for every tenant.
revoke all on ifta_rates from public, anon, authenticated;
grant select on ifta_rates to authenticated;

create policy fuel_purchases_rw on fuel_purchases
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create policy jurisdiction_miles_rw on jurisdiction_miles
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create trigger jurisdiction_miles_touch before update on jurisdiction_miles
  for each row execute function touch_updated_at();
