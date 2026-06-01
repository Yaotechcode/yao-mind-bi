# Yao Mind BI — API Capability & Pipeline Restructure Plan (Current-State Refresh)

**Refreshed:** 2026-06-01
**Supersedes:** the 2026-05-08 edition of this document.
**Scope:** Backend data pipeline and formula engine only. No UI changes.
**Verified against:** current `src/server/` + `src/shared/` source, and `docs/yao-api-spec.json` (33,757-line OpenAPI 3.0 spec).

> **Why this refresh exists.** The previous edition of this plan (8 May) recommended a Priority 1–10 fix list. **Five commits have since landed that implement most of it.** Re-reading the current source confirms the date-field bug, ledger fetch, attorney map, completeness check, summary validation, targets fetch, WIP/invoice merge, and matter-status classification are all now in place. This edition records what is now done, then concentrates on what is **still wrong or newly discovered**, plus the data-readiness work needed for the Phase 2 CFO / Managing Partner dashboard.

Commits since the prior edition:

| Commit | Effect |
|--------|--------|
| `7e928f7` | `dataPullLookbackMonths` default 3 → 13; persisted in working_time_defaults |
| `6a2e42f` | PullOrchestrator loads `dataPullLookbackMonths` from firm config (fallback 13) |
| `bc5f945` | `parallelPaginatePost` retries timed-out pages; TE batch size → 3; request timeout 30s → 45s |
| `4ab1337` | Include NO_STATUS time entries; exclude only CONSOLIDATED / CONSOLIDATION_TARGET / DELETED |
| `0ddb06f` | `durationHours` uses `units × 6 / 60` (billing units) not `duration_minutes / 60` |

---

## Section 0 — Current State Summary (what is already fixed)

These items from the prior plan are **implemented and verified**. They are NOT re-recommended below.

| Prior-plan item | Status | Evidence (current source) |
|---|---|---|
| Date field `date_from` → `start` | ✅ Fixed | `DataSourceAdapter.fetchTimeEntries`/`fetchInvoices`/`fetchLedgers`/`fetchTimeEntrySummary` all build `body['start'] = fromDate` |
| Ledger fetch disabled | ✅ Re-enabled | `PullOrchestrator` `Promise.all` triple-fetch: `fetchLedgers('OFFICE_PAYMENT' \| 'CLIENT_TO_OFFICE' \| 'OFFICE_RECEIPT', …)` |
| Attorney map dropped disabled attorneys | ✅ Fixed | `fetchAttorneys` returns all attorneys; the `status==='active'` count is log-only; `buildAttorneyMap` iterates the full list |
| Per-attorney completeness (Ben Haulkham / Carla Fishlock) | ✅ Added | `fetchTimeEntries` builds a `seenAssignees` set and runs targeted `{ assignee }` queries for attorneys with zero entries; `PullOrchestrator` passes `attorneyIds` |
| `/time-entries/summary` validation | ✅ Added | `fetchTimeEntrySummary` + `validateTimeEntryTotals` warn on > 1% discrepancy; called in `PullOrchestrator` |
| Targets API fetched | ✅ Partial | `fetchTargets(competence)` called for current `YYYY-MM`; `targetsByUser` map built (but **not yet consumed by the formula engine** — see Issue 2) |
| WIP + invoice aggregates merged into matter records | ✅ Done | `PullOrchestrator` builds `wipByMatter` / `invoiceByMatter`, merges `wipTotalBillable`/`invoicedNetBilling`/… onto each matter before `storeEnrichedEntities` |
| `firmRealisation` returning 0 | ✅ Largely resolved | `orchestrator.ts:707` spreads `...r` **last** in the fallback matter map, so merged `wipTotalBillable`/`invoicedNetBilling` override the zero-init at lines 685–704. F-RB-01 now produces matter-level values; `dashboard-service.ts:453–458` averages them. **Caveat:** the numerator is overstated — see Issue 1. |
| Matter status enum | ✅ Fixed | `transformations.ts` `CLOSED_STATUSES` now includes `NOT_PROCEEDING`, `DESTROYED`, `LOCKED` |
| NO_STATUS time entries dropped | ✅ Fixed | `fetchTimeEntries` includes undefined/null/empty status; excludes only `CONSOLIDATED`/`CONSOLIDATION_TARGET`/`DELETED` |
| Pagination silent failure | ✅ Mitigated | `parallelPaginatePost` retries a timed-out page sequentially before stopping; TE batch size 3; 45s timeout |

