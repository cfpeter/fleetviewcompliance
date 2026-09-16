-- Align the header-lock message with the wording the tests and the UI already
-- use. 0018 rewrote this function and changed "edited" to "changed", which is
-- the same meaning and a different string — and a test asserting the message is
-- asserting what the user will actually read.
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
    if new.status in ('paid', 'void') then
      raise exception
        'a settlement cannot be created already %. Start it as a draft and mark it paid.',
        new.status;
    end if;
    return new;
  end if;

  if old.status not in ('paid', 'void') then
    if new.driver_id is distinct from old.driver_id
       and exists (select 1 from settlement_lines where settlement_id = old.id) then
      raise exception
        'this settlement already has lines built from the current driver''s pay agreements. Start a new one for the other driver.';
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
