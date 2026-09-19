-- What the driver sent, waiting for the owner to look at it.
--
-- THIS TABLE IS WHY THE FEATURE IS SAFE.
--
-- A link is a bearer token in a text message. It can be forwarded, screenshotted,
-- or sit on a phone somebody else picks up. If the anonymous route wrote
-- straight to `drivers` or `compliance_records`, whoever held that link could
-- move a date on the carrier's compliance board — and the board is what the
-- owner shows a broker and what he stands on at a roadside inspection.
--
-- So the anonymous path writes HERE and nowhere else. Nothing in this table is
-- read by the rule engine, the dashboard, the digest or the proof page. It is a
-- queue. When the owner accepts a row, the real write happens the ordinary way:
-- signed in, through RLS, stamped `source = 'driver'` (0037) so that months
-- later anyone can see the date came from the driver and not from the office.
--
-- It also keeps us out of a trap. `documents_subject_belongs_to_carrier()` in
-- 0003 is SECURITY INVOKER on purpose, and its comment warns that a DEFINER
-- caller "would match no TO authenticated policy under FORCE, and find nothing
-- for ANYBODY". A definer function inserting into `documents` might clear that
-- or might not, depending on whether the owning role's BYPASSRLS applies. With a
-- staging table we never have to find out.

create table driver_submissions (
  id              uuid primary key default gen_random_uuid(),
  carrier_id      uuid not null references carriers (id) on delete cascade,
  driver_link_id  uuid not null references driver_links (id) on delete cascade,
  -- Denormalised from the link, and stored anyway. The RLS policy has to fence
  -- on the carrier without a join, and a tenant boundary that depends on a join
  -- is a tenant boundary one bad query away from not existing.
  driver_id       uuid not null references drivers (id) on delete cascade,

  submitted_at    timestamptz not null default now(),

  -- The typed answers, keyed by ask. Read by the review screen and by nothing
  -- else — never parsed by the rule engine, never rendered as a compliance date
  -- until an owner has accepted it.
  payload         jsonb not null default '{}'::jsonb,

  -- R2 object keys for anything he photographed. The Worker writes the objects
  -- before this row exists, so a failed insert leaves files to clean up rather
  -- than a row pointing at nothing.
  storage_keys    text[] not null default '{}'::text[],

  state           text not null default 'pending',
  decided_by      uuid references profiles (id),
  decided_at      timestamptz,

  -- WHO SENT IT, as much as we can honestly say.
  --
  -- The predecessor recorded audit rows for creating, revoking, accepting and
  -- rejecting a link — and none at all for the driver's actual write. So the one
  -- question staging exists to answer, "was this really him", had no evidence
  -- behind it whatsoever. A salted hash rather than the address itself: enough
  -- to say "these two submissions came from the same place", never enough to
  -- become a location record on a driver.
  ip_hash         text,

  constraint driver_submissions_state_known check (state in ('pending', 'accepted', 'rejected')),
  -- A decision and its stamp travel together or not at all.
  constraint driver_submissions_decided_together check (
    (state = 'pending' and decided_at is null)
    or (state <> 'pending' and decided_at is not null)
  )
);

create index driver_submissions_pending_idx on driver_submissions (carrier_id, submitted_at desc)
  where state = 'pending';
create index driver_submissions_driver_idx on driver_submissions (carrier_id, driver_id, submitted_at desc);

comment on table driver_submissions is
  'A claim a driver sent through a one-time link. Nothing here is a compliance fact until an owner accepts it, at which point the real write happens signed-in with source = driver. See 0035.';
comment on column driver_submissions.ip_hash is
  'Salted digest of the caller address. Answers "did these two come from the same place", never "where is this driver".';

-- ------------------------------------------------------------------- tenancy

alter table driver_submissions enable row level security;
alter table driver_submissions force row level security;

revoke all on driver_submissions from public, anon, authenticated;

-- SELECT and UPDATE, and NO INSERT, deliberately.
--
-- Rows here are written by the anonymous submit function in 0036 and by nothing
-- else. Granting INSERT to `authenticated` would let a signed-in user fabricate
-- "the driver sent this" — a row that then gets accepted onto a compliance
-- record, carrying `source = 'driver'`, with no driver anywhere near it.
grant select, update on driver_submissions to authenticated;

create policy driver_submissions_rw on driver_submissions
  for all to authenticated
  using (carrier_id in (select current_user_carriers()))
  with check (carrier_id in (select current_user_carriers()));

-- No policy for anon. The definer function in 0036 is the only door.

-- A submission is answered once.
--
-- Accepting writes a compliance record; accepting twice writes it twice, and the
-- second one supersedes the first with the identical date, which reads on the
-- history screen as though somebody changed their mind.
create or replace function driver_submissions_decide_once()
returns trigger
language plpgsql
as $$
begin
  if old.state <> 'pending' and new.state is distinct from old.state then
    raise exception 'submission % was already %', old.id, old.state;
  end if;
  return new;
end;
$$;

create trigger driver_submissions_decide_once_check
  before update on driver_submissions
  for each row execute function driver_submissions_decide_once();
