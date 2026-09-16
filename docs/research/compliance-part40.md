# Part 40 / drug & alcohol — verified facts that change product logic

Sourced from eCFR (Title 49 current as of 2026-09-11) and the Federal Register directly.
ODAPC's own web pages return HTTP 403 and could not be read — every claim below is from
the CFR or FR, which are authoritative anyway.

## 1. Oral fluid testing does not exist in practice — do not offer it

As of 2026-09-01 there are **zero HHS-certified oral fluid laboratories**
(91 FR 56152). DOT's own May 2026 final rule (91 FR 25507, effective 2026-06-10) says so
outright and calls the earlier drafting an "inadvertent factual impossibility."

Every DOT drug test in 2026 is a **urine** test. Any "oral fluid" option in our UI would be
a feature a customer cannot use.

**The trigger to watch:** HHS must certify a *second* oral fluid lab, then ODAPC publishes
an FR notice starting an **18-month grace period**. Two published notices, in that order —
a cheap thing to monitor and a good reason to send an alert when it happens.

## 2. Fentanyl is NOT on the DOT panel — and this is the easiest mistake to make

- **HHS added fentanyl + norfentanyl** (1 ng/mL) effective **2025-07-07** — but that governs
  *federal employee* testing (90 FR 4662).
- **DOT only proposed it** (90 FR 42363, 2025-09-02). Comments closed 2025-10-17.
  **No final rule exists as of 2026-09-14.**

A DOT-regulated CDL driver is tested for **5 drug classes, not 6**: marijuana, cocaine,
expanded opioids, amphetamines, PCP. Full-text search of current Part 40 returns **zero**
occurrences of "fentanyl."

If our marketing or help text says drivers are tested for fentanyl, it is wrong today.

## 3. Two different lookback periods, and they are not interchangeable

This trips people constantly because both live in the same hiring workflow:

| Requirement | Lookback | Cite |
|---|---|---|
| Part 40 previous-employer drug/alcohol records | **2 years** | 40.25(b) |
| FMCSA safety performance history investigation | **3 years** | 391.23(e) |

Also load-bearing for a hiring checklist:
- **Written consent first** — refusal means the employee may not perform safety-sensitive
  functions at all (40.25(a)(1)).
- **30-day hard stop**: the driver may not perform safety-sensitive functions past 30 days
  from first performing them unless the info was obtained *or* a documented good-faith
  effort was made (40.25(d)). ← a real, datable deadline we can track.
- **Retain the record 3 years** from the driver's first safety-sensitive performance (40.25(i)).
- Previous employers must respond **within 30 days** (391.23(g)(1)).

## 4. Return-to-duty follow-up testing — the rules our scheduler must respect

- Minimum **6 unannounced tests in the first 12 months** after return (40.307(d)), and the
  SAP may extend for a further **48 months** — 60 months maximum.
- The SAP sets the *number and frequency*; **the employer picks the actual dates**
  (40.307(d)(3)).
- **The plan follows the employee** to later employers and through breaks in service
  (40.307(e)).
- A **cancelled follow-up test does not count** and must be recollected (40.309).
- ⚠️ **We must never show the follow-up testing schedule to the driver.** 40.307(g) forbids
  the employer, SAP *or service agent* from giving the employee a copy or hinting at
  frequency or duration. ODAPC reiterated this in March 2026 (91 FR 10518).

  **This is a hard constraint on our permission model.** If we ever build a driver-facing
  view, follow-up test scheduling must be invisible to it — not merely un-linked. Worth
  writing into the RLS policy, not just the UI.

## 5. A live typo in the CFR

40.25(a)(2) cites "49 CFR 382.71(a)", which **does not exist**. The correct cite is
**382.701(a)**. DOT acknowledged the error in the 2025 NPRM but the fix is not final — the
typo is still in the CFR today. If we cite it, cite 382.701(a) and don't let a reviewer
"correct" us back.
