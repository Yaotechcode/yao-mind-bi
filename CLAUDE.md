# Yao Mind — CLAUDE.md

BI engine for UK law firms. Ingests practice management exports → runs an 8-stage pipeline → formula engine → 6 dashboards.

See full system design in `ARCHITECTURE.md`.

---

## Tech Stack

- **Backend/logic**: TypeScript (strict), Netlify Functions, Zod validation, Vitest
- **Auth + config DB**: Supabase (PostgreSQL + RLS)
- **Data DB**: MongoDB Atlas
- **Frontend**: Lovable.dev — built separately, not in this repo
- **Hosting**: Netlify
- **Version control**: GitHub — every session ends with a commit and push

---

## Project Structure

```
/src/shared/     — types, entity definitions, formula definitions, Zod validators
/src/client/     — browser-side parsers only
/src/server/     — Netlify Functions + services + lib (supabase, mongodb, auth-middleware)
/scripts/        — one-time migration and seeding scripts
/tests/          — mirrors /src structure
```

---

## Non-Negotiable Rules

**firm_id on every MongoDB query.** MongoDB has no native RLS. Every query function takes `firmId` as its first parameter and includes it in every filter. No exceptions.

**Always push to GitHub.** End every session with `git add -a && git commit -m "..." && git push`.

**Work through prompts in order.** Each phase (1A → 1B → 1C...) builds on the previous. Do not skip ahead.

**Verify before proceeding.** Each prompt has explicit verification steps. Pass them all before starting the next prompt.

**No colours or theming.** A separate theme guide exists. Never suggest or hardcode colour values.

**Null-safe formulas.** Every formula implementation must handle missing/null data gracefully and return null (not throw) when required inputs are absent.

**Formulas are pure functions.** `f(data, config) → result`. No side effects, no state mutation.

---

## Build & Test Commands

```bash
npm run build          # TypeScript compile
tsc --noEmit           # Type-check only (run after every change)
npm test               # Vitest (run after every change to affected files)
npm run lint           # Linter
```

After every change: run `tsc --noEmit` and the relevant test file. Fix all errors before committing.

---

## Key Patterns

**Netlify Function structure** — every function follows this exact pattern:
1. Call `authenticateRequest(event)` from `src/server/lib/auth-middleware.ts`
2. Extract `firmId` from the result
3. Call the relevant service function
4. Return typed response with correct HTTP status (200/400/401/403/500)

**Service functions** — every service function takes `firmId` as its first parameter. Never trust `firmId` from the request body — always derive it from the authenticated user.

**Supabase RLS** — `get_user_firm_id()` extracts the calling user's firm via `auth.uid()`. All tables have RLS enabled. Never use the service role key client-side.

**Config updates** — always write to `audit_log` (old value, new value, path, userId) before or alongside the update. Use `updateFirmConfig()` from the config service, never raw JSONB writes.

**Entity registry** — when creating/updating custom fields, always update both `custom_fields` table AND the relevant entity's `fields` array in `entity_registry`. These must stay in sync.

**Cross-reference registry** — the `CrossReferenceRegistry` in MongoDB maps between identifier forms (matterId ↔ matterNumber, lawyerId ↔ lawyerName, contactId ↔ displayName, departmentId ↔ name). It is built in pipeline Stage 3, persisted to MongoDB (`cross_reference_registries` collection), and extended (not replaced) on each new upload. When debugging join failures, check the registry coverage stats in the DataQualityReport first.

**Pipeline stage order** — Parse → Normalise → Cross-Reference → Index → Join → Enrich → Aggregate → Calculate. Cross-Reference (Stage 3) must run before Index (Stage 4). Never build indexes from un-resolved records.

**Formula readiness** — every formula result carries a `FormulaReadinessResult` (READY / PARTIAL / BLOCKED / ENHANCED). BLOCKED formulas must not execute. All KPI API responses include readiness metadata. The UI uses this to render confidence indicators.

**Formula versioning** — every formula definition change creates a new version in `formula_versions` table. Calculated KPI documents reference the `formulaVersionSnapshot` used to produce them. Never mutate a formula definition in place — always version it.

---

## Phase 1B: Pipeline & Data Layer (complete)

### Pipeline stage sequence

Each upload triggers Stages 2–7 inside `runFullPipeline` in `src/server/pipeline/pipeline-orchestrator.ts`. Stages run in this exact order — never reorder them.

