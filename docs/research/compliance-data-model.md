## 4. Proposed data model

### 4.1 Design goals

1. **A new state is new rows, not new code.** Every jurisdiction-specific fact lives in a `RuleDefinition` row. The engine only knows how to evaluate generic primitives.
2. **The engine never hardcodes a cadence.** Cadences are expressed as a small algebra of `Recurrence` variants that covers everything found in the research (fixed calendar dates, rolling anniversaries, digit-derived schedules, registration-linked, event-triggered, quarterly-with-fixed-due-dates).
3. **Applicability is data.** Conditional predicates are a serialisable expression tree evaluated against a typed fact bag, not a JS function.
4. **Every obligation resolves to a (subject, due date) pair** so "what expires next" is a single sort.

### 4.2 Core entities

```ts
// ---------- Jurisdictions ----------

/** ISO-ish jurisdiction key. "US" = federal; two-letter = US state. */
export type JurisdictionCode = 'US' | 'CA' | 'AZ' | 'NV' | 'TX' | (string & {});

export interface Jurisdiction {
  code: JurisdictionCode;
  name: string;
  /** Federal rules are inherited by every state-domiciled carrier. */
  parent?: JurisdictionCode;
}

// ---------- What a rule attaches to ----------

export type SubjectType =
  | 'carrier'      // the operating entity
  | 'driver'       // a person
  | 'power_unit'   // tractor / straight truck
  | 'trailer'      // towed unit
  | 'terminal'     // a physical maintenance/dispatch location
  | 'employee';    // non-driver staff (supervisors, mechanics, hazmat employees)

// ---------- Facts the predicates run against ----------

/**
 * The fact bag is deliberately flat and typed. Adding a state may require
 * adding FACT KEYS, but never engine logic: unknown keys simply evaluate
 * to `undefined` and the predicate reports `indeterminate`.
 */
export interface FactBag {
  // carrier facts
  'carrier.usdot_number'?: string;
  'carrier.mc_number'?: string;
  'carrier.domicile_state'?: JurisdictionCode;
  'carrier.operates_interstate'?: boolean;
  'carrier.operates_intrastate'?: boolean;
  'carrier.operation_type'?: 'for_hire' | 'private' | 'both';
  'carrier.power_unit_count'?: number;
  'carrier.driver_count'?: number;
  'carrier.hazmat_placarded'?: boolean;
  'carrier.hazmat_registration_required'?: boolean;
  'carrier.has_security_plan'?: boolean;
  'carrier.transports_passengers'?: boolean;
  'carrier.employs_owner_operators'?: boolean;
  'carrier.states_operated_in'?: JurisdictionCode[];
  'carrier.terminal_count'?: number;
  'carrier.employee_count'?: number;
  'carrier.uses_eld'?: boolean;

  // driver facts
  'driver.hire_date'?: IsoDate;
  'driver.has_cdl'?: boolean;
  'driver.cdl_state'?: JurisdictionCode;
  'driver.hazmat_endorsement'?: boolean;
  'driver.is_excepted_interstate'?: boolean;
  'driver.is_intrastate_only'?: boolean;
  'driver.is_supervisor'?: boolean;
  'driver.is_owner_operator'?: boolean;
  'driver.medcert_expiry'?: IsoDate;
  'driver.medcert_duration_months'?: 3 | 12 | 24 | (number & {});
  'driver.has_medical_variance'?: boolean;

  // vehicle facts
  'vehicle.gvwr_lbs'?: number;
  'vehicle.gcwr_lbs'?: number;
  'vehicle.declared_gross_weight_lbs'?: number;
  'vehicle.model_year'?: number;
  'vehicle.engine_model_year'?: number;
  'vehicle.fuel_type'?: 'diesel' | 'gasoline' | 'cng' | 'lng' | 'electric' | 'hydrogen' | 'hybrid';
  'vehicle.is_zero_emission'?: boolean;
  'vehicle.has_obd'?: boolean;
  'vehicle.axle_count'?: number;
  'vehicle.registration_state'?: JurisdictionCode;
  'vehicle.registration_expiry'?: IsoDate;
  'vehicle.is_apportioned'?: boolean;
  'vehicle.is_power_unit'?: boolean;
  'vehicle.has_reefer'?: boolean;

  // terminal facts
  'terminal.state'?: JurisdictionCode;
  'terminal.vehicles_subject_to_cvc_34500'?: boolean;
  'terminal.last_rating'?: 'satisfactory' | 'conditional' | 'unsatisfactory';
}

export type FactKey = keyof FactBag;
export type IsoDate = string; // 'YYYY-MM-DD'

// ---------- Conditional applicability ----------

export type Predicate =
  | { op: 'always' }
  | { op: 'never' }
  | { op: 'eq'; fact: FactKey; value: unknown }
  | { op: 'neq'; fact: FactKey; value: unknown }
  | { op: 'gt' | 'gte' | 'lt' | 'lte'; fact: FactKey; value: number }
  | { op: 'in'; fact: FactKey; values: unknown[] }
  | { op: 'contains'; fact: FactKey; value: unknown }   // array facts
  | { op: 'exists'; fact: FactKey }
  | { op: 'between'; fact: FactKey; min: number; max: number }
  | { op: 'and'; all: Predicate[] }
  | { op: 'or'; any: Predicate[] }
  | { op: 'not'; of: Predicate };

/**
 * Three-valued so a missing fact is never silently "not applicable".
 * The UI must surface `indeterminate` as "we need to know X about this truck".
 */
export type Applicability = 'applies' | 'does_not_apply' | 'indeterminate';

// ---------- What starts the clock ----------

export type TriggerType =
  | 'hire_date'
  | 'issue_date'              // permit/licence/certificate issued
  | 'last_completion'         // last time the obligation was satisfied
  | 'assignment_date'         // e.g. USDOT number assigned
  | 'identifier_derived'      // schedule computed from an identifier's digits
  | 'fixed_calendar'          // same dates every year regardless of entity
  | 'registration_expiry'     // keyed to a vehicle's DMV registration date
  | 'vehicle_in_service_date'
  | 'event'                   // accident, roadside inspection, positive test
  | 'continuous';             // no expiry; a standing state to monitor

// ---------- Cadence ----------

export type Month = 1|2|3|4|5|6|7|8|9|10|11|12;

export type Recurrence =
  /** "at least once every N months", measured from the anchor. */
  | { kind: 'rolling'; months: number; anchor: 'last_completion' | 'issue_date' | 'hire_date' }

  /** "at least once every N days". */
  | { kind: 'rolling_days'; days: number; anchor: 'last_completion' | 'issue_date' }

  /** Same date(s) every year. Multiple entries = multiple deadlines/yr. */
  | { kind: 'fixed_annual'; dates: { month: Month; day: number }[] }

  /** Quarterly periods each with their own fixed due date. */
  | {
      kind: 'fixed_quarterly';
      periods: {
        periodMonths: [Month, Month, Month];
        dueMonth: Month;
        dueDay: number;
        /** due date lands in the year AFTER the period ends */
        dueNextYear?: boolean;
      }[];
    }

  /**
   * Schedule derived from digits of an identifier — the MCS-150 case.
   * `monthFromDigit` maps the identifier's last digit to a month;
   * `yearParityFromDigit` maps the next-to-last digit's parity to which
   * calendar years are filing years.
   */
  | {
      kind: 'identifier_digit';
      identifierFact: FactKey;
      monthSelector: { digitFromEnd: 1; map: Record<string, Month> };
      yearSelector: { digitFromEnd: 2; parity: 'odd_digit_odd_year_even_digit_even_year' };
      dueOn: 'last_day_of_month';
    }

  /** Due relative to a per-entity external date (e.g. DMV registration expiry). */
  | { kind: 'relative_to_fact'; fact: FactKey; offsetDays: number; window?: { opensDaysBefore: number } }

  /** Fires only on an event; `dueWithin` from the event timestamp. */
  | { kind: 'event_driven'; event: string; dueWithinHours?: number; dueWithinDays?: number }

  /** A set number of occurrences within a window (382.311 follow-up testing). */
  | { kind: 'n_within'; count: number; windowMonths: number; maxExtensionMonths?: number }

  /** No recurrence; one-time on trigger. Tracked for evidence, not expiry. */
  | { kind: 'one_time' }

  /** Ongoing state with no due date; monitored, not scheduled. */
  | { kind: 'continuous_monitor' };

// ---------- Evidence ----------

export type EvidenceLocation =
  | 'driver_qualification_file'
  | 'driver_investigation_history_file'   // must be access-controlled (391.53)
  | 'carrier_office'
  | 'terminal'                            // "where the vehicle is housed or maintained"
  | 'on_vehicle'                          // must physically travel with the unit
  | 'in_vehicle_documents'
  | 'state_agency_portal'
  | 'third_party_administrator'
  | 'secure_restricted';                  // drug & alcohol records (382.401)

export interface EvidenceSpec {
  /** Human name of the proving document. */
  documentName: string;
  /** Where it must be kept / produced. */
  locations: EvidenceLocation[];
  /** Retention measured from the stated anchor. */
  retention?: {
    months: number;
    anchor: 'document_date' | 'employment_end' | 'vehicle_leaves_control' | 'accident_date';
    /** Some items may be purged from the DQF earlier than the file itself. */
    purgeableFromFileAfterMonths?: number;
  };
  /** Whether a digital copy satisfies (49 CFR 390.32 for DVIRs, etc.). */
  electronicAllowed?: boolean;
}

// ---------- Consequences ----------

export type ConsequenceKind =
  | 'civil_penalty'
  | 'per_day_penalty'
  | 'driver_out_of_service'
  | 'vehicle_out_of_service'
  | 'registration_hold'
  | 'authority_revocation'
  | 'usdot_deactivation'
  | 'permit_suspension'
  | 'cdl_downgrade'
  | 'criminal'
  | 'rating_downgrade';

export interface Consequence {
  kind: ConsequenceKind;
  minUsd?: number;
  maxUsd?: number;
  perDay?: boolean;
  /** Free text for things money doesn't capture. */
  note?: string;
  citation?: string;
}

// ---------- Warning windows ----------

export interface WarningWindow {
  /** Days before due at which to raise each severity. Descending. */
  notice: number;
  warning: number;
  critical: number;
  /**
   * Some obligations need lead time because the remediation itself
   * takes time (booking a DOT physical, scheduling a CARB test).
   * This is the realistic minimum to *start*.
   */
  minimumLeadTimeDays: number;
}

// ---------- The rule definition ----------

export interface RuleDefinition {
  id: string;                       // stable slug, e.g. 'us.fmcsa.391.25.annual-mvr'
  jurisdiction: JurisdictionCode;
  agency: string;                   // 'FMCSA' | 'CARB' | 'CA DMV' | 'CHP' | 'CDTFA' | 'IRS' | 'PHMSA'
  name: string;
  citations: Citation[];
  subject: SubjectType;
  trigger: TriggerType;
  recurrence: Recurrence;
  appliesIf: Predicate;
  evidence: EvidenceSpec;
  consequences: Consequence[];
  warning: WarningWindow;

  /**
   * THE PORTABILITY HOOK.
   * For a state-specific rule, this names the generic question another
   * state's ruleset must answer. When adding Arizona, you enumerate every
   * `equivalentQuestion` in the CA set and ask "what is Arizona's answer?".
   * Federal rules leave this undefined.
   */
  equivalentQuestion?: string;

  /** Rules that supersede/absorb this one in some jurisdictions. */
  supersededBy?: string[];
  /** Satisfying this rule also satisfies these (e.g. CA EPN vs 391.25). */
  alsoSatisfies?: string[];

  verifiedOn: IsoDate;
  /** Set when the rule changed recently; drives a "re-verify" queue. */
  volatility: 'stable' | 'changed_recently' | 'in_rulemaking' | 'contested';
  notes?: string;
}

export interface Citation {
  label: string;                    // '49 CFR 391.25(a)'
  url: string;                      // primary source
  kind: 'cfr' | 'usc' | 'cvc' | 'ccr' | 'hsc' | 'labor_code' | 'gov_code' | 'agency_guidance' | 'federal_register';
}

// ---------- Computed output ----------

export interface ObligationInstance {
  ruleId: string;
  subjectType: SubjectType;
  subjectId: string;                // driver id, VIN, terminal id, carrier id
  subjectLabel: string;
  periodStart?: IsoDate;
  dueDate: IsoDate | null;          // null for continuous_monitor
  status: 'satisfied' | 'due' | 'overdue' | 'upcoming' | 'not_applicable' | 'indeterminate';
  severity: 'none' | 'notice' | 'warning' | 'critical' | 'breach';
  lastSatisfiedOn?: IsoDate;
  evidenceRefs: string[];
  /** Why the engine thinks this applies — for auditability. */
  applicabilityTrace: { predicate: Predicate; result: Applicability }[];
}
```

