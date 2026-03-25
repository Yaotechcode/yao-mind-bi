/**
 * pdf-export-service.ts — Server-side PDF generation for dashboard exports.
 *
 * Uses pdfkit (Node.js, no browser required). A4 landscape orientation.
 * All currency formatted as £1,234.56. All percentages as 82.1%.
 * RAG status shown as small coloured filled circles.
 */

import PDFDocument from 'pdfkit';
import type { FirmConfig } from '../../shared/types/index.js';
import {
  getFirmOverviewData,
  getFeeEarnerPerformanceData,
  getWipData,
  getBillingCollectionsData,
  getMatterAnalysisData,
  getClientIntelligenceData,
  type DashboardFilters,
} from './dashboard-service.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateDashboardPdf(
  firmId: string,
  dashboardId: string,
  filters: Record<string, unknown>,
  config: FirmConfig,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, autoFirstPage: true });
  const bufferPromise = collectBuffer(doc);

  const df = filters as DashboardFilters;

  drawHeader(doc, config.firmName, dashboardTitle(dashboardId), 30);

  switch (dashboardId) {
    case 'firm-overview':
      await renderFirmOverview(doc, firmId, df);
      break;
    case 'fee-earner-performance':
      await renderFeeEarnerPerformance(doc, firmId, df);
      break;
    case 'wip':
      await renderWip(doc, firmId, df);
      break;
    case 'billing':
      await renderBilling(doc, firmId, df);
      break;
    case 'matters':
      await renderMatters(doc, firmId, df);
      break;
    case 'clients':
      await renderClients(doc, firmId, df);
      break;
    default:
      doc.fontSize(11).text(`Unknown dashboard: ${dashboardId}`);
  }

  doc.end();
  return bufferPromise;
}

// ---------------------------------------------------------------------------
// Exported formatting helpers (tested directly)
// ---------------------------------------------------------------------------

export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '—';
  return `\u00a3${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPct(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${value.toFixed(1)}%`;
}

export function formatNum(value: number | null | undefined, decimals = 1): string {
  if (value == null) return '—';
  return value.toFixed(decimals);
}

// ---------------------------------------------------------------------------
// Buffer collection
// ---------------------------------------------------------------------------

function collectBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Layout constants  (A4 landscape: 842 × 595 pt)
// ---------------------------------------------------------------------------

const PAGE_W = 841.89;
const PAGE_H = 595.28;
const MARGIN = 30;
const CONTENT_W = PAGE_W - MARGIN * 2;
const HEADER_H = 50;
const FOOTER_H = 25;
const CONTENT_TOP = MARGIN + HEADER_H + 8;
const CONTENT_BOTTOM = PAGE_H - MARGIN - FOOTER_H;

const COLORS = {
  primary:    '#0186B0',
  textMain:   '#0D394D',
  textMuted:  '#919EAB',
  border:     '#E1E5EF',
  bgLight:    '#F7F9FA',
  green:      '#09B5B5',
  amber:      '#E49060',
  red:        '#E4607B',
  neutral:    '#919EAB',
  headerBg:   '#0D394D',
  rowAlt:     '#F7F9FA',
};

function ragColor(status: string): string {
  switch (status) {
    case 'green':  return COLORS.green;
    case 'amber':  return COLORS.amber;
    case 'red':    return COLORS.red;
    default:       return COLORS.neutral;
  }
}

function dashboardTitle(id: string): string {
  const titles: Record<string, string> = {
    'firm-overview':          'Firm Command Centre',
    'fee-earner-performance': 'Fee Earner Performance',
    'wip':                    'WIP & Leakage',
    'billing':                'Billing & Collections',
    'matters':                'Matter Analysis',
    'clients':                'Client Intelligence',
  };
  return titles[id] ?? id;
}

// ---------------------------------------------------------------------------
// Header & Footer
// ---------------------------------------------------------------------------

function drawHeader(doc: PDFKit.PDFDocument, firmName: string, title: string, pageNum: number): void {
  // Background bar
  doc.save()
    .rect(MARGIN, MARGIN, CONTENT_W, HEADER_H)
    .fillColor(COLORS.headerBg)
    .fill()
    .restore();

  // Firm name (left)
  doc.save()
    .fontSize(13)
    .fillColor('#FFFFFF')
    .font('Helvetica-Bold')
    .text(firmName, MARGIN + 10, MARGIN + 10, { width: 280 })
    .restore();

  // Dashboard title (centre)
  doc.save()
    .fontSize(11)
    .fillColor('#FFFFFF')
    .font('Helvetica')
    .text(title, MARGIN + 280, MARGIN + 16, { width: 240, align: 'center' })
    .restore();

  // "Yao Mind" + date (right)
  const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  doc.save()
    .fontSize(9)
    .fillColor('#AECFDA')
    .font('Helvetica')
    .text(`Yao Mind  |  ${dateStr}`, MARGIN + 560, MARGIN + 10, { width: 220, align: 'right' })
    .restore();
}

function drawFooter(doc: PDFKit.PDFDocument): void {
  const y = PAGE_H - MARGIN - FOOTER_H + 8;
  doc.save()
    .moveTo(MARGIN, y - 4).lineTo(MARGIN + CONTENT_W, y - 4)
    .strokeColor(COLORS.border).lineWidth(0.5).stroke()
    .restore();
  doc.save()
    .fontSize(8)
    .fillColor(COLORS.textMuted)
    .font('Helvetica')
    .text('CONFIDENTIAL — For internal use only', MARGIN, y, { width: CONTENT_W / 2 })
    .restore();
  doc.save()
    .fontSize(8)
    .fillColor(COLORS.textMuted)
    .font('Helvetica')
    .text(`Generated by Yao Mind`, MARGIN, y, { width: CONTENT_W, align: 'right' })
    .restore();
}

// ---------------------------------------------------------------------------
// Table helper
// ---------------------------------------------------------------------------

