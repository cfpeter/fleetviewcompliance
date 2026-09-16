-- One view was answering two different questions, and getting one of them wrong.
--
-- "When did you last do X?" wants the most recent OCCURRENCE. A driving-record
-- review done in March and again in September: September is the answer, whatever
-- order they were typed in.
--
-- "When does this expire?" wants the most recent STATEMENT. There is only ever
-- one current medical certificate. If the office manager types 2027 by mistake
-- and corrects it to 2026, ordering by occurred_on keeps the typo forever — the
-- correction is a valid row the view then ignores.
--
-- Both are right for their own question and wrong for the other. The fix is to
-- record which question an anchor answers.

create type anchor_kind as enum ('occurrence', 'statement');

-- The registry, so the app never has to pass the kind in and cannot get it
-- wrong. Everything absent from this table is an occurrence, which is both the
-- common case and the safe default: it keeps history rather than replacing it.
create table anchor_kinds (
  anchor_key text primary key,
  kind       anchor_kind not null
);

-- Kept in sync with src/lib/rules/* by tests/anchor-kinds.test.ts, which fails
-- if the catalogue gains an `expiry` anchor that is not listed here.
insert into anchor_kinds (anchor_key, kind) values
  ('medical_certificate_expires', 'statement');

alter table compliance_records
  add column anchor_kind anchor_kind not null default 'occurrence';

-- Set from the registry on write, so no caller has to know or remember.
create or replace function set_anchor_kind()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.anchor_kind := coalesce(
    (select kind from anchor_kinds where anchor_key = new.anchor_key),
    'occurrence'
  );
  return new;
end;
$$;

create trigger compliance_records_set_anchor_kind
  before insert on compliance_records
  for each row execute function set_anchor_kind();

-- Backfill the rows written before this migration existed.
update compliance_records cr
   set anchor_kind = ak.kind
  from anchor_kinds ak
 where ak.anchor_key = cr.anchor_key
   and cr.anchor_kind is distinct from ak.kind;

-- anchor_kind is derived, so it is exempt from the append-only guard — but
-- nothing else is. Rewritten rather than patched so the whole list is readable.
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

create or replace view current_compliance_anchors as
  select distinct on (carrier_id, subject_type, subject_id, anchor_key)
    carrier_id, subject_type, subject_id, anchor_key, occurred_on, source, id, anchor_kind
  from compliance_records
  where superseded_at is null
  order by
    carrier_id, subject_type, subject_id, anchor_key,
    -- For a statement, the latest thing the user SAID wins, so a correction
    -- typed today beats a typo typed yesterday even when the typo's date is
    -- further in the future. Null for occurrence rows, so they fall straight
    -- through to the next key.
    (case when anchor_kind = 'statement' then recorded_at end) desc nulls last,
    -- For an occurrence, the latest time it actually HAPPENED wins. A correction
    -- typed today about last March is still about last March.
    occurred_on desc,
    recorded_at desc;

alter view current_compliance_anchors set (security_invoker = on);
grant select on current_compliance_anchors to authenticated;

revoke all on anchor_kinds from public, anon, authenticated;
-- Read-only reference data: every tenant sees the same rows, and nobody writes
-- them at runtime. No RLS, because there is nothing tenant-specific to protect.
grant select on anchor_kinds to authenticated;
