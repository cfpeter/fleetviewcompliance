-- Documents: the evidence behind a deadline.
--
-- These are append-only. A superseded medical card is not garbage — it is the
-- proof that the driver was qualified during the period it covered, and 49 CFR
-- 391.51(c) requires the file be kept for as long as the driver is employed and
-- three years after. Deleting it to "clean up" destroys the record an auditor
-- asks for.

create type document_subject as enum ('carrier', 'driver', 'vehicle', 'terminal');

create table documents (
  id              uuid primary key default gen_random_uuid(),
  carrier_id      uuid not null references carriers (id) on delete cascade,

  subject_type    document_subject not null,
  -- Polymorphic by design: a foreign key per subject type would mean four
  -- nullable columns and a check constraint, for no gain. Integrity is enforced
  -- by the trigger below, which is stricter than a FK because it also checks
  -- that the subject belongs to the same carrier.
  subject_id      uuid,

  -- What kind of document this is, as a rule code ('medical_certificate',
  -- 'cdl', 'annual_inspection'). Free text until the rule registry lands in
  -- phase 2, then constrained to it.
  kind            text not null,

  -- R2 object key. No presigned URLs are stored: they expire, and a stale URL
  -- in the database looks like a working one.
  storage_key     text not null,
  file_name       text,
  content_type    text,
  byte_size       int,

  -- The date the document itself carries, when it has one. Entered by a person;
  -- nothing here is extracted automatically.
  issued_on       date,
  expires_on      date,

  uploaded_by     uuid references profiles (id),
  uploaded_at     timestamptz not null default now(),

  -- Soft supersede instead of delete. The row stays; it stops being current.
  superseded_at   timestamptz,
  superseded_by   uuid references documents (id)
);

create index documents_subject_idx on documents (carrier_id, subject_type, subject_id);
create index documents_current_idx on documents (carrier_id, kind) where superseded_at is null;

-- A document must point at a subject inside its own carrier. Without this a
-- user could attach a file to another tenant's driver id: the INSERT would pass
-- RLS (their own carrier_id is fine) while the subject_id pointed elsewhere.
-- SECURITY INVOKER, not DEFINER, and that is the whole point of the check.
--
-- Running as the calling user means the SELECTs below are themselves subject to
-- RLS, so a subject_id belonging to another carrier is simply invisible and the
-- existence test fails. A DEFINER version would run as the table owner, match no
-- `TO authenticated` policy under FORCE, and find nothing for ANYBODY — making
-- every document insert fail.
create or replace function documents_subject_belongs_to_carrier()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  ok boolean;
begin
  if new.subject_type = 'carrier' then
    ok := new.subject_id is null or new.subject_id = new.carrier_id;
  elsif new.subject_type = 'driver' then
    select exists (select 1 from drivers
      where id = new.subject_id and carrier_id = new.carrier_id) into ok;
  elsif new.subject_type = 'vehicle' then
    select exists (select 1 from vehicles
      where id = new.subject_id and carrier_id = new.carrier_id) into ok;
  elsif new.subject_type = 'terminal' then
    select exists (select 1 from terminals
      where id = new.subject_id and carrier_id = new.carrier_id) into ok;
  else
    ok := false;
  end if;

  if not ok then
    raise exception 'document subject % does not belong to carrier %',
      new.subject_id, new.carrier_id;
  end if;
  return new;
end;
$$;

create trigger documents_subject_check
  before insert or update on documents
  for each row execute function documents_subject_belongs_to_carrier();

-- Append-only, enforced. An UPDATE may set the supersede columns and nothing
-- else — not the storage key, not the dates, not the carrier.
create or replace function documents_are_append_only()
returns trigger
language plpgsql
as $$
begin
  if new.carrier_id  is distinct from old.carrier_id
  or new.subject_type is distinct from old.subject_type
  or new.subject_id  is distinct from old.subject_id
  or new.kind        is distinct from old.kind
  or new.storage_key is distinct from old.storage_key
  or new.issued_on   is distinct from old.issued_on
  or new.expires_on  is distinct from old.expires_on
  or new.uploaded_at is distinct from old.uploaded_at then
    raise exception
      'documents are append-only: supersede this row and insert a new one';
  end if;
  return new;
end;
$$;

create trigger documents_append_only
  before update on documents
  for each row execute function documents_are_append_only();

alter table documents enable row level security;
alter table documents force  row level security;

revoke all on documents from public, anon, authenticated;
-- No DELETE grant at all. Not a policy choice a future migration can loosen by
-- accident — the privilege simply is not there.
grant select, insert, update on documents to authenticated;

create policy documents_rw on documents
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));
