-- A reminder about EVERY driver, or EVERY truck, as one row.
--
-- WHAT WAS MISSING, in the owner's words: "add an option for all drivers or all
-- trucks, just like we have for company — so when the user chooses all drivers
-- we show it to all drivers." A reminder could name the whole company, one
-- driver or one truck, and nothing in between. "Safety meeting" is about every
-- driver he has; filing it against the company hides it from the driver pages,
-- and filing it against one driver is a lie about the other six.
--
-- ONE ROW, NOT N. The other way to build this is to fan out at save time — one
-- reminder per driver — and it is wrong for a reason that only shows up later:
-- seven rows that started identical drift the first time he edits one, and
-- there is no screen that can tell him which of the seven he is looking at. A
-- scope is a property of the reminder, so it is stored on the reminder.
--
-- NULL IS THE EXISTING BEHAVIOUR, exactly. Every row written before this
-- migration keeps the meaning it had: both ids null is the whole company, an id
-- is that record. Nothing is backfilled and nothing changes on anybody's screen
-- until he picks one of the new options.

alter table reminders
  add column subject_scope text
    constraint reminders_subject_scope_known
    check (subject_scope in ('all_drivers', 'all_vehicles'));

comment on column reminders.subject_scope is
  'all_drivers / all_vehicles: one reminder that belongs to every driver or every truck. NULL keeps the original meaning — driver_id or vehicle_id names one record, and both null is the whole company.';

-- A SCOPE AND AN ID CANNOT BOTH BE TRUE.
--
-- "All drivers" and "Aram" are two different answers to one question, and a row
-- carrying both has no honest label on any screen: the dashboard would have to
-- pick one to print. `reminders_one_subject` already refuses a driver AND a
-- truck for the same reason; this is the third corner of the same rule.
alter table reminders
  add constraint reminders_scope_excludes_subject check (
    subject_scope is null or (driver_id is null and vehicle_id is null)
  );

-- No RLS change. The policies on `reminders` from 0023 are TABLE-level — they
-- decide which ROWS a carrier can read and write, and a new column sits inside
-- rows they already cover. A scoped reminder is still one carrier's row.
--
-- No trigger change either. `reminder_subject_belongs_to_carrier` fires on
-- driver_id / vehicle_id, and a scoped row has neither, so there is no
-- cross-tenant reference for it to check.