| Stage | Name | Input | Output | Key type |
|-------|------|-------|--------|----------|
| 1 | **Parse** | Raw file (client-side) | Detected columns + raw rows | `ParseResult` |
| 2 | **Normalise** | `ParseResult` + column mappings | Entity-typed records; invalid rows rejected | `NormaliseResult` / `NormalisedRecord[]` |
| 3 | **Cross-Reference** | All normalised datasets + existing registry | Extended registry; both identifier forms on every record | `CrossReferenceRegistry` |
| 4 | **Index** | All cross-referenced datasets | Lookup Maps (by id, by number, by name) | `PipelineIndexes` |
| 5 | **Join** | Indexes + datasets | Records with resolved cross-entity references (`hasMatchedMatter`, `clientResolved`, `isOverdue`, etc.) | `JoinResult` |
| 6 | **Enrich** | `JoinResult` | Derived fields added (`durationHours`, `isChargeable`, `recordedValue`, `ageInDays`, `weekNumber`, `monthKey`, `ageBand`, `firmExposure`) | `JoinResult` (updated in place) |
| 7 | **Aggregate** | Enriched `JoinResult` + available file types | Per-firm, per-fee-earner, per-matter, per-client, per-department summaries + data quality report | `AggregateResult` |

After Stage 7 the orchestrator persists:
- **`enriched_entities`** — fully join-enriched records for all 8 entity types (timeEntry, matter, feeEarner, invoice, client, disbursement, task, department), one snapshot per upload
- **`calculated_kpis.kpis.aggregate`** — the complete `AggregateResult` JSON, accessed via `getLatestCalculatedKpis(firmId)`

### Key aggregated field names for the formula engine

The formula engine (Phase 1C) reads from `calculated_kpis.kpis.aggregate`. These are the exact field names on each type:

**`AggregatedFeeEarner`** (`aggregate.feeEarners[]`):
- Effort: `wipTotalHours`, `wipChargeableHours`, `wipNonChargeableHours`, `wipEntryCount`
- Value: `wipChargeableValue`, `wipTotalValue`, `wipWriteOffValue`
- Orphaned WIP: `wipOrphanedHours`, `wipOrphanedValue`
- Billing: `invoicedRevenue`, `invoicedOutstanding`, `invoicedCount`
- Activity gap: `recordingGapDays` (calendar days since last WIP entry — null if no entries)
- Identity: `lawyerId`, `lawyerName`

**`AggregatedMatter`** (`aggregate.matters[]`):
- Effort: `wipTotalHours`, `wipChargeableHours`, `wipNonChargeableHours`, `wipTotalBillable`, `wipTotalWriteOff`
- Billing: `invoicedNetBilling`, `invoicedDisbursements`, `invoicedTotal`, `invoicedOutstanding`, `invoicedPaid`, `invoicedWrittenOff`, `invoiceCount`
- Discrepancy: `discrepancy.billingDifference`, `discrepancy.billingDifferencePercent`, `discrepancy.hasMajorDiscrepancy` (threshold >10%)
- Identity: `matterId`, `matterNumber`

**`AggregatedFirm`** (`aggregate.firm`):
- Effort: `totalWipHours`, `totalChargeableHours`, `totalWipValue`, `totalWriteOffValue`
- Revenue: `totalInvoicedRevenue`, `totalOutstanding`, `totalPaid`
- Orphaned WIP summary: `orphanedWip.orphanedWipEntryCount`, `orphanedWip.orphanedWipHours`, `orphanedWip.orphanedWipValue`, `orphanedWip.orphanedWipPercent`
- Fee earner counts: `feeEarnerCount`, `activeFeeEarnerCount`, `salariedFeeEarnerCount`, `feeShareFeeEarnerCount`

**`EnrichedTimeEntry`** (individual records from `enriched_entities`, entity type `timeEntry`):
- `durationHours`, `isChargeable`, `recordedValue`
- `hasMatchedMatter` (false = orphaned), `lawyerGrade`, `lawyerPayModel`
- `ageInDays`, `weekNumber`, `monthKey`

## Phase 1C: Formula Engine (complete)

Phase 1C complete — Formula Engine, 23 formulas, 5 snippets, custom executor, 10 templates, AI translation, sandbox, orchestration API, formula intelligence API. 1020 tests passing. Committed and pushed.

### Architecture
- Formulas are pure functions: f(data, config) → result. No DB calls inside formulas.
- Snippets execute BEFORE formulas (dependency order). Results available via context.snippetResults.
- Readiness checker runs BEFORE execution: BLOCKED formulas never execute, PARTIAL formulas flag missing inputs.
- Every formula result carries metadata: computedAt, variantUsed, nullReasons, breakdown.
- Formula versions tracked in formula_versions table (migration 003). KPI documents reference version snapshot.