---

## Section 1 — API Capability Assessment (corrected against current spec)

Endpoints whose assessment is unchanged from the prior edition are summarised; corrections and newly-confirmed facts are called out.

### 1.1 POST /attorneys/login
JWT in `access_token`. Public. `extractToken()` handles multiple key names. Re-authenticated every pull (no token caching). **No change.**

### 1.2 GET /attorneys
Returns a flat **array** of `Attorney`. No pagination. Query params: `status[]`, `search`, `accounts_authorisation` (all optional). Status enum: `ACTIVE | PENDING | DISABLED` (3 values). Key fields: `_id`, `name`, `surname`, `status`, `rate`, `rates[]`, `integration_account_id`, `job_title`.
**Correction vs Phase 2 spec:** `department` is **NOT a field on `Attorney`** (confirmed absent in the schema). Department attribution must route through `matter.case_type.department`. This blocks fee-earner-by-department analysis — see Section 4.
**Verdict:** Working. Keep all attorneys in the resolution map (done).

### 1.3 POST /time-entries/search
**Spec response says flat `TimeEntry[]`** — but the working code reads `result` from a `{ result, next }` envelope via `parallelPaginatePost(..., 'result', 50, 3)`. **The spec response shape is unreliable here; trust the code.** Page-based pagination, stop when a page returns `< size`.
**SearchTimeEntryDto:** all 10 fields (`page, size, matter, assignee, work_type, start, end, invoiced, status, invoice`) are marked `required` in the spec — a Swagger artifact. `status` is typed `object` (no enum). Only `page` + `size` are truly required; omit unused fields (do not send empty strings — `@IsMongoId()` would reject `""`).
**Underused capability:** `invoiced: 'Uninvoiced'` returns only unbilled entries — the exact set needed for an unbilled-WIP aggregate (Section 4, lock-up). Not currently used.
**Verdict:** Fetch path is correct. Add an `invoiced: 'Uninvoiced'` pass for lock-up WIP (Section 5, P2).

### 1.4 POST /time-entries/summary
Response object (5 fields): `total_duration_hours`, `total_duration_minutes`, `total_units`, `total_days`, `total_value`. **Now used** for post-fetch validation. **No change.**

### 1.5 GET /matters
Response: `FindMattersQueryResponse` = `{ limit, search, rows[] }`. **Pagination: `page` is required; `limit` defaults to 50; a `last_id` cursor param also exists.** Filters (all optional): `case_type`, `department`, `client_id`, `status`, `responsible_lawyer`, `title`, `contact`, `number`.
**Matter status enum (11 values, confirmed):** `DRAFT, IN_PROGRESS, QUOTE, ON_HOLD, COMPLETED, ARCHIVED, EXCHANGED, NOT_PROCEEDING, CLOSED, DESTROYED, LOCKED`.
BI fields: `financial_limit` (budget cap), `office_account_balance` (outstanding debtor position), `client_account_balance`, `responsible_lawyer`, `department`, `case_type`, `in_progress_date`, `completed_date`, `archived_date`.
**Verdict:** Working. Verify `fetchMatters` exit condition against `page`/`limit`/`rows.length < limit` (Section 5, P7).

### 1.6 GET /matters/{id}/financial-stats
`FinancialLimitResponse` = `{ limit_percentage, financial_limit, limit_consumed }` (3 fields). Per-matter (N calls). `matter.office_account_balance` already gives outstanding without it. **Skip for the batch pipeline.**