interface ColDef {
  header: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

type CellValue = string | (() => void);  // string or a draw callback for RAG circles

function drawTable(
  doc: PDFKit.PDFDocument,
  cols: ColDef[],
  rows: (string | null)[][],
  startX: number,
  startY: number,
  rowHeight = 16,
): number {
  let y = startY;
  const totalW = cols.reduce((s, c) => s + c.width, 0);

  // Header row
  doc.save()
    .rect(startX, y, totalW, rowHeight)
    .fillColor(COLORS.primary)
    .fill()
    .restore();

  let x = startX;
  for (const col of cols) {
    doc.save()
      .fontSize(8)
      .fillColor('#FFFFFF')
      .font('Helvetica-Bold')
      .text(col.header, x + 3, y + 4, { width: col.width - 6, align: col.align ?? 'left', ellipsis: true })
      .restore();
    x += col.width;
  }
  y += rowHeight;

  // Data rows
  rows.forEach((row, rowIdx) => {
    if (y + rowHeight > CONTENT_BOTTOM) {
      doc.addPage();
      drawHeader(doc, '', '', 0);
      y = CONTENT_TOP;
    }

    if (rowIdx % 2 === 1) {
      doc.save()
        .rect(startX, y, totalW, rowHeight)
        .fillColor(COLORS.rowAlt)
        .fill()
        .restore();
    }

    x = startX;
    for (let ci = 0; ci < cols.length; ci++) {
      const col = cols[ci];
      const cell = row[ci] ?? '';
      doc.save()
        .fontSize(8)
        .fillColor(COLORS.textMain)
        .font('Helvetica')
        .text(cell, x + 3, y + 4, { width: col.width - 6, align: col.align ?? 'left', ellipsis: true })
        .restore();
      x += col.width;
    }
    y += rowHeight;
  });

  return y;
}

function drawRag(doc: PDFKit.PDFDocument, x: number, y: number, status: string): void {
  doc.save()
    .fillColor(ragColor(status))
    .circle(x + 5, y + 8, 4)
    .fill()
    .restore();
}

function sectionHeading(doc: PDFKit.PDFDocument, text: string, y: number): number {
  doc.save()
    .fontSize(10)
    .fillColor(COLORS.primary)
    .font('Helvetica-Bold')
    .text(text, MARGIN, y)
    .restore();
  return y + 16;
}

// ---------------------------------------------------------------------------
// 1. Firm Overview
// ---------------------------------------------------------------------------

async function renderFirmOverview(doc: PDFKit.PDFDocument, firmId: string, filters: DashboardFilters): Promise<void> {
  const data = await getFirmOverviewData(firmId);
  let y = CONTENT_TOP;

  // KPI cards row
  y = sectionHeading(doc, 'Key Performance Indicators', y);
  const cardW = CONTENT_W / 4 - 4;
  const cards = [
    { label: 'Unbilled WIP',       value: formatCurrency(data.kpiCards.totalUnbilledWip.value), rag: data.kpiCards.totalUnbilledWip.ragStatus },
    { label: 'Firm Realisation',   value: formatPct(data.kpiCards.firmRealisation.value),       rag: data.kpiCards.firmRealisation.ragStatus },
    { label: 'Firm Utilisation',   value: formatPct(data.kpiCards.firmUtilisation.value),       rag: data.kpiCards.firmUtilisation.ragStatus },
    { label: 'Combined Lock-Up',   value: formatNum(data.kpiCards.combinedLockup.value) + ' days', rag: data.kpiCards.combinedLockup.ragStatus },
  ];
  const cardH = 40;
  cards.forEach((card, i) => {
    const cx = MARGIN + i * (cardW + 5);
    doc.save()
      .rect(cx, y, cardW, cardH)
      .strokeColor(COLORS.border).lineWidth(0.5).stroke()
      .restore();
    drawRag(doc, cx, y + 2, card.rag);
    doc.save().fontSize(8).fillColor(COLORS.textMuted).font('Helvetica')
      .text(card.label, cx + 14, y + 4, { width: cardW - 16 }).restore();
    doc.save().fontSize(14).fillColor(COLORS.textMain).font('Helvetica-Bold')
      .text(card.value, cx + 4, y + 16, { width: cardW - 8 }).restore();
  });
  y += cardH + 12;

  // WIP Age Bands
  y = sectionHeading(doc, 'WIP Age Bands', y);
  const bandCols: ColDef[] = [
    { header: 'Band',   width: 100 },
    { header: 'Value',  width: 120, align: 'right' },
    { header: 'Count',  width: 60,  align: 'right' },
  ];
  const bandRows = data.wipAgeBands.map(b => [
    b.band,
    formatCurrency(b.value),
    String(b.count),
  ]);
  y = drawTable(doc, bandCols, bandRows, MARGIN, y) + 10;

  // Top Leakage Risks
  y = sectionHeading(doc, 'Top Leakage Risks', y);
  const leakCols: ColDef[] = [
    { header: 'Matter',       width: 70  },
    { header: 'Client',       width: 130 },
    { header: 'Responsible',  width: 100 },
    { header: 'WIP Value',    width: 100, align: 'right' },
    { header: 'Age (days)',   width: 70,  align: 'right' },
    { header: 'Risk Score',   width: 70,  align: 'right' },
    { header: 'RAG',          width: 40,  align: 'center' },
  ];
  const leakRows = data.topLeakageRisks.map(r => [
    r.matterNumber,
    r.clientName,
    r.lawyerName,
    formatCurrency(r.wipValue),
    String(r.wipAge),
    String(r.riskScore),
    r.ragStatus.toUpperCase(),
  ]);
  y = drawTable(doc, leakCols, leakRows, MARGIN, y) + 10;

  // Utilisation Snapshot
  if (y + 80 > CONTENT_BOTTOM) { doc.addPage(); drawHeader(doc, '', '', 0); y = CONTENT_TOP; }
  y = sectionHeading(doc, 'Utilisation Snapshot', y);
  const utilSummary = data.utilisationSnapshot;
  doc.save().fontSize(9).fillColor(COLORS.textMain).font('Helvetica')
    .text(`Green: ${utilSummary.green}   Amber: ${utilSummary.amber}   Red: ${utilSummary.red}`, MARGIN, y)
    .restore();
  y += 14;
  const utilCols: ColDef[] = [
    { header: 'Fee Earner',   width: 180 },
    { header: 'Utilisation',  width: 100, align: 'right' },
    { header: 'RAG',          width: 60,  align: 'center' },
  ];
  const utilRows = utilSummary.feeEarners.map(fe => [
    fe.name,
    formatPct(fe.utilisation),
    fe.ragStatus.toUpperCase(),
  ]);
  y = drawTable(doc, utilCols, utilRows, MARGIN, y) + 10;

  // Department Summary
  if (data.departmentSummary.length > 0) {
    if (y + 60 > CONTENT_BOTTOM) { doc.addPage(); drawHeader(doc, '', '', 0); y = CONTENT_TOP; }
    y = sectionHeading(doc, 'Department Summary', y);
    const deptCols: ColDef[] = [
      { header: 'Department',   width: 180 },
      { header: 'WIP Value',    width: 120, align: 'right' },
      { header: 'Matters',      width: 70,  align: 'right' },
      { header: 'Utilisation',  width: 100, align: 'right' },
    ];
    const deptRows = data.departmentSummary.map(d => [
      d.name,
      formatCurrency(d.wipValue),
      String(d.matterCount),
      formatPct(d.utilisation),
    ]);
    drawTable(doc, deptCols, deptRows, MARGIN, y);
  }

  drawFooter(doc);
}

// ---------------------------------------------------------------------------
// 2. Fee Earner Performance
// ---------------------------------------------------------------------------

async function renderFeeEarnerPerformance(doc: PDFKit.PDFDocument, firmId: string, filters: DashboardFilters): Promise<void> {
  const data = await getFeeEarnerPerformanceData(firmId, filters);
  let y = CONTENT_TOP;

  // Active filter summary
  const activeFilters = Object.entries(filters)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join('   ');
  if (activeFilters) {
    doc.save().fontSize(8).fillColor(COLORS.textMuted).font('Helvetica')
      .text(`Filters: ${activeFilters}`, MARGIN, y).restore();
    y += 12;
  }

  // Alert summary
  if (data.alerts.length > 0) {
    y = sectionHeading(doc, `Alerts (${data.alerts.length})`, y);
    const alertCols: ColDef[] = [
      { header: 'Fee Earner', width: 160 },
      { header: 'Type',       width: 120 },
      { header: 'Message',    width: CONTENT_W - 280 },
    ];
    const alertRows = data.alerts.slice(0, 10).map(a => [a.name, a.type, a.message]);
    y = drawTable(doc, alertCols, alertRows, MARGIN, y) + 10;
  }

  // Fee earner table
  y = sectionHeading(doc, `Fee Earners (${data.pagination.totalCount})`, y);
  const feCols: ColDef[] = [
    { header: 'Name',          width: 100 },
    { header: 'Dept',          width: 80  },
    { header: 'Grade',         width: 60  },
    { header: 'Pay Model',     width: 65  },
    { header: 'Chg Hrs',       width: 50, align: 'right' },
    { header: 'Utilisation',   width: 65, align: 'right' },
    { header: 'WIP Value',     width: 80, align: 'right' },
    { header: 'Billed Rev',    width: 80, align: 'right' },
    { header: 'Eff. Rate',     width: 60, align: 'right' },
    { header: 'W/O Rate',      width: 55, align: 'right' },
    { header: 'Gap (days)',    width: 55, align: 'right' },
    { header: 'Scorecard',     width: 55, align: 'right' },
    { header: 'RAG',           width: 30, align: 'center' },
  ];
  const feRows = data.feeEarners.map(fe => [
    fe.name,
    fe.department,
    fe.grade,
    fe.payModel,
    formatNum(fe.chargeableHours),
    formatPct(fe.utilisation),
    formatCurrency(fe.wipValueRecorded),
    formatCurrency(fe.billedRevenue),
    formatCurrency(fe.effectiveRate),
    formatPct(fe.writeOffRate),
    fe.recordingGapDays != null ? String(fe.recordingGapDays) : '—',
    formatPct(fe.scorecard),
    fe.utilisationRag.toUpperCase(),
  ]);
  drawTable(doc, feCols, feRows, MARGIN, y);
  drawFooter(doc);
}

// ---------------------------------------------------------------------------
// 3. WIP & Leakage
// ---------------------------------------------------------------------------

async function renderWip(doc: PDFKit.PDFDocument, firmId: string, filters: DashboardFilters): Promise<void> {
  const data = await getWipData(firmId, filters);
  let y = CONTENT_TOP;

  // Headlines
  y = sectionHeading(doc, 'WIP Headlines', y);
  const hl = data.headlines;
  doc.save().fontSize(9).fillColor(COLORS.textMain).font('Helvetica')
    .text(
      `Total Unbilled WIP: ${formatCurrency(hl.totalUnbilledWip.value)}   ` +
      `At Risk (61+ days): ${formatCurrency(hl.atRisk.value)} (${formatPct(hl.atRisk.percentage)})   ` +
      `Est. Leakage: ${formatCurrency(hl.estimatedLeakage.value)}`,
      MARGIN, y,
    ).restore();
  y += 16;

  // Age bands
  y = sectionHeading(doc, 'WIP Age Bands', y);
  const bandCols: ColDef[] = [
    { header: 'Band',            width: 100 },
    { header: 'Value',           width: 120, align: 'right' },
    { header: 'Count',           width: 60,  align: 'right' },
    { header: 'Recovery Prob.',  width: 100, align: 'right' },
  ];
  const bandRows = data.ageBands.map(b => [
    b.band, formatCurrency(b.value), String(b.count), formatPct(b.recoveryProb * 100),
  ]);
  y = drawTable(doc, bandCols, bandRows, MARGIN, y) + 10;

  // Write-off analysis
  y = sectionHeading(doc, 'Write-Off Analysis', y);
  const wo = data.writeOffAnalysis;
  doc.save().fontSize(9).fillColor(COLORS.textMain).font('Helvetica')
    .text(
      `Total Write-Off: ${formatCurrency(wo.totalWriteOff)}   Rate: ${formatPct(wo.writeOffRate)}   RAG: ${wo.ragStatus.toUpperCase()}`,
      MARGIN, y,
    ).restore();
  y += 16;

  // Disbursement exposure
  if (data.disbursementExposure.byMatter.length > 0) {
    y = sectionHeading(doc, 'Disbursement Exposure', y);
    doc.save().fontSize(9).fillColor(COLORS.textMain).font('Helvetica')
      .text(`Total Exposure: ${formatCurrency(data.disbursementExposure.totalExposure)}`, MARGIN, y).restore();
    y += 14;
    const disbCols: ColDef[] = [
      { header: 'Matter',   width: 80  },
      { header: 'Client',   width: 160 },
      { header: 'Exposure', width: 120, align: 'right' },
      { header: 'Age (days)', width: 80, align: 'right' },
    ];
    const disbRows = data.disbursementExposure.byMatter.slice(0, 20).map(d => [
      d.matterNumber, d.clientName, formatCurrency(d.value), String(d.age),
    ]);
    y = drawTable(doc, disbCols, disbRows, MARGIN, y) + 10;
  }

  // WIP entries grouped
  if (data.entries.length > 0) {
    if (y + 60 > CONTENT_BOTTOM) { doc.addPage(); drawHeader(doc, '', '', 0); y = CONTENT_TOP; }
    y = sectionHeading(doc, `WIP Detail (${data.pagination.totalCount} groups)`, y);
    const entCols: ColDef[] = [
      { header: 'Group',     width: 160 },
      { header: 'Value',     width: 120, align: 'right' },
      { header: 'Hours',     width: 70,  align: 'right' },
      { header: 'Avg Age',   width: 70,  align: 'right' },
      { header: 'Entries',   width: 60,  align: 'right' },
    ];
    const entRows = data.entries.map(g => [
      g.groupLabel, formatCurrency(g.totalValue), formatNum(g.totalHours), formatNum(g.avgAge) + ' d', String(g.entryCount),
    ]);
    drawTable(doc, entCols, entRows, MARGIN, y);
  }

  drawFooter(doc);
}

// ---------------------------------------------------------------------------
// 4. Billing & Collections
// ---------------------------------------------------------------------------

async function renderBilling(doc: PDFKit.PDFDocument, firmId: string, filters: DashboardFilters): Promise<void> {
  const data = await getBillingCollectionsData(firmId, filters);
  let y = CONTENT_TOP;

  // Pipeline summary
  y = sectionHeading(doc, 'Billing Pipeline', y);
  const pip = data.pipeline;
  const pipCols: ColDef[] = [
    { header: 'Stage',             width: 150 },
    { header: 'Value',             width: 140, align: 'right' },
    { header: 'Detail',            width: 200 },
  ];
  const pipRows: (string | null)[][] = [
    ['Unbilled WIP',     formatCurrency(pip.wip.value),      pip.wip.avgDays != null ? `Avg lock-up: ${formatNum(pip.wip.avgDays)} days` : ''],
    ['Invoiced',         formatCurrency(pip.invoiced.value), pip.invoiced.avgDaysToPayment != null ? `Avg days to payment: ${formatNum(pip.invoiced.avgDaysToPayment)}` : ''],
    ['Collected',        formatCurrency(pip.paid.value),     ''],
    ['Written Off',      formatCurrency(pip.writtenOff.value), `Rate: ${formatPct(pip.writtenOff.rate)}`],
  ];
  y = drawTable(doc, pipCols, pipRows, MARGIN, y) + 10;

  // Headlines
  const hl = data.headlines;
  doc.save().fontSize(9).fillColor(COLORS.textMain).font('Helvetica')
    .text(
      `Period Invoiced: ${formatCurrency(hl.invoicedPeriod.value)} (${hl.invoicedPeriod.count} invoices)   ` +
      `Period Collected: ${formatCurrency(hl.collectedPeriod.value)} (${formatPct(hl.collectedPeriod.rate)})   ` +
      `Total Outstanding: ${formatCurrency(hl.totalOutstanding.value)}`,
      MARGIN, y,
    ).restore();
  y += 16;

  // Aged debtors
  y = sectionHeading(doc, 'Aged Debtors', y);
  const debtorCols: ColDef[] = [
    { header: 'Band',   width: 120 },
    { header: 'Value',  width: 140, align: 'right' },
    { header: 'Count',  width: 60,  align: 'right' },
  ];
  const debtorRows = data.agedDebtors.map(b => [b.band, formatCurrency(b.value), String(b.count)]);
  y = drawTable(doc, debtorCols, debtorRows, MARGIN, y) + 10;

  // Invoice table
  if (data.invoices.length > 0) {
    if (y + 60 > CONTENT_BOTTOM) { doc.addPage(); drawHeader(doc, '', '', 0); y = CONTENT_TOP; }
    y = sectionHeading(doc, `Invoices (${data.pagination.totalCount})`, y);
    const invCols: ColDef[] = [
      { header: 'Invoice #',    width: 80  },
      { header: 'Client',       width: 140 },
      { header: 'Matter',       width: 70  },
      { header: 'Date',         width: 70  },
      { header: 'Total',        width: 90, align: 'right' },
      { header: 'Outstanding',  width: 90, align: 'right' },
      { header: 'Days Out.',    width: 60, align: 'right' },
      { header: 'RAG',          width: 40, align: 'center' },
    ];
    const invRows = data.invoices.map(inv => [
      inv.invoiceNumber ?? 'Draft',
      inv.clientName,
      inv.matterNumber,
      inv.invoiceDate.slice(0, 10),
      formatCurrency(inv.total),
      formatCurrency(inv.outstanding),
      inv.daysOutstanding != null ? String(inv.daysOutstanding) : '—',
      inv.ragStatus.toUpperCase(),
    ]);
    drawTable(doc, invCols, invRows, MARGIN, y);
  }

  drawFooter(doc);
}

// ---------------------------------------------------------------------------
// 5. Matter Analysis
// ---------------------------------------------------------------------------

async function renderMatters(doc: PDFKit.PDFDocument, firmId: string, filters: DashboardFilters): Promise<void> {
  const data = await getMatterAnalysisData(firmId, filters);
  let y = CONTENT_TOP;

  // Matters at risk
  if (data.mattersAtRisk.length > 0) {
    y = sectionHeading(doc, `Matters At Risk (${data.mattersAtRisk.length})`, y);
    const riskCols: ColDef[] = [
      { header: 'Matter',      width: 70  },
      { header: 'Client',      width: 110 },
      { header: 'Case Type',   width: 90  },
      { header: 'Lawyer',      width: 100 },
      { header: 'Primary Issue', width: 170 },
      { header: 'WIP Value',   width: 90, align: 'right' },
      { header: 'WIP Age',     width: 60, align: 'right' },
      { header: 'RAG',         width: 40, align: 'center' },
    ];
    const riskRows = data.mattersAtRisk.map(m => [
      m.matterNumber, m.clientName, m.caseType, m.responsibleLawyer,
      m.primaryIssue, formatCurrency(m.wipValue), String(m.wipAge) + 'd', m.ragStatus.toUpperCase(),
    ]);
    y = drawTable(doc, riskCols, riskRows, MARGIN, y) + 10;
  }

  // Full matter table
  if (y + 60 > CONTENT_BOTTOM) { doc.addPage(); drawHeader(doc, '', '', 0); y = CONTENT_TOP; }
  y = sectionHeading(doc, `All Matters (${data.pagination.totalCount})`, y);
  const matterCols: ColDef[] = [
    { header: 'Matter',     width: 60  },
    { header: 'Client',     width: 110 },
    { header: 'Case Type',  width: 90  },
    { header: 'Lawyer',     width: 90  },
    { header: 'Status',     width: 65  },
    { header: 'WIP',        width: 80, align: 'right' },
    { header: 'Billed',     width: 80, align: 'right' },
    { header: 'Outstanding',width: 80, align: 'right' },
    { header: 'WIP Age',    width: 55, align: 'right' },
    { header: 'Realisation',width: 60, align: 'right' },
    { header: 'RAG',        width: 40, align: 'center' },
  ];
  const matterRows = data.matters.map(m => [
    m.matterNumber, m.clientName, m.caseType, m.responsibleLawyer, m.status,
    formatCurrency(m.wipTotalBillable), formatCurrency(m.netBilling),
    formatCurrency(m.unbilledBalance),
    m.wipAge != null ? String(m.wipAge) + 'd' : '—',
    formatPct(m.realisation),
    m.realisationRag.toUpperCase(),
  ]);
  y = drawTable(doc, matterCols, matterRows, MARGIN, y) + 10;

  // Case type summary
  if (data.byCaseType.length > 0) {
    if (y + 60 > CONTENT_BOTTOM) { doc.addPage(); drawHeader(doc, '', '', 0); y = CONTENT_TOP; }
    y = sectionHeading(doc, 'By Case Type', y);
    const ctCols: ColDef[] = [
      { header: 'Case Type',    width: 160 },
      { header: 'Count',        width: 60,  align: 'right' },
      { header: 'Total WIP',    width: 120, align: 'right' },
      { header: 'Avg Real.',    width: 80,  align: 'right' },
      { header: 'Avg WIP Age',  width: 90,  align: 'right' },
    ];
    const ctRows = data.byCaseType.map(ct => [
      ct.name, String(ct.count), formatCurrency(ct.totalWip),
      formatPct(ct.avgRealisation), ct.avgWipAge != null ? formatNum(ct.avgWipAge) + ' d' : '—',
    ]);
    drawTable(doc, ctCols, ctRows, MARGIN, y);
  }

  drawFooter(doc);
}

// ---------------------------------------------------------------------------
// 6. Client Intelligence
// ---------------------------------------------------------------------------

async function renderClients(doc: PDFKit.PDFDocument, firmId: string, filters: DashboardFilters): Promise<void> {
  const data = await getClientIntelligenceData(firmId, filters);
  let y = CONTENT_TOP;

  // Headlines
  const hl = data.headlines;
  doc.save().fontSize(9).fillColor(COLORS.textMain).font('Helvetica')
    .text(
      `Total Clients: ${hl.totalClients}   ` +
      (hl.topClient ? `Top Client: ${hl.topClient.name} (${formatCurrency(hl.topClient.revenue)})   ` : '') +
      (hl.mostAtRisk ? `Most At Risk: ${hl.mostAtRisk.name} (${formatCurrency(hl.mostAtRisk.outstanding)} outstanding)` : ''),
      MARGIN, y,
    ).restore();
  y += 16;

  // Client table
  y = sectionHeading(doc, `Clients (${data.pagination.totalCount})`, y);
  const clientCols: ColDef[] = [
    { header: 'Client',       width: 160 },
    { header: 'Matters',      width: 60,  align: 'right' },
    { header: 'Departments',  width: 110 },
    { header: 'Total Revenue',width: 100, align: 'right' },
    { header: 'Outstanding',  width: 100, align: 'right' },
  ];
  const clientRows = data.clients.map(c => [
    c.clientName,
    String(c.matterCount),
    c.departments.join(', '),
    formatCurrency(c.totalRevenue),
    formatCurrency(c.totalOutstanding),
  ]);
  y = drawTable(doc, clientCols, clientRows, MARGIN, y) + 12;

  // Top 10 by revenue
  if (data.topByRevenue.length > 0) {
    if (y + 60 > CONTENT_BOTTOM) { doc.addPage(); drawHeader(doc, '', '', 0); y = CONTENT_TOP; }
    y = sectionHeading(doc, 'Top Clients by Revenue', y);
    const topRevCols: ColDef[] = [
      { header: 'Client',  width: 260 },
      { header: 'Revenue', width: 120, align: 'right' },
    ];
    const topRevRows = data.topByRevenue.map(c => [c.name, formatCurrency(c.value)]);
    y = drawTable(doc, topRevCols, topRevRows, MARGIN, y) + 12;
  }

  // Top 10 by outstanding
  if (data.topByOutstanding.length > 0) {
    if (y + 60 > CONTENT_BOTTOM) { doc.addPage(); drawHeader(doc, '', '', 0); y = CONTENT_TOP; }
    y = sectionHeading(doc, 'Top Clients by Outstanding Debt', y);
    const topOsCols: ColDef[] = [
      { header: 'Client',      width: 260 },
      { header: 'Outstanding', width: 120, align: 'right' },
    ];
    const topOsRows = data.topByOutstanding.map(c => [c.name, formatCurrency(c.value)]);
    drawTable(doc, topOsCols, topOsRows, MARGIN, y);
  }

  drawFooter(doc);
}
