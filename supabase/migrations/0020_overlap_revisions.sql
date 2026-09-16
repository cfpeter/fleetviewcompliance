-- The overlap constraint must not fight the revision chain.
--
-- 0018 added an exclusion constraint so that Mar 1-7 and Mar 3-9 could not both
-- exist and pay three days twice. Correct intent, wrong scope: a REVISION
-- covers exactly the same period as the settlement it replaces — that is what
-- makes it a revision — so `revise` started failing with
-- "conflicting key value violates exclusion constraint".
--
-- Adding `revision with =` compares a row only against others at the SAME
-- revision number. Two independent settlements still cannot overlap (both are
-- revision 1); a revision 2 no longer collides with the revision 1 it corrects.
alter table settlements
  drop constraint settlements_no_overlapping_periods;

alter table settlements
  add constraint settlements_no_overlapping_periods
  exclude using gist (
    driver_id with =,
    revision with =,
    daterange(period_start, period_end, '[]') with &&
  )
  where (status <> 'void');
