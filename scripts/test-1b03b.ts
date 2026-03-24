import {
  buildCrossReferenceRegistry,
  applyRegistryToDatasets,
  serialiseRegistry,
  deserialiseRegistry,
  normaliseNameForLookup,
  generateNameVariants,
} from '../src/server/pipeline/cross-reference';
import type { NormaliseResult } from '../src/shared/types/pipeline';

// Helper — wraps plain records into NormaliseResult shape
function makeDataset(fileType: string, records: Record<string, any>[]): NormaliseResult {
  return {
    fileType,
    records,
    recordCount: records.length,
    normalisedAt: new Date().toISOString(),
    warnings: [],
  } as unknown as NormaliseResult;
}

const FIRM_ID = 'firm-test-001';

async function run() {

  // ── NAME NORMALISATION & VARIANTS ────────────────────────────────────────

  console.log('\n--- NAME NORMALISATION ---');

  console.log(normaliseNameForLookup('John Smith') === 'john smith' ? '✅' : '❌',
    `normaliseNameForLookup('John Smith') → "${normaliseNameForLookup('John Smith')}"`);
  console.log(normaliseNameForLookup('Dr. Sarah Jones') === 'sarah jones' ? '✅' : '❌',
    `normaliseNameForLookup('Dr. Sarah Jones') → "${normaliseNameForLookup('Dr. Sarah Jones')}"`);
  console.log(normaliseNameForLookup('  DAVID BROWN  ') === 'david brown' ? '✅' : '❌',
    `normaliseNameForLookup('  DAVID BROWN  ') → "${normaliseNameForLookup('  DAVID BROWN  ')}"`);

  console.log('\n--- NAME VARIANTS ---');

  const variants = generateNameVariants('John Smith');
  const expectedVariants = ['j. smith', 'smith, john', 'smith, j.', 'j smith'];
  for (const v of expectedVariants) {
    console.log(variants.includes(v) ? '✅' : '❌',
      `generateNameVariants('John Smith') includes "${v}"`);
  }
  console.log(`   All variants: [${variants.join(', ')}]`);

  // ── BUILD REGISTRY ───────────────────────────────────────────────────────

  console.log('\n--- BUILD CROSS-REFERENCE REGISTRY ---');

  const datasets: Record<string, NormaliseResult> = {
    feeEarnerCsv: makeDataset('feeEarnerCsv', [
      { lawyerId: 'fe-001', lawyerName: 'John Smith',  department: 'Commercial', payModel: 'Salaried' },
      { lawyerId: 'fe-002', lawyerName: 'Sarah Jones', department: 'Family',     payModel: 'FeeShare' },
      { lawyerId: 'fe-003', lawyerName: 'David Brown', department: 'Commercial', payModel: 'Salaried' },
    ]),
    fullMattersJson: makeDataset('fullMattersJson', [
      { matterId: 'm-001', matterNumber: 1001, responsibleLawyer: 'John Smith',  responsibleLawyerId: 'fe-001', lawyerName: 'John Smith',  lawyerId: 'fe-001', department: 'Commercial' },
      { matterId: 'm-002', matterNumber: 1002, responsibleLawyer: 'S. Jones',    responsibleLawyerId: null,     lawyerName: 'S. Jones',    lawyerId: null,     department: 'Family' },
      { matterId: 'm-003', matterNumber: 1003, responsibleLawyer: 'DAVID BROWN', responsibleLawyerId: null,     lawyerName: 'DAVID BROWN', lawyerId: null,     department: 'Commercial' },
      { matterId: 'm-004', matterNumber: 1004, responsibleLawyer: 'Brown, D.',   responsibleLawyerId: null,     lawyerName: 'Brown, D.',   lawyerId: null,     department: 'Commercial' },
    ]),
    wipJson: makeDataset('wipJson', [
      { entryId: 'w-001', matterId: 'm-001', matterNumber: 1001, lawyerId: 'fe-001', lawyerName: 'John Smith', billableValue: 500, durationMinutes: 60, doNotBill: false, rate: 300, date: '2024-01-15' },
      { entryId: 'w-002', matterId: 'm-002', matterNumber: 1002, lawyerId: null,     lawyerName: null,         billableValue: 300, durationMinutes: 36, doNotBill: false, rate: 300, date: '2024-01-16' },
    ]),
    invoicesJson: makeDataset('invoicesJson', [
      { invoiceId: 'inv-001', matterNumber: 1001, responsibleLawyer: 'John Smith',  responsibleLawyerId: 'fe-001', subtotal: 2000, total: 2400, outstanding: 0,    paid: 2400, invoiceDate: '2024-02-01', dueDate: '2024-03-01' },
      { invoiceId: 'inv-002', matterNumber: 1002, responsibleLawyer: 'Sarah Jones', responsibleLawyerId: null,     subtotal: 1500, total: 1800, outstanding: 1800, paid: 0,    invoiceDate: '2024-02-05', dueDate: '2024-03-05' },
    ]),
  };

  let registry: any;
  try {
    registry = buildCrossReferenceRegistry(FIRM_ID, datasets);
    console.log('✅ Registry built without errors');
    console.log(`   firmId: ${registry.firmId}`);
    console.log(`   feeEarners mapped: ${registry.feeEarners.idToName.size}`);
    console.log(`   matters mapped: ${registry.matters.numberToId.size}`);
    console.log(`   name variants: ${registry.feeEarners.nameVariants.size}`);
  } catch (e: any) {
    console.error('❌ buildCrossReferenceRegistry threw:', e.message);
    process.exit(1);
  }

  // ── NAME VARIANT RESOLUTION ──────────────────────────────────────────────

  console.log('\n--- NAME VARIANT RESOLUTION ---');

  // nameVariants maps variant → canonical name; nameToId maps canonical name → id
  // Two-step lookup: variant → name → id
  const sarahVariants = ['s. jones', 'jones, s.', 'sarah jones', 'jones, sarah'];
  for (const v of sarahVariants) {
    const nameFromVariant = registry.feeEarners.nameVariants.get(v);
    const idFromName = nameFromVariant
      ? registry.feeEarners.nameToId.get(normaliseNameForLookup(nameFromVariant))
      : registry.feeEarners.nameToId.get(v);
    console.log(idFromName === 'fe-002' ? '✅' : '⚠️ ',
      `"${v}" → name:"${nameFromVariant}" → id:"${idFromName}" (expected fe-002)`);
  }

  const davidVariants = ['david brown', 'brown, d.', 'd. brown'];
  for (const v of davidVariants) {
    const nameFromVariant = registry.feeEarners.nameVariants.get(v);
    const idFromName = nameFromVariant
      ? registry.feeEarners.nameToId.get(normaliseNameForLookup(nameFromVariant))
      : registry.feeEarners.nameToId.get(v);
    console.log(idFromName === 'fe-003' ? '✅' : '⚠️ ',
      `"${v}" → name:"${nameFromVariant}" → id:"${idFromName}" (expected fe-003)`);
  }

  // ── APPLY REGISTRY TO DATASETS ───────────────────────────────────────────

  console.log('\n--- APPLY REGISTRY TO DATASETS ---');

  let enriched: Record<string, NormaliseResult>;
  try {
    enriched = applyRegistryToDatasets(datasets, registry);
    console.log('✅ applyRegistryToDatasets completed without errors');
  } catch (e: any) {
    console.error('❌ applyRegistryToDatasets threw:', e.message);
    process.exit(1);
  }

  const enrichedMatters = enriched['fullMattersJson']?.records ?? [];

  // m-001: existing ID must NOT be overwritten
  const m001 = enrichedMatters.find((m: any) => m.matterId === 'm-001');
  console.log(m001?.responsibleLawyerId === 'fe-001' || m001?.lawyerId === 'fe-001' ? '✅' : '❌',
    `m-001 existing ID preserved: responsibleLawyerId="${m001?.responsibleLawyerId}" lawyerId="${m001?.lawyerId}" (must not overwrite)`);

  // m-002: 'S. Jones' should resolve to fe-002
  const m002 = enrichedMatters.find((m: any) => m.matterId === 'm-002');
  const m002resolved = m002?.responsibleLawyerId ?? m002?.lawyerId;
  console.log(m002resolved === 'fe-002' ? '✅' : '⚠️ ',
    `m-002 S. Jones resolved: responsibleLawyerId="${m002?.responsibleLawyerId}" lawyerId="${m002?.lawyerId}" (expected fe-002 in either)`);

  // m-003: 'DAVID BROWN' should resolve to fe-003
  const m003 = enrichedMatters.find((m: any) => m.matterId === 'm-003');
  const m003resolved = m003?.responsibleLawyerId ?? m003?.lawyerId;
  console.log(m003resolved === 'fe-003' ? '✅' : '⚠️ ',
    `m-003 DAVID BROWN resolved: responsibleLawyerId="${m003?.responsibleLawyerId}" lawyerId="${m003?.lawyerId}" (expected fe-003 in either)`);

  // m-004: 'Brown, D.' should resolve to fe-003
  const m004 = enrichedMatters.find((m: any) => m.matterId === 'm-004');
  const m004resolved = m004?.responsibleLawyerId ?? m004?.lawyerId;
  console.log(m004resolved === 'fe-003' ? '✅' : '⚠️ ',
    `m-004 Brown, D. resolved: responsibleLawyerId="${m004?.responsibleLawyerId}" lawyerId="${m004?.lawyerId}" (expected fe-003 in either)`);

  // ── _fieldSource METADATA ────────────────────────────────────────────────

  console.log('\n--- _fieldSource METADATA ---');

  const filledMatter = enrichedMatters.find((m: any) =>
    m.matterId !== 'm-001' && (m.lawyerId !== null || m.responsibleLawyerId !== null)
  );
  if (filledMatter) {
    const hasMeta = filledMatter._fieldSource?.responsibleLawyerId !== undefined
      || filledMatter._fieldSource?.lawyerId !== undefined
      || filledMatter._lawyerIdSource !== undefined;
    console.log(hasMeta ? '✅' : '⚠️ ',
      `Source metadata present on filled record: _lawyerIdSource="${filledMatter._lawyerIdSource}" _fieldSource=${JSON.stringify(filledMatter._fieldSource)}`);
  } else {
    console.log('⚠️  No filled matters found to check _fieldSource — applyRegistryToDatasets may only fill lawyerId not responsibleLawyerId');
    console.log('   Flag to Claude Code: confirm applyRegistryToDatasets fills responsibleLawyerId for matter/invoice records');
  }

  // inv-001 existing lawyerId preserved
  const enrichedInvoices = enriched['invoicesJson']?.records ?? [];
  const inv001 = enrichedInvoices.find((i: any) => i.invoiceId === 'inv-001');
  console.log(inv001?.responsibleLawyerId === 'fe-001' ? '✅' : '❌',
    `inv-001 existing ID preserved: "${inv001?.responsibleLawyerId}"`);

  // ── SERIALISATION ────────────────────────────────────────────────────────

  console.log('\n--- MONGODB SERIALISATION ---');

  let serialised: any;
  try {
    serialised = serialiseRegistry(registry);
    const json = JSON.stringify(serialised);
    console.log('✅ serialiseRegistry produces JSON-safe object');
    console.log(`   JSON length: ${json.length} chars`);
    const hasMapInstances = json.includes('[object Map]');
    console.log(!hasMapInstances ? '✅' : '❌',
      `No Map instances in serialised output`);
  } catch (e: any) {
    console.error('❌ serialiseRegistry threw:', e.message);
  }

  // ── DESERIALISATION ──────────────────────────────────────────────────────

  console.log('\n--- DESERIALISATION ---');

  try {
    const roundTripped = deserialiseRegistry(serialised);
    const fe001Name = roundTripped.feeEarners.idToName.get('fe-001');
    console.log(fe001Name === 'John Smith' ? '✅' : '❌',
      `Round-trip: fe-001 name = "${fe001Name}" (expected "John Smith")`);
    console.log(roundTripped.feeEarners.nameVariants instanceof Map ? '✅' : '❌',
      `nameVariants is a Map after deserialise: ${roundTripped.feeEarners.nameVariants instanceof Map}`);
  } catch (e: any) {
    console.error('❌ deserialiseRegistry threw:', e.message);
  }

  // ── REGISTRY MERGE (extend, not replace) ────────────────────────────────

  console.log('\n--- REGISTRY MERGE ---');

  try {
    const extendedDatasets = {
      ...datasets,
      fullMattersJson: makeDataset('fullMattersJson', [
        ...datasets['fullMattersJson'].records,
        { matterId: 'm-005', matterNumber: 1005, responsibleLawyer: 'New Lawyer', responsibleLawyerId: null, lawyerName: 'New Lawyer', lawyerId: null, department: 'Commercial' },
      ]),
    };
    const extendedRegistry = buildCrossReferenceRegistry(FIRM_ID, extendedDatasets, registry);
    const fe001StillThere = extendedRegistry.feeEarners.idToName.get('fe-001') === 'John Smith';
    console.log(fe001StillThere ? '✅' : '❌',
      `fe-001 preserved after merge: "${extendedRegistry.feeEarners.idToName.get('fe-001')}"`);
    console.log(extendedRegistry.matters.numberToId.size >= registry.matters.numberToId.size ? '✅' : '❌',
      `Matter count grew or stayed same: ${registry.matters.numberToId.size} → ${extendedRegistry.matters.numberToId.size}`);
  } catch (e: any) {
    console.error('❌ Registry merge threw:', e.message);
  }

  // ── STATS ────────────────────────────────────────────────────────────────

  console.log('\n--- REGISTRY STATS ---');

  console.log(registry.stats ? '✅' : '❌',
    `Registry has stats object`);
  console.log(typeof registry.stats?.feeEarners?.totalMappings === 'number' ? '✅' : '❌',
    `stats.feeEarners.totalMappings: ${registry.stats?.feeEarners?.totalMappings}`);
  console.log(typeof registry.stats?.matters?.totalMappings === 'number' ? '✅' : '❌',
    `stats.matters.totalMappings: ${registry.stats?.matters?.totalMappings}`);
  console.log(Array.isArray(registry.stats?.feeEarners?.unresolvedLawyerNames) ? '✅' : '❌',
    `stats.feeEarners.unresolvedLawyerNames: [${registry.stats?.feeEarners?.unresolvedLawyerNames?.join(', ')}]`);

  console.log('\n--- SUMMARY ---');
  console.log('✅ = pass  ❌ = fix before 1B-04  ⚠️  = minor, flag to Claude Code');
  console.log('\nKey flag for Claude Code if ⚠️  remain on m-002/m-003/m-004:');
  console.log('  applyRegistryToDatasets resolves lawyerName→lawyerId but may not resolve');
  console.log('  responsibleLawyer→responsibleLawyerId. Confirm this is handled in 1B-05 Join stage.');
}

run().catch(console.error);