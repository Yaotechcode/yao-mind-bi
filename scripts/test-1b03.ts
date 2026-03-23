import { autoMap } from '../src/client/mapping/auto-mapper';
import { validateMappingSet, getMappingSummary, updateMapping, buildTemplateFromMappingSet } from '../src/client/mapping/mapping-service';
import { getBuiltInEntityDefinitions } from '../src/shared/entities/registry';
import { EntityType } from '../src/shared/types/index';
import type { ParseResult } from '../src/client/parsers/types';

function mockParseResult(columnNames: string[], fileType: 'csv' | 'json'): ParseResult {
  return {
    fileType,
    originalFilename: 'test.csv',
    rowCount: 5,
    columns: columnNames.map(h => ({
      originalHeader: h,
      detectedType: 'string' as const,
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

  // Load entity definitions once
  const entities = getBuiltInEntityDefinitions();
  const matterEntity    = entities.find(e => e.entityType === EntityType.MATTER)!;
  const feeEarnerEntity = entities.find(e => e.entityType === EntityType.FEE_EARNER)!;

  if (!matterEntity || !feeEarnerEntity) {
    console.error('❌ Could not load entity definitions');
    console.error('   Available entityTypes:', entities.map(e => e.entityType));
    process.exit(1);
  }
  console.log(`\n✅ Loaded ${entities.length} entity definitions`);

  // ── PRIORITY 1: EXACT MATCH ──────────────────────────────────────────────

  console.log('\n--- AUTO-MAPPER: EXACT MATCH ---');

  const exactResult = autoMap(
    mockParseResult(['matterId', 'matterNumber', 'status', 'department', 'budget'], 'json'),
    'fullMattersJson',
    matterEntity,
    []
  );
  const exactMatterId = exactResult.mappings.find(m => m.rawColumn === 'matterId');
  console.log(exactMatterId?.mappedTo === 'matterId' ? '✅' : '❌',
    `Exact: matterId → "${exactMatterId?.mappedTo}" (confidence: ${exactMatterId?.confidence})`);

  const exactStatus = exactResult.mappings.find(m => m.rawColumn === 'status');
  console.log(exactStatus?.mappedTo === 'status' ? '✅' : '❌',
    `Exact: status → "${exactStatus?.mappedTo}"`);

  // ── PRIORITY 2: ALIAS MATCH ──────────────────────────────────────────────

  console.log('\n--- AUTO-MAPPER: ALIAS MATCH ---');

  const aliasResult = autoMap(
    mockParseResult(['Responsible Lawyer', 'Matter No', 'Bill Value'], 'csv'),
    'fullMattersJson',
    matterEntity,
    []
  );
  const lawyerMapping = aliasResult.mappings.find(m => m.rawColumn === 'Responsible Lawyer');
  console.log(lawyerMapping?.mappedTo ? '✅' : '⚠️ ',
    `Alias: "Responsible Lawyer" → "${lawyerMapping?.mappedTo}" (confidence: ${lawyerMapping?.confidence})`);

  // ── PRIORITY 4: FUZZY MATCH ──────────────────────────────────────────────

  console.log('\n--- AUTO-MAPPER: FUZZY MATCH ---');

  const fuzzyResult = autoMap(
    mockParseResult(['matterld', 'departmnt', 'stauts'], 'json'),
    'fullMattersJson',
    matterEntity,
    []
  );
  const fuzzyMatter = fuzzyResult.mappings.find(m => m.rawColumn === 'matterld');
  console.log(fuzzyMatter?.mappedTo === 'matterId' ? '✅' : '⚠️ ',
    `Fuzzy: "matterld" → "${fuzzyMatter?.mappedTo}" (confidence: ${fuzzyMatter?.confidence}) — expected matterId`);

  const noMatch = autoMap(
    mockParseResult(['xxxxxxxx'], 'csv'), 'fullMattersJson', matterEntity, []
  ).mappings.find(m => m.rawColumn === 'xxxxxxxx');
  console.log(noMatch?.mappedTo === null ? '✅' : '❌',
    `No match: "xxxxxxxx" → "${noMatch?.mappedTo}" — should be null`);

  // ── PRIORITY 3: TEMPLATE MATCH ───────────────────────────────────────────

  console.log('\n--- AUTO-MAPPER: TEMPLATE MATCH ---');

  const templateResult = autoMap(
    mockParseResult(['Staff Name', 'Team', 'Grade'], 'csv'),
    'feeEarnerCsv',
    feeEarnerEntity,
    [{
      id: 'tpl-1', firmId: 'firm-1', name: 'My Export Template',
      fileType: 'feeEarnerCsv',
      mappings: { 'Staff Name': 'name', 'Team': 'department' },
      typeOverrides: {}, createdAt: new Date().toISOString(),
    }]
  );
  const staffMapping = templateResult.mappings.find(m => m.rawColumn === 'Staff Name');
  console.log(staffMapping?.mappedTo === 'name' && staffMapping?.confidence === 'template' ? '✅' : '⚠️ ',
    `Template: "Staff Name" → "${staffMapping?.mappedTo}" (confidence: ${staffMapping?.confidence}) — expected name/template`);

  // ── isComplete FLAG ──────────────────────────────────────────────────────

  console.log('\n--- isComplete FLAG ---');

  console.log(exactResult.isComplete !== undefined ? '✅' : '❌',
    `MappingSet has isComplete: ${exactResult.isComplete}`);
  console.log(Array.isArray(exactResult.missingRequiredFields) ? '✅' : '❌',
    `MappingSet has missingRequiredFields: [${exactResult.missingRequiredFields.join(', ')}]`);
  console.log(Array.isArray(exactResult.unmappedColumns) ? '✅' : '❌',
    `MappingSet has unmappedColumns: [${exactResult.unmappedColumns.join(', ')}]`);

  // ── VALIDATION ───────────────────────────────────────────────────────────

  console.log('\n--- MAPPING VALIDATION ---');

  // Duplicate target — two rawColumns mapped to same field
  const dupResult = validateMappingSet(
    {
      ...exactResult,
      mappings: [
        ...exactResult.mappings,
        { rawColumn: 'matterId2', mappedTo: 'matterId', entityKey: EntityType.MATTER, isRequired: false, confidence: 'manual' as const },
      ],
    },
    matterEntity
  );
  console.log(!dupResult.valid ? '✅' : '❌',
    `Duplicate target detection: valid=${dupResult.valid} (expected false), errors: ${dupResult.errors.join(', ')}`);

  // ── IMMUTABILITY ─────────────────────────────────────────────────────────

  console.log('\n--- IMMUTABILITY ---');

  const originalMapping = exactResult.mappings.find(m => m.rawColumn === 'matterId')!;
  const originalMappedTo = originalMapping.mappedTo;
  const updatedSet = updateMapping(exactResult, 'matterId', 'customField');
  const updatedMapping = updatedSet.mappings.find(m => m.rawColumn === 'matterId')!;

  console.log(originalMapping.mappedTo === originalMappedTo ? '✅' : '❌',
    `Original unchanged: "${originalMapping.mappedTo}"`);
  console.log(updatedMapping.mappedTo === 'customField' ? '✅' : '❌',
    `Updated correctly: "${updatedMapping.mappedTo}"`);
  console.log(updatedMapping.confidence === 'manual' ? '✅' : '❌',
    `Confidence set to manual: "${updatedMapping.confidence}"`);

  // ── getMappingSummary ────────────────────────────────────────────────────

  console.log('\n--- getMappingSummary ---');

  const summary = getMappingSummary(exactResult);
  console.log(typeof summary === 'string' && summary.length > 0 ? '✅' : '❌',
    `Summary is a string: "${summary}"`);

  // ── buildTemplateFromMappingSet ──────────────────────────────────────────

  console.log('\n--- BUILD TEMPLATE ---');

  const builtTemplate = buildTemplateFromMappingSet(exactResult, 'My Firm Export');
  console.log(builtTemplate.name === 'My Firm Export' ? '✅' : '❌',
    `Template name: "${builtTemplate.name}"`);
  console.log(builtTemplate.fileType === 'fullMattersJson' ? '✅' : '❌',
    `Template fileType: "${builtTemplate.fileType}"`);
  const mappedCount = Object.keys(builtTemplate.mappings).length;
  console.log(mappedCount > 0 ? '✅' : '❌',
    `Template has ${mappedCount} mappings`);

  console.log('\n--- SUMMARY ---');
  console.log('✅ = pass  ❌ = fix before 1B-04  ⚠️  = minor, flag to Claude Code');
}

run().catch(console.error);