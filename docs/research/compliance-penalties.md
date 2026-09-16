# Civil penalty amounts — verified, and one myth to stop repeating

Source: 49 CFR 386 Appendix B (eCFR, current 2026-09-01), amounts set by
**89 FR 106282** (2025 adjustment, effective 2024-12-30, multiplier 1.02598).

## ⚠️ The "$10,000 per day" claim is wrong

Competitor and blog copy routinely says a carrier faces "$10,000/day for failing to
implement a drug and alcohol testing program." Verified against the actual appendix:

- There is **no such line item.** Grepping "implement" across Appendix B returns zero hits.
- The $10,000 figure is the **unadjusted statutory maximum** in 49 U.S.C. 521(b)(2)(A).
- Appendix B(a)(3) **is** that $10,000 after inflation: **$19,246** — and it is stated
  **per violation, not per day.**
- Only the **recordkeeping** entry carries an express daily multiplier. Where Appendix B
  means "per day" it says so explicitly (see (d), (e)(1), (f)(1)-(2)) — and (a)(3), (a)(4)
  and (b) contain no such language.

We must not put the per-day figure in marketing copy. It is checkable, it is wrong, and
the audience includes people who have actually been fined.

## The amounts to hard-code

| Violation | Amount | Appendix B |
|---|---|---|
| Part 382 non-recordkeeping — **employer** | **$19,246** per violation | (a)(3) |
| Part 382 non-recordkeeping — **driver** | **$4,812** per violation | (a)(4) |
| **Clearinghouse** (Part 382 subpart G) — queries, reporting | **$7,155** per violation | (b) |
| Recordkeeping | **$1,584/day**, cap **$15,846** | (a)(1) |
| Knowing falsification of records | **$15,846** | (a)(2) |
| Employer knowingly allowing a CDL driver to operate under an OOS order | **$7,155 – $39,615** | (b)(2) |
| Driver convicted of violating an OOS order | ≥$3,961 first, ≥$7,924 second+ | (b)(1) |
| Driving after a 24-hour alcohol OOS (392.5) | ≤$3,961 first, ≥$7,924 second+ | (a)(5) |

## Two caveats to carry

1. **These are current but stale-risk.** DOT appears to have **skipped the January 2026
   adjustment cycle** — no 2026 rule exists as of 2026-09-14, confirmed three ways
   (FR API on 49 CFR 386, FR API on the Inflation Adjustment Act, and eCFR version
   history). The statutory duty is ongoing, so a catch-up rule could land at any time.
   **Store penalty amounts as data with an effective date, not as constants in code**, and
   watch for the adjustment.

2. Clearinghouse record retention (382.701(e), 3 years) sits under **(b) at $7,155**, not
   under the (a)(1) recordkeeping line — (a)(1) covers Part 382 subparts A–F and
   **excludes subpart G**. FMCSA's May 2025 preamble says something in tension with this;
   how they reconcile it in practice is **UNVERIFIED**.

## Product use

Penalty amounts are good for the *severity ranking* of a deadline and for an honest
"what's at stake" line on an overdue item. They should be shown with the citation and the
effective date visible — the credibility comes from being checkable, and this audience
checks.
