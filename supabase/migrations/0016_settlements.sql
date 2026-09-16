-- Driver settlements: what the driver is owed, and the paper that says why.
--
-- This is NOT payroll. Nothing here withholds tax, files a 941, or produces a
-- W-2. It produces a SETTLEMENT STATEMENT — the sheet an owner-operator or a
-- company driver is handed alongside the cheque — and exports it. The pages that
-- read these tables say so on screen, deliberately, because a carrier who
-- believes this is payroll is a carrier who stops withholding.
--
-- UNITS, and they are not negotiable. The same discipline as 0009 and 0015:
--   money          — integer CENTS            ($1,850.50 -> 185050)
--   per-mile rates — MILLS per mile           ($0.585/mi -> 585)
--   percentages    — BASIS POINTS             (68.5%     -> 6850)
--   quantities     — THOUSANDTHS of the unit  (1,250 mi  -> 1250000; 7.5 h -> 7500)
--
-- Cents alone cannot hold a per-mile rate. Real 2026 CPM runs $0.58-$0.78 and is
-- negotiated in half-cents; storing 58 and calling it "cents per mile" makes
-- $0.585 unrepresentable, and the workaround every time is to round it, which is
-- $12.50 a week wrong on a 2,500-mile driver. Mills is the same choice 0015 made
-- for fuel tax and for the same reason.
--
-- Percentages are basis points because lease agreements really do say 67.5%.

-- ---------------------------------------------------------------- pay methods

create type pay_method as enum ('per_mile', 'percentage', 'hourly', 'flat_per_trip');

-- WHICH BOOK OF MILES. This is the single most expensive unlabelled field in
-- driver pay.
--
-- The same physical run is four different numbers. PC*MILER practical is the
-- routing a truck can legally take; shortest ignores truck restrictions and is
-- routinely 3-6% lower; HHG (Household Goods) is a 1970s tariff table still
-- written into contracts; hub is the odometer, which is higher than all of them
-- because it includes the fuel stop and the wrong turn. A driver paid "58 cents
-- a mile" on shortest while reading his odometer believes he is being shorted
-- every single week, and he is not wrong to ask — nobody ever wrote down which
-- book was meant.
--
-- There is NO default on this type's column on purpose. See the CHECK below.
create type mileage_basis as enum ('practical', 'shortest', 'hhg', 'hub');

-- ---------------------------------------------------------------- agreements

