// src/server/pipeline/data-quality.ts
// Data Quality Report builder — pure functions only. No database calls.

import type {
  JoinResult,
  AggregateResult,
  AggregateDataQualityReport,
  FileCoverage,
  EntityIssue,
  AggregateKnownGap,
  Discrepancy,
  Recommendation,
} from '../../shared/types/pipeline.js';

type AggregateBase = Omit<AggregateResult, 'dataQuality'>;

// ---------------------------------------------------------------------------
// File metadata
// ---------------------------------------------------------------------------

interface FileSpec {
  fileType: string;
  label: string;
  impact: FileCoverage['impact'];
  missingImpact: string;
}

const FILE_SPECS: FileSpec[] = [
  {
    fileType: 'wipJson',
    label: 'WIP / Lawyer Time',
    impact: 'critical',
    missingImpact: 'All time-based KPIs are unavailable: utilisation, recording rate, WIP value.',
  },
  {
    fileType: 'fullMattersJson',
    label: 'Full Matters',
    impact: 'critical',
    missingImpact: 'Matter profitability, client summaries, and department breakdowns are unavailable.',
  },
  {
    fileType: 'feeEarner',
    label: 'Fee Earner Setup',
    impact: 'critical',
    missingImpact: 'Utilisation, profitability, capacity, and pay model analysis are unavailable.',
  },
  {
    fileType: 'invoicesJson',
    label: 'Invoices',
    impact: 'high',
    missingImpact: 'Debtor days, billing reconciliation, and revenue KPIs are unavailable.',
  },
  {
    fileType: 'contactsJson',
    label: 'Clients / Contacts',
    impact: 'medium',
    missingImpact: 'Client-level analysis and cross-matter client summaries are limited.',
  },
  {
    fileType: 'closedMattersJson',
    label: 'Closed Matters',
    impact: 'medium',
    missingImpact: 'Matter P&L for completed matters will be incomplete.',
  },
  {
    fileType: 'disbursementsJson',
    label: 'Disbursements',
    impact: 'low',
    missingImpact: 'Disbursement tracking and expense analysis are unavailable.',
  },
  {
    fileType: 'tasksJson',
    label: 'Tasks',
    impact: 'low',
    missingImpact: 'Task overdue analysis is unavailable.',
  },
];

// ---------------------------------------------------------------------------
// buildDataQualityReport
// ---------------------------------------------------------------------------

