import { detectFileType } from '../src/client/detection/file-type-detector';
import { normaliseColumnName } from '../src/client/detection/column-normaliser';
import type { ParseResult } from '../src/client/parsers/types';

// Helper — builds a minimal ParseResult from a column name array + format
function mockParseResult(columnNames: string[], fileType: 'csv' | 'json'): ParseResult {
  return {
    fileType,
    originalFilename: 'test.csv',
    rowCount: 5,
    columns: columnNames.map(h => ({
      originalHeader: h,
      detectedType: 'string',
      sampleValues: [],
      nullCount: 0,
      totalCount: 5,
      nullPercent: 0,
    })),
    previewRows: [],
    fullRows: [],
    parseErrors: [],
    parsedAt: new Date().toISOString(),
  } as ParseResult;
}

async function run() {

  // ── COLUMN NORMALISER ────────────────────────────────────────────────────

  console.log('\n--- COLUMN NORMALISER ---');
  const normCases: [string, string][] = [
    ['Matter Number',      'matternumber'],
    ['matter_number',      'matternumber'],
    ['MATTER NUMBER',      'matternumber'],
    ['Responsible Lawyer', 'lawyer'],
    ['responsible_lawyer', 'lawyer'],
    ['Fee Earner',         'feeearner'],
    ['fee_earner_id',      'feeearnerid'],
    ['  spaces  ',         'spaces'],
    ['camelCaseField',     'camelcasefield'],
  ];
  let normPass = 0;
  for (const [input, expected] of normCases) {
    const result = normaliseColumnName(input);
    const ok = result === expected;
    console.log(ok ? '✅' : '❌', `"${input}" → "${result}" (expected "${expected}")`);
    if (ok) normPass++;
  }
  console.log(`\nNormaliser: ${normPass}/${normCases.length} passed`);

  // ── FILE TYPE DETECTOR ───────────────────────────────────────────────────

  console.log('\n--- FILE TYPE DETECTOR ---');

  // WIP JSON
  const wipResult = detectFileType(mockParseResult(
    ['entryId', 'doNotBill', 'rate', 'durationMinutes', 'billableValue', 'matterId', 'lawyerId'], 'json'
  ));
  console.log(wipResult.detected === 'wipJson' ? '✅' : '❌',
    `WIP JSON → "${wipResult.detected}" (confidence: ${wipResult.confidence}) — expected wipJson`);

  // Full Matters JSON
  const matterResult = detectFileType(mockParseResult(
    ['matterId', 'matterNumber', 'status', 'responsibleLawyer', 'department', 'budget'], 'json'
  ));
  console.log(matterResult.detected === 'fullMattersJson' ? '✅' : '❌',
    `Matters JSON → "${matterResult.detected}" (confidence: ${matterResult.confidence}) — expected fullMattersJson`);

  // Invoices JSON
  const invoiceResult = detectFileType(mockParseResult(
    ['invoiceDate', 'dueDate', 'subtotal', 'outstanding', 'paid', 'responsibleLawyer', 'matterNumber'], 'json'
  ));
  console.log(invoiceResult.detected === 'invoicesJson' ? '✅' : '❌',
    `Invoices JSON → "${invoiceResult.detected}" (confidence: ${invoiceResult.confidence}) — expected invoicesJson`);

  // Fee Earner CSV
  const feeEarnerResult = detectFileType(mockParseResult(
    ['Name', 'Department', 'Grade', 'Pay Model', 'Annual Salary', 'Rate'], 'csv'
  ));
  console.log(feeEarnerResult.detected === 'feeEarnerCsv' ? '✅' : '❌',
    `Fee Earner CSV → "${feeEarnerResult.detected}" (confidence: ${feeEarnerResult.confidence}) — expected feeEarnerCsv`);

  // Unknown — should be low/none confidence
  const unknownResult = detectFileType(mockParseResult(['foo', 'bar', 'baz', 'qux'], 'csv'));
  const unknownLow = unknownResult.confidence === 'low' || unknownResult.confidence === 'none';
  console.log(unknownLow ? '✅' : '❌',
    `Unknown columns → "${unknownResult.detected}" (confidence: ${unknownResult.confidence}) — expected low/none`);

  // Bug fix: generic JSON should NOT match fullMattersJson with high confidence
  const genericResult = detectFileType(mockParseResult(
    ['title', 'description', 'createdAt', 'updatedAt'], 'json'
  ));
  const bugFixed = genericResult.detected !== 'fullMattersJson'
    || genericResult.confidence === 'low'
    || genericResult.confidence === 'none';
  console.log(bugFixed ? '✅' : '❌',
    `Generic JSON → "${genericResult.detected}" (confidence: ${genericResult.confidence}) — should NOT be fullMattersJson high confidence`);

  // Alias columns — real-world practice management variants
  const aliasResult = detectFileType(mockParseResult(
    ['Responsible Lawyer', 'Matter No', 'Bill Value', 'Duration Mins'], 'csv'
  ));
  console.log(aliasResult.detected !== null ? '✅' : '⚠️ ',
    `Alias columns → "${aliasResult.detected}" (confidence: ${aliasResult.confidence}) — aliases should help detection`);

  // ── SUMMARY ──────────────────────────────────────────────────────────────

  console.log('\n--- SUMMARY ---');
  console.log('✅ = pass  ❌ = fix before 1B-03  ⚠️  = minor, flag to Claude Code');
}

run().catch(console.error);