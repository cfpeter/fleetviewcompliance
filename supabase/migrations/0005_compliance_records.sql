-- Where the dates live.
--
-- The rule engine asks for anchors by NAME — 'medical_certificate_expires',
-- 'bit_last_inspection', 'annual_mvr_last_obtained'. Storing those as columns
-- would mean a schema migration every time a rule is added, which defeats the
-- whole point of rules being data. So they are rows, keyed by the same string
-- the rule uses.
--
-- Adding a state adds rule rows and anchor keys. It does not add columns.

create table compliance_records (
  id             uuid primary key default gen_random_uuid(),
  carrier_id     uuid not null references carriers (id) on delete cascade,

  -- Reuses document_subject: 'carrier' | 'driver' | 'vehicle' | 'terminal'.
  -- The engine's finer split between power_unit and trailer comes from
  -- vehicles.kind, so it does not need to be repeated here.
  subject_type   document_subject not null,
  subject_id     uuid,

  -- Matches Recurrence.anchor in src/lib/rules/types.ts exactly. A typo here is
  -- a rule that silently reports missing_data forever, so the app writes this
  -- from a constant, never from user input.
  anchor_key     text not null,

  -- A date, not a timestamp. "The card expires on the 2nd" is not an instant,
  -- and storing it as one makes it move for a reader in another timezone.
  occurred_on    date not null,

  source         record_source not null default 'owner',
  note           text,
  recorded_by    uuid references profiles (id),
  recorded_at    timestamptz not null default now(),

  -- Append-only, same as documents. A superseded date is the evidence that the
  -- driver was qualified during the period it covered.
  superseded_at  timestamptz
);

create index compliance_records_lookup_idx
  on compliance_records (carrier_id, subject_type, subject_id, anchor_key)
  where superseded_at is null;

-- The current value of each anchor: the most recent date that has not been
-- superseded. DISTINCT ON orders by occurred_on first and recorded_at only as a
-- tie-break — the compliance fact outranks the data-entry timestamp, because a
-- correction typed today about last March is still about last March.
create view current_compliance_anchors as
  select distinct on (carrier_id, subject_type, subject_id, anchor_key)
    carrier_id, subject_type, subject_id, anchor_key, occurred_on, source, id
  from compliance_records
  where superseded_at is null
  order by carrier_id, subject_type, subject_id, anchor_key,
           occurred_on desc, recorded_at desc;

-- The subject must belong to the same carrier. SECURITY INVOKER so the lookups
-- below run under the caller's own RLS: a subject in another carrier is simply
-- invisible, and the check fails for the right reason.
create or replace function compliance_subject_belongs_to_carrier()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare ok boolean;
begin
  if new.subject_type = 'carrier' then
    ok := new.subject_id is null or new.subject_id = new.carrier_id;
  elsif new.subject_type = 'driver' then
    select exists (select 1 from drivers where id = new.subject_id
      and carrier_id = new.carrier_id) into ok;
  elsif new.subject_type = 'vehicle' then
    select exists (select 1 from vehicles where id = new.subject_id
      and carrier_id = new.carrier_id) into ok;
  elsif new.subject_type = 'terminal' then
    select exists (select 1 from terminals where id = new.subject_id
      and carrier_id = new.carrier_id) into ok;
  else
    ok := false;
  end if;

  if not ok then
    raise exception 'compliance subject % does not belong to carrier %',
      new.subject_id, new.carrier_id;
  end if;
  return new;
end;
$$;

create trigger compliance_records_subject_check
  before insert or update on compliance_records
  for each row execute function compliance_subject_belongs_to_carrier();

-- Append-only: an update may only supersede.
create or replace function compliance_records_are_append_only()
returns trigger
language plpgsql
as $$
begin
  if new.carrier_id   is distinct from old.carrier_id
  or new.subject_type is distinct from old.subject_type
  or new.subject_id   is distinct from old.subject_id
  or new.anchor_key   is distinct from old.anchor_key
  or new.occurred_on  is distinct from old.occurred_on
  or new.recorded_at  is distinct from old.recorded_at then
    raise exception
      'compliance records are append-only: supersede this row and insert a new one';
  end if;
  return new;
end;
$$;

create trigger compliance_records_append_only
  before update on compliance_records
  for each row execute function compliance_records_are_append_only();

alter table compliance_records enable row level security;
alter table compliance_records force  row level security;

revoke all on compliance_records from public, anon, authenticated;
-- No DELETE. Same reasoning as documents: the retention rules need these.
grant select, insert, update on compliance_records to authenticated;

create policy compliance_records_rw on compliance_records
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

-- The view runs as its owner, so it must be granted explicitly and it inherits
-- nothing from the table's policy. It reads only from a table the caller is
-- already restricted on, and security_invoker makes that restriction apply.
alter view current_compliance_anchors set (security_invoker = on);
grant select on current_compliance_anchors to authenticated;
