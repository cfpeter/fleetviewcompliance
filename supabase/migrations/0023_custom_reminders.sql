-- The owner's own reminders.
--
-- Everything else this product tracks is a rule somebody else wrote: a CFR
-- section, a California vehicle code, a filing calendar. The engine computes
-- those, cites them, and links to the text. This table holds the other half of
-- the owner's week — the insurance renewal, the truck payment, the appointment
-- at the DMV — which no federal record knows about and no rule engine can
-- derive.
--
-- THE LINE THIS TABLE MUST NOT BLUR. A row here carries NO legal authority. It
-- has no citation column and no source URL, deliberately: there is nothing to
-- cite, and a column that could hold one is a column somebody eventually fills
-- in with a guess. The dashboard renders these rows with the word "Your
-- reminder" where a regulation prints its citation, so the difference survives
-- the trip from this table to a phone screen in a yard.
--
-- The matching TypeScript is src/lib/reminders.ts, the screen is
-- src/pages/app/reminders/index.astro, and the daily job that mails them is
-- src/pages/api/cron/digest.ts.

-- ---------------------------------------------------------------- the table

create table reminders (
  id           uuid primary key default gen_random_uuid(),
  carrier_id   uuid not null references carriers (id) on delete cascade,

  -- Who typed it. Kept so a fleet with an office manager and an owner can tell
  -- whose reminder this was; never used to restrict who may see it, because the
  -- whole carrier shares one list.
  created_by   uuid references profiles (id),

  title        text not null,
  note         text,

  -- A date, not a timestamp. "The insurance renews on the 2nd" is not an
  -- instant, and storing it as one makes it move for a reader in another
  -- timezone — the same rule compliance_records.occurred_on follows.
  due_on       date not null,

  -- REPEAT, AS ONE INTEGER.
  --
  -- 0 means it happens once. Anything else is a whole number of MONTHS, and the
  -- set is closed: monthly, quarterly, twice a year, yearly. That covers what an
  -- owner actually schedules for himself — insurance, registration, a lease
  -- payment — and it is deliberately not a recurrence engine. Months rather than
  -- days because these are calendar facts ("the 15th"), and the advance uses the
  -- same clamped month arithmetic the rules engine uses, so 31 January plus one
  -- month is 28 February and never 3 March: a date this product moves must never
  -- move LATER than the owner meant.
  --
  -- A repeating reminder is never "finished". Pressing Done advances due_on to
  -- the next cycle and stamps last_done_on; see the check below.
  repeat_months int not null default 0,

  -- What it is about, when it is about anything. Both null means the whole
  -- company, which is the common case ("renew the MC permit", "pay the ELD
  -- bill").
  --
  -- ON DELETE CASCADE, not SET NULL. A reminder about a truck that is no longer
  -- on the fleet is a reminder about nothing — and left behind with a null
  -- subject it would silently re-label itself as a company-wide reminder, which
  -- is a wrong answer that looks exactly like a right one. Trucks are marked
  -- 'sold' rather than deleted in practice, so this fires almost never; when it
  -- does, losing the row is the honest outcome.
  driver_id    uuid references drivers (id)  on delete cascade,
  vehicle_id   uuid references vehicles (id) on delete cascade,

  -- How many days before due_on the warning starts, chosen PER REMINDER.
  --
  -- The category lead times in notification_category_preferences are one array
  -- for every deadline of a kind, which is right for regulations — every medical
  -- card wants the same warning. Owner reminders are not alike: an insurance
  -- renewal wants a month, "call the broker back" wants a day. So the number
  -- lives on the row, and the settings screen says so instead of offering a box
  -- that nothing would read.
  lead_days    int not null default 7,

  -- DONE IS A FLAG HERE, AND THAT IS THE DIFFERENCE FROM compliance_records.
  --
  -- A compliance record is append-only because it is EVIDENCE: a superseded
  -- medical-card date proves the driver was qualified during the period it
  -- covered, and an auditor may ask about that period years later. Nobody will
  -- ever ask this carrier to prove when he called his insurance broker. Keeping
  -- a full history of a private to-do list would be storing personal working
  -- notes forever, to answer a question no one asks — so a reminder is closed
  -- with a stamp and can be opened again, and deleting one really deletes it.
  completed_at timestamptz,
  completed_by uuid references profiles (id),

  -- The last time Done was pressed, which for a repeating reminder is the only
  -- trace left once due_on has moved on. Kept so "every year" does not read as
  -- "never done" the day after it rolls over.
  last_done_on date,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- A blank title is a row nobody can act on: it renders as an empty line on the
  -- dashboard next to a federal deadline. The page refuses it too; this is the
  -- half an import or a psql session cannot skip.
  constraint reminders_title_present check (length(btrim(title)) between 1 and 120),
  constraint reminders_note_length   check (note is null or length(note) <= 2000),

  constraint reminders_repeat_known check (repeat_months in (0, 1, 3, 6, 12)),

  -- A warning further out than a year is not a warning — the same ceiling, and
  -- the same reasoning, as MAX_LEAD_DAY in src/lib/notify/preferences.ts. 0 is
  -- legitimate and means "tell me on the day".
  constraint reminders_lead_days_sane check (lead_days between 0 and 365),

  -- One subject at most. A reminder attached to a driver AND a truck has no
  -- honest label on the dashboard, and no screen can offer one.
  constraint reminders_one_subject check (num_nonnulls(driver_id, vehicle_id) <= 1),

  -- A repeating reminder cannot be closed, because closing it is not a state the
  -- product has: Done moves it to the next cycle. Stopping one for good is
  -- setting the repeat back to "once" and then closing it, or deleting it —
  -- both of which are visible choices rather than a row that quietly stopped.
  constraint reminders_repeat_stays_open check (repeat_months = 0 or completed_at is null)
);

-- The dashboard and the digest both ask the same question — "what is open, in
-- date order, for this carrier" — so it is an index and not a scan that grows
-- with every reminder ever closed.
create index reminders_open_idx
  on reminders (carrier_id, due_on)
  where completed_at is null;

-- ------------------------------------------------------- subject tenancy

/**
 * The subject must belong to the same carrier.
 *
 * RLS checks carrier_id and nothing else, so a crafted POST carrying MY
 * carrier_id and YOUR driver id passes the policy and writes a row that points
 * into your fleet. Exactly the hole 0011 closed for load children and 0005
 * closed for compliance records.
 *
 * SECURITY INVOKER so the lookup runs under the caller's own RLS: another
 * carrier's driver is simply invisible, and the check fails for the right
 * reason rather than for a reason that leaks whether that driver exists.
 */
create or replace function reminder_subject_belongs_to_carrier()
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

  if new.vehicle_id is not null and not exists (
    select 1 from vehicles where id = new.vehicle_id and carrier_id = new.carrier_id
  ) then
    raise exception 'vehicle % does not belong to carrier %', new.vehicle_id, new.carrier_id;
  end if;

  return new;
end;
$$;

create trigger reminders_subject_check
  before insert or update on reminders
  for each row execute function reminder_subject_belongs_to_carrier();

create trigger reminders_touch
  before update on reminders
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- RLS

alter table reminders enable row level security;
alter table reminders force  row level security;

revoke all on reminders from public, anon, authenticated;

-- DELETE is granted here, where compliance_records and documents refuse it. Same
-- reason the completed flag is a flag: this is the owner's own list, not
-- evidence anyone is entitled to inspect. A to-do he typed by mistake should go
-- away when he says so.
grant select, insert, update, delete on reminders to authenticated;

create policy reminders_rw on reminders
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

-- ------------------------------------------------- a category that sends

-- A FOURTH NOTIFICATION CATEGORY, AND IT IS LIVE FROM THE DAY IT SHIPS.
--
-- The two existing non-compliance values ('federal', 'system') are switched off
-- in NOTIFY_CATEGORIES because no job sends them; this one is switched on in the
-- same breath as the code that sends it, which is the only honest way to add a
-- row to that screen.
--
-- It is a separate category rather than more 'compliance' traffic because the
-- two are different news with different consequences. A federal deadline missed
-- costs a truck; a reminder the owner typed is his own business. He must be able
-- to stop hearing about his own list WITHOUT turning off the warnings that keep
-- him legal — and folded into 'compliance' the only way to quieten one would be
-- to silence both, which is precisely the muting failure notification_
-- preferences exists to prevent.
--
-- ADD VALUE inside this transaction is safe on Postgres 12+ so long as the new
-- value is not USED in the same transaction. Nothing below uses it: the first
-- rows carrying 'reminder' are written by the settings page and the digest job,
-- long after this file commits.
alter type notify_category add value if not exists 'reminder';
