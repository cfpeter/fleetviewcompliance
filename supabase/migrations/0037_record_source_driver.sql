-- 'driver' joins the list of places a date can come from.
--
-- `record_source` has been ('owner', 'fmcsa', 'import') since 0002 and is used
-- by drivers.source, vehicles.source, compliance_records.source, the two IFTA
-- tables and carriers.operation_source. Every one of those answers the same
-- question: who said so.
--
-- With driver links (0034–0036) there is a fourth answer, and it is the one an
-- owner will most want months later — "did I type this, or did Aram send it in
-- from his phone?" Without it, an accepted submission is indistinguishable from
-- something the office typed, and the whole point of making the owner accept it
-- was that the two are not the same thing.
--
-- ITS OWN FILE ON PURPOSE. Postgres will not let a new enum value be USED in the
-- transaction that adds it, and scripts/migrate.mjs runs one transaction per
-- file. Anything that writes 'driver' therefore has to live in a later
-- migration, or at runtime — which is where it does live.

alter type record_source add value if not exists 'driver';
