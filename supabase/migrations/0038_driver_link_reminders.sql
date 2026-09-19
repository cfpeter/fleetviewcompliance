-- Asking a driver about the owner's OWN reminders, not only the six federal papers.
--
-- WHAT WAS MISSING, in the owner's words: "we also need to send the reminders to
-- driver... we should add reminder or maybe a custom input or something owner
-- can ask the driver to upload or like tyre check or engine oil". A link could
-- carry a medical card, a licence and four conditional exemptions, and nothing
-- else — so the one thing an owner asks a driver for every week, "send me a
-- photo of the tires", had no way onto the page at all.
--
-- A REMINDER IS THE CUSTOM INPUT. He already has a screen that makes one, it
-- already carries any title he likes, it already scopes to one driver or to
-- every driver (0032), and it already has a due date and a repeat. Adding a
-- second free-text question here would be a second thing that means the same
-- as a reminder and cannot be completed, counted or reported on. A one-off is a
-- reminder set to "does not repeat".
--
-- `asks` STAYS A CLOSED SET, and that is the reason for a second column rather
-- than a seventh ask. 0034 calls `asks` "the scope of an unauthenticated write"
-- and constrains it to six literal strings; widening it to arbitrary text would
-- throw that away for every link, including the ones carrying nothing but
-- federal papers. Reminder ids are uuids that must name the owner's own open
-- reminder for this driver, which is a different and narrower claim.

alter table driver_links
  add column reminder_ids uuid[] not null default '{}'::uuid[];

comment on column driver_links.reminder_ids is
  'The owner''s own reminders this link also asks about. Validated by trigger against reminders: open, same carrier, and either this driver''s or scoped to all drivers. No FK — Postgres has none for array elements, which is exactly what the trigger is for.';

-- ------------------------------------------------------------ what it may ask
--
-- The old constraint said `array_length(asks, 1) between 1 and 6`. Two things
-- change and both matter:
--
--   1. A link may now ask for NO federal paper at all — "send me a tire photo"
--      is a whole errand. `array_length` on an empty array is NULL, not 0, and
--      a CHECK that evaluates to NULL passes, so the old wording had already
--      stopped refusing an empty `asks` by accident. The new one says what it
--      means with coalesce.
--   2. SIX QUESTIONS IS THE CEILING FOR THE WHOLE LINK, papers and reminders
--      together. The number is not about storage: it is how many boxes a man
--      answers on a phone in a yard before he sends half of it or none.
alter table driver_links drop constraint driver_links_asks_known;

alter table driver_links
  add constraint driver_links_asks_known check (
    asks <@ array['medical', 'cdl', 'spe', 'intracity', 'diabetes', 'vision']::text[]
  );

alter table driver_links
  add constraint driver_links_asks_something check (
    coalesce(array_length(asks, 1), 0) + coalesce(array_length(reminder_ids, 1), 0)
      between 1 and 6
  );

-- --------------------------------------------------------- whose reminders
--
-- SECURITY INVOKER, the same reasoning as driver_links_driver_belongs_to_carrier
-- above it and documents_subject_belongs_to_carrier in 0003: running as the
-- calling user means the SELECT is itself subject to RLS, so another carrier's
-- reminder is simply invisible and the check fails. A DEFINER version would run
-- as the table owner and answer a question nobody asked.
--
-- FOUR CONDITIONS, and each one is a different way to send a driver a question
-- he cannot answer:
--   - same carrier: the tenancy rule, enforced here rather than trusted.
--   - still open: a reminder the owner finished last month is not an errand.
--   - his, or every driver's: a reminder about ONE OTHER DRIVER, or about a
--     truck, names something this man has no standing to report on.
--   - no duplicates: the same question twice on one page reads as a mistake in
--     the app, and it would also let one pick eat two of the six slots.
--
-- ON UPDATE OF reminder_ids ONLY, deliberately. `driver_link_submit` in 0036 is
-- SECURITY DEFINER and stamps `used_at` on this table; firing there would run
-- this check as the definer, and a reminder the owner completed between sending
-- the link and the driver opening it would make the driver's submit fail with a
-- database error he can do nothing about.
create or replace function driver_links_reminders_belong()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  n int := coalesce(array_length(new.reminder_ids, 1), 0);
  usable int;
begin
  if n = 0 then
    return new;
  end if;

  select count(distinct r.id) into usable
    from reminders r
   where r.id = any (new.reminder_ids)
     and r.carrier_id = new.carrier_id
     and r.completed_at is null
     and (r.driver_id = new.driver_id or r.subject_scope = 'all_drivers');

  if usable <> n then
    raise exception
      'a driver link may only name open reminders for this driver or for all drivers';
  end if;

  return new;
end;
$$;

create trigger driver_links_reminders_check
  before insert or update of reminder_ids on driver_links
  for each row execute function driver_links_reminders_belong();