### 1.7 POST /invoices/search
Response: flat **array** of `Invoice`. Page-based (`page` + `size`). Date filter on `invoice_date` via `start`/`end`.
**Invoice status enum — CORRECTED (11 values):** `DRAFT, ALLOCATED, ISSUED, PAID, CREDITED, WRITTEN_OFF, CANCELED, REVERSED, REMOVED, ERROR, DRAFT_ERROR`.
> The prior edition (and CLAUDE.md) listed `DRAFT | ISSUED | PENDING_APPROVAL | APPROVED | PAID | OVERDUE`. That is **wrong**. In particular there is **no `OVERDUE` status** — overdue is derived from `TODAY − due_date`; and `WRITTEN_OFF` is a distinct status (see Issue 3).
BI fields: `billing_amount` (net fees, excl VAT), `subtotal`, `total` (incl VAT + disbursements), `total_firm_fees`, `total_disbursements`, `vat`, `outstanding`, `paid`, `credited`, `written_off`, `write_off`, `solicitor`, `matter`, `invoice_date`, `due_date`, `time_entries[]`.
**Verdict:** Fetch correct. The aggregation reads the **wrong amount field** — see Issue 1.

### 1.8 GET /invoices/summary
`{ unpaid, paid, total }`, all-time. Fetched correctly. **No change.**

### 1.9 POST /invoices/credit-control/search
`CreditControlSearchDto`: `page` (default 0), `size` (default 50, max 1000), `department`, `status`, `responsible_lawyer`, `client` — all optional (`page`/`size` typed `object`, Swagger artifact). Useful for the Billing/Collections dashboard; the `credit_control` object on each Invoice from `/invoices/search` may already suffice. **Medium priority, not yet used.**

### 1.10 GET /departments, GET /case-types/active
Fetched correctly. `is_deleted` filtered client-side; `fixed_fee > 0 → isFixedFee`. **No change.**

### 1.11 POST /ledgers/search
Root-level **array** of `Ledger`. Page-based. **Now re-enabled** via parallel triple-fetch.
**DTO field disambiguation (confirmed):** the DTO exposes `type`, `types[]`, and `ledger_type` separately, all typed `object`/untyped-array (Swagger artifact, no enums emitted). The transaction-type enum lives on the `Ledger.type` schema (**25 values**): `OFFICE_RECEIPT, CLIENT_RECEIPT, OFFICE_PAYMENT, CLIENT_PAYMENT, CLIENT_TO_OFFICE, OFFICE_TO_CLIENT, CLIENT_TRANSFER, INVOICE, OFFICE_CREDIT, OFFICE_TO_OFFICE, CREDIT_NOTE, REVERSAL, INTEREST, LINKED_PAYMENT, LINKED_RECEIPT, CLIENT_TO_LINKED, LINKED_TO_CLIENT, LINKED_TO_OFFICE, OFFICE_TO_LINKED, REGULATORY_DEPOSIT, REGULATORY_WITHDRAWAL, WRITE_OFF, WRITE_OFF_BILL, TAX, OPENING_BALANCE`. `BankAccountType` (used by `type`/`types`) has **5 values**: `CLIENT, OFFICE, EXTERNAL, MATTER, REGULATORY`.
**Verdict:** Working via per-`ledger_type` calls. `WRITE_OFF` / `WRITE_OFF_BILL` ledger types are available as an alternative write-off source (relevant to Issue 3).

### 1.12 GET /tasks
Page-based GET. Known 500 on a later page handled by `stopOnServerError`. **No change.**

### 1.13 GET /targets/{competence}
`TargetsFirm`: `global.{target_billing, target_hours}`, `workday_rules.{working_days_per_month, excluded_dates[]}`, `user_targets[]` (`UMUserTargetDto`: `user_id, work_hours_per_day, non_chargeable_ratio, rate_per_hour, billing_override?`). **Fetched, but only partially consumed** — see Issue 2.

### 1.14 GET /targets/progress, /targets/progress/individual
No response schema in the spec; return recorded performance, not configured targets. **Not needed for the pipeline.**

### 1.15 GET /dashboard/law-firm/{admin,attorney,admin-report}
No 200 response schema documented in the spec; in practice these return Metabase embed URLs for the Yao frontend, not BI data. **Never call from Yao Mind.**

### 1.16 GET /contacts; POST /rates/search; GET /rates/applicable_rate
Contacts disabled (display names inline on matters/invoices). Rates unnecessary (`attorney.rates[]`). **Keep as-is.**