-- SEVERAL ACTIVE AT ONCE IS THE NORMAL CASE, not an edge case.
--
-- A real driver is per-mile on linehaul AND flat $25 a stop AND hourly for
-- detention. Modelling pay as one column on `drivers` — the obvious first
-- design — cannot express that, and what happens next is that the stop pay gets
-- typed onto the settlement by hand every week until someone forgets. So pay is
-- a LIST of agreements per driver, each one naming what it covers.
create table pay_agreements (
  id            uuid primary key default gen_random_uuid(),
  carrier_id    uuid not null references carriers (id) on delete cascade,
  driver_id     uuid not null references drivers (id) on delete cascade,

  -- What this agreement is for, in the owner's words: "Linehaul", "Stop pay",
  -- "Detention". Printed on the settlement line, so it is how the driver knows
  -- which of his three agreements produced a number.
  label         text not null,
  method        pay_method not null,

  -- EXACTLY ONE rate column is filled, and which one depends on the method.
  --
  -- Three columns rather than one `rate` whose unit depends on `method`. A
  -- single column holding 58 is unreadable: cents? mills? percent? Somebody
  -- eventually reads it as the wrong one, and a 58% linehaul split paid as
  -- $0.58/mi is not a rounding error, it is a lawsuit. The column name carries
  -- the unit so the question cannot be asked.
  rate_mills    int,   -- per_mile:      thousandths of a dollar PER MILE
  percent_bp    int,   -- percentage:    basis points
  rate_cents    int,   -- hourly:        cents per hour
                       -- flat_per_trip: cents per trip (or per stop)

  -- REQUIRED for per_mile. Forbidden for everything else. Never defaulted.
  mileage_basis mileage_basis,

  -- WHAT THE PERCENTAGE IS A PERCENTAGE OF.
  --
  -- The most common settlement dispute in the segment, and it is entirely
  -- avoidable. "70% of the load" is three different cheques depending on whether
  -- the fuel surcharge and the accessorials are in the pot. A load paying $2,000
  -- linehaul + $400 FSC + $150 lumper settles at $1,400, $1,680 or $1,785 —
  -- a $385 spread on one load, argued about six weeks later when neither party
  -- remembers what was said on the phone.
  --
  -- NOT NULL DEFAULT FALSE would have been the easy schema and it is the bug:
  -- false is an ANSWER ("fuel surcharge is excluded"), and defaulting to it
  -- silently takes the carrier's side of an argument nobody knew they were
  -- having. Nullable + a CHECK forces the question to be asked once, at the
  -- moment the agreement is written, when both people are in the room.
  percent_includes_fuel_surcharge boolean,
  percent_includes_accessorials   boolean,

  -- History, not just the current deal. A settlement produced in March must
  -- still be explainable in June after the CPM went up, so agreements are dated
  -- rather than edited in place when the rate changes.
  effective_on  date not null default current_date,
  ends_on       date,

  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- The rate column has to match the method, or the arithmetic downstream picks
  -- up a NULL and pays the driver nothing while looking like it worked.
  constraint pay_agreements_rate_matches_method check (
    case method
      when 'per_mile'      then rate_mills is not null and num_nonnulls(percent_bp, rate_cents) = 0
      when 'percentage'    then percent_bp is not null and num_nonnulls(rate_mills, rate_cents) = 0
      when 'hourly'        then rate_cents is not null and num_nonnulls(rate_mills, percent_bp) = 0
      when 'flat_per_trip' then rate_cents is not null and num_nonnulls(rate_mills, percent_bp) = 0
    end
  ),

  -- A PER-MILE RATE WITH NO STATED BASIS IS A DISPUTE WAITING TO HAPPEN.
  -- Written as a biconditional so it also stops a mileage basis being attached
  -- to an hourly agreement, where it would print on the statement and imply a
  -- mileage term that does not exist.
  constraint pay_agreements_basis_required check (
    (method = 'per_mile') = (mileage_basis is not null)
  ),

  -- Same shape, for the two percentage flags. The database refuses a percentage
  -- agreement that does not say what it is of.
  constraint pay_agreements_percent_scope_required check (
    (method = 'percentage') = (percent_includes_fuel_surcharge is not null)
    and (method = 'percentage') = (percent_includes_accessorials is not null)
  ),

  -- Zero is not a rate, it is an unfinished form. A $0.00/mi agreement pays
  -- nothing forever and looks configured.
  constraint pay_agreements_rate_positive check (
    (rate_mills is null or rate_mills > 0)
    and (rate_cents is null or rate_cents > 0)
    -- 10000bp = 100%. Above that the driver is paid more than the load earned,
    -- which is a typo ("750" meaning 75%) every time it appears.
    and (percent_bp is null or (percent_bp > 0 and percent_bp <= 10000))
  ),

  constraint pay_agreements_dates_ordered check (ends_on is null or ends_on >= effective_on)
);

create index pay_agreements_driver_idx on pay_agreements (driver_id, effective_on desc);
create index pay_agreements_carrier_idx on pay_agreements (carrier_id);

-- ---------------------------------------------------------------- settlements

-- draft    — being built. Fully editable.
-- approved — the owner has signed it off. Still editable; see the lock note.
-- paid     — the money has moved. LOCKED.
-- void     — cancelled before payment. LOCKED, and kept, because a settlement
--            that vanishes is a settlement the driver swears he was promised.
create type settlement_status as enum ('draft', 'approved', 'paid', 'void');

