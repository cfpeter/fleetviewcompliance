-- A seventh ask: "send the office whatever they asked you for."
--
-- WHAT WAS WRONG, in the owner's words: "i need a button to text the driver
-- regardless — this is an sms that goes to the driver to upload certain files
-- or dates, we shouldn't limit it by some stupid logic."
--
-- He is right about the screen, and the limit was real. The dashboard only
-- offered to text a driver when one of his MISSING dates happened to be one of
-- the six federal papers in 0034. Measured on dev: four of six carriers had no
-- driver who qualified, so the button was simply absent — on a roster where the
-- owner still had every ordinary reason to text the man. "Send me a photo of
-- your tyres." "Where is your fuel receipt." The product had a working way to
-- deliver a link to a phone and no way to press it.
--
-- WHY A SEVENTH LITERAL AND NOT FREE TEXT. 0034 calls `asks` "the scope of an
-- unauthenticated write" and 0038 refused to widen it to arbitrary strings for
-- exactly the right reason: a link carrying free text is a link whose scope
-- cannot be checked here. This adds ONE more closed value, and it is the
-- narrowest possible one — it asks for no date, names no anchor, and writes
-- nothing. The driver page has carried an ungated "Anything else to send?" file
-- box since it was built; every file that arrives through it is filed as
-- `kind = 'other'` with no regulation attached, and no compliance fact moves
-- until the owner accepts it on his own screen, signed in, through RLS.
--
-- So the scope of 'anything' is: one more row in the staging queue, with files
-- nobody has claimed a meaning for. That is strictly less than any of the six.
--
-- 49 CFR 40.307(g) IS UNAFFECTED and stays unaffected. The return-to-duty test
-- date is not askable here for the same reason it is not askable anywhere: it
-- is not a key this value can name, because this value names no key at all.

alter table driver_links drop constraint driver_links_asks_known;

alter table driver_links
  add constraint driver_links_asks_known check (
    asks <@ array['medical', 'cdl', 'spe', 'intracity', 'diabetes', 'vision', 'anything']::text[]
  );

comment on column driver_links.asks is
  'The closed set of things this link may ask for. Six are dated federal papers; "anything" asks for no date at all and only opens the free upload box. ASK_KEYS in src/lib/driver-link/asks.ts is the same list and the two must be changed together.';

-- `driver_links_asks_something` is unchanged: 1 to 6 things between `asks` and
-- `reminder_ids`. 'anything' counts as one of them, which is the point — it is
-- what lets a link exist for a driver who owes no dated paper.