export function buildDataQualityReport(
  joinResult: JoinResult,
  aggregateResult: AggregateBase,
  availableFileTypes: string[]
): AggregateDataQualityReport {
  const avail = new Set(availableFileTypes);
  const { firm, matters } = aggregateResult;

  // ── Files coverage ────────────────────────────────────────────────────────
  const filesCoverage: FileCoverage[] = FILE_SPECS.map(spec => ({
    fileType: spec.fileType,
    label: spec.label,
    isPresent: avail.has(spec.fileType),
    impact: spec.impact,
    missingImpact: avail.has(spec.fileType) ? undefined : spec.missingImpact,
  }));

  // ── Entity issues ─────────────────────────────────────────────────────────
  const entityIssues: EntityIssue[] = [];

  // Orphaned WIP entries
  const orphanedCount = joinResult.timeEntries.filter(e => !e.hasMatchedMatter).length;
  const totalEntries = joinResult.timeEntries.length;
  if (orphanedCount > 0 && totalEntries > 0) {
    entityIssues.push({
      entityKey: 'wipJson',
      issueType: 'orphaned_records',
      severity: firm.orphanedWip.orphanedWipPercent > 20 ? 'error' : 'warning',
      affectedCount: orphanedCount,
      totalCount: totalEntries,
      percentage: Math.round((orphanedCount / totalEntries) * 100),
      description: `${orphanedCount} WIP entries (${Math.round(firm.orphanedWip.orphanedWipPercent)}%) have no matching matter in the Full Matters export.`,
      resolution: 'Expand the Full Matters Metabase query to include all active matters, or upload a Closed Matters export.',
    });
  }

  // Unresolved client references
  const clientUnresolved = joinResult.matters.filter(m => !m._clientResolved).length;
  const totalMatters = joinResult.matters.length;
  if (clientUnresolved > 0 && totalMatters > 0) {
    entityIssues.push({
      entityKey: 'fullMattersJson',
      issueType: 'unresolved_references',
      severity: clientUnresolved / totalMatters > 0.2 ? 'warning' : 'info',
      affectedCount: clientUnresolved,
      totalCount: totalMatters,
      percentage: Math.round((clientUnresolved / totalMatters) * 100),
      description: `${clientUnresolved} matters have no linked client.`,
      resolution: 'Add a Client IDs column to your Full Matters Metabase query.',
    });
  }

  // ── Known gaps ────────────────────────────────────────────────────────────
  const knownGaps: AggregateKnownGap[] = [];

  // ORPHANED_WIP
  if (firm.orphanedWip.orphanedWipPercent > 5) {
    const pct = Math.round(firm.orphanedWip.orphanedWipPercent);
    const value = firm.orphanedWip.orphanedWipValue;
    knownGaps.push({
      gapId: 'ORPHANED_WIP',
      title: 'WIP entries have no matching matter',
      description: `~${pct}% of WIP entries (£${value.toFixed(0)}) have no matching matter in your Full Matters export. Resolve by expanding the Full Matters Metabase query to include all active matters, or by adding these matter numbers manually.`,
      affectedFormulas: ['SN-001', 'SN-002', 'SN-003', 'SN-004'],
      degradedMode: 'Orphaned WIP is included in fee earner totals but excluded from matter profitability.',
      resolution: 'Expand the Full Matters Metabase query to include all active matters.',
      severity: pct > 20 ? 'error' : 'warning',
    });
  }

  // MISSING_CLIENT_IDS
  if (clientUnresolved > 0) {
    knownGaps.push({
      gapId: 'MISSING_CLIENT_IDS',
      title: 'Matters missing linked client',
      description: `${clientUnresolved} matters have no linked client. Your Full Matters Metabase query may need a client IDs column added.`,
      affectedFormulas: ['SN-007', 'SN-008'],
      degradedMode: 'Client-level summaries are incomplete.',
      resolution: 'Add Client IDs to your Full Matters Metabase query.',
      severity: 'warning',
    });
  }

  // MISSING_DATE_PAID
  const invoicesPresent = avail.has('invoicesJson') && joinResult.invoices.length > 0;
  const hasDatePaid = joinResult.invoices.some(inv => inv.datePaid != null);
  if (invoicesPresent && !hasDatePaid) {
    knownGaps.push({
      gapId: 'MISSING_DATE_PAID',
      title: 'Invoice Date Paid not available',
      description: 'Date Paid is missing from your invoices. Debtor days will be calculated from Due Date only. Add Date Paid to your Metabase invoices query for exact debtor analysis.',
      affectedFormulas: ['SN-009', 'SN-010'],
      degradedMode: 'Debtor days calculated from Due Date rather than Date Paid.',
      resolution: 'Add Date Paid to your Metabase invoices query.',
      severity: 'warning',
    });
  }

  // MISSING_ACTIVITY_TYPE
  const wipPresent = avail.has('wipJson') && joinResult.timeEntries.length > 0;
  const hasActivityType = joinResult.timeEntries.some(te => te.activityType != null);
  if (wipPresent && !hasActivityType) {
    knownGaps.push({
      gapId: 'MISSING_ACTIVITY_TYPE',
      title: 'Activity Type not available in WIP',
      description: 'Activity Type is missing from your WIP export. Non-chargeable time breakdown analysis is unavailable. Add Activity Type to your WIP Metabase query.',
      affectedFormulas: ['SN-011'],
      degradedMode: 'Non-chargeable time cannot be categorised by activity.',
      resolution: 'Add Activity Type to your WIP Metabase query.',
      severity: 'info',
    });
  }

  // MISSING_FEE_EARNER_DATA
  if (!avail.has('feeEarner')) {
    knownGaps.push({
      gapId: 'MISSING_FEE_EARNER_DATA',
      title: 'Fee earner data not uploaded',
      description: 'No fee earner data uploaded. Utilisation, profitability, and capacity analysis require the fee earner file.',
      affectedFormulas: ['SN-005', 'SN-006', 'SN-007'],
      resolution: 'Upload the fee earner CSV file.',
      severity: 'error',
    });
  }

  // MISSING_CLOSED_MATTERS
  if (!avail.has('closedMattersJson')) {
    knownGaps.push({
      gapId: 'MISSING_CLOSED_MATTERS',
      title: 'Closed matters data not uploaded',
      description: 'No closed matters data uploaded. Matter P&L for completed matters will be incomplete.',
      affectedFormulas: ['SN-003', 'SN-004'],
      degradedMode: 'Completed matter P&L uses Full Matters data only.',
      resolution: 'Upload the Closed Matters export from Metabase.',
      severity: 'warning',
    });
  }

  // ── Discrepancies ─────────────────────────────────────────────────────────
  const discrepancies: Discrepancy[] = [];

  for (const matter of matters) {
    if (!matter.discrepancy?.hasMajorDiscrepancy) continue;

    const pct = Math.abs(matter.discrepancy.billingDifferencePercent);
    const severity: Discrepancy['severity'] = pct > 30 ? 'high' : 'medium';
    const entityId = matter.matterId ?? matter.matterNumber ?? 'unknown';

    discrepancies.push({
      type: 'wip_vs_invoice',
      entityKey: 'matter',
      entityId,
      description: `Matter ${matter.matterNumber ?? matter.matterId}: WIP billable £${matter.wipTotalBillable.toFixed(0)} differs from invoiced £${matter.invoicedNetBilling.toFixed(0)} by ${pct.toFixed(1)}%.`,
      valueA: matter.wipTotalBillable,
      sourceA: 'WIP export',
      valueB: matter.invoicedNetBilling,
      sourceB: 'Yao invoice data',
      difference: matter.discrepancy.billingDifference,
      differencePercent: matter.discrepancy.billingDifferencePercent,
      severity,
    });
  }

  // ── Overall score ─────────────────────────────────────────────────────────
  let score = 100;

  if (!avail.has('feeEarner'))        score -= 20;
  if (!avail.has('wipJson'))          score -= 20;
  if (!avail.has('fullMattersJson'))  score -= 15;
  if (!avail.has('invoicesJson'))     score -= 10;
  if (!avail.has('contactsJson'))     score -= 5;

  const orphanPct = firm.orphanedWip.orphanedWipPercent;
  if (orphanPct > 20)       score -= 5;
  else if (orphanPct > 5)   score -= 3;

  if (totalMatters > 0 && clientUnresolved / totalMatters > 0.2) score -= 3;
  if (invoicesPresent && !hasDatePaid)  score -= 2;
  if (wipPresent && !hasActivityType)   score -= 2;

  const overallScore = Math.max(0, score);

  // ── Recommendations ───────────────────────────────────────────────────────
  const recommendations: Recommendation[] = [];

  if (!avail.has('feeEarner')) {
    recommendations.push({
      priority: 1,
      title: 'Upload fee earner file',
      description: 'The fee earner CSV is missing. Utilisation, profitability, and pay model analysis are blocked.',
      action: 'Export the fee earner list from your HR system and upload it as a CSV.',
      estimatedImpact: 'Unlocks utilisation, capacity, and profitability dashboards.',
    });
  }

  if (!avail.has('wipJson')) {
    recommendations.push({
      priority: 1,
      title: 'Upload WIP / Lawyer Time export',
      description: 'No WIP data is loaded. All time-based KPIs are unavailable.',
      action: 'Run the Lawyer Time report in Metabase and upload the JSON export.',
      estimatedImpact: 'Unlocks all time-recording and utilisation analysis.',
    });
  }

  if (!avail.has('fullMattersJson')) {
    recommendations.push({
      priority: 1,
      title: 'Upload Full Matters export',
      description: 'No matters data is loaded. Matter and client dashboards are unavailable.',
      action: 'Run the Full Matters report in Metabase and upload the JSON export.',
      estimatedImpact: 'Unlocks matter profitability and client analysis.',
    });
  }

  if (!avail.has('invoicesJson')) {
    recommendations.push({
      priority: 2,
      title: 'Upload Invoices export',
      description: 'No invoice data is loaded. Revenue and debtor analysis are unavailable.',
      action: 'Run the Invoices report in Metabase and upload the JSON export.',
      estimatedImpact: 'Unlocks debtor days analysis for all invoices.',
    });
  }

  if (invoicesPresent && !hasDatePaid) {
    recommendations.push({
      priority: 2,
      title: 'Add Date Paid to your Metabase invoices query',
      description: 'Date Paid is absent from invoice data. Debtor days are approximate.',
      action: 'Edit the Metabase invoices query to include the Date Paid column, then re-upload.',
      estimatedImpact: 'Enables exact debtor days calculation.',
    });
  }

  if (clientUnresolved > 0) {
    recommendations.push({
      priority: 2,
      title: 'Add Client IDs to Full Matters query',
      description: `${clientUnresolved} matters are missing a linked client.`,
      action: 'Edit the Full Matters Metabase query to include Client IDs, then re-upload.',
      estimatedImpact: 'Enables client-level P&L and cross-matter summaries.',
    });
  }

  if (!avail.has('closedMattersJson')) {
    recommendations.push({
      priority: 3,
      title: 'Upload Closed Matters export',
      description: 'Closed matter billing data is incomplete without this file.',
      action: 'Run the Closed Matters report in Metabase and upload the JSON export.',
      estimatedImpact: 'Completes matter P&L for all completed matters.',
    });
  }

  if (!avail.has('contactsJson')) {
    recommendations.push({
      priority: 3,
      title: 'Upload Contacts export',
      description: 'Client contact data is missing.',
      action: 'Run the Contacts report in Metabase and upload the JSON export.',
      estimatedImpact: 'Improves client name resolution across all datasets.',
    });
  }

  recommendations.sort((a, b) => a.priority - b.priority);

  return {
    overallScore,
    filesCoverage,
    entityIssues,
    knownGaps,
    discrepancies,
    recommendations,
  };
}