create table settlements (
  id            uuid primary key default gen_random_uuid(),
  carrier_id    uuid not null references carriers (id) on delete cascade,
  driver_id     uuid not null references drivers (id) on delete cascade,

  period_start  date not null,
  period_end    date not null,
  status        settlement_status not null default 'draft',

  -- REVISIONS. See the lock trigger below for the whole decision.
  revision      int not null default 1,
  -- The settlement this one replaces. NULL on an original.
  supersedes_id uuid references settlements (id) on delete set null,
  -- Stamped on the OLD row when a revision replaces it.
  superseded_at timestamptz,

  -- THE NET, FROZEN AT THE MOMENT IT WAS LOCKED.
  --
  -- NULL while draft, and that is deliberate: a draft's total is re-derived from
  -- its lines on every page load, so it cannot drift from them. Storing a
  -- running total on a draft is how a stored total and its lines end up
  -- disagreeing, and then nobody can say which one was on the cheque.
  --
  -- Once locked the lines are immutable (trigger below), so this snapshot can
  -- never disagree with them — it exists so the number that was actually paid is
  -- a fact on the row rather than an arithmetic result that depends on today's
  -- code.
  net_cents     int,

  approved_at   timestamptz,
  approved_by   uuid references profiles (id),
  paid_on       date,
  -- Free text: 'ACH 8841', 'check 1042'. Not a payment integration, and not
  -- pretending to be one.
  payment_reference text,

  note          text,
  created_at    timestamptz not null default now(),
  created_by    uuid references profiles (id),
  updated_at    timestamptz not null default now(),

  constraint settlements_period_ordered check (period_end >= period_start),
  constraint settlements_revision_positive check (revision >= 1),
  -- A settlement cannot supersede itself: that would make the revision chain a
  -- loop and the "what replaced this?" link on the page point back at the page.
  constraint settlements_not_self_superseding check (supersedes_id is null or supersedes_id <> id),
  -- A locked settlement must carry the number that was paid. Without this a
  -- settlement could be marked paid with a NULL net and the statement would
  -- print a blank where the cheque amount goes.
  constraint settlements_locked_has_net check (status <> 'paid' or net_cents is not null)
);

-- One settlement per driver per period per revision. The revision is in the key
-- on purpose: re-issuing a corrected March statement is exactly the thing this
-- schema is for, and a bare (driver, period) unique would forbid it.
create unique index settlements_period_idx
  on settlements (carrier_id, driver_id, period_start, period_end, revision);

create index settlements_list_idx on settlements (carrier_id, period_start desc, driver_id);

-- ---------------------------------------------------------------- lines

-- THE SIGN CONVENTION LIVES HERE, and it is enforced rather than remembered.
--
-- category drives the sign. Earnings and reimbursements are POSITIVE; advances
-- and deductions are NEGATIVE. The net is therefore a plain SUM of amount_cents
-- with no sign flipping anywhere in the application — which is the point, because
-- every sign flip in application code is a place where one caller forgets and a
-- $250 escrow deduction gets ADDED to the driver's pay.
--
-- The UI takes a positive dollar figure (nobody types "-250") and negates it on
-- the way in, in exactly one function. The CHECK below is what catches every
-- other path: an import, a psql session, a future page that forgets.
create type settlement_category as enum ('earning', 'reimbursement', 'advance', 'deduction');

-- Reimbursements are a separate category from earnings even though both are
-- positive, because a reimbursement is the carrier paying back money the driver
-- already spent — it is not compensation, it does not belong in a per-mile
-- average, and on the statement it is subtotalled separately.
create type settlement_line_kind as enum (
  -- earning
  'linehaul', 'stop_pay', 'detention', 'layover', 'accessorial', 'bonus', 'other_earning',
  -- reimbursement
  'toll', 'scale', 'lumper', 'other_reimbursement',
  -- advance
  'advance',
  -- deduction
  'escrow', 'insurance', 'eld_fee', 'truck_lease', 'fuel_card', 'other_deduction'
);

