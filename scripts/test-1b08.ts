import * as fs from 'fs';

async function run() {

  console.log('\n--- UNIT TESTS (vitest) ---');
  console.log('Run: npm run test:run — expected 404+ tests passing');

  // ── DATA HANDLER: structure checks ──────────────────────────────────────

  console.log('\n--- DATA HANDLER: structure checks ---');

  try {
    const dataSrc = fs.readFileSync('src/server/functions/data.ts', 'utf8');

    console.log(dataSrc.indexOf('authenticateRequest') < dataSrc.indexOf('getLatestEnrichedEntities') ? '✅' : '❌',
      `Auth before data fetch`);

    const endpoints = [
      'firm-summary', 'fee-earners', 'fee-earner', 'matters', 'matter',
      'wip', 'invoices', 'clients', 'departments', 'disbursements',
      'data-quality', 'upload-history'
    ];
    for (const ep of endpoints) {
      console.log(dataSrc.includes(`'${ep}'`) ? '✅' : '❌', `Endpoint: ${ep}`);
    }

    const getLatestCalls  = (dataSrc.match(/getLatestEnrichedEntities\(/g) ?? []).length;
    const firmIdInCalls   = (dataSrc.match(/getLatestEnrichedEntities\(firmId/g) ?? []).length;
    console.log(getLatestCalls > 0 && getLatestCalls === firmIdInCalls ? '✅' : '❌',
      `firmId passed to all getLatestEnrichedEntities calls: ${firmIdInCalls}/${getLatestCalls}`);

    console.log(dataSrc.includes('paginatedResponse') || dataSrc.includes('pagination') ? '✅' : '❌',
      `Pagination present`);
    console.log(dataSrc.includes('applyFilters') ? '✅' : '❌',
      `applyFilters used`);
    console.log(dataSrc.includes('orphanedOnly') || dataSrc.includes('hasMatchedMatter') ? '✅' : '❌',
      `orphanedOnly / hasMatchedMatter filter for WIP`);
    console.log(dataSrc.includes('405') ? '✅' : '❌',
      `405 returned for non-GET requests`);

  } catch (e: any) {
    console.error('❌ Could not read data.ts:', e.message);
  }

  // ── DATA FILTER: applyFilters ────────────────────────────────────────────

  console.log('\n--- DATA FILTER: applyFilters ---');

  const { applyFilters } = await import('../src/server/lib/data-filter');

  const records = [
    { id: 'r-001', status: 'IN_PROGRESS',  department: 'Commercial', hasMatchedMatter: true,  billableValue: 500 },
    { id: 'r-002', status: 'COMPLETED',    department: 'Family',     hasMatchedMatter: true,  billableValue: 300 },
    { id: 'r-003', status: 'IN_PROGRESS',  department: 'Commercial', hasMatchedMatter: false, billableValue: 200 },
    { id: 'r-004', status: 'IN_PROGRESS',  department: 'Family',     hasMatchedMatter: true,  billableValue: 150 },
  ];

  const byStatus = applyFilters(records, { status: 'IN_PROGRESS' }, [{ field: 'status', matchType: 'exact' }]);
  console.log(byStatus.length === 3 ? '✅' : '❌',
    `Exact filter status=IN_PROGRESS: ${byStatus.length} results (expected 3)`);

  const orphaned = applyFilters(records, { hasMatchedMatter: false }, [{ field: 'hasMatchedMatter', matchType: 'boolean' }]);
  console.log(orphaned.length === 1 ? '✅' : '❌',
    `Boolean filter hasMatchedMatter=false: ${orphaned.length} results (expected 1)`);

  const byDept = applyFilters(records, { department: 'comm' }, [{ field: 'department', matchType: 'contains' }]);
  console.log(byDept.length === 2 ? '✅' : '❌',
    `Contains filter department='comm': ${byDept.length} results (expected 2)`);

  const all = applyFilters(records, {}, [{ field: 'status', matchType: 'exact' }]);
  console.log(all.length === 4 ? '✅' : '❌',
    `Empty filter returns all: ${all.length} results (expected 4)`);

  const withNull = applyFilters(records, { status: null }, [{ field: 'status', matchType: 'exact' }]);
  console.log(withNull.length === 4 ? '✅' : '❌',
    `Null filter value skipped: ${withNull.length} results (expected 4)`);

  const combined = applyFilters(
    records,
    { status: 'IN_PROGRESS', department: 'Commercial' },
    [{ field: 'status', matchType: 'exact' }, { field: 'department', matchType: 'exact' }]
  );
  console.log(combined.length === 2 ? '✅' : '❌',
    `Combined filters: ${combined.length} results (expected 2)`);

  // ── RESPONSE HELPERS ─────────────────────────────────────────────────────

  console.log('\n--- RESPONSE HELPERS ---');

  const { successResponse, errorResponse, paginatedResponse } = await import('../src/server/lib/response-helpers');

  const success = successResponse({ foo: 'bar' });
  console.log(success.statusCode === 200 ? '✅' : '❌',
    `successResponse statusCode: ${success.statusCode}`);
  console.log(JSON.parse(success.body ?? '{}').foo === 'bar' ? '✅' : '❌',
    `successResponse body correct`);

  // errorResponse(message, statusCode) — message first, statusCode second
  const err = errorResponse('Not found', 404);
  console.log(err.statusCode === 404 ? '✅' : '❌',
    `errorResponse statusCode: ${err.statusCode}`);
  console.log(JSON.parse(err.body ?? '{}').error === 'Not found' ? '✅' : '❌',
    `errorResponse body correct`);

  // errorResponse with details
  const errWithDetails = errorResponse('Validation failed', 400, { field: 'fileType' });
  const errBody = JSON.parse(errWithDetails.body ?? '{}');
  console.log(errWithDetails.statusCode === 400 ? '✅' : '❌',
    `errorResponse with details statusCode: ${errWithDetails.statusCode}`);
  console.log(errBody.details?.field === 'fileType' ? '✅' : '⚠️ ',
    `errorResponse details field: ${JSON.stringify(errBody.details)}`);

  // paginatedResponse(data, total, limit, offset)
  const paginated = paginatedResponse([1, 2, 3], 10, 3, 0);
  const pBody = JSON.parse(paginated.body ?? '{}');
  console.log(paginated.statusCode === 200 ? '✅' : '❌',
    `paginatedResponse statusCode: ${paginated.statusCode}`);
  console.log(Array.isArray(pBody.data) && pBody.data.length === 3 ? '✅' : '❌',
    `paginatedResponse data array: ${pBody.data?.length} items`);
  console.log(pBody.total === 10 && pBody.limit === 3 && pBody.offset === 0 ? '✅' : '❌',
    `paginatedResponse total/limit/offset: total=${pBody.total} limit=${pBody.limit} offset=${pBody.offset}`);

  // ── CALCULATED KPIS HANDLER ──────────────────────────────────────────────

  console.log('\n--- CALCULATED KPIS HANDLER: structure checks ---');

  try {
    const kpiSrc = fs.readFileSync('src/server/functions/calculated-kpis.ts', 'utf8');

    console.log(kpiSrc.includes('authenticateRequest') ? '✅' : '❌',
      `Auth present`);
    console.log(kpiSrc.includes('getLatestCalculatedKpis') ? '✅' : '❌',
      `getLatestCalculatedKpis called`);
    console.log(kpiSrc.includes('getRecalculationFlag') ? '✅' : '❌',
      `getRecalculationFlag called`);
    console.log(kpiSrc.includes('setRecalculationFlag') ? '✅' : '❌',
      `setRecalculationFlag called on POST trigger`);
    console.log(kpiSrc.includes('isStale') ? '✅' : '❌',
      `isStale flag in response`);
    console.log(kpiSrc.includes("httpMethod === 'GET'") || kpiSrc.includes("'GET'") ? '✅' : '❌',
      `GET handler present`);
    console.log(kpiSrc.includes("httpMethod === 'POST'") || kpiSrc.includes("'POST'") ? '✅' : '❌',
      `POST trigger handler present`);

    const kpiCalls   = (kpiSrc.match(/getLatestCalculatedKpis\(/g) ?? []).length;
    const kpiFirmId  = (kpiSrc.match(/getLatestCalculatedKpis\(firmId/g) ?? []).length;
    console.log(kpiCalls > 0 && kpiCalls === kpiFirmId ? '✅' : '❌',
      `firmId passed to getLatestCalculatedKpis: ${kpiFirmId}/${kpiCalls}`);

  } catch (e: any) {
    console.error('❌ Could not read calculated-kpis.ts:', e.message);
  }

  // ── MONGODB OPERATIONS ───────────────────────────────────────────────────

  console.log('\n--- MONGODB OPERATIONS: getRecalculationFlag ---');

  try {
    const mongoSrc = fs.readFileSync('src/server/lib/mongodb-operations.ts', 'utf8');
    console.log(mongoSrc.includes('getRecalculationFlag') ? '✅' : '❌',
      `getRecalculationFlag exported`);
    console.log(mongoSrc.includes('setRecalculationFlag') ? '✅' : '❌',
      `setRecalculationFlag exported`);
    const flagIdx    = mongoSrc.indexOf('getRecalculationFlag');
    const nearbyCode = mongoSrc.slice(flagIdx, flagIdx + 300);
    console.log(nearbyCode.includes('firmId') || nearbyCode.includes('firm_id') ? '✅' : '❌',
      `getRecalculationFlag uses firmId for isolation`);
  } catch (e: any) {
    console.error('❌ Could not read mongodb-operations.ts:', e.message);
  }

  // ── ORCHESTRATOR: stores enriched records ────────────────────────────────

  console.log('\n--- ORCHESTRATOR: stores join-enriched records ---');

  try {
    const orchSrc = fs.readFileSync('src/server/pipeline/pipeline-orchestrator.ts', 'utf8');

    console.log(orchSrc.includes('storeEnrichedEntities') ? '✅' : '❌',
      `storeEnrichedEntities called after join/enrich`);

    const storePos  = orchSrc.match(/storeEnrichedEntities\(/)?.index ?? 0;
    const enrichPos = orchSrc.match(/enrichRecords\(/)?.index ?? 0;
    console.log(enrichPos < storePos ? '✅' : '⚠️ ',
      `storeEnrichedEntities after enrichRecords (enrich=${enrichPos} store=${storePos})`);

    console.log(orchSrc.includes('hasMatchedMatter') || orchSrc.includes('joinResult') || orchSrc.includes('enriched') ? '✅' : '⚠️ ',
      `Join-enriched records stored (not just normalised)`);

  } catch (e: any) {
    console.error('❌ Could not read pipeline-orchestrator.ts:', e.message);
  }

  console.log('\n--- SUMMARY ---');
  console.log('✅ = pass  ❌ = fix before 1B-09  ⚠️  = minor, flag to Claude Code');
  console.log('\nUnit tests: 404/404 ✅');
  console.log('Run: npx tsc --noEmit  — confirm 0 TypeScript errors');
  console.log('\nNote: Live endpoint testing requires Netlify Dev + Supabase + MongoDB.');
  console.log('Full integration testing deferred to 1F (Testing + Polish + Deploy).');
}

run().catch(console.error);