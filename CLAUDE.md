# Yao Mind — CLAUDE.md

BI engine for UK law firms. Pulls live data from the Yao practice management API → runs pipeline → formula engine → pre-computed KPI store → 6 dashboards.

See full system design in `ARCHITECTURE.md`.
See Phase 2 implementation plan in `Yao-Mind-Phase2-API-Integration-Plan.md`.

---

## Tech Stack

- **Backend/logic**: TypeScript (strict), Netlify Functions, Zod validation, Vitest
- **Auth + config DB**: Supabase (PostgreSQL + RLS)
- **Data DB**: MongoDB Atlas (`yao-mind` database — NOT `yao-mind-dev`)
- **Frontend**: Lovable.dev — built separately, not in this repo
- **Hosting**: Netlify
- **Version control**: GitHub — every session ends with a commit and push

---

## Project Structure

```
/src/shared/     — types, entity definitions, formula definitions, Zod validators
/src/client/     — browser-side parsers only (legacy upload pipeline)
/src/server/     — Netlify Functions + services + lib (supabase, mongodb, auth-middleware)
  /datasource/   — DataSourceAdapter: Yao API fetch, auth, normalise
  /pipeline/     — enrichment, aggregation, formula engine
  /functions/    — individual Netlify Function endpoints
/scripts/        — one-time migration and seeding scripts
/tests/          — mirrors /src structure
```

---

## Non-Negotiable Rules

**firm_id on every MongoDB query.** MongoDB has no native RLS. Every query function takes `firmId` as its first parameter and includes it in every filter. No exceptions.

**Always push to GitHub.** End every session with `git add -A && git commit -m "..." && git push`.

**Work through prompts in order.** Each phase builds on the previous. Do not skip ahead.

**Verify before proceeding.** Each prompt has explicit verification steps. Pass them all before starting the next prompt.

**No colours or theming.** A separate ThemeGuide.md exists. Never suggest or hardcode colour values.

**Null-safe formulas.** Every formula implementation must handle missing/null data gracefully and return null (not throw) when required inputs are absent.

**Formulas are pure functions.** `f(data, config) → result`. No side effects, no state mutation.

**Strip sensitive fields.** Always remove `password` and `email_default_signature` from attorney objects before storing in MongoDB. Never persist password hashes.

**Never store JWT tokens.** Yao API tokens are short-lived. Always re-authenticate on every pull using stored credentials. Never cache tokens between pulls.

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

**Cross-reference registry** — the `CrossReferenceRegistry` in MongoDB maps between identifier forms (matterId ↔ matterNumber, lawyerId ↔ lawyerName, contactId ↔ displayName, departmentId ↔ name). Used by the legacy upload pipeline. When debugging join failures on legacy data, check registry coverage stats in DataQualityReport first.

**Pipeline stage order (legacy upload)** — Parse → Normalise → Cross-Reference → Index → Join → Enrich → Aggregate → Calculate. Cross-Reference (Stage 3) must run before Index (Stage 4). Never build indexes from un-resolved records.

**Pipeline stage order (API pull)** — Auth → Fetch → Normalise → Enrich → Calculate → Store. See DataSourceAdapter section below.

**Formula readiness** — every formula result carries a `FormulaReadinessResult` (READY / PARTIAL / BLOCKED / ENHANCED). BLOCKED formulas must not execute. All KPI API responses include readiness metadata. The UI uses this to render confidence indicators.

**Formula versioning** — every formula definition change creates a new version in `formula_versions` table. Calculated KPI documents reference the `formulaVersionSnapshot` used to produce them. Never mutate a formula definition in place — always version it.

**Dashboards read from kpi_snapshots only.** The Supabase `kpi_snapshots` table is the sole data source for all dashboard queries. Dashboards never call MongoDB, never trigger formula calculations, never call the Yao API. All computation happens at pull time.

---

## Data Sources

### Primary — Yao API (api.yao.legal)

All transactional data. Credentials (email + password) stored AES-256 encrypted in Supabase `yao_api_credentials` table per firm. Never in env vars. Never in code. Re-authenticate on every pull — never cache tokens.

**Pull sequence:**

Step 1 — Lookup tables (fetch once, build in-memory maps):
- `GET /attorneys` → `attorneyMap { _id → { fullName, rate, status, integrationId } }`
- `GET /departments` → `departmentMap { _id → title }`
- `GET /case-types/active` → `caseTypeMap { _id → { title, departmentId, isFixedFee } }`

