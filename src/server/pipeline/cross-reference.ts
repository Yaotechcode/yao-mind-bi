// src/server/pipeline/cross-reference.ts
//
// Pipeline Stage 3: Cross-Reference Resolution
//
// Scans normalised datasets for co-occurring identifier pairs and builds
// mapping dictionaries. Applies the dictionaries back to fill in missing
// identifier forms across every dataset.

import type {
  NormaliseResult,
  NormalisedRecord,
  CrossReferenceRegistry,
  CrossReferenceRegistrySerialised,
  CrossReferenceStats,
} from '@shared/types/pipeline.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dataset priority order for conflict resolution (highest quality first). */
const DATASET_PRIORITY: string[] = [
  'lawyersJson',      // Authoritative attorney ID → name lookup table
  'fullMattersJson',
  'closedMattersJson',
  'wipJson',
  'invoicesJson',
  'disbursementsJson',
  'tasksJson',
  'feeEarnerCsv',
  'contactsJson',
];

function datasetPriority(name: string): number {
  const idx = DATASET_PRIORITY.indexOf(name);
  return idx === -1 ? DATASET_PRIORITY.length : idx;
}

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

const TITLE_PATTERN = /^(mr|mrs|ms|dr|prof|sir)\.?\s+/i;

/**
 * Normalise a person's name for use as a dictionary key.
 * Strips titles, lowercases, and trims whitespace.
 */
export function normaliseNameForLookup(name: string): string {
  return name.trim().replace(TITLE_PATTERN, '').toLowerCase().trim();
}

/**
 * Generate all plausible lookup variants for a full name.
 * e.g., 'John Smith' → ['john smith', 'smith', 'j smith', 'j. smith',
 *                        'smith john', 'smith, john', 'smith j', 'smith, j.']
 */
export function generateNameVariants(name: string): string[] {
  const base = normaliseNameForLookup(name);
  const parts = base.split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    return [base]; // cannot derive variants from a single token
  }

  const first = parts[0];
  const last = parts[parts.length - 1];
  const initial = first[0];

  return [
    base,                            // 'john smith'
    last,                            // 'smith'
    `${initial} ${last}`,            // 'j smith'
    `${initial}. ${last}`,           // 'j. smith'
    `${last} ${first}`,              // 'smith john'
    `${last}, ${first}`,             // 'smith, john'
    `${last} ${initial}`,            // 'smith j'
    `${last}, ${initial}`,           // 'smith, j'
    `${last}, ${initial}.`,          // 'smith, j.'
  ].filter(v => v.length > 0);
}

// ---------------------------------------------------------------------------
// Empty registry factory
// ---------------------------------------------------------------------------

function emptyRegistry(firmId: string): CrossReferenceRegistry {
  return {
    firmId,
    builtAt: new Date().toISOString(),
    matters: {
      idToNumber: new Map(),
      numberToId: new Map(),
      confidence: new Map(),
      sourceDatasets: new Map(),
    },
    feeEarners: {
      idToName: new Map(),
      nameToId: new Map(),
      nameVariants: new Map(),
      confidence: new Map(),
      sourceDatasets: new Map(),
    },
    clients: {
      idToName: new Map(),
      nameToId: new Map(),
      confidence: new Map(),
      sourceDatasets: new Map(),
    },
    departments: {
      idToName: new Map(),
      nameToId: new Map(),
      confidence: new Map(),
      sourceDatasets: new Map(),
    },
    stats: emptyStats(),
  };
}

function emptyStats(): CrossReferenceStats {
  return {
    matters: {
      totalMappings: 0,
      certainMappings: 0,
      inferredMappings: 0,
      conflictingMappings: 0,
      conflicts: [],
    },
    feeEarners: {
      totalMappings: 0,
      certainMappings: 0,
      nameVariantsResolved: 0,
      unresolvedLawyerNames: [],
    },
    clients: {
      totalMappings: 0,
      certainMappings: 0,
      inferredMappings: 0,
    },
    departments: {
      totalMappings: 0,
      certainMappings: 0,
      inferredMappings: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildCrossReferenceRegistry(
  firmId: string,
  normalisedDatasets: Record<string, NormaliseResult>,
  existingRegistry?: CrossReferenceRegistry
): CrossReferenceRegistry {
  const registry = existingRegistry
    ? cloneRegistry(existingRegistry, firmId)
    : emptyRegistry(firmId);

  extractMatterMappings(registry, normalisedDatasets);
  extractFeeEarnerMappings(registry, normalisedDatasets);
  extractClientMappings(registry, normalisedDatasets);
  extractDepartmentMappings(registry, normalisedDatasets);

  registry.stats = computeStats(registry);
  registry.builtAt = new Date().toISOString();

  return registry;
}

export function applyRegistryToDatasets(
  normalisedDatasets: Record<string, NormaliseResult>,
  registry: CrossReferenceRegistry
): Record<string, NormaliseResult> {
  const result: Record<string, NormaliseResult> = {};

  for (const [fileType, dataset] of Object.entries(normalisedDatasets)) {
    const enrichedRecords = dataset.records.map(record =>
      applyRegistryToRecord(record, registry)
    );
    result[fileType] = { ...dataset, records: enrichedRecords };
  }

  return result;
}

export function serialiseRegistry(
  registry: CrossReferenceRegistry
): CrossReferenceRegistrySerialised {
  return {
    firmId: registry.firmId,
    builtAt: registry.builtAt,
    matters: {
      idToNumber: Object.fromEntries(registry.matters.idToNumber),
      numberToId: Object.fromEntries(registry.matters.numberToId),
      confidence: Object.fromEntries(registry.matters.confidence),
      sourceDatasets: Object.fromEntries(registry.matters.sourceDatasets),
    },
    feeEarners: {
      idToName: Object.fromEntries(registry.feeEarners.idToName),
      nameToId: Object.fromEntries(registry.feeEarners.nameToId),
      nameVariants: Object.fromEntries(registry.feeEarners.nameVariants),
      confidence: Object.fromEntries(registry.feeEarners.confidence),
      sourceDatasets: Object.fromEntries(registry.feeEarners.sourceDatasets),
    },
    clients: {
      idToName: Object.fromEntries(registry.clients.idToName),
      nameToId: Object.fromEntries(registry.clients.nameToId),
      confidence: Object.fromEntries(registry.clients.confidence),
      sourceDatasets: Object.fromEntries(registry.clients.sourceDatasets),
    },
    departments: {
      idToName: Object.fromEntries(registry.departments.idToName),
      nameToId: Object.fromEntries(registry.departments.nameToId),
      confidence: Object.fromEntries(registry.departments.confidence),
      sourceDatasets: Object.fromEntries(registry.departments.sourceDatasets),
    },
    stats: registry.stats,
  };
}

export function deserialiseRegistry(
  s: CrossReferenceRegistrySerialised
): CrossReferenceRegistry {
  return {
    firmId: s.firmId,
    builtAt: s.builtAt,
    matters: {
      idToNumber: new Map(Object.entries(s.matters.idToNumber)),
      numberToId: new Map(Object.entries(s.matters.numberToId)),
      confidence: new Map(Object.entries(s.matters.confidence)),
      sourceDatasets: new Map(Object.entries(s.matters.sourceDatasets)),
    },
    feeEarners: {
      idToName: new Map(Object.entries(s.feeEarners.idToName)),
      nameToId: new Map(Object.entries(s.feeEarners.nameToId)),
      nameVariants: new Map(Object.entries(s.feeEarners.nameVariants)),
      confidence: new Map(Object.entries(s.feeEarners.confidence)),
      sourceDatasets: new Map(Object.entries(s.feeEarners.sourceDatasets)),
    },
    clients: {
      idToName: new Map(Object.entries(s.clients.idToName)),
      nameToId: new Map(Object.entries(s.clients.nameToId)),
      confidence: new Map(Object.entries(s.clients.confidence)),
      sourceDatasets: new Map(Object.entries(s.clients.sourceDatasets)),
    },
    departments: {
      idToName: new Map(Object.entries(s.departments.idToName)),
      nameToId: new Map(Object.entries(s.departments.nameToId)),
      confidence: new Map(Object.entries(s.departments.confidence)),
      sourceDatasets: new Map(Object.entries(s.departments.sourceDatasets)),
    },
    stats: s.stats,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function cloneRegistry(src: CrossReferenceRegistry, firmId: string): CrossReferenceRegistry {
  return deserialiseRegistry({ ...serialiseRegistry(src), firmId });
}

function extractMatterMappings(
  registry: CrossReferenceRegistry,
  datasets: Record<string, NormaliseResult>
): void {
  const orderedEntries = Object.entries(datasets).sort(
    ([a], [b]) => datasetPriority(a) - datasetPriority(b)
  );

  for (const [datasetName, dataset] of orderedEntries) {
    for (const record of dataset.records) {
      const matterId = asString(record.matterId);
      const matterNumber = asString(record.matterNumber);

      if (!matterId || !matterNumber) continue;

      const existingNumber = registry.matters.idToNumber.get(matterId);

      if (existingNumber === undefined) {
        registry.matters.idToNumber.set(matterId, matterNumber);
        registry.matters.numberToId.set(matterNumber, matterId);
        registry.matters.confidence.set(matterId, 'certain');
        registry.matters.sourceDatasets.set(matterId, [datasetName]);
      } else if (existingNumber !== matterNumber) {
        const sources = registry.matters.sourceDatasets.get(matterId) ?? [];
        // On a merge run, sources[0] may be from a prior upload session and may
        // not reflect the current priority ordering. Use it as best-available
        // attribution but make the resolution reason explicit about this.
        const sourceA = sources[0] ?? 'unknown (prior session)';

        registry.stats.matters.conflicts.push({
          entityType: 'matter',
          idForm: matterId,
          mappingA: existingNumber,
          sourceA,
          mappingB: matterNumber,
          sourceB: datasetName,
          resolution: 'kept_a',
          resolutionReason: `Existing mapping preserved (source: ${sourceA}); conflicting value from ${datasetName} discarded`,
        });
      } else {
        const sources = registry.matters.sourceDatasets.get(matterId) ?? [];
        if (!sources.includes(datasetName)) {
          registry.matters.sourceDatasets.set(matterId, [...sources, datasetName]);
        }
      }
    }
  }
}

function extractFeeEarnerMappings(
  registry: CrossReferenceRegistry,
  datasets: Record<string, NormaliseResult>
): void {
  const orderedEntries = Object.entries(datasets).sort(
    ([a], [b]) => datasetPriority(a) - datasetPriority(b)
  );

  for (const [datasetName, dataset] of orderedEntries) {
    for (const record of dataset.records) {
      tryRegisterFeeEarner(registry, asString(record.lawyerId), asString(record.lawyerName), datasetName);
      tryRegisterFeeEarner(registry, asString(record.responsibleLawyerId), asString(record.responsibleLawyer), datasetName);
    }
  }
}

function tryRegisterFeeEarner(
  registry: CrossReferenceRegistry,
  lawyerId: string | null,
  lawyerName: string | null,
  datasetName: string
): void {
  if (!lawyerId || !lawyerName) return;

  if (registry.feeEarners.idToName.has(lawyerId)) return;

  registry.feeEarners.idToName.set(lawyerId, lawyerName);
  registry.feeEarners.confidence.set(lawyerId, 'certain');
  registry.feeEarners.sourceDatasets.set(lawyerId, [datasetName]);

  const variants = generateNameVariants(lawyerName);
  for (const variant of variants) {
    if (!registry.feeEarners.nameToId.has(variant)) {
      registry.feeEarners.nameToId.set(variant, lawyerId);
    }
    if (!registry.feeEarners.nameVariants.has(variant)) {
      registry.feeEarners.nameVariants.set(variant, lawyerName);
    }
  }
}

function extractClientMappings(
  registry: CrossReferenceRegistry,
  datasets: Record<string, NormaliseResult>
): void {
  const orderedEntries = Object.entries(datasets).sort(
    ([a], [b]) => datasetPriority(a) - datasetPriority(b)
  );

  for (const [datasetName, dataset] of orderedEntries) {
    for (const record of dataset.records) {
      const contactId = asString(record.contactId);
      const displayName = asString(record.displayName);

      if (!contactId || !displayName) continue;

      if (!registry.clients.idToName.has(contactId)) {
        registry.clients.idToName.set(contactId, displayName);
        registry.clients.nameToId.set(displayName.toLowerCase(), contactId);
        registry.clients.confidence.set(contactId, 'certain');
        registry.clients.sourceDatasets.set(contactId, [datasetName]);
      }
    }
  }
}

function extractDepartmentMappings(
  registry: CrossReferenceRegistry,
  datasets: Record<string, NormaliseResult>
): void {
  const orderedEntries = Object.entries(datasets).sort(
    ([a], [b]) => datasetPriority(a) - datasetPriority(b)
  );

  for (const [datasetName, dataset] of orderedEntries) {
    for (const record of dataset.records) {
      const departmentId = asString(record.departmentId);
      const departmentName = asString(record.department);

      if (!departmentId || !departmentName) continue;

      if (!registry.departments.idToName.has(departmentId)) {
        registry.departments.idToName.set(departmentId, departmentName);
        registry.departments.nameToId.set(departmentName.toLowerCase(), departmentId);
        registry.departments.confidence.set(departmentId, 'certain');
        registry.departments.sourceDatasets.set(departmentId, [datasetName]);
      }
    }
  }
}

function applyRegistryToRecord(
  record: NormalisedRecord,
  registry: CrossReferenceRegistry
): NormalisedRecord {
  const result = { ...record };

  if (result.matterId && !result.matterNumber) {
    const matterNumber = registry.matters.idToNumber.get(result.matterId);
    if (matterNumber) {
      result.matterNumber = matterNumber;
      result._matterNumberSource = 'cross_reference';
    }
  }

  if (result.matterNumber && !result.matterId) {
    const matterId = registry.matters.numberToId.get(String(result.matterNumber));
    if (matterId) {
      result.matterId = matterId;
      result._matterIdSource = 'cross_reference';
    }
  }

  if (result.lawyerId && !result.lawyerName) {
    const name = registry.feeEarners.idToName.get(result.lawyerId);
    if (name) {
      result.lawyerName = name;
      result._lawyerNameSource = 'cross_reference';
    }
  }

  if (result.lawyerName && !result.lawyerId) {
    const normalised = normaliseNameForLookup(String(result.lawyerName));
    const id = registry.feeEarners.nameToId.get(normalised);
    if (id) {
      result.lawyerId = id;
      result._lawyerIdSource = 'cross_reference';
    }
  }

  if (result.contactId && !result.displayName) {
    const name = registry.clients.idToName.get(result.contactId);
    if (name) {
      result.displayName = name;
      result._displayNameSource = 'cross_reference';
    }
  }

  if (result.displayName && !result.contactId) {
    const id = registry.clients.nameToId.get(String(result.displayName).toLowerCase());
    if (id) {
      result.contactId = id;
      result._contactIdSource = 'cross_reference';
    }
  }

  if (result.departmentId && !result.department) {
    const name = registry.departments.idToName.get(result.departmentId);
    if (name) {
      result.department = name;
      result._departmentNameSource = 'cross_reference';
    }
  }

  if (result.department && !result.departmentId) {
    const id = registry.departments.nameToId.get(String(result.department).toLowerCase());
    if (id) {
      result.departmentId = id;
      result._departmentIdSource = 'cross_reference';
    }
  }

  return result;
}

function computeStats(registry: CrossReferenceRegistry): CrossReferenceStats {
  const matters = registry.matters;
  const fe = registry.feeEarners;

  const totalMatterMappings = matters.idToNumber.size;
  let certainMatter = 0;
  let inferredMatter = 0;
  for (const [id] of matters.idToNumber) {
    const conf = matters.confidence.get(id);
    if (conf === 'certain') certainMatter++;
    else inferredMatter++;
  }

  const totalFeMappings = fe.idToName.size;
  let certainFe = 0;
  for (const [id] of fe.idToName) {
    if (fe.confidence.get(id) === 'certain') certainFe++;
  }

  let certainClients = 0;
  let inferredClients = 0;
  for (const conf of registry.clients.confidence.values()) {
    if (conf === 'certain') certainClients++;
    else inferredClients++;
  }

  let certainDepts = 0;
  let inferredDepts = 0;
  for (const conf of registry.departments.confidence.values()) {
    if (conf === 'certain') certainDepts++;
    else inferredDepts++;
  }

  return {
    matters: {
      totalMappings: totalMatterMappings,
      certainMappings: certainMatter,
      inferredMappings: inferredMatter,
      // conflictingMappings is read from the accumulated list (not recomputed from Maps
      // because conflicts have no separate Map — they are only stored in stats.conflicts)
      conflictingMappings: registry.stats.matters.conflicts.length,
      conflicts: registry.stats.matters.conflicts,
    },
    feeEarners: {
      totalMappings: totalFeMappings,
      certainMappings: certainFe,
      nameVariantsResolved: fe.nameToId.size,
      unresolvedLawyerNames: [],
    },
    clients: {
      totalMappings: registry.clients.idToName.size,
      certainMappings: certainClients,
      inferredMappings: inferredClients,
    },
    departments: {
      totalMappings: registry.departments.idToName.size,
      certainMappings: certainDepts,
      inferredMappings: inferredDepts,
    },
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}
