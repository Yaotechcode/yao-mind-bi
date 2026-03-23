// src/server/pipeline/indexer.ts
// Stage 4: Index — pure functions only. No database calls.

import type {
  NormaliseResult,
  NormalisedRecord,
  PipelineIndexes,
} from '../../shared/types/pipeline.js';

// ---------------------------------------------------------------------------
// normaliseName
// ---------------------------------------------------------------------------

const TITLE_PATTERN = /^(mr|mrs|ms|dr|prof)\.?\s+/i;

export function normaliseName(name: string): string {
  let result = name.trim().toLowerCase();
  // Remove title prefix (may repeat for edge cases, but one pass is sufficient)
  result = result.replace(TITLE_PATTERN, '');
  // Collapse multiple spaces
  result = result.replace(/\s+/g, ' ').trim();
  return result;
}

// ---------------------------------------------------------------------------
// buildIndexes
// ---------------------------------------------------------------------------

function getRecords(
  normalisedResults: Record<string, NormaliseResult>,
  key: string
): NormalisedRecord[] {
  return normalisedResults[key]?.records ?? [];
}

function addToArrayMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

export function buildIndexes(
  normalisedResults: Record<string, NormaliseResult>,
  _entityKeys: string[]
): PipelineIndexes {
  const feeEarnerById = new Map<string, NormalisedRecord>();
  const feeEarnerByName = new Map<string, NormalisedRecord>();
  const feeEarnerByNameFuzzy: Array<{ name: string; normalised: string; record: NormalisedRecord }> = [];

  const matterById = new Map<string, NormalisedRecord>();
  const matterByNumber = new Map<string, NormalisedRecord>();

  const invoiceByMatterNumber = new Map<string, NormalisedRecord[]>();

  const clientById = new Map<string, NormalisedRecord>();
  const clientByName = new Map<string, NormalisedRecord>();

  const disbursementByMatterId = new Map<string, NormalisedRecord[]>();
  const taskByMatterId = new Map<string, NormalisedRecord[]>();

  const matterNumbersInWip = new Set<string>();
  const matterNumbersInMatters = new Set<string>();
  const matterNumbersInInvoices = new Set<string>();
  const lawyerIdsInWip = new Set<string>();
  const lawyerIdsInFeeEarners = new Set<string>();

  // --- feeEarner ---
  for (const record of getRecords(normalisedResults, 'feeEarner')) {
    if (typeof record.lawyerId === 'string') {
      feeEarnerById.set(record.lawyerId, record);
      lawyerIdsInFeeEarners.add(record.lawyerId);
    }
    if (typeof record.lawyerName === 'string') {
      const normalised = normaliseName(record.lawyerName);
      feeEarnerByName.set(normalised, record);
      feeEarnerByNameFuzzy.push({ name: record.lawyerName, normalised, record });
    }
  }

  // --- fullMattersJson ---
  for (const record of getRecords(normalisedResults, 'fullMattersJson')) {
    if (typeof record.matterId === 'string') {
      matterById.set(record.matterId, record);
    }
    if (typeof record.matterNumber === 'string') {
      matterByNumber.set(record.matterNumber, record);
      matterNumbersInMatters.add(record.matterNumber);
    }
  }

  // --- closedMattersJson ---
  for (const record of getRecords(normalisedResults, 'closedMattersJson')) {
    if (typeof record.matterId === 'string') {
      matterById.set(record.matterId, record);
    }
    if (typeof record.matterNumber === 'string') {
      matterByNumber.set(record.matterNumber, record);
      matterNumbersInMatters.add(record.matterNumber);
    }
  }

  // --- wipJson ---
  for (const record of getRecords(normalisedResults, 'wipJson')) {
    if (typeof record.matterNumber === 'string') {
      matterNumbersInWip.add(record.matterNumber);
    }
    if (typeof record.lawyerId === 'string') {
      lawyerIdsInWip.add(record.lawyerId);
    }
  }

  // --- invoicesJson ---
  for (const record of getRecords(normalisedResults, 'invoicesJson')) {
    if (typeof record.matterNumber === 'string') {
      addToArrayMap(invoiceByMatterNumber, record.matterNumber, record);
      matterNumbersInInvoices.add(record.matterNumber);
    }
  }

  // --- disbursementsJson ---
  for (const record of getRecords(normalisedResults, 'disbursementsJson')) {
    if (typeof record.matterId === 'string') {
      addToArrayMap(disbursementByMatterId, record.matterId, record);
    }
  }

  // --- tasksJson ---
  for (const record of getRecords(normalisedResults, 'tasksJson')) {
    if (typeof record.matterId === 'string') {
      addToArrayMap(taskByMatterId, record.matterId, record);
    }
  }

  // --- contactsJson ---
  for (const record of getRecords(normalisedResults, 'contactsJson')) {
    if (typeof record.contactId === 'string') {
      clientById.set(record.contactId, record);
    }
    if (typeof record.displayName === 'string') {
      clientByName.set(normaliseName(record.displayName), record);
    }
  }

  return {
    feeEarnerById,
    feeEarnerByName,
    feeEarnerByNameFuzzy,
    matterById,
    matterByNumber,
    invoiceByMatterNumber,
    clientById,
    clientByName,
    disbursementByMatterId,
    taskByMatterId,
    matterNumbersInWip,
    matterNumbersInMatters,
    matterNumbersInInvoices,
    lawyerIdsInWip,
    lawyerIdsInFeeEarners,
  };
}

// ---------------------------------------------------------------------------
// fuzzyMatchLawyer
// ---------------------------------------------------------------------------

export function fuzzyMatchLawyer(
  rawName: string,
  index: PipelineIndexes
): NormalisedRecord | null {
  if (!rawName || !rawName.trim()) {
    return null;
  }

  const normalised = normaliseName(rawName);
  if (!normalised) {
    return null;
  }

  // Level 1: exact normalised match
  const exact = index.feeEarnerByName.get(normalised);
  if (exact) {
    return exact;
  }

  const words = normalised.split(' ');
  const surname = words[words.length - 1];

  // Level 2: surname-only match — find fee earner whose normalised name ends with surname
  if (surname) {
    for (const entry of index.feeEarnerByNameFuzzy) {
      const entryWords = entry.normalised.split(' ');
      if (entryWords[entryWords.length - 1] === surname) {
        return entry.record;
      }
    }
  }

  // Level 3: initials + surname match — e.g. "J. Smith" or "J Smith"
  // Detect pattern: first word is a single letter (possibly followed by dot already stripped)
  const firstWord = words[0];
  const firstWordStripped = firstWord ? firstWord.replace(/\.$/, '') : '';
  if (firstWordStripped && firstWordStripped.length === 1 && words.length >= 2) {
    const initial = firstWordStripped;
    for (const entry of index.feeEarnerByNameFuzzy) {
      const entryWords = entry.normalised.split(' ');
      if (
        entryWords[0].startsWith(initial) &&
        entryWords[entryWords.length - 1] === surname
      ) {
        return entry.record;
      }
    }
  }

  return null;
}
