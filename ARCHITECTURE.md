# Yao Mind — Architecture

**BI engine for UK law firms. Phase 1.**

---

## System Overview

Yao Mind ingests law firm data exports (CSV/JSON from practice management systems), runs a 7-stage processing pipeline, executes a formula engine against enriched data, and surfaces KPIs across 6 dashboards. It is a **read-only intelligence layer** — it never writes back to the source systems.

The system has a dual source-of-truth model: **Yao** (billing system) for money/invoices, **WIP** (time recording) for effort/hours. Discrepancies between the two are flagged rather than silently resolved.

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Hosting | Netlify | Static frontend + serverless functions |
| Auth + Config DB | Supabase (PostgreSQL) | Auth, RLS, firm config, entity registry, formula registry |
| Data DB | MongoDB Atlas | Raw uploads, enriched entities, calculated KPIs, snapshots |
| Frontend | Lovable.dev (React) | All UI/UX — built separately from this codebase |
| Version Control | GitHub | Always synced; all changes committed and pushed |
| Language | TypeScript (strict) | End-to-end |
| Validation | Zod | Runtime validation of all inputs and configs |
| Testing | Vitest | Unit and integration tests |

---

## Repository Structure

```
/src
  /shared/          # Shared between client and server — types, constants, entities, formulas
    /types/         # Core TypeScript interfaces and enums (index.ts, mongodb.ts)
    /entities/      # Entity registry definitions (registry.ts, defaults.ts)
    /formulas/      # Formula and snippet definitions (built-in-formulas.ts, built-in-snippets.ts)
    /validation/    # Zod schemas (config-validators.ts, custom-field-validators.ts)
    /constants/     # Defaults and lookup tables (defaults.ts)
  /client/          # Client-side only code
    /parsers/       # File parsers (CSV, JSON) — run in browser for instant preview
  /server/          # Server-side only code
    /functions/     # Netlify Functions (one file per endpoint)
    /services/      # Business logic services
    /lib/           # Infrastructure clients (supabase.ts, mongodb.ts, auth-middleware.ts)
/scripts/           # One-time setup scripts (migrations, seeding)
/tests/             # Mirror of /src structure
/netlify/           # Netlify config
```

---

## Data Architecture

### Two Databases, Two Roles

**Supabase (PostgreSQL)** — structured, relational, enforced by RLS:
- `firms` — one row per law firm
- `users` — extends Supabase auth, includes `firm_id` and `role`
- `firm_config` — all three configuration tiers as JSONB
- `entity_registry` — field/relationship schemas for all 9 built-in + custom entities
- `custom_fields` — user-defined fields per entity type
- `formula_registry` — formula definitions with variants and modifiers
- `fee_earner_overrides` — per-lawyer config overrides
- `column_mapping_templates` — saved CSV column mapping templates
- `audit_log` — immutable change history

**MongoDB Atlas** — document store for bulk/variable data:
- `raw_uploads` — original file content as stored
- `enriched_entities` — processed and joined records per entity type
- `calculated_kpis` — formula output snapshots
- `historical_snapshots` — periodic firm summaries for trending
- `custom_entity_records` — records for user-created entity types

### Firm Isolation

Supabase: Row Level Security enforces `firm_id` on every table. A helper function `get_user_firm_id()` extracts the calling user's firm from `auth.uid()`.

MongoDB: No native RLS — firm isolation is enforced at the application layer. Every MongoDB query function takes `firmId` as a required first parameter and includes it in every query. This is non-negotiable.

---

## Entity Model

9 built-in entity types. All are extensible with custom fields.

| Entity | Key | Data Source |
|---|---|---|
| Fee Earner | `feeEarner` | Fee Earner CSV export |
| Matter | `matter` | Full Matters JSON |
| Time Entry | `timeEntry` | WIP JSON |
| Invoice | `invoice` | Invoices JSON |
| Client | `client` | Contacts JSON |
| Disbursement | `disbursement` | Disbursements JSON |
| Department | `department` | Derived from matter.department |
| Task | `task` | Tasks JSON |
| Firm | `firm` | Aggregated singleton |

Entities are defined in `src/shared/entities/registry.ts`. Each definition includes all fields with type metadata, relationships (hasMany/belongsTo with join keys), and extensible fields that unlock features when populated (e.g. `activityType` on TimeEntry enables non-chargeable breakdown).