---

## Section 2 — Gap Analysis (KPI × data × status)

| KPI | Data required | Endpoint(s) | Status | Remaining gap |
|-----|---------------|-------------|--------|----------------|
| Chargeable utilisation (F-TU-01) | Chargeable hours; target hours | `/time-entries/search`; `/targets/{competence}` or CSV | Partial | Denominator uses CSV `targetWeeklyHours` / firm config — targets API `work_hours_per_day` + `excluded_dates` not wired in (Issue 2); hours now counted in 6-min **billing units** (Issue 4) |
| Recording consistency (F-TU-02) | Last entry date per attorney | `/time-entries/search` | Working | — |
| Non-chargeable breakdown (F-TU-03) | `work_type` per entry | `/time-entries/search` | Working | — |
| Effective hourly rate (F-RB-02) | Hours + attributed revenue | `/time-entries/search`, `/invoices/search` | Partial | Revenue numerator inflated by VAT+disb (Issue 1) |
| Revenue per fee earner (F-RB-03) | Invoiced revenue via `solicitor` | `/invoices/search` | Partial | Same VAT+disb inflation (Issue 1); pay model still CSV |
| Realisation rate (F-RB-01) | WIP value + invoiced per matter | `/time-entries/search`, `/invoices/search` | **Producing values, but overstated** | Numerator = `invoice.total` (gross) not net (Issue 1) |
| Firm realisation | Avg of matter F-RB-01 | derived | **Producing values, but overstated** | Cascades from Issue 1 |
| WIP age / budget burn (F-RB-04 / F-BG-01) | Unbilled entry age; `financial_limit` | `/time-entries/search`, `/matters` | Partial | `wipTotalBillable` mixes billed+unbilled — needs unbilled-only WIP (Section 4) |
| Write-off rate | `written_off`/`write_off` | `/invoices/search` | Partial | Fully `WRITTEN_OFF` invoices excluded from aggregation (Issue 3) |
| Invoice datePaid / disbursement exposure / recovery | Ledgers | `/ledgers/search` ×3 | Working | — |
| Aged debtor analysis | `invoice.outstanding` + `due_date` | `/invoices/search` | Working | Overdue derived from `due_date` (no OVERDUE status) |
| Lock-up days / WIP days / debtor days (Phase 2) | Unbilled WIP + outstanding + annualised income | multiple | **Not built** | Needs unbilled-only WIP aggregate (Section 4) |
| Collections forecast (Phase 2) | `client_avg_payment_days` | `/ledgers/search` (CLIENT_TO_OFFICE) | **Not built** | Per-client payment-lag aggregation missing (Section 4) |
| Matter profitability / WIP cost (Phase 2) | `rate_per_hour` cost rate | `/targets/{competence}` | **Not built** | Targets cost rate not wired into a cost calc (Section 4) |
| Department-by-fee-earner profitability (Phase 2) | dept per attorney | — | **Blocked** | `department` not on Attorney; route via `matter.case_type.department` (Section 4) |
| Write-down leakage (Phase 2) | entry-to-invoice linkage | `invoice.time_entries[]` | **Not built** | Linkage exists; computation not implemented (Section 4) |

---

## Section 3 — Open Issues: Root Cause & Fix Strategy

> Resolved issues from the prior edition (date fields, ledger fetch, attorney map, completeness, summary validation, WIP/invoice merge, matter status, NO_STATUS, pagination) are recorded in Section 0 and not repeated here.

