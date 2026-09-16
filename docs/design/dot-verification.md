# Proving somebody owns the USDOT number they typed

A USDOT number is public and sequential. Without a check, the first person to
type one owns that carrier here forever — `carriers.dot_number` is UNIQUE, there
is no invite mechanism and no transfer path, so the real carrier arrives to a
locked door at the moment of highest purchase intent. The whole market is
squattable from a script.

The fix is the obvious one: send a code to a contact on the carrier's own
federal record, and create nothing until it comes back.

## What the federal record actually carries — measured, not assumed

Sampled from the live Socrata census (`az4n-8mr2`), California carriers:

| DOT band | has email | has phone | has neither |
|---|---:|---:|---:|
| oldest registrations | 10% | 62% | **37%** |
| > 1,000,000 | 39% | 99% | 1% |
| > 2,000,000 | 52% | 98% | 0% |
| > 3,000,000 | 99% | 100% | 0% |

**Phone is the primary channel and email is the option.** Designing this
email-first would have failed for roughly half of all carriers and for nine out
of ten of the oldest ones.

A warning about sampling, because it nearly sent this the wrong way: Socrata's
default ordering returns the OLDEST registrations first, from before FMCSA
collected email addresses. The first sample read 10% email / 37% unreachable and
looked like a reason to abandon the flow. Ordered by `dot_number DESC`, the
newest 300 California carriers have **100% email and 100% phone**. Carriers
shopping for software are at the top of the number range.

## There is no second source

`inys-ebih` — the authority dataset this codebase already queries — carries
`bus_telno` but no email. Tested against 60 sampled carriers whose census row
had neither phone nor email: it had a phone for **0 of them**. Those legacy
registrations have no operating-authority record either.

So: **if the census has nothing, nothing does.** Do not add an authority lookup
as a rescue path — it adds a request, a failure mode and some hope, and rescues
nobody. Use `bus_telno` only as a cross-check when the census phone is present.

The consequence is that manual review is not a nicety for a rare edge case. It
is the ONLY path that exists for that population, and the screen must treat it
as a first-class outcome rather than an apology: say plainly that the federal
record carries no phone or email for them, that this is normal for an older
registration, and hand them a way to reach a person with the DOT number and
their account email already stated so the request is actionable on arrival.

## The dev behaviour, which is not the production behaviour

`src/lib/notify/guard.ts` redirects every outbound message outside production,
so on `dev.fleetviewcompliance.com` the verification code goes to
`DEV_REDIRECT_EMAIL` / `DEV_REDIRECT_PHONE` — the developer — and never to the
carrier. That means **on dev, anybody who can reach the site can claim any
carrier.** That is intended, and it is another reason the dev host belongs
behind Cloudflare Access. Nobody should mistake it for how production behaves.

## A limit worth knowing before the support tickets arrive

The phone on a census record is frequently a landline: the office number the
carrier filed. SMS to it silently goes nowhere. A failed send has to offer the
other channel or manual review rather than leaving somebody staring at "we sent
a code" when nothing went out. Voice OTP is the eventual answer if this turns
out to be common.