create table settlement_lines (
  id             uuid primary key default gen_random_uuid(),
  carrier_id     uuid not null references carriers (id) on delete cascade,
  settlement_id  uuid not null references settlements (id) on delete cascade,

  category       settlement_category not null,
  kind           settlement_line_kind not null,
  description    text,

  -- Signed. See settlement_lines_sign_matches_category.
  amount_cents   int not null,

  -- Which load this came off, when it came off one. Nullable: escrow, insurance
  -- and the ELD fee belong to the period, not to a load.
  load_id        uuid references loads (id) on delete set null,

  -- ------------------------------------------------------------------
  -- HOW THIS NUMBER WAS ARRIVED AT — snapshotted, never joined for.
  --
  -- pay_agreement_id is kept for provenance, but every term below is COPIED
  -- rather than read through it at render time. The agreement WILL be edited:
  -- the CPM goes up in April, and if the March statement re-renders through
  -- today's agreement it silently starts claiming it paid 62 cents when the
  -- cheque was written at 58. A settlement statement is a document handed to a
  -- person; a document that says something different a year later is a document
  -- nobody can win an argument with.
  -- ------------------------------------------------------------------
  pay_agreement_id uuid references pay_agreements (id) on delete set null,
  method         pay_method,
  -- Thousandths of the unit: miles, hours, or trips/stops.
  quantity_milli bigint,
  rate_mills     int,
  percent_bp     int,
  rate_cents     int,
  -- The amount the percentage was taken OF, in cents. Printed on the line so the
  -- driver can check it against the rate confirmation without asking.
  basis_cents    int,
  -- Snapshotted answers to "which miles" and "percentage of what". These are the
  -- two facts a settlement argument is actually about, so they are on the LINE,
  -- not only on the agreement they came from.
  mileage_basis  mileage_basis,
  percent_includes_fuel_surcharge boolean,
  percent_includes_accessorials   boolean,

  created_at     timestamptz not null default now(),
  created_by     uuid references profiles (id),

  -- The kind has to belong to the category, or the subtotals lie: an 'escrow'
  -- line filed as an earning is $250 of the carrier's money handed to the driver
  -- on paper and it reconciles to nothing.
  constraint settlement_lines_kind_matches_category check (
    case category
      when 'earning' then kind in (
        'linehaul', 'stop_pay', 'detention', 'layover', 'accessorial', 'bonus', 'other_earning')
      when 'reimbursement' then kind in ('toll', 'scale', 'lumper', 'other_reimbursement')
      when 'advance' then kind = 'advance'
      when 'deduction' then kind in (
        'escrow', 'insurance', 'eld_fee', 'truck_lease', 'fuel_card', 'other_deduction')
    end
  ),

  -- THE SIGN. Zero is permitted on all four — a $0.00 detention line recorded
  -- against a stop that was released on time is a real thing to want on the
  -- statement, and it is different from no line at all.
  constraint settlement_lines_sign_matches_category check (
    case category
      when 'earning'       then amount_cents >= 0
      when 'reimbursement' then amount_cents >= 0
      when 'advance'       then amount_cents <= 0
      when 'deduction'     then amount_cents <= 0
    end
  ),

  -- A computed per-mile line without its basis is the disputed line all over
  -- again, one layer down. If the method is recorded, the terms that make it
  -- readable are recorded with it.
  constraint settlement_lines_per_mile_basis check (
    method is distinct from 'per_mile' or (mileage_basis is not null and rate_mills is not null)
  ),
  constraint settlement_lines_percent_scope check (
    method is distinct from 'percentage'
    or (percent_bp is not null
        and percent_includes_fuel_surcharge is not null
        and percent_includes_accessorials is not null)
  ),
  constraint settlement_lines_quantity_nonnegative check (
    quantity_milli is null or quantity_milli >= 0
  )
);

create index settlement_lines_settlement_idx on settlement_lines (settlement_id, category, kind);
create index settlement_lines_carrier_idx on settlement_lines (carrier_id);

-- ---------------------------------------------------------------- tenancy