### Issue 1 — `invoicedNetBilling` is GROSS, not net (HIGH — correctness)
**Root cause:** `transformInvoice` (`transformations.ts:207`) sets `total: raw.total`, and the spec defines `invoice.total` as "total including VAT". `aggregateInvoicesByMatter` (`invoice-enricher.ts:173`) then does `summary.invoicedNetBilling += invoice.total`. So `invoicedNetBilling` carries **VAT + disbursements**, despite the name. `transformInvoice` already computes `billingAmount` (`raw.billing_amount`, net fees) and `subtotal`, but neither feeds this aggregate.
**Impact:** F-RB-01 numerator `billedValue = matter.invoicedNetBilling` (`revenue.ts:159`) → `realisation = billedValue / recordedValue × 100` (`revenue.ts:183`) is overstated by roughly the VAT rate (~20%) plus any disbursements. `firmRealisation` (the unweighted average, `dashboard-service.ts:453–458`) and revenue-per-fee-earner inherit the error. A firm at a true ~85% realisation could display >100%.
**Fix:** Aggregate `invoice.billingAmount` (net fees) — or `subtotal` if F-RB-01's denominator (`wipTotalBillable`, which is fee value excl VAT) should be matched on a like-for-like basis. Confirm the intended semantic against `wip-aggregator` (`totalBillable` = sum of `entry.billable`, a net fee value), then make numerator and denominator consistent (both net of VAT and disbursements). Update the `InvoiceMatterSummary.invoicedNetBilling` source and the analogous `InvoiceFeeEarnerSummary`.
**Files:** `src/server/datasource/enrich/invoice-enricher.ts` (lines ~173 and the fee-earner aggregation); cross-check `src/server/formula-engine/formulas/revenue.ts:158–183`.
**Effort:** Small (code) + medium (validation against a live firm).
**Acceptance:** For a matter with £80k net fees invoiced and £20k remaining WIP, F-RB-01 ≈ 80%. No matter shows realisation materially above ~110% solely due to VAT.

### Issue 2 — Targets API fetched but not consumed by the formula engine (MEDIUM)
**Root cause:** `fetchTargets` + `targetsByUser` exist in the pull path, but `utilisation.ts` derives the F-TU-01 denominator from `computeAvailableHours()` using `firmConfig.weeklyTargetHours` / CSV `targetWeeklyHours` (via SN-002), and the fee-earner merger does not read targets-API fields. `workday_rules.excluded_dates` (bank holidays / firm closures) is never used to refine the available-days denominator.
**Impact:** The stated reduction of the CSV upload dependency is **not realised in the formula path** — a firm with Yao targets but no CSV still falls back to firm-config defaults for utilisation. Utilisation denominators are less accurate than the available data allows.
**Fix:** Wire `user_targets[].work_hours_per_day` and `non_chargeable_ratio` into the effective fee-earner config consumed by SN-002 / `computeAvailableHours`, and subtract `workday_rules.excluded_dates` from working days. Establish precedence (CSV override > targets API > firm-config default) and document it.
**Files:** `src/server/formula-engine/formulas/utilisation.ts` (`computeAvailableHours`, `getAvailableHours`), the SN-002 snippet, `src/server/datasource/enrich/fee-earner-merger.ts`, and the merge point in `PullOrchestrator`.
**Effort:** Medium.
**Acceptance:** A firm with Yao targets and no CSV returns non-null F-TU-01 driven by `work_hours_per_day`; available days for a month containing a bank holiday are reduced accordingly.

### Issue 3 — Invoice status enum + `WRITTEN_OFF` exclusion (MEDIUM)
**Root cause:** The real status enum has 11 values (Section 1.7). `BILLABLE_STATUSES = {ISSUED, PAID, CREDITED}` (`invoice-enricher.ts:38`) is used to gate `aggregateInvoicesByMatter`. Fully written-off invoices carry status `WRITTEN_OFF` and are therefore skipped entirely — so `invoicedWrittenOff` (summed from the `written_off` field only within billable invoices) **misses** them.
**Impact:** Write-off rate is understated; lifetime matter revenue/realisation can be misstated where invoices were later written off. Aged-debt logic must not rely on a non-existent `OVERDUE` status.
**Fix:** Decide the treatment of each status explicitly. Include `WRITTEN_OFF` (and consider `CREDITED`/`REVERSED`) in a dedicated write-off aggregate, or alternatively source write-offs from `WRITE_OFF`/`WRITE_OFF_BILL` ledger types (now available). Replace any `OVERDUE`-status logic with `due_date`-based derivation. Correct the enum in CLAUDE.md.
**Files:** `src/server/datasource/enrich/invoice-enricher.ts`; any dashboard-service aged-debt logic; `CLAUDE.md`.
**Effort:** Medium.
**Acceptance:** A firm's write-off total matches the sum of `written_off` across all relevant statuses; no code references an `OVERDUE` invoice status.

