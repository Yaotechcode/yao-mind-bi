# Yao Mind — Architecture & Design Decisions

**Version 2.0 · April 2026 · Confidential**

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
9. [Yao API Integration](#9-yao-api-integration)
10. [Authentication & Security](#10-authentication--security)
11. [Performance Architecture](#11-performance-architecture)
12. [AI Layer (Future Phase)](#12-ai-layer-future-phase)
13. [Design & Theming](#13-design--theming)
14. [Key Design Decisions](#14-key-design-decisions)
15. [Future Considerations](#15-future-considerations)

---

## 1. System Overview

Yao Mind is a Business Intelligence engine purpose-built for UK law firms. It connects directly to the Yao practice management system via API, pulls live data on demand, runs a structured calculation pipeline, and presents pre-computed KPIs across six dashboards.

**Core principle:** *From data you already have, to intelligence you have never had.*

**Primary data flow:**
```
User clicks "Pull from Yao"
  → Netlify Background Function
  → DataSourceAdapter (authenticate + fetch 8 datasets)
  → Normalise + Enrich + Calculate
  → Store: MongoDB (full data) + Supabase kpi_snapshots (dashboard-ready)
  → Dashboards read from kpi_snapshots only — fast, pre-computed, zero recalculation
```

The system is designed around three user types:
- **Firm owners / managing partners** — firm-level P&L, scorecard, strategic view
- **Department heads / partners** — team performance, matter health, WIP
- **Fee earners** — personal utilisation, billing, matter status

All data is firm-isolated. No firm ever sees another firm's data.

---

## 2. Tech Stack & Rationale

| Layer | Technology | Why |
|---|---|---|
| Hosting | Netlify | Serverless, global CDN, Background Functions for long-running pulls |
| Frontend | React + TypeScript + Vite (Lovable.dev) | Rapid UI development, type-safe |
| Backend logic | Netlify Functions (TypeScript) | Serverless, co-located with frontend |
| Structured data / Auth | Supabase (PostgreSQL + RLS) | Auth, row-level security, kpi_snapshots for fast dashboard reads |
| Document / raw data | MongoDB Atlas | Full enriched entities, calculated KPIs, risk flags, historical snapshots |
| Validation | Zod | Runtime + compile-time validation, shared client/server |
| Date handling | date-fns | Lightweight, tree-shakeable |
| Testing | Vitest | Fast, TypeScript-native |
| Version control | GitHub (Yaotechcode/yao-mind-bi) | Single repo, always synced |

---

## 3. Repository Structure

```
/src
  /shared         — types, interfaces, constants, validators (used by client + server)
    /types        — TypeScript interfaces + enums
    /entities     — entity registry definitions
    /formulas     — formula + snippet definitions
    /validation   — Zod schemas
  /client         — client-side code (legacy upload parsers only)
  /server         — server-side code
    /datasource   — DataSourceAdapter: Yao API auth, fetch, normalise
    /pipeline     — enrich, aggregate, formula engine, risk scanner
    /functions    — individual Netlify Functions (one file = one endpoint)
    /services     — business logic services (config, entities, formulas, kpi-snapshots)
    /lib          — shared utilities (supabase, mongodb, auth-middleware)
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
- `kpi_snapshots` — pre-computed KPIs, sole data source for all dashboard queries
- `yao_api_credentials` — AES-256 encrypted Yao API credentials per firm
- `pull_status` — tracks pull progress for UI polling

**MongoDB Atlas** owns:
- Raw pulled data (pre-processing, for audit and reprocessing)
- Enriched entity records (post-pipeline, source of truth for AI layer)
- Calculated KPIs (full detail, post-formula-engine)
- Historical snapshots
- Risk flags
- Custom entity records
- Cross-reference registries (legacy upload pipeline only)

### kpi_snapshots Table

The performance-critical table. Written once per pull. Read on every dashboard load.

```sql
CREATE TABLE kpi_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id       uuid REFERENCES firms(id),
  pulled_at     timestamptz NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  entity_name   text NOT NULL,
  kpi_key       text NOT NULL,
  kpi_value     numeric,
  rag_status    text,
  period        text NOT NULL,
  display_value text
);

CREATE INDEX idx_kpi_snapshots_firm_type_period
  ON kpi_snapshots(firm_id, entity_type, period);
CREATE INDEX idx_kpi_snapshots_firm_entity
  ON kpi_snapshots(firm_id, entity_id, kpi_key);
```

`entity_type`: feeEarner | matter | invoice | disbursement | department | client | firm
`kpi_key`: formula ID e.g. F-TU-01, F-RB-01
`period`: current | ytd | 2025-Q1 etc
`display_value`: pre-formatted string e.g. 73.4% or 42500

Target dashboard query time: under 500ms. No MongoDB access. No formula calculations.

### risk_flags Collection (MongoDB)

```typescript
{
  firm_id:      string,
  flagged_at:   Date,
  entity_type:  string,
  entity_id:    string,
  entity_name:  string,
  flag_type:    'WIP_AGE_HIGH' | 'BUDGET_BURN_CRITICAL' | 'DEBTOR_DAYS_HIGH'
                | 'UTILISATION_DROP' | 'DORMANT_MATTER' | 'BAD_DEBT_RISK' | 'WRITE_OFF_SPIKE',
  severity:     'high' | 'medium' | 'low',
  detail:       string,
  kpi_value:    number,
  threshold:    number,
  ai_summary?:  string   // populated by AI layer in future phase
}
```

### Dual Source of Truth

Effort data (hours, utilisation, write-offs) comes from time entries.
Revenue data (invoiced, collected, outstanding) comes from invoices.
Budget comes from matter.financial_limit (source of truth).
Discrepancies between WIP totals and invoice totals are surfaced, not silently resolved.

---

## 5. Entity Model

Nine built-in entity types, all extensible:

| Entity | API Source | Key Role |
|---|---|---|
| Fee Earner | GET /attorneys + Fee Earner CSV | Central to all profitability + utilisation |
| Matter | GET /matters | Revenue unit, joins to most other entities |
| Time Entry | POST /time-entries/search | Raw effort data, source of utilisation |
| Invoice | POST /invoices/search | Billing + debtor analysis |
| Client | GET /contacts | Aggregation target for client intelligence |
| Disbursement | POST /ledgers/search (OFFICE_PAYMENT) | Expense tracking, recovery analysis |
| Department | GET /departments | Organisational grouping |
| Task | GET /tasks | Matter workload and overdue tracking |
| Firm | Aggregated singleton | Firm-level rollup |

### Fee Earner: API + CSV Hybrid

The Yao API provides: _id, name, surname, email, status, job_title, rates[].value (where default=true), integration_account_id, integration_account_code.

The fee earner CSV still provides (manual upload required): payModel, annualSalary, monthlySalary, pension, NI, variablePay, targetWeeklyHours, chargeableWeeklyTarget, annualLeaveEntitlement, feeSharePercent, firmLeadPercent.

Join key: integration_account_id (primary) or email (fallback).

### Extensible Fields (via API — now populated)

| Field | Entity | Source |
|---|---|---|
| activityType | TimeEntry | activity.title on time entry (Email, Telephone, Drafting etc) |
| datePaid | Invoice | Derived from CLIENT_TO_OFFICE or OFFICE_RECEIPT ledger record |
| payee | Disbursement | payee field on OFFICE_PAYMENT ledger record |
| description | TimeEntry | description field on time entry |

---

## 6. Configuration System

Three tiers, all stored in Supabase firm_config as JSONB:

**Tier 1 — Firm Profile** (set once): working time defaults, pay model defaults, revenue attribution method, FTE counting method, financial year end.

**Tier 2 — Formula Configuration** (periodic): cost rate method, fee share percentages, overhead allocation, scorecard weights.

**Tier 3 — RAG Thresholds** (frequent): per-metric green/amber/red with per-grade overrides.

Always use getFirmConfig() / updateFirmConfig() — never raw JSONB queries. Every change writes to audit_log. Rollback always available.

---

## 7. Formula System

23 built-in formulas + 5 snippets across 7 domains. All formulas are pure functions: f(data, config) → result. No side effects. Null-safe. Pay-model-aware (always branch on salaried vs fee share).

| Domain | Formulas | Key Metrics |
|---|---|---|
| Utilisation & Time | F-TU-01 to F-TU-03 | Chargeable utilisation, recording consistency, non-chargeable breakdown |
| Revenue & Billing | F-RB-01 to F-RB-04 | Realisation rate, effective hourly rate, revenue per earner, billing velocity |
| WIP & Leakage | F-WL-01 to F-WL-04 | WIP age, write-off analysis, disbursement recovery, lock-up days |
| Profitability | F-PR-01 to F-PR-05 | Matter, fee earner, department, client, firm profitability |
| Budget & Scope | F-BS-01 to F-BS-02 | Budget burn rate, scope creep indicator |
| Debtors | F-DM-01 | Aged debtor analysis |
| Composites | F-CS-01 to F-CS-03 | Recovery opportunity, fee earner scorecard, matter health score |

Snippets: SN-001 (fully loaded cost rate), SN-002 (available working hours), SN-003 (firm retain), SN-004 (employment cost), SN-005 (cost rate by pay model).

Every formula result carries FormulaReadinessResult: READY / PARTIAL / BLOCKED / ENHANCED.
Every formula definition change creates a new version in formula_versions table. Never mutate in place.

---

## 8. Data Pipeline

### API Pull Pipeline (primary)

Runs inside a Netlify Background Function. Triggered by user clicking Pull from Yao.

| Stage | What |
|---|---|
| Auth | Re-authenticate to Yao API. Decrypt credentials from Supabase. POST /attorneys/login. Never cache token. |
| Fetch | Step 1: attorneys + departments + case-types in parallel (lookup tables, no pagination). Step 2: matters + time-entries + invoices + ledgers + tasks + contacts with pagination loops. Step 3: invoices/summary. |
| Normalise | Apply 12 field transformations. Strip password and email_default_signature. Route ledger records by type. Resolve all ObjectId references using in-memory lookup maps. |
| Enrich | Aggregate WIP per matter and fee earner. Derive datePaid from ledger routing. Build client profiles. Merge fee earner CSV data (payModel, salary, targets). |
| Calculate | Run full formula engine. Apply RAG thresholds. Run risk scanner. Generate risk_flags. |
| Store MongoDB | enriched_entities, calculated_kpis, risk_flags. Full detail, source of truth for AI layer. |
| Store Supabase | kpi_snapshots. Flat, indexed, pre-formatted, display-ready. Replace previous snapshot for this firm. Update pull_status to complete. |

### Legacy Upload Pipeline (preserved)

Hidden under Settings > Data Management > Advanced. For firms not on Yao API.

Stages: Parse > Normalise > Cross-Reference > Index > Join > Enrich > Aggregate > Calculate.

The cross-reference registry (MongoDB) maps matterId to matterNumber, lawyerId to lawyerName, contactId to displayName. Persists and extends on each upload. Coverage statistics in DataQualityReport.

---

## 9. Yao API Integration

### Authentication

Credentials stored AES-256 encrypted in Supabase yao_api_credentials. POST /attorneys/login returns JWT. All requests use Authorization: Bearer token. Re-authenticate on every pull — never store tokens.

### Endpoint Map

| Dataset | Endpoint | Method | Pagination | Response key |
|---|---|---|---|---|
| Attorneys | /attorneys | GET | None | Array |
| Departments | /departments | GET | None | Array |
| Case Types | /case-types/active | GET | None | Array |
| Matters | /matters | GET | page + limit | rows[] |
| Time Entries | /time-entries/search | POST | cursor: next | result[] |
| Invoices | /invoices/search | POST | page + size | Array |
| Ledgers | /ledgers/search | POST | page + size | Array |
| Tasks | /tasks | GET | page + limit | Array |
| Contacts | /contacts | GET | page + limit | Array |
| Invoice Summary | /invoices/summary | GET | None | Object |

### Ledger Routing Logic

Applied during Normalise stage. Filter: types: ["OFFICE_PAYMENT", "CLIENT_TO_OFFICE", "OFFICE_RECEIPT"].

- OFFICE_PAYMENT → disbursement entity. Use abs(value). firmExposure = abs(outstanding) when outstanding < 0. isRecovered = outstanding == 0.
- CLIENT_TO_OFFICE or OFFICE_RECEIPT + invoice field populated + disbursements[] empty → invoice payment. Use ledger.date as datePaid on matching invoice.
- CLIENT_TO_OFFICE or OFFICE_RECEIPT + disbursements[] populated + invoice empty → disbursement recovery record.
- Both invoice AND disbursements[] populated → split into two records.

### Field Transformation Rules

1. name + surname → fullName on all attorney objects
2. financial_limit → budget on matters (source of truth)
3. abs(value) on OFFICE_PAYMENT records (stored as negative in API)
4. datePaid: find CLIENT_TO_OFFICE or OFFICE_RECEIPT where invoice == invoice._id, use ledger.date
5. isFixedFee: caseTypeMap[case_type._id].fixed_fee > 0
6. isActive: status IN [IN_PROGRESS, ON_HOLD, EXCHANGED, QUOTE]
7. isClosed: status IN [COMPLETED, ARCHIVED, CLOSED]
8. durationHours: duration_minutes / 60
9. firmExposure: abs(outstanding) where outstanding < 0 on OFFICE_PAYMENT
10. isRecovered: outstanding == 0 on OFFICE_PAYMENT
11. activityType: activity.title preferred, work_type as fallback on time entries
12. Strip: password, email_default_signature from all attorney objects before storage

### Advantages Over Metabase Exports

- datePaid: absent in Metabase, derivable from ledger records via API
- activityType: ~0% coverage in Metabase, 100% via activity.title in API
- Orphaned WIP: ~49% in Metabase due to ID mismatch, 0% via API (consistent ObjectIds)
- Lawyer join: fuzzy name match in Metabase, exact ObjectId via API
- Client per matter: JSON string in Metabase, proper array of objects via API
- Disbursement payee: absent in Metabase, populated via API (HMLR etc)
- Payments on account: absent in Metabase, less_paid_on_account field via API
- Paralegal on matter: absent in Metabase, full nested object via API

---

## 10. Authentication & Security

- Supabase Auth handles all user authentication
- JWT tokens verified on every Netlify Function request via auth-middleware.ts
- RLS on all Supabase tables, enforced at database level
- MongoDB isolation enforced at application layer (firm_id on every query)
- Yao API credentials: AES-256 encrypted in yao_api_credentials, never in env vars or code
- Yao API JWT: short-lived, re-authenticated every pull, never stored or cached
- Sensitive fields: password and email_default_signature stripped before MongoDB storage
- User roles: owner, admin, partner, department_head, fee_earner, viewer
- Audit log: immutable, no UPDATE or DELETE permitted
- Config export: excludes user accounts, raw data, calculated KPIs, API credentials

---

## 11. Performance Architecture

The fundamental principle: **dashboards never calculate anything**. All computation happens at pull time in a Background Function. Dashboards only read pre-computed values from kpi_snapshots.

Pull time (background, no timeout limit):
- Heavy work: fetch + normalise + enrich + calculate + store
- Duration: 30 seconds to several minutes depending on firm data volume
- User sees a progress indicator via pull_status polling

Dashboard load time:
- Single SELECT from kpi_snapshots
- Target: under 500ms for any dashboard
- Zero MongoDB access, zero formula calculation, zero API calls

Root causes of current UI slowness and their fixes:
1. Calculation on every load → kpi_snapshots pre-computation
2. MongoDB chunk reassembly on load → pre-aggregated KPI documents, never assembled client-side
3. No caching → kpi_snapshots is safe to cache between pulls
4. Large payloads → never send raw entities to frontend, only display-ready kpi_snapshots rows
5. Cold start chains → batch multiple KPI reads into single Netlify Function call

---

## 12. AI Layer (Future Phase)

Seeds planted now so AI features work cleanly when built:

### Natural Language Query

Users ask: "Who are my top 5 fee earners by realisation rate this quarter?"
System: Claude receives question + kpi_snapshots schema → generates safe query DSL → executes → formats response.
Planted now: kpi_snapshots uses consistent, descriptive field names (entity_name, kpi_key, display_value).

### AI Risk Flagging

After every pull, risk_scanner generates risk_flags in MongoDB. AI phase adds: Claude summarises flags in plain English, stores in ai_summary field, surfaces in dashboard notification feed.
Planted now: risk_flags collection with ai_summary field (null until AI phase). Scanner runs every pull.

### AI Context for Matters

Time entry description fields (now populated via API) enable Claude to generate matter summaries and flag billing anomalies.
Planted now: description stored on enriched time entry entities in MongoDB.

---

## 13. Design & Theming

All colours, typography, spacing, and component styling are defined in ThemeGuide.md.

Claude Code: do not generate UI styles, suggest colour values, or make component design decisions.
Lovable.dev: follow ThemeGuide.md for all visual decisions.

Upload pipeline UI is hidden under Settings > Data Management > Advanced. Never in main navigation or onboarding for API-connected firms. Pull from Yao button is the primary data ingestion action.

---

## 14. Key Design Decisions

**kpi_snapshots as the dashboard data layer.** All dashboards read exclusively from kpi_snapshots. This separates heavy computation (pull time) from user experience (dashboard load) completely. MongoDB holds full enriched data for the AI layer. Dashboards never touch MongoDB.

**API-first, upload as fallback.** The Yao API provides cleaner data, consistent identifiers, richer fields, and eliminates the ~49% WIP orphan rate. Legacy upload pipeline preserved but hidden.

**Re-authenticate on every pull.** Yao tokens are short-lived. Credentials stored encrypted, fresh token obtained per pull. No token storage, no refresh logic, no expiry edge cases.

**risk_flags planted early.** Risk scanner and collection built in Phase 1 so data accumulates from day one. AI layer has historical context when it launches.

**Formulas are pure data, not code.** Formula definitions are structured descriptor objects, not executable JavaScript. Enables safe versioning, import/export, and AI translation.

**Fee share vs salaried as first-class concept.** Every profitability formula branches on pay model. Fee share lawyers have no employment cost to the firm. All formulas handle both explicitly.

**datePaid is now derivable.** Previously absent from Metabase exports. Now derived from CLIENT_TO_OFFICE or OFFICE_RECEIPT ledger records. Unlocks exact debtor days and payment behaviour analysis.

**Config changes are always audited and reversible.** Every change logs old value, new value, user, timestamp. Rollback always available. Formula versioning means historical results are never corrupted.

---

## 15. Future Considerations

**AI Natural Language Query:** kpi_snapshots already designed for Claude to query. Add NLQ endpoint. No schema changes needed.

**AI Risk Summarisation:** risk_flags already populated. Add post-pull Claude summarisation step. Surface in dashboard notification feed.

**Scheduled Auto-Pull:** Add Netlify scheduled function for automatic daily/weekly pulls. Credentials already stored. No architectural changes needed.

**Historical Trend Analysis:** kpi_snapshots retains records with pulled_at. Trend lines and week-on-week comparisons query across multiple pulled_at values.

**Multi-currency:** currency field on firms table is present. Formula execution context carries currency. Conversion logic can be added without schema changes.

**Formula Marketplace:** Formulas are pure data definitions. Can be exported, anonymised, shared between firms without architectural changes.

**Direct Yao Webhooks:** Instead of user-triggered pulls, Yao pushes events on each update. DataSourceAdapter abstraction makes this a new ingestion path without pipeline changes.

---

*Yao Mind — From data you already have, to intelligence you have never had.*
*Built with Claude Code · Powered by Anthropic · For UK Law Firms*
