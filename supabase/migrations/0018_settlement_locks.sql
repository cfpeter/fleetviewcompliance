-- Seven ways a paid settlement could be changed or destroyed.
--
-- Each was reproduced against a live database as an ordinary carrier user over
-- the same REST surface the app uses — not as a superuser, and not in psql only.
-- A settlement statement exists to be unarguable after the fact; every one of
-- these made it arguable.

-- ---------------------------------------------------------------- 1. the cascade

-- `settlements.driver_id references drivers on delete cascade` meant DELETING A
-- DRIVER DESTROYED HIS PAID SETTLEMENTS. The lock trigger did not stop it: on a
-- cascade the parent row is already gone, `select status into parent_status`
-- leaves NULL, and `NULL in ('paid','void')` is NULL — so the guard fell through
-- and returned the row unchallenged. Reproduced: one paid settlement of
-- $1,462.50 and its line, gone, no error.
--
-- RESTRICT, not CASCADE. A driver who has ever been paid cannot be deleted; he
-- is terminated. Financial records outlive employment — that is the point of them.
alter table settlements
  drop constraint settlements_driver_id_fkey;

alter table settlements
  add constraint settlements_driver_id_fkey
  foreign key (driver_id) references drivers (id) on delete restrict;

-- ---------------------------------------------------------------- 2. the locks

/**
 * Is this settlement locked?
 *
 * A MISSING parent counts as locked. That is the whole lesson of the cascade
 * above: "I cannot find the settlement" is not evidence that editing is
 * allowed, and a lock that fails open is not a lock.
 */
create or replace function settlement_is_locked(p_id uuid)
returns boolean
language sql
security invoker
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select status in ('paid', 'void') from settlements where id = p_id),
    true
  )
$$;

/**
 * The header lock.
 *
 * Previously an ALLOW-LIST of columns to compare, which silently permitted
 * every column added afterwards — `approved_at`, `approved_by`, `created_at` and
 * `created_by` were all editable on a paid settlement. Rewriting `approved_by`
 * changes who signed off a document whose entire purpose is to be unarguable.
 *
 * Now the comparison is total: everything except the two fields a lock is
 * explicitly allowed to annotate. A column added next year is covered the day
 * it is added, without anybody remembering to come back here.
 */
create or replace function settlements_respect_lock()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  before_j jsonb;
  after_j  jsonb;
begin
  if tg_op = 'INSERT' then
    -- INSERT was not covered at all, so a settlement could be created ALREADY
    -- paid, with any net and no lines — and was then permanently unfixable,
    -- because every subsequent write hit the lock. Reproduced with one REST POST.
    if new.status in ('paid', 'void') then
      raise exception
        'a settlement cannot be created already %. Start it as a draft and mark it paid.',
        new.status;
    end if;
    return new;
  end if;

  if old.status not in ('paid', 'void') then
    -- Still open. But the driver must not move once lines exist: the lines carry
    -- the OTHER driver's snapshotted rate, so his statement would print her
    -- terms with her agreement id on it.
    if new.driver_id is distinct from old.driver_id
       and exists (select 1 from settlement_lines where settlement_id = old.id) then
      raise exception
        'this settlement already has lines built from % pay agreements. Start a new one for the other driver.',
        'the current driver''s';
    end if;
    return new;
  end if;

  before_j := to_jsonb(old) - 'superseded_at' - 'updated_at';
  after_j  := to_jsonb(new) - 'superseded_at' - 'updated_at';

  if before_j is distinct from after_j then
    raise exception
      'settlement % is % and cannot be edited. Create a revision instead.',
      old.id, old.status;
  end if;
  return new;
end;
$$;

drop trigger if exists settlements_lock on settlements;
create trigger settlements_lock
  before insert or update on settlements
  for each row execute function settlements_respect_lock();

/**
 * The line lock.
 *
 * Two holes. It read only `new.settlement_id` on UPDATE, so a line could be
 * MOVED OFF a paid settlement with one PATCH — leaving the frozen total intact
 * above zero lines, which is exactly the drift the design exists to prevent. And
 * it treated a missing parent as unlocked.
 */
create or replace function settlement_lines_respect_lock()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  -- Where the row is going.
  if tg_op in ('INSERT', 'UPDATE') and settlement_is_locked(new.settlement_id) then
    raise exception
      'settlement % is settled — its lines cannot be changed. Create a revision instead.',
      new.settlement_id;
  end if;

  -- Where the row is coming FROM. On UPDATE these differ, and checking only the
  -- destination is what allowed a paid statement to be quietly stripped.
  if tg_op in ('UPDATE', 'DELETE') and settlement_is_locked(old.settlement_id) then
    raise exception
      'settlement % is settled — its lines cannot be changed. Create a revision instead.',
      old.settlement_id;
  end if;

  return case tg_op when 'DELETE' then old else new end;
end;
$$;

drop trigger if exists settlement_lines_lock on settlement_lines;
create trigger settlement_lines_lock
  before insert or update or delete on settlement_lines
  for each row execute function settlement_lines_respect_lock();

-- ---------------------------------------------------------------- 3. paid twice

-- A percentage line could be taken of a load THE DRIVER NEVER RAN — the parent
-- check verified only that the load belonged to the carrier. The equivalent
-- check on the pay agreement's driver was already there; this is its mirror.
create or replace function settlement_line_load_belongs_to_driver()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_driver uuid;
begin
  if new.load_id is null then
    return new;
  end if;

  select s.driver_id into v_driver from settlements s where s.id = new.settlement_id;

  if not exists (
    select 1 from load_assignments a
     where a.load_id = new.load_id
       and a.unassigned_at is null
       and v_driver in (a.driver_id, a.co_driver_id)
  ) then
    raise exception
      'that load is not assigned to this driver — paying him for it would pay somebody else''s work';
  end if;
  return new;
end;
$$;

create trigger settlement_lines_load_driver_check
  before insert or update on settlement_lines
  for each row execute function settlement_line_load_belongs_to_driver();

-- ---------------------------------------------------------------- 4. periods

-- The unique index was on the EXACT tuple, so Mar 1-7 and Mar 3-9 both inserted
-- happily and three days could be paid twice from the same miles.
create extension if not exists btree_gist;

alter table settlements
  add constraint settlements_no_overlapping_periods
  exclude using gist (
    driver_id with =,
    daterange(period_start, period_end, '[]') with &&
  )
  where (status <> 'void' and superseded_at is null);

-- A "revision 2" that supersedes nothing renders as an ordinary statement with
-- no indication it replaces anything.
alter table settlements
  add constraint settlements_revision_supersedes
  check ((revision = 1) = (supersedes_id is null));

-- A settlement for March cannot have been paid in 1999. Reproduced, and it
-- printed "Paid 01 Jan 1999" on the statement header.
alter table settlements
  add constraint settlements_paid_after_period
  check (paid_on is null or paid_on >= period_start);