### Issue 4 — `durationHours = units × 6 / 60` hardcodes 6-minute units (MEDIUM — verify)
**Root cause:** `transformations.ts:162` computes `durationHours = (units > 0) ? units*6/60 : duration_minutes/60`, assuming one billing unit = 6 minutes (0.1h).
**Impact:** Utilisation and hours-based KPIs now count **billing units**, not recorded clock time. If a firm bills in different unit lengths, or records meaningful `duration_minutes` divergent from `units`, hours are wrong. The two branches can disagree for the same entry.
**Fix:** Confirm against the Yao API / a live firm that `units` are always 6-minute units. Document the assumption prominently. If unit length varies, source it from config rather than hardcoding `6`. Decide deliberately whether utilisation should reflect billed units or recorded minutes.
**Files:** `src/server/datasource/normalise/transformations.ts:162`; CLAUDE.md transformation #8 (currently still says `duration_minutes / 60` — stale).
**Effort:** Small (doc) + verification.
**Acceptance:** CLAUDE.md matches the code; a documented basis for the 6-minute assumption exists.

### Issue 5 — Matters pagination basis (LOW — verify)
**Root cause:** Spec marks `page` required and offers both `limit` (default 50) and a `last_id` cursor. The current `fetchMatters` should be confirmed to paginate by `page`/`limit` with the correct `rows.length < limit` exit.
**Impact:** Low; a wrong exit condition could truncate or loop matters.
**Fix:** Read `fetchMatters`; confirm the loop and exit. No change if correct.
**Files:** `src/server/datasource/DataSourceAdapter.ts` (`fetchMatters`).
**Effort:** Small.

---

## Section 4 — Phase 2 (CFO / Managing Partner) Readiness Gap Analysis

Mapping the Phase 2 financial dashboard spec to current data readiness. "Ready" = computable from data the pipeline already stores; "Gap" = needs new aggregation or a data-model change.

### 4.1 Lock-Up / WIP Days — **GAP (unbilled-only WIP)**
Phase 2 defines `Total WIP Value = SUM(time_entry.billable) WHERE invoice = null AND do_not_bill = false AND status = ACTIVE AND matter.status IN [IN_PROGRESS, ON_HOLD, EXCHANGED]`. The current `wip-aggregator` `totalBillable` sums **all** recorded entries (billed and unbilled). Lock-up requires the **unbilled** subset.
**Action:** Add an unbilled-WIP aggregate — either filter the already-fetched entries by `invoice == null` when building a parallel `wipUnbilledByMatter`, or add a dedicated `invoiced: 'Uninvoiced'` fetch pass (Section 1.3) that also captures unbilled entries predating the lookback window. Annualised fee income (the denominator) is available from `/invoices/search` (`paid + outstanding + written_off`), with `TargetsFirm.global.target_billing` as the <3-month proxy the spec calls for.
**Files:** `src/server/datasource/enrich/wip-aggregator.ts`; `PullOrchestrator` merge; new firm-level snapshot keys.

### 4.2 Debtor Days / Aged Debt — **READY**
`invoice.outstanding` per ISSUED invoice; banding from `TODAY − due_date`. No `OVERDUE` status — derive overdue from `due_date` (Issue 3). `matter.office_account_balance` is an alternative firm-level cross-check.

### 4.3 Collections Forecast / `client_avg_payment_days` — **GAP**
Spec needs `AVG(ledger.date − invoice.invoice_date) WHERE ledger.type = CLIENT_TO_OFFICE` per client over a rolling window. Ledgers are now fetched and `deriveInvoiceDatePaid` (`invoice-enricher.ts`) already matches payments to invoices.
**Action:** Add a per-client payment-lag aggregation from CLIENT_TO_OFFICE / OFFICE_RECEIPT ledgers; gate the forecast behind the 3-month-history confidence rule from the spec.
**Files:** new aggregator (alongside `invoice-enricher.ts`); client-level snapshots.

