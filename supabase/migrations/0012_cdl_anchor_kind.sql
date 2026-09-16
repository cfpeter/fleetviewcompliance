-- The CDL expiry is a STATEMENT, not an occurrence.
--
-- A driver holds one current licence. When the office corrects a fat-fingered
-- 2037 to 2027, the correction must win — and it only does if the anchor is
-- registered here. Without this row the view orders by occurred_on, the typo
-- sits further in the future, and the wrong date is permanent no matter how
-- many times it is retyped.
--
-- tests/anchor-kinds.test.ts fails when the catalogue gains an `expiry` anchor
-- that is missing from this table. It is what caught this one.
insert into anchor_kinds (anchor_key, kind)
values ('cdl_expires', 'statement')
on conflict (anchor_key) do update set kind = excluded.kind;

update compliance_records
   set anchor_kind = 'statement'
 where anchor_key = 'cdl_expires'
   and anchor_kind is distinct from 'statement';