Step 2 — Transactional data (paginated loops):
- `GET /matters?page=N&limit=100` → `{ rows[], limit }` — increment page until `rows.length < limit`
- `POST /time-entries/search { size:100, next:N }` → `{ result[], next }` — cursor pagination, loop until `next` absent
- `POST /invoices/search { size:100, page:N }` → page pagination
- `POST /ledgers/search { types:["OFFICE_PAYMENT","CLIENT_TO_OFFICE","OFFICE_RECEIPT"], size:100, page:N }`
- `GET /tasks?page=N&limit=100`
- `GET /contacts?is_archived=false&ids_filter=[]&tag=&company=&page=N&limit=100`

Step 3 — Summary (single call):
- `GET /invoices/summary` → `{ unpaid, paid, total }`

**Ledger routing logic** (apply in normalise stage):
- `OFFICE_PAYMENT` → disbursement entity
- `CLIENT_TO_OFFICE` or `OFFICE_RECEIPT` + `invoice` field populated → invoice payment record → derive `datePaid`
- `CLIENT_TO_OFFICE` or `OFFICE_RECEIPT` + `disbursements[]` populated → disbursement recovery record
- Both `invoice` AND `disbursements[]` populated → split into two records

**Field transformations** (apply in normalise stage):
1. `name + ' ' + surname` → `fullName` on all attorney objects
2. `financial_limit` → `budget` on matters (source of truth)
3. `abs(value)` on `OFFICE_PAYMENT` ledger records (stored as negative)
4. `datePaid`: find `CLIENT_TO_OFFICE` or `OFFICE_RECEIPT` where `invoice == invoice._id`, use `ledger.date`
5. `isFixedFee`: `caseTypeMap[case_type._id].fixed_fee > 0`
6. `isActive`: `status IN ['IN_PROGRESS','ON_HOLD','EXCHANGED','QUOTE']`
7. `isClosed`: `status IN ['COMPLETED','ARCHIVED','CLOSED']`
8. `durationHours`: `duration_minutes / 60`
9. `firmExposure`: `abs(outstanding)` where `outstanding < 0` on `OFFICE_PAYMENT`
10. `isRecovered`: `outstanding == 0` on `OFFICE_PAYMENT`
11. `activityType`: `activity.title` (preferred) || `work_type` (fallback) on time entries
12. Strip: `password`, `email_default_signature` from all attorney objects

### Secondary — Fee Earner CSV (upload only)

The only data not available via API. Still requires manual upload per firm:
- `payModel` (Salaried vs FeeShare)
- `annualSalary`, `monthlySalary`, `pension`, `NI`, `variablePay`
- `targetWeeklyHours`, `chargeableWeeklyTarget`, `annualLeaveEntitlement`
- `feeSharePercent`, `firmLeadPercent`

Join key: `integration_account_id` (primary) or `email` (fallback) — matches to attorney `_id`.

### Legacy — JSON/CSV Upload Pipeline

Preserved intact. Hidden under Settings → Data Management → Advanced. For firms not yet connected to the Yao API. Never surfaced in main navigation or onboarding flow for API-connected firms. The cross-reference engine and 8-stage pipeline remain fully functional for this path.

---

## kpi_snapshots Table (Supabase)

The performance-critical table. All dashboards read exclusively from here.

```sql
firm_id       uuid     -- firm isolation
pulled_at     timestamptz -- when this snapshot was computed
entity_type   text     -- 'feeEarner' | 'matter' | 'invoice' | 'disbursement' | 'department' | 'client' | 'firm'
entity_id     text     -- the entity's _id from MongoDB/Yao
entity_name   text     -- display name (human-readable label)
kpi_key       text     -- formula ID e.g. 'F-TU-01', 'F-RB-01'
kpi_value     numeric  -- computed result
rag_status    text     -- 'green' | 'amber' | 'red' | 'neutral'
period        text     -- 'current' | 'ytd' | '2025-Q1' etc
display_value text     -- pre-formatted for display (e.g. '73.4%', '£42,500')
```

Indexed on: `(firm_id, entity_type, period)` and `(firm_id, entity_id, kpi_key)`.

Dashboard queries are simple `SELECT` statements against this table — target load time < 500ms for any dashboard. No MongoDB access on load. No formula calculations on load.