### 4.4 Realisation (Billing & Cash) & Leakage — **PARTIAL**
Billing realisation depends on Issue 1 being fixed (net-of-VAT numerator). Cash realisation = `invoice.paid / total_invoiced` — ready. **Write-down leakage** (recorded rate vs billed amount) is computable because `invoice.time_entries[]` links invoices to entries; not yet implemented. Do-not-bill and write-off leakage are available (subject to Issue 3 for `WRITTEN_OFF`).
**Files:** `invoice-enricher.ts`; a new leakage aggregator.

### 4.5 Matter Profitability / WIP Cost — **GAP (wiring)**
Cost = `time_entry.units/60 × attorney_cost_rate`, where `attorney_cost_rate = UMUserTargetDto.rate_per_hour` from the targets API (now fetched). Revenue from invoices (net — Issue 1). Fixed-fee cap via `matter.financial_limit` with the 70/90/100% thresholds.
**Action:** Wire `rate_per_hour` into a per-matter WIP-cost aggregate; add fixed-fee cap consumption.
**Files:** `wip-aggregator.ts` (or a new cost aggregator); targets merge.

### 4.6 Department / Fee-Earner-by-Department — **BLOCKED (data model)**
`department` is **not on Attorney**. Department-level WIP is reachable via `matter.case_type.department`, but fee-earner-by-department needs an attorney→department mapping that the API does not provide.
**Action (MVP):** Compute department metrics via matter routing only; defer FE×dept until a department field is added to the fee-earner CSV or attorney model.

### 4.7 Matter-Type WIP Tolerance Modifiers — **GAP (config)**
Section 7 of the Phase 2 spec applies per-matter-type WIP-age baselines (e.g. residential conveyancing 60d, wills/probate 30d). Requires a `case_type → matter-type` mapping plus per-type thresholds in `firm_config` (Tier 3 RAG, per-firm overridable).
**Action:** Add the mapping + threshold config; apply as offsets in the WIP-age RAG evaluation.

### 4.8 Multi-tenancy — **CONFIRMED**
All Yao API responses are scoped to the authenticated firm's `law_firm` (firm credentials from `yao_api_credentials`, re-auth per pull). Every MongoDB op includes `firm_id`; Supabase RLS via `get_user_firm_id()`. The new aggregates above add no cross-firm surface.

---

## Section 5 — Re-prioritised Fix List

### P1 — Fix `invoicedNetBilling` gross/VAT inflation (Issue 1)
**Change:** In `invoice-enricher.ts`, aggregate net fees (`billingAmount`/`subtotal`) instead of `invoice.total`; make F-RB-01 numerator/denominator consistent.
**Why first:** Every realisation and revenue number a managing partner sees is currently overstated by ~VAT + disbursements — the single largest trust risk.
**Acceptance:** Matter realisation lands in a credible 50–110% band; £80k-net/£20k-WIP example ≈ 80%.

### P2 — Add unbilled-only WIP aggregate (Issue 4.1 / lock-up)
**Change:** Build `wipUnbilledByMatter` (and firm total) from entries with `invoice == null`; expose as snapshot keys for WIP days / lock-up.
**Why:** Unlocks the Phase 2 headline numbers (Total Lock-Up, WIP Days, Combined Lock-Up Days).
**Files:** `wip-aggregator.ts`, `PullOrchestrator`.
**Acceptance:** Firm WIP Days computes from unbilled WIP ÷ annualised income and matches a hand check on a sample firm.

### P3 — Wire targets API into utilisation (Issue 2)
**Change:** Feed `work_hours_per_day`, `non_chargeable_ratio`, `excluded_dates` into the F-TU-01 denominator with documented CSV > targets > default precedence.
**Files:** `utilisation.ts`, SN-002, `fee-earner-merger.ts`, `PullOrchestrator`.
**Acceptance:** A CSV-less firm with Yao targets returns non-null utilisation reflecting `work_hours_per_day` and bank-holiday exclusions.