### 4.3 The engine's only job

```ts
export function evaluate(
  rules: RuleDefinition[],
  facts: FactBag,
  subjects: Subject[],
  history: CompletionRecord[],
  asOf: IsoDate,
): ObligationInstance[];
```

Four pure functions underneath, none of which know any jurisdiction:

| Function | Responsibility |
|---|---|
| `resolveApplicability(pred, facts)` | walk the predicate tree → `applies` / `does_not_apply` / `indeterminate` |
| `nextDueDate(recurrence, anchors, asOf)` | one `switch` over `Recurrence.kind` |
| `severityFor(dueDate, warning, asOf)` | map days-remaining onto the window thresholds |
| `expandSubjects(rule, fleet)` | fan a `subject: 'power_unit'` rule out to every truck |

### 4.4 Adding a new state

Adding, say, Arizona is three data operations and zero code:

1. Insert a `Jurisdiction` row `{ code: 'AZ', parent: 'US' }`.
2. For each CA rule carrying an `equivalentQuestion`, answer it for AZ and insert a row (or insert nothing, if AZ has no analogue — e.g. AZ has no Clean Truck Check equivalent, so the emissions-testing question resolves to "none").
3. Add any AZ-only fact keys to `FactBag`. *(This is the one TypeScript edit — and it is additive and type-only. If you would rather have zero code changes, type the bag as `Record<string, unknown>` with a runtime schema registry per jurisdiction; the trade-off is losing compile-time fact-key checking.)*