### Field names from pipeline (formulas MUST use these exact names)
- AggregatedFeeEarner: wipTotalHours, wipChargeableHours, wipNonChargeableHours, wipTotalBillable, wipTotalWriteOff, invoicedNetBilling, invoicedTotal, invoicedOutstanding, invoicedPaid, recordingGapDays, lastRecordedDate, orphanedWip.orphanedWipEntryCount, orphanedWip.orphanedWipValue
- AggregatedMatter: wipTotalBillable, wipTotalHours, wipTotalWriteOff, invoicedNetBilling, invoicedOutstanding, invoicedPaid, budget, isFixedFee, disbursementTotal, disbursementOutstanding
- AggregatedFirm: firm-wide totals of all above

### Prompt sequence (16 prompts)
1C-01 → 1C-01b → 1C-01c → 1C-02 → 1C-03 → 1C-04 → 1C-05 → 1C-06 → 1C-07 → 1C-08 → 1C-09 → 1C-09b → 1C-09c → 1C-09d → 1C-10 → 1C-10b

### Dual source of truth

Two independent data sources cover overlapping ground — their values will differ and must never be silently reconciled:

- **WIP / time recording** (`wipJson`) = source of truth for **effort**: hours billed, write-offs, chargeability, fee earner activity. Use `wipTotalBillable`, `wipTotalHours`, `wipWriteOffValue`.
- **Yao invoiced data** (`invoicesJson`, `fullMattersJson`) = source of truth for **revenue**: what was actually invoiced and collected. Use `invoicedNetBilling`, `invoicedOutstanding`, `invoicedPaid`.

When both sources cover the same matter, `AggregatedMatter.discrepancy` captures the gap. `hasMajorDiscrepancy: true` means the difference exceeds 10%. Formulas that mix both sources must document which source they use for each component. Flag discrepancies to the user — never silently pick one.

### Known data characteristics

These are structural realities of the real firm data, not bugs. Formulas must handle them gracefully:

**~49% WIP orphan rate** — approximately half of all WIP entries have no matched matter (`hasMatchedMatter: false`). Causes: WIP uses `matterId` (UUID), matter exports use `matterNumber` (integer); if the cross-reference registry doesn't have the mapping yet, the entry is orphaned. Orphaned entries are included in firm-level and fee-earner-level totals (`wipOrphanedHours`, `wipOrphanedValue`) but excluded from matter-level analysis. Never drop them silently.

**`responsibleLawyerId` sometimes missing on matters** — the full matters export does not always include the lawyer's UUID, only their display name (`responsibleLawyer`). When `responsibleLawyerId` is null, use the cross-reference registry to resolve from name, then fall back to `responsibleLawyer` as a display-only value. Formulas that join matter data to fee earner data must handle this — do not assume the UUID is always present.

**`datePaid` not yet in invoice data** — the current invoice export does not include a payment date. This field has `missingBehaviour: 'degrade'` in the entity registry. Any formula that calculates cash collection speed or aged debt will run in PARTIAL/BLOCKED readiness until `datePaid` is populated. Design those formulas to return null gracefully when `datePaid` is absent.

**`lawyerGrade` depends on fee earner CSV** — `lawyerGrade` and `lawyerPayModel` on `EnrichedTimeEntry` records are populated from the fee earner CSV file. If that file has not been uploaded, both fields are null on every time entry. Grade-dependent formulas (utilisation targets, cost rate by grade) will be BLOCKED until the fee earner file is present.

### Known data gaps

These fields are structurally absent from the current Metabase exports. Any formula that depends on them will run at PARTIAL or BLOCKED readiness until the query is updated:

- **`datePaid` absent from invoice export** — F-WL-04 `from_payment_date` variant falls back to `daysOutstanding`; aged debt formulas cannot compute actual days-to-payment. Fix: add `Date Paid` to the Metabase invoice query.
- **~49% WIP orphan rate** — F-WL-04 average-of-ages under-represents lock-up because orphaned time entries (no matched matter) are excluded from the per-matter WIP age average. Fix: upload both WIP and Full Matters so the cross-reference registry can resolve `matterId` ↔ `matterNumber`.
- **`activityType` absent from WIP export** — F-TU-03 (non-chargeable breakdown) cannot sub-categorise time by activity. Fix: add `Activity Type` to the Metabase WIP query (future Metabase schema extension).
- **Client IDs absent from matters export** — matter → client joins use `responsibleLawyer` name string, which is fragile (name variations cause missed joins). Fix: add Client ID column to Full Matters Metabase query.

### Known limitations

Implementation-level constraints to be aware of:

- **Rate limiter is in-memory only** — the AI formula-translator rate limiter resets on each cold-start. Under concurrent invocations (multiple Netlify instances), the per-minute limit can be exceeded. Acceptable for MVP; fix with Redis or Supabase counter before multi-firm production.
- **F-CS-02 uses firm-level realisation as per-earner proxy** — the composite scorecard uses the firm's overall realisation rate as a proxy for each fee earner's realisation score when per-earner data is unavailable. This overestimates high-billing earners and underestimates low-billing ones.
- **SN-001 and SN-004 compute annual cost independently** — annual salary (SN-001) and total cost including overhead (SN-004) are computed by separate snippets without cross-validation. If overhead config changes between snippet executions (unlikely but possible), the two snippets may use different effective rates.
- **F-WL-04 uses average-of-ages, not stock/flow ratio** — see deliberate deviations below.

### Deliberate deviations from spec

Where the implementation intentionally differs from the formula specification:

- **F-WL-04 Lock-Up (average-of-ages vs stock/flow ratio)** — the spec defines lock-up days as `(wipTotalBillable + invoicedOutstanding) / (invoicedNetBilling / 365)` (stock/flow ratio). The implementation uses `avgWipAgeInDays + avgDebtorDaysOutstanding` (average-of-ages), which is more intuitive for daily operational monitoring but under-represents lock-up when the orphan rate is high. A future variant `stock_flow_ratio` should implement the spec formula once orphan rates decrease. See comment in `src/server/formula-engine/formulas/wip-leakage.ts`.

### Metabase query fixes needed

The following changes to Metabase queries will unlock currently PARTIAL/BLOCKED formulas:

| Priority | Query | Change needed | Formulas unlocked |
|----------|-------|---------------|-------------------|
| High | Invoices | Add `Date Paid` column | F-WL-04 `from_payment_date`, aged debt analysis |
| High | Full Matters | Add Client ID column | Client → matter joins |
| High | Full Matters | Remove status filter (if any) — include all statuses | Cross-reference completeness |
| Medium | WIP (Lawyer Time) | Add `Activity Type` column | F-TU-03 non-chargeable breakdown |

---

## Data Model Essentials

**Dual source of truth**: Yao (billing) for money, WIP (time recording) for hours. Flag discrepancies — never silently resolve them.

**Pay model is first-class**: fee share vs salaried affects every profitability formula. Always check `payModel` before calculating costs. See `SN-005` in formula registry.

**Extensible fields**: some entity fields are defined but not yet populated (e.g. `activityType` on TimeEntry, `datePaid` on Invoice). These have `missingBehaviour` and `enablesFeatures` metadata. Dashboards must adapt gracefully when these are absent.

**WIP orphan gap**: ~49% of WIP entries lack a matched matter. The pipeline flags these as `hasMatchedMatter: false`. Never drop them silently.

**Mixed identifier types**: different exports use different identifier forms for the same entity. WIP uses `matterId` (UUID); invoices use `matterNumber` (integer). Fee earner CSV uses names where WIP uses `lawyerId`. The Cross-Reference engine (Stage 3) resolves this by building mapping dictionaries from rows that contain both forms, then applying them across all datasets. Never assume two datasets use the same identifier form for the same entity.

---

## Configuration Tiers (Quick Reference)

- **Tier 1** — Firm Profile (set once): working time, pay model defaults, revenue attribution
- **Tier 2** — Formula Config (periodic): cost rate method, fee share %, overhead, scorecard weights  
- **Tier 3** — RAG Thresholds (frequent): per-metric green/amber/red with per-grade overrides

All config lives in Supabase `firm_config` as JSONB. Use `getFirmConfig()` / `updateFirmConfig()` — never raw queries.

---

## When Things Go Wrong

- Type errors → run `tsc --noEmit` and fix all before proceeding
- Test failures → fix before committing; never commit with failing tests
- RLS issues → verify `get_user_firm_id()` returns the correct firm for the test user
- MongoDB isolation → check that every query includes `firm_id` in the filter
- Formula returns wrong value → check `payModel` branching and null handling first
- Config not persisting → check audit_log; if no entry, the write didn't go through config service
- Join failure (matter not found) → check `CrossReferenceRegistry` coverage stats in DataQualityReport; the record may have only one identifier form and the registry may not yet have the mapping (upload the file type that contains both forms)
- Identifier conflict in cross-reference → check `CrossReferenceConflict[]` in the registry stats; a conflict means two datasets disagree on the mapping — priority order is fullMatters > closedMatters > wip > invoice > disbursements > tasks
- Formula readiness BLOCKED unexpectedly → check `DataAvailabilitySummary.loadedDataSources` against the formula's declared data requirements; the required file type may not have been uploaded yet
- Formula version mismatch → KPI results reference a `formulaVersionSnapshot`; if numbers change unexpectedly after a formula edit, compare the snapshot definition against the current formula registry