-- A child row could be attached to another carrier's parent. This is the same
-- hole 0011_load_child_tenancy.sql closed for load_stops and load_assignments,
-- and the reasoning is worth restating because it is not obvious:
--
-- The RLS policies below check `carrier_id`, which stops a user writing rows
-- labelled as another carrier's. What they do NOT check is that `driver_id`,
-- `settlement_id` or `load_id` point at a row belonging to that SAME carrier. A
-- crafted POST carrying MY carrier_id and YOUR driver_id passes the policy — the
-- row is mine by the policy's reckoning — and lands a pay agreement on your
-- driver. RLS then hides the result from me, which is worse rather than better:
-- I have written into your record and cannot see what I did.
--
-- SECURITY INVOKER throughout, so the lookups run under the caller's own RLS. A
-- driver in another carrier is simply invisible and the check fails for the
-- right reason.

create or replace function driver_child_belongs_to_carrier()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from drivers
     where id = new.driver_id
       and carrier_id = new.carrier_id
  ) then
    raise exception 'driver % does not belong to carrier %', new.driver_id, new.carrier_id;
  end if;
  return new;
end;
$$;

create trigger pay_agreements_parent_check
  before insert or update on pay_agreements
  for each row execute function driver_child_belongs_to_carrier();

create trigger settlements_parent_check
  before insert or update on settlements
  for each row execute function driver_child_belongs_to_carrier();

-- A settlement line has up to three parents, and two of them are optional.
create or replace function settlement_line_parents_belong_to_carrier()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  line_driver uuid;
  agreement_driver uuid;
begin
  select driver_id into line_driver
    from settlements
   where id = new.settlement_id
     and carrier_id = new.carrier_id;

  if line_driver is null then
    raise exception 'settlement % does not belong to carrier %', new.settlement_id, new.carrier_id;
  end if;

  if new.load_id is not null and not exists (
    select 1 from loads where id = new.load_id and carrier_id = new.carrier_id
  ) then
    raise exception 'load % does not belong to carrier %', new.load_id, new.carrier_id;
  end if;

  if new.pay_agreement_id is not null then
    select driver_id into agreement_driver
      from pay_agreements
     where id = new.pay_agreement_id
       and carrier_id = new.carrier_id;

    if agreement_driver is null then
      raise exception 'pay agreement % does not belong to carrier %',
        new.pay_agreement_id, new.carrier_id;
    end if;

    -- Both rows are inside one carrier and RLS is satisfied, and the line is
    -- still wrong: this pays driver A at driver B's rate. Same tenant, so no
    -- policy anywhere would ever catch it, and on screen it renders as a
    -- perfectly ordinary line with a rate that is simply not his.
    if agreement_driver <> line_driver then
      raise exception 'pay agreement % belongs to a different driver than settlement %',
        new.pay_agreement_id, new.settlement_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger settlement_lines_parent_check
  before insert or update on settlement_lines
  for each row execute function settlement_line_parents_belong_to_carrier();

-- ---------------------------------------------------------------- the lock

-- THE REVISION MECHANISM, and why it is this one.
--
-- Requirement: a settlement that has been paid must not be silently editable.
-- Three mechanisms were available.
--
--   (a) A status that locks, edits refused, corrections made by a new
--       settlement that SUPERSEDES the old one. Chosen.
--   (b) Copy-on-write versions of every settlement, edit freely, keep history.
--       Rejected: it makes every save a version, so the history is 40 rows of
--       typing and the one revision that matters — the corrected statement the
--       driver was re-issued — is not distinguishable from them.
--   (c) An audit-log table beside a freely mutable settlement. Rejected: the
--       statement itself still changes, so the PDF the driver is holding and the
--       screen the office is looking at disagree, and the log only records that
--       they now disagree.
--
-- What locks: `paid` and `void`. What does not: `approved`.
--
-- `approved` is deliberately still editable. An owner who approves on Friday and
-- spots a missing toll receipt on Saturday must be able to add it; forcing a
-- formal revision for a statement nobody has acted on yet trains people to leave
-- everything in draft, which defeats the whole mechanism. The lock exists to
-- protect a statement the driver has ALREADY BEEN PAID against — the only case
-- where a silent edit means the paper in his hand disagrees with the screen.
--
-- The one field that may still change on a locked row is `superseded_at`, which
-- is how a revision marks the row it replaces. This is the same allowance the
-- append-only compliance_records trigger makes, and for the same reason: the
-- record is not being altered, it is being annotated as replaced.
create or replace function settlements_locked_is_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status not in ('paid', 'void') then
    return new;
  end if;

  -- Annotating a locked statement as replaced is allowed. Everything else is
  -- compared field by field rather than with row equality, so the error names
  -- what was being changed instead of saying "something".
  if new.status is distinct from old.status
     or new.driver_id is distinct from old.driver_id
     or new.carrier_id is distinct from old.carrier_id
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.net_cents is distinct from old.net_cents
     or new.revision is distinct from old.revision
     or new.supersedes_id is distinct from old.supersedes_id
     or new.paid_on is distinct from old.paid_on
     or new.payment_reference is distinct from old.payment_reference
     or new.note is distinct from old.note
  then
    raise exception
      'settlement % is % and cannot be edited — create a revision instead',
      old.id, old.status;
  end if;

  return new;