The `equivalentQuestion` values from the California set form the portability checklist:

| CA rule | `equivalentQuestion` |
|---|---|
| CARB Clean Truck Check | *Does this state run a periodic heavy-duty emissions inspection program, and is it linked to registration?* |
| CA DMV Motor Carrier Permit | *Does this state require a state-level intrastate operating permit, and on what renewal cycle?* |
| CHP BIT terminal inspection | *Does this state inspect carrier terminals on a cycle, and what does it require be produced?* |
| CA 90-day periodic inspection | *Does this state impose a vehicle inspection interval shorter than the federal 12 months?* |
| CA DMV Employer Pull Notice | *Does this state offer/require automatic driver-record monitoring, and does it satisfy 391.25?* |
| CVRA weight decal | *How does this state assess and renew commercial weight fees?* |
| CA workers' comp / IIPP / harassment / WVPP training | *What recurring state employment-law obligations attach to employing drivers?* |
| AB 5 classification | *What is this state's worker-classification test for owner-operators?* |

IFTA and IRP deliberately carry `jurisdiction: 'US'`-style treatment as **multi-jurisdiction agreements**: the cadence is identical in every member jurisdiction, only the *base jurisdiction* (and therefore the filing portal and penalty schedule) changes. Model them once with a `baseJurisdictionFact` rather than duplicating per state.