---

## Data Pipeline (7 Stages)

```
Parse → Normalise → Index → Join → Enrich → Aggregate → Calculate
```

**Parse** — client-side for instant preview, server-side for persistence  
**Normalise** — standardise field names, coerce types, apply column mapping templates  
**Index** — build lookup maps (lawyerId → feeEarner, matterId → matter) for O(1) joins  
**Join** — resolve relationships across entities (e.g. timeEntry.lawyerId → feeEarner)  
**Enrich** — compute derived fields (durationHours, isChargeable, ageInDays, etc.)  
**Aggregate** — roll up to matter/feeEarner/department/firm level  
**Calculate** — run formula engine, produce KPIs, apply RAG status

Critical known data gap: ~49% of WIP entries are orphaned from matters (Full Matters export needs expanding). The pipeline flags these rather than silently discarding them.

---

## Formula Engine

Formulas are **pure functions**: `f(data, config) → result`. They never mutate state.

**23 built-in formulas** across 7 domains:
- Utilisation & Time: F-TU-01 to F-TU-03
- Revenue & Billing: F-RB-01 to F-RB-04
- WIP & Leakage: F-WL-01 to F-WL-04
- Profitability: F-PR-01 to F-PR-05
- Budget & Scope: F-BS-01 to F-BS-02
- Debtors: F-DM-01
- Composites: F-CS-01 to F-CS-03

**5 built-in snippets** (SN-001 to SN-005) — reusable sub-calculations (cost rates, available hours, firm-retain logic).

Each formula supports variants, user modifiers, and dependency resolution. Fee share vs salaried is a first-class concept that affects every profitability formula. All formulas handle null gracefully and adapt to progressive data availability.

---

## Configuration System (3 Tiers)

**Tier 1 — Firm Profile** (set once during onboarding): working time defaults, pay model defaults, revenue attribution method, FTE counting method.

**Tier 2 — Formula Config** (periodic): cost rate methods, fee share percentages, overhead allocation, scorecard weights.

**Tier 3 — RAG Thresholds** (frequent): per-metric green/amber/red boundaries with per-grade overrides (e.g. different utilisation thresholds for Partners vs Paralegals).

Config is stored in Supabase `firm_config` as JSONB. All changes are logged to `audit_log` with old/new values. Full export/import (JSON) with backup-before-import and rollback support.

---

## Authentication & Security

- Supabase Auth handles all identity (JWT)
- All Netlify Functions use `auth-middleware.ts` — extracts Bearer token, verifies with Supabase, resolves `firm_id` and `role`
- Role hierarchy: `owner > admin > partner > department_head > fee_earner > viewer`
- Data mutations require `owner` or `admin` role
- Config deletion requires `owner` or `admin` role
- Audit log is append-only (no UPDATE or DELETE policy)

---

## API Layer (Netlify Functions)

All endpoints follow the pattern: authenticate → extract firm_id → call service → return typed response.

HTTP conventions: 200 success, 400 bad request, 401 unauthenticated, 403 forbidden, 500 server error. Error bodies always include a message field.

Key endpoint groups:
- `/api/config-*` — firm configuration CRUD
- `/api/upload` — file upload and pipeline trigger
- `/api/data/*` — enriched entity retrieval
- `/api/calculate` — formula execution
- `/api/audit-log` — audit history and rollback

---

## 6 Dashboards (Phase 1E)

Firm Overview · Fee Earner Performance · WIP · Billing & Collections · Matter Analysis · Client Intelligence

Dashboards adapt to what data has been loaded (progressive availability). All dashboards show both gross and firm-net views, and both firm and lawyer perspectives for fee share earners.

---

## Development Principles

- **Work in order.** Prompts 1A-01 through 1A-09 must be completed and verified before moving to 1B.
- **Test before proceeding.** Each prompt has explicit verification steps — do not skip.
- **Small, focused increments.** One concern per commit.
- **Always push to GitHub.** Every session ends with a commit and push.
- **firm_id on every query.** Non-negotiable data isolation pattern.
- **Null-safe formulas.** All formula implementations must handle missing data gracefully.
- **No colours.** Theming is provided separately — never suggest or hardcode colour values.
