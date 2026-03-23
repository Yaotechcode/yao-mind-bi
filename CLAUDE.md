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