end;
$$;

create trigger settlements_lock
  before update on settlements
  for each row execute function settlements_locked_is_immutable();

-- The lines are the statement. Locking the header and leaving the lines writable
-- would be no lock at all: the total on the row would stay frozen while the
-- lines underneath it changed, and the two would silently stop agreeing.
create or replace function settlement_lines_respect_lock()
returns trigger
language plpgsql
-- INVOKER, not DEFINER, and the reason is the trap documented at the top of
-- 0001_tenancy.sql. `settlements` has FORCE row level security, so even the
-- table OWNER is subject to its policies — and every policy here is granted TO
-- authenticated. A SECURITY DEFINER function runs as the owner, matches no
-- policy at all, and reads back NOTHING. parent_status would be NULL on every
-- row and this lock would FAIL OPEN while looking like it worked.
--
-- Under INVOKER the lookup runs as the caller, who can see their own
-- settlements. The "caller can see the line but not the parent" case that would
-- otherwise fail open cannot arise: both tables are scoped by the same
-- carrier_id policy, and settlement_lines_parent_check separately refuses a line
-- whose settlement belongs to anyone else.
security invoker
set search_path = public, pg_temp
as $$
declare
  parent uuid;
  parent_status settlement_status;
begin
  -- Branched on TG_OP rather than coalescing NEW and OLD: on a DELETE, NEW is
  -- null, and reaching into a null row variable is the sort of thing that
  -- behaves differently across server versions. This is a lock; it does not get
  -- to be clever.
  if tg_op = 'DELETE' then
    parent := old.settlement_id;
  else
    parent := new.settlement_id;
  end if;

  select status into parent_status from settlements where id = parent;

  if parent_status in ('paid', 'void') then
    raise exception
      'settlement % is % — its lines cannot be changed. Create a revision instead',
      parent, parent_status;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger settlement_lines_lock
  before insert or update or delete on settlement_lines
  for each row execute function settlement_lines_respect_lock();

-- ---------------------------------------------------------------- RLS

alter table pay_agreements   enable row level security;
alter table pay_agreements   force  row level security;
alter table settlements      enable row level security;
alter table settlements      force  row level security;
alter table settlement_lines enable row level security;
alter table settlement_lines force  row level security;

-- Revoke first. RLS restricts rows; it does not grant table access, and a table
-- left with the default PUBLIC grant is reachable before a policy is consulted.
revoke all on pay_agreements, settlements, settlement_lines
  from public, anon, authenticated;
grant select, insert, update, delete on pay_agreements   to authenticated;
-- No DELETE on settlements. A settlement is cancelled by being voided, never
-- removed: "he was never paid for that week" is a conversation that needs a row
-- to point at. Drafts created in error are voided too.
grant select, insert, update          on settlements      to authenticated;
grant select, insert, update, delete on settlement_lines to authenticated;

create policy pay_agreements_rw on pay_agreements
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create policy settlements_rw on settlements
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create policy settlement_lines_rw on settlement_lines
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

create trigger pay_agreements_touch before update on pay_agreements
  for each row execute function touch_updated_at();
create trigger settlements_touch before update on settlements
  for each row execute function touch_updated_at();