---

## risk_flags Collection (MongoDB)

Generated after every pull by the risk scanning stage:

```typescript
{
  firm_id: string,
  flagged_at: Date,
  entity_type: string,
  entity_id: string,
  entity_name: string,
  flag_type: string,       // e.g. 'WIP_AGE_HIGH', 'BUDGET_BURN_CRITICAL', 'DORMANT_MATTER'
  severity: 'high' | 'medium' | 'low',
  detail: string,          // human-readable explanation
  kpi_value: number,
  threshold: number,
  ai_summary?: string      // populated by AI layer in future phase
}
```

Risk flag types: `WIP_AGE_HIGH`, `BUDGET_BURN_CRITICAL`, `DEBTOR_DAYS_HIGH`, `UTILISATION_DROP`, `DORMANT_MATTER`, `BAD_DEBT_RISK`, `WRITE_OFF_SPIKE`.

---

## Phase 1B: Pipeline & Data Layer (complete — legacy upload path)

### Field names from pipeline (formulas MUST use these exact names)
- AggregatedFeeEarner: `wipTotalHours`, `wipChargeableHours`, `wipNonChargeableHours`, `wipTotalBillable`, `wipTotalWriteOff`, `invoicedNetBilling`, `invoicedTotal`, `invoicedOutstanding`, `invoicedPaid`, `recordingGapDays`, `lastRecordedDate`, `orphanedWip.orphanedWipEntryCount`, `orphanedWip.orphanedWipValue`
- AggregatedMatter: `wipTotalBillable`, `wipTotalHours`, `wipTotalWriteOff`, `invoicedNetBilling`, `invoicedOutstanding`, `invoicedPaid`, `budget`, `isFixedFee`, `disbursementTotal`, `disbursementOutstanding`
- AggregatedFirm: firm-wide totals of all above

### Prompt sequence (Phase 1C)
1C-01 → 1C-01b → 1C-01c → 1C-02 → 1C-03 → 1C-04 → 1C-05 → 1C-06 → 1C-07 → 1C-08 → 1C-09 → 1C-09b → 1C-09c → 1C-09d → 1C-10 → 1C-10b

### Dual source of truth (legacy pipeline)
- **WIP** (`wipJson`) = source of truth for **effort**: hours, write-offs, chargeability
- **Yao invoiced data** (`invoicesJson`, `fullMattersJson`) = source of truth for **revenue**: invoiced and collected

Via API pull, this distinction is maintained: time entries feed effort metrics, invoices feed revenue metrics.

---

## Data Model Essentials

**Pay model is first-class**: fee share vs salaried affects every profitability formula. Always check `payModel` before calculating costs. See `SN-005` in formula registry.

**Extensible fields**: some entity fields are defined but not yet populated (e.g. `activityType` on TimeEntry — now populated via API, `datePaid` on Invoice — now derivable from ledger records). Dashboards must adapt gracefully when these are absent.

**datePaid is now derivable** via API: find `CLIENT_TO_OFFICE` or `OFFICE_RECEIPT` ledger record where `invoice` field matches invoice `_id`. Use `ledger.date`. This was not available in Metabase exports.

**activityType is now populated** via API: `activity.title` on time entries (Email, Telephone, Drafting etc). Was ~0% coverage in Metabase exports.

**No orphaned WIP via API**: the API uses consistent ObjectIds throughout. `time_entry.matter._id` always matches `matter._id` exactly. The ~49% orphan rate was a Metabase export artefact.

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
- Yao API 401 → credentials may be wrong or expired — re-fetch from `yao_api_credentials`, re-authenticate
- Yao API 404 → endpoint path is wrong — check DataSourceAdapter endpoint map against ARCHITECTURE.md §8
- Pull incomplete → check Background Function logs for pagination loop exit condition; `next` cursor or page count may have been handled incorrectly
- Dashboard slow → check that it is reading from `kpi_snapshots` (Supabase) not MongoDB; no dashboard should ever call MongoDB directly
- kpi_snapshots stale → check `pulled_at` timestamp; if old, trigger a new pull
- Join failure (legacy upload) → check `CrossReferenceRegistry` coverage stats in DataQualityReport
- Formula readiness BLOCKED → check `DataAvailabilitySummary.loadedDataSources` against formula requirements
- Formula version mismatch → compare `formulaVersionSnapshot` on KPI result against current formula registry
