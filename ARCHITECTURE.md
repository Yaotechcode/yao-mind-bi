# Yao Mind — Architecture & Design Decisions

**Version 1.2 · March 2026 · Confidential**

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Tech Stack & Rationale](#2-tech-stack--rationale)
3. [Repository Structure](#3-repository-structure)
4. [Data Architecture](#4-data-architecture)
5. [Entity Model](#5-entity-model)
6. [Configuration System](#6-configuration-system)
7. [Formula System](#7-formula-system)
8. [Data Pipeline](#8-data-pipeline)
9. [Authentication & Security](#9-authentication--security)
10. [Design & Theming](#10-design--theming)
11. [Key Design Decisions](#11-key-design-decisions)
12. [Future Considerations](#12-future-considerations)

---

## 1. System Overview

Yao Mind is a Business Intelligence engine purpose-built for UK law firms. It ingests practice management data exports, runs a structured calculation pipeline, and presents KPIs across six dashboards — giving firms actionable intelligence from data they already have.

**Core principle:** *From data you already have, to intelligence you have never had.*

The system is designed around three user types:

- **Firm owners / managing partners** — firm-level P&L, scorecard, strategic view
- **Department heads / partners** — team performance, matter health, WIP
- **Fee earners** — personal utilisation, billing, matter status

All data is firm-isolated. No firm ever sees another firm's data.

---

## 2. Tech Stack & Rationale

| Layer | Technology | Why |
|---|---|---|
| Hosting | Netlify | Serverless, global CDN, easy deploy from GitHub |
| Frontend | React + TypeScript + Vite (Lovable.dev) | Rapid UI development, type-safe |
| Backend logic | Netlify Functions (TypeScript) | Serverless, co-located with frontend |
| Structured data / Auth | Supabase (PostgreSQL + RLS) | Auth out of the box, row-level security, JSONB for config |
| Document / raw data | MongoDB Atlas | Flexible schema for heterogeneous law firm data exports |
| Validation | Zod | Runtime + compile-time validation, shared client/server |
| Date handling | date-fns | Lightweight, tree-shakeable |
| Testing | Vitest | Fast, TypeScript-native |
| Version control | GitHub | Source of truth, two-repo strategy (see §11) |

**Two-repo strategy:**
- `yao-mind` (Claude Code) — backend, data pipeline, formula engine, Netlify Functions, shared types
- `yao-mind-ui` (Lovable.dev) — React components, pages, layouts, dashboard UI

The repos share environment variables and API endpoint contracts. UI calls backend via Netlify Function URLs. Merge UI into main repo at end of each phase.

---

## 3. Repository Structure

```
/src
  /shared         — types, interfaces, constants, validators (used by client + server)
    /types        — TypeScript interfaces + enums
    /entities     — entity registry definitions
    /formulas     — formula + snippet definitions
    /validation   — Zod schemas
  /client         — client-side code (parsers, state, utilities)
  /server         — server-side code
    /functions    — individual Netlify Functions (one file = one endpoint)
    /services     — business logic services (called by functions)
    /lib          — shared server utilities (Supabase client, MongoDB client, auth middleware)
/scripts          — database seeding, migrations, setup utilities
/tests            — mirrors /src structure
/netlify          — Netlify configuration
```

---

## 4. Data Architecture

### Dual Database Strategy

**Supabase (PostgreSQL)** owns:
- User accounts and authentication
- Firm profiles and configuration (all three tiers)
- Entity registry (schema definitions)
- Formula registry (formula definitions)
- Custom fields definitions
- Column mapping templates
- Fee earner overrides
- Audit log

**MongoDB Atlas** owns:
- Raw uploaded files (pre-processing)
- Enriched entity records (post-pipeline)
- Calculated KPIs (post-formula-engine)
- Historical snapshots
- Custom entity records (manually entered)
- Cross-reference registries (identifier mapping dictionaries, one per firm, extended on each upload)

### Rationale for Split

Supabase handles structured, relational, security-critical data where row-level security and relational integrity matter. MongoDB handles the heterogeneous, variable-schema data that comes from law firm practice management exports — where the shape varies by firm and no two exports are identical.

### Dual Source of Truth

A deliberate architectural decision: **Yao (billing system) and WIP (time recording) are treated as separate sources of truth.** Discrepancies between them are flagged, not silently resolved. This reflects real law firm operations where these systems are often out of sync, and surfacing the gap is itself valuable intelligence.

### Data Flow

```
CSV/JSON Upload
  → Client-side parse (instant preview)
  → Raw storage (MongoDB)
  → Server pipeline: Normalise → Cross-Reference → Index → Join → Enrich → Aggregate → Calculate
  → Enriched entities (MongoDB)
  → KPI calculation (Formula Engine)
  → Calculated KPIs (MongoDB)
  → Dashboard queries (Netlify Functions)
  → UI
```

---

## 5. Entity Model

Nine built-in entity types, all extensible:

| Entity | Source | Key Role |
|---|---|---|
| Fee Earner | CSV upload | Central to all profitability + utilisation |
| Matter | Full Matters JSON | Revenue unit, joins to most other entities |
| Time Entry | WIP JSON | Raw effort data, source of utilisation |
| Invoice | Invoices JSON | Billing + debtor analysis |
| Client | Contacts JSON | Aggregation target for client intelligence |
| Disbursement | Disbursements JSON | Expense tracking, recovery analysis |
| Department | Derived from Matter | Organisational grouping |
| Task | Tasks JSON | Matter workload and overdue tracking |
| Firm | Aggregated | Singleton, firm-level rollup |

All entities support custom fields (added by the firm). All entities support custom relationships. New entity types can be created (derived, manual, or uploaded).

### Extensible Fields

Several built-in fields are defined but not always present in data exports. These are tracked with a `missingBehaviour` property:

- `exclude_from_analysis` — data exists in some firms, analysis adapts when present
- `hide_column` — purely additive display field
- `use_default` — falls back to a configured default

Key extensible fields and what they unlock:

| Field | Entity | Unlocks |
|---|---|---|
| `activityType` | Time Entry | Non-chargeable breakdown, activity analysis |
| `datePaid` | Invoice | Exact debtor days, payment behaviour, slow payer ranking |
| `description` | Time Entry | Matter detail view, AI context builder |
| `description` | Disbursement | Disbursement categorisation |

---

## 6. Configuration System

Three-tier configuration, all stored per-firm in Supabase:

**Tier 1 — Firm Profile** (set once at onboarding)
Working time defaults, pay model defaults, revenue attribution method, FTE counting method, cost rate method.

**Tier 2 — Formula Configuration** (updated periodically)
Per-formula variant selection, user modifiers, snippet composition, fee earner overrides, overhead allocation method.

**Tier 3 — RAG Thresholds** (adjusted frequently)
Per-metric green/amber/red boundaries, with per-grade overrides (e.g., partner thresholds differ from paralegal thresholds).

All config changes are logged in the audit trail with old value, new value, timestamp, and user. Config can be exported as JSON and imported to another firm (built-in entities and formulas are never overwritten on import). Rollback to any previous config state is supported.

---

## 7. Formula System

### Architecture

Formulas are **pure data definitions**: `f(data, config) → result`. They are not executable code stored in the database. The Formula Engine (built in Phase 1C) reads definitions and executes them. This separation enables:

- Safe export/import of custom formulas between firms
- Formula versioning without code deployment
- AI-assisted formula translation and validation
- Sandbox execution before production deployment

### Formula Registry

28 entries at launch: 23 built-in formulas + 5 built-in snippets. All have:
- Unique formula ID (e.g., `F-TU-01`, `SN-002`)
- Structured definition descriptor (not executable code)
- Variant definitions (different calculation approaches)
- Dependency declarations (which snippets/config values are needed)
- Display configuration (default dashboard placement)

### Formula Layers (bottom to top)

```
Raw Data Fields
  → Snippets (reusable calculation fragments: SN-001 to SN-005)
  → Built-in Formulas (F-TU-01 through F-CS-03)
  → User Modifiers (firm-specific adjustments layered on top)
  → Variants (alternative approaches, firm selects one as active)
  → Custom Formulas (firm-created, can compose snippets)
  → RAG Thresholds (applied to any numeric result)
  → Composite Scores (weighted combinations: F-CS-01 to F-CS-03)
```

### Formula Readiness States

Every formula is evaluated for readiness before execution:

| State | Meaning |
|---|---|
| 🟢 Ready | All required data present, full accuracy |
| 🟡 Partial | Running with fallbacks/assumptions, results are estimates |
| 🔴 Blocked | Required data source missing, cannot run |
| 💡 Enhanced | Optional extensible field present, richer variant auto-activated |

Readiness state is displayed on KPI cards and the formula library. Users always know the confidence level of a number.

### Formula Versioning

Every formula change creates a new version. Historical KPI snapshots reference the formula version that produced them. This means:
- Results from different time periods are comparable even if formulas changed
- Partners cannot accidentally rewrite history by modifying a formula
- Audit trail records not just what changed but what numbers were produced under each version

### AI-Assisted Formula Tools

**Plain-English Translation:** When a user defines or modifies a formula, Claude translates the definition back into plain English for confirmation before saving. Example:

> *"This formula will calculate total billed value for each fee earner on active matters, divided by their available hours this month, expressed as a percentage. It will return null for fee earners with no time entries in the period."*

**Dependency Impact Analysis:** When a config value is changed, the system identifies which formulas will be affected and shows the user before applying the change.

**Formula Validation:** Before saving, Claude checks that all referenced fields exist on the declared entity, all joins are defined in the entity registry, and the result type is consistent with the formula logic.

### Sandbox / Preview Mode

Before any custom formula is activated, users can run it against a sample of real data (configurable: last 30 days, one department, all data). Preview shows:
- Raw results for a sample of records
- Null rate and reasons for nulls
- Distribution (min, median, max)
- Any records that produced unexpected result types

### Dependency Graph

A visual showing the full dependency chain of any formula: which snippets it uses, which config values affect it, which data fields feed it. When a config value changes, the graph highlights all affected formulas. Built as a UI component in Lovable (Phase 1E).

### Formula Templates

Above snippets, a library of complete formula starting points for common law firm patterns:
- Matter profitability (fixed fee vs time & charge)
- Fee earner ROI (salaried vs fee share)
- Department margin
- Client lifetime value
- WIP recovery probability by age band

Templates are cloneable and editable. Wizard creates from scratch; template clones a proven pattern.

### Custom Formula Wizard (5-step flow)

1. **What are you measuring?** — select entity type and result type
2. **What data does it use?** — pick fields and snippets
3. **How is it calculated?** — define the logic using the visual builder
4. **When should it run?** — set data requirements and null handling
5. **Review & confirm** — AI plain-English translation, preview against sample data

### Phase 1C Implementation (complete)

**Engine components built:**

- `FormulaEngine` — core executor: registers snippets, runs readiness checks, executes built-in and custom formulas in dependency order
- `ReadinessChecker` — evaluates `FORMULA_INPUT_REQUIREMENTS` against `DataAvailabilitySummary`; returns READY / PARTIAL / BLOCKED / ENHANCED per formula
- `RagEngine` — applies `RagThreshold[]` config to formula results; `evaluateAll` uses `FORMULA_TO_METRIC` map, `evaluateSingle` for direct threshold lookup
- `CustomFormulaExecutor` — validates and executes custom formula `Expression` objects (no `eval()`); `validate()` returns `referencedEntities` for readiness pre-check
- `SnippetEngine` — executes SN-001 through SN-005 before formula execution; results available in `context.snippetResults`
- `FormulaTranslator` — AI-assisted translation of formula definitions to plain English via Claude API; rate-limited (20 req/min); injectable HTTP client for testing
- `FormulaSandbox` — read-only dry-run execution against real firm data without persisting results; supports `dryRun`, `diffWithLive`, `dryRunBatch`; injectable `SandboxDeps` for deterministic testing

**Key architectural decisions made in Phase 1C:**

- **Injectable deps over mocking** — `FormulaSandbox`, `FormulaTranslator`, and the rate limiter all accept injected dependencies so tests never hit real databases or external APIs
- **Readiness before execution** — BLOCKED formulas never execute; the readiness check runs synchronously before any data is loaded
- **Snippets always run** — even for PARTIAL formulas, all declared snippets run first so their results are available in `context.snippetResults`
- **RAG is post-execution metadata** — the engine never uses RAG state to gate execution; assignments are metadata on the result, consumed by the UI
- **Custom formulas use `Expression` node trees** — not `eval()` or template strings; the executor interprets `field`, `literal`, `operator`, `function` node types safely

### Phase 1C File Map

```
src/shared/formulas/
  formula-registry.ts           — 23 built-in formula definitions + 5 snippet definitions
  formula-types.ts              — FormulaDefinition, SnippetDefinition, FormulaResult,
                                  FormulaReadinessResult, RagThreshold, etc.
  custom-formula-types.ts       — CustomFormulaDefinition, Expression, ExpressionNode types

src/server/formula-engine/
  engine/
    formula-engine.ts           — FormulaEngine: registerSnippet, execute, executeAll
    snippet-engine.ts           — SnippetEngine: registers and runs SN-001 to SN-005
    readiness-checker.ts        — ReadinessChecker: FORMULA_INPUT_REQUIREMENTS map,
                                  checkSingleReadiness, DataAvailabilitySummary
    rag-engine.ts               — RagEngine: evaluateAll (FORMULA_TO_METRIC), evaluateSingle
  formulas/
    utilisation.ts              — F-TU-01 through F-TU-03 (time utilisation)
    wip-leakage.ts              — F-WL-01 through F-WL-04 (WIP & lock-up)
    profitability.ts            — F-PR-01 through F-PR-04 (profitability)
    composites.ts               — F-CS-01 through F-CS-03 (composite scorecard)
  snippets/
    sn-001-annual-salary.ts     — SN-001: annualised salary from config
    sn-002-cost-rate.ts         — SN-002: hourly cost rate (salary ÷ working hours)
    sn-003-realisation.ts       — SN-003: firm-level realisation rate
    sn-004-total-cost.ts        — SN-004: total cost including overhead allocation
    sn-005-pay-model.ts         — SN-005: pay model branching (salaried vs fee share)
  custom/
    custom-formula-executor.ts  — CustomFormulaExecutor: validate() + execute()
  ai/
    formula-translator.ts       — FormulaTranslator: plain-English translation via Claude,
                                  in-memory rate limiter, injectable HTTP client
  sandbox/
    formula-sandbox.ts          — FormulaSandbox: dryRun, diffWithLive, dryRunBatch,
                                  injectable SandboxDeps

src/server/functions/
  formula-sandbox.ts            — Netlify Function: POST /api/formula-sandbox/{run,diff,batch}
  formula-translator.ts         — Netlify Function: POST /api/formula-translator/translate
  calculated-kpis.ts            — Netlify Function: GET /api/calculated-kpis
  formula-library.ts            — Netlify Function: GET /api/formula-library
  rag-thresholds.ts             — Netlify Function: GET/PUT /api/rag-thresholds

tests/server/formula-engine/
  engine/                       — FormulaEngine, ReadinessChecker, RagEngine tests
  formulas/                     — utilisation, wip-leakage, profitability, composites tests
  custom/                       — CustomFormulaExecutor tests
  ai/                           — FormulaTranslator tests (includes rate limiter, few-shot examples)
  sandbox/                      — FormulaSandbox tests (22 tests)
```

---

## 8. Data Pipeline

Eight stages, split between client-side (instant preview) and server-side (full persistence):

| Stage | Where | What |
|---|---|---|
| 1. Parse | Client | CSV/JSON → typed records, instant column preview |
| 2. Normalise | Server | Standardise field names, coerce types, apply column mapping |
| 3. Cross-Reference | Server | Build identifier mapping dictionaries from rows that contain both forms (matterId ↔ matterNumber, lawyerId ↔ lawyerName, contactId ↔ displayName, departmentId ↔ name). Apply maps across all records to fill missing identifier forms. Persist registry to MongoDB. |
| 4. Index | Server | Build lookup maps from fully-resolved records. Both identifier forms now present on most records. |
| 5. Join | Server | Link time entries → matters → fee earners → clients using the complete indexes |
| 6. Enrich | Server | Calculate derived fields, resolve names from IDs, apply custom fields |
| 7. Aggregate | Server | Roll up to matter/fee earner/department/firm level |
| 8. Calculate | Server | Run formula engine against enriched aggregates |

### Why Cross-Reference is a Dedicated Stage

Different Metabase exports use different identifier types for the same entities — some use internal UUIDs, others use human-readable numbers or name strings. A time entry references a matter by `matterId` (UUID); an invoice references the same matter by `matterNumber` (integer). Without resolving these before building indexes, join success rates are significantly reduced.

The Cross-Reference engine scans every uploaded dataset for rows that contain both forms of an identifier simultaneously. Each such row is a mapping opportunity. The resulting `CrossReferenceRegistry` is:
- Built from the dataset with the highest confidence first (Full Matters > Closed Matters > WIP > Invoices > Disbursements > Tasks)
- Applied back to all records to fill in the missing form
- Persisted to MongoDB and extended (not replaced) on each subsequent upload
- Surfaced in the DataQualityReport with coverage statistics

Identifier pairs resolved: `matterId` ↔ `matterNumber`, `lawyerId` ↔ `lawyerName` (including name variants and abbreviations), `contactId` ↔ `displayName`, `departmentId` ↔ department name.

### Data Quality

The pipeline produces a `DataQualityReport` alongside enriched data:
- Orphaned records (e.g., time entries with no matching matter)
- Missing required fields
- Unresolved joins (ID present but no matching record)
- Extensible field coverage (what % of records have `activityType`, `datePaid`, etc.)
- Discrepancies between Yao billing totals and WIP totals
- **Cross-reference coverage** — what % of records had both identifier forms, how many were resolved via the registry, any conflicts between datasets

Data quality issues are surfaced in the UI, not silently swallowed.

### Progressive Data Availability

Dashboards adapt to what data is loaded. A firm that has only uploaded fee earner data and WIP will see utilisation dashboards fully populated and billing dashboards in a "data needed" state. No empty dashboards — every loaded data source unlocks something.

---

## 9. Authentication & Security

- Supabase Auth handles all authentication (email/password, magic link)
- JWT tokens verified on every Netlify Function request via `auth-middleware.ts`
- Row Level Security on all Supabase tables — enforced at database level, not just application level
- MongoDB firm isolation enforced at application layer (every query includes `firm_id`)
- User roles: `owner`, `admin`, `partner`, `department_head`, `fee_earner`, `viewer`
- Audit log is immutable (no UPDATE or DELETE on audit_log table)
- Config export does not include user accounts, raw data, or calculated KPIs

---

## 10. Design & Theming

All colours, typography, spacing, and component styling are defined in `/ThemeGuide.md`.

**Claude Code:** Do not generate UI styles, suggest colour values, or make component design decisions. All UI is built in Lovable.dev following ThemeGuide.md.

**Lovable.dev:** Follow ThemeGuide.md for all visual decisions. When generating components, reference the theme guide before applying any styling.

**When generating backend code that touches UI contracts** (e.g., API response shapes that feed dashboard components), add a comment referencing the relevant dashboard section in the Architecture doc so Lovable has context for how the data will be displayed.

---

## 11. Key Design Decisions

### Formulas are pure data, not code
Formula definitions are structured descriptor objects, not executable JavaScript. The Formula Engine is separate from the definitions. This enables safe sharing, versioning, import/export, and AI translation. Never store executable code in the formula registry.

### Dual source of truth (Yao vs WIP)
Billing totals (Yao) and time recording totals (WIP) are kept separate and discrepancies surfaced, not resolved. This is intentional — the gap is itself a KPI.

### Cross-reference before index
Different Metabase exports use different identifier types for the same entities. The pipeline resolves this with a dedicated Cross-Reference stage (Stage 3) that builds identifier mapping dictionaries from any row that contains both forms simultaneously, then applies those dictionaries to all records before indexes are built. The resulting `CrossReferenceRegistry` persists to MongoDB and is extended on each new upload — so uploading a second file type retrospectively improves the resolution of data already in the system.

### Fee share vs salaried as first-class concept
Every profitability formula branches on pay model. This is not a modifier or edge case — it is a fundamental axis of the calculation. Fee share lawyers have no employment cost to the firm; salaried lawyers do. All formulas handle both.

### Revenue attribution is configurable
Who "owns" a matter's revenue (responsible lawyer, supervisor, originator, or split) is a firm-level config choice, not a hardcoded assumption. Formulas consume the attribution model from config.

### Show both gross and firm-net views
For fee share lawyers, dashboards show both the gross revenue (before fee share split) and the firm-net revenue (after). Both are meaningful; neither replaces the other.

### Progressive data availability
The system never blocks on missing data. Every loaded data source unlocks something. Dashboards show their readiness state and degrade gracefully when optional data is absent.

### Config changes are always audited and reversible
No configuration change is permanent without an audit trail. Every change logs old value, new value, user, and timestamp. Rollback is always available. Formula versioning means historical results are never corrupted by current changes.

### Two-repo strategy
Claude Code (backend) and Lovable.dev (frontend) operate in separate GitHub repositories to prevent tool conflicts. The backend repo is the source of truth for API contracts and shared types. Merge UI into backend repo at the end of each phase.

---

## 12. Future Considerations

These are not Phase 1 deliverables but the architecture is designed to accommodate them:

**Formula Marketplace:** Because formulas are pure data definitions, they can be exported, anonymised, and shared between firms. The registry structure supports this without architectural changes.

**AI Context Builder:** When `description` fields are populated on time entries, Claude can generate matter summaries, identify billing patterns, and flag anomalies. The extensible field design enables this when data is available.

**Scheduled Snapshots:** The `historical_snapshots` MongoDB collection is designed to support automated weekly/monthly KPI snapshots once a scheduling mechanism is added (Netlify scheduled functions or external cron).

**Multi-currency:** The currency field on `firms` table is present. Formula engine execution context carries currency — conversion logic can be added without schema changes.

**API Access for Firms:** The Netlify Function architecture is already a REST API. Authenticated API keys per firm (separate from user auth) would enable direct integration with practice management systems, eliminating the CSV export step.

---

*Yao Mind — From data you already have, to intelligence you have never had.*
*Built with Claude Code · Powered by Anthropic · For UK Law Firms*