### P4 — Correct invoice status handling incl. `WRITTEN_OFF` (Issue 3)
**Change:** Add a write-off aggregate covering `WRITTEN_OFF` (or source from `WRITE_OFF`/`WRITE_OFF_BILL` ledgers); remove any `OVERDUE`-status assumptions; fix CLAUDE.md enum.
**Files:** `invoice-enricher.ts`, dashboard-service aged-debt, `CLAUDE.md`.
**Acceptance:** Firm write-off total matches the full ledger/invoice write-off sum.

### P5 — Per-client payment-lag aggregation (Section 4.3)
**Change:** Compute `client_avg_payment_days` from CLIENT_TO_OFFICE/OFFICE_RECEIPT ledgers; gate the collections forecast behind the history-confidence rule.
**Files:** new aggregator; client snapshots.
**Acceptance:** Clients with payment history show a sensible average lag; forecast suppressed for <3 months of data.

### P6 — Department metrics via `matter.case_type.department` (Section 4.6)
**Change:** Route department WIP/revenue through matter→case_type→department; document the FE×dept block pending a department field.
**Acceptance:** Department-level WIP totals reconcile to the sum of their matters.

### P7 — Document `durationHours` unit assumption + verify matters pagination (Issues 4, 5)
**Change:** Update CLAUDE.md transformation #8 to the `units × 6 / 60` reality with the 6-minute-unit caveat; confirm `fetchMatters` page/limit exit condition.
**Files:** `transformations.ts` (doc only), `CLAUDE.md`, `DataSourceAdapter.ts` (verify).
**Acceptance:** CLAUDE.md matches code; matters pagination confirmed correct.

---

## Appendix A — Corrected Field / Enum Reference

**Invoice status (11):** `DRAFT, ALLOCATED, ISSUED, PAID, CREDITED, WRITTEN_OFF, CANCELED, REVERSED, REMOVED, ERROR, DRAFT_ERROR` — no `OVERDUE`.
**Matter status (11):** `DRAFT, IN_PROGRESS, QUOTE, ON_HOLD, COMPLETED, ARCHIVED, EXCHANGED, NOT_PROCEEDING, CLOSED, DESTROYED, LOCKED`.
**Attorney status (3):** `ACTIVE, PENDING, DISABLED`. **No `department` field on Attorney.**
**Ledger transaction type (25):** see Section 1.11.
**BankAccountType (5):** `CLIENT, OFFICE, EXTERNAL, MATTER, REGULATORY`.
**Invoice amount fields:** `billing_amount` (net fees, excl VAT) · `subtotal` · `total` (incl VAT + disbursements) · `total_firm_fees` · `total_disbursements` · `vat` · `outstanding` · `paid` · `credited` · `written_off` · `write_off`.
**TargetsFirm:** `global.{target_billing, target_hours}` · `workday_rules.{working_days_per_month, excluded_dates[]}` · `user_targets[].{user_id, work_hours_per_day, non_chargeable_ratio, rate_per_hour, billing_override?}`.

## Appendix B — Spec vs Reality

| Item | Spec says | Reality |
|------|-----------|---------|
| Search*Dto `required` arrays | All fields required | Only `page` + `size`; rest optional (Swagger artifact) |
| `status`/`type`/`ledger_type` DTO types | `object`, no enum | Accept string enum values |
| `/time-entries/search` response | Flat `TimeEntry[]` | `{ result, next }` envelope (code reads `result`) |
| `/invoices/search` response | Flat `Invoice[]` | Flat array (correct) |
| Invoice status enum | (prior doc) 6 values incl `OVERDUE` | 11 values, **no `OVERDUE`** |
| `/matters` pagination | `page` required + `limit` + `last_id` | Page-based with `rows`/`limit` |
| `/matters/{id}/financial-stats` | 3 fields | 3 fields (`limit_percentage, financial_limit, limit_consumed`) |
| `/dashboard/*` | No 200 schema | Metabase embed URLs — not data APIs |
| `/targets/progress*` | No schema | Recorded performance, not configured targets |
| Attorney `department` | — | Absent — route via `matter.case_type.department` |
| `invoice.total` | Total incl VAT | Wrongly aggregated as `invoicedNetBilling` (Issue 1) |
| `durationHours` | (CLAUDE.md) `duration_minutes/60` | `units × 6 / 60` (Issue 4) |
