-- Repeats measured in years, because real fleet dates are.
--
-- WHAT THIS UNBLOCKS. 0023 allowed 0, 1, 3, 6 and 12 months and nothing else,
-- which was right for the cases it was written for — an insurance renewal, a
-- monthly payment. Researching what owners actually track turned up several
-- that the list simply cannot express:
--
--   TWIC card                 5 years   (33 CFR 101.514; TSA)
--   Hazmat endorsement check  5 years   (49 CFR 1572.13(e))
--   Forklift re-evaluation    3 years   (8 CCR 3668(d)(2))
--   Fictitious business name  5 years
--   CA Statement of Info      2 years for an LLC
--
-- Each of those had to ship as a single dated reminder that never comes back —
-- which for a five-year cycle means the owner is told once and then never
-- again, by a product whose whole job is telling him again.
--
-- WHY THESE FIVE NUMBERS AND NOT AN ARBITRARY INTEGER. The constraint is a
-- whitelist on purpose: `nextCycle` steps whole months from the due date, and a
-- free integer invites 18, 30, 45 and a dropdown nobody can read. Two, three
-- and five years are the intervals that turned up in the research; nothing else
-- did.

alter table reminders drop constraint reminders_repeat_known;

alter table reminders
  add constraint reminders_repeat_known check (repeat_months in (0, 1, 3, 6, 12, 24, 36, 60));

comment on constraint reminders_repeat_known on reminders is
  'Whole months, from a fixed list: 0 (one time), 1, 3, 6, 12, 24, 36, 60. REPEAT_OPTIONS in src/lib/reminders.ts is the same list and the form renders it — the two must be changed together.';
