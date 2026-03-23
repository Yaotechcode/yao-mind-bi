import type { ParseResult } from '../parsers/types.js';
import { COLUMN_NAME_ALIASES } from './column-normaliser.js';

// ---------------------------------------------------------------------------
// Simple normalisation used ONLY within the detector.
// Lowercase + strip separators. No prefix stripping — prefix stripping would
// transform signature keys (e.g. 'responsiblelawyer' → 'lawyer') and break
// symmetric matching between input columns and signature columns.
// ---------------------------------------------------------------------------
function simpleNorm(name: string): string {
  return name.toLowerCase().replace(/[\s_\-\.]+/g, '');
}

// ---------------------------------------------------------------------------
// File type signatures
// ---------------------------------------------------------------------------

export interface FileTypeSignature {
  label: string
  requiredColumns: string[]
  strongSignalColumns: string[]
  weakSignalColumns: string[]
  format: 'csv' | 'json'
}

export const FILE_TYPE_SIGNATURES: Record<string, FileTypeSignature> = {
  feeEarnerCsv: {
    label: 'Fee Earner Data',
    requiredColumns: [],
    strongSignalColumns: ['paymodel', 'feeshare', 'salary', 'annualsalary', 'chargeoutrate', 'targetweeklyhours', 'annualtarget', 'chargeableweeklytarget'],
    weakSignalColumns: ['department', 'grade', 'name', 'email', 'startdate'],
    format: 'csv',
  },
  wipJson: {
    label: 'WIP (Time Entries)',
    requiredColumns: ['billablevalue', 'durationminutes', 'matterId', 'lawyerId', 'doNotBill'],
    strongSignalColumns: ['billablevalue', 'durationminutes', 'matterid', 'lawyerid', 'donotbill', 'writeoffvalue'],
    weakSignalColumns: ['rate', 'entryid', 'casetype'],
    format: 'json',
  },
  fullMattersJson: {
    label: 'Full Matters',
    requiredColumns: [],
    strongSignalColumns: ['matternumber', 'matterid', 'responsiblelawyer', 'status', 'createdate', 'department'],
    weakSignalColumns: ['budget', 'client', 'casetype', 'netbilling'],
    format: 'json',
  },
  closedMattersJson: {
    label: 'Closed Matters',
    requiredColumns: [],
    strongSignalColumns: ['matternumber', 'invoicenetbilling', 'invoiceddisbursements', 'wipbillable', 'wipwriteoff'],
    weakSignalColumns: ['completeddate', 'responsiblelawyer', 'invoiceoutstanding'],
    format: 'json',
  },
  invoicesJson: {
    label: 'Invoices',
    requiredColumns: [],
    strongSignalColumns: ['invoicedate', 'duedate', 'subtotal', 'outstanding', 'paid', 'matternumber', 'responsiblelawyer'],
    weakSignalColumns: ['invoicenumber', 'total', 'vat', 'writtenoff'],
    format: 'json',
  },
  contactsJson: {
    label: 'Contacts / Clients',
    requiredColumns: [],
    strongSignalColumns: ['contactid', 'displayname'],
    weakSignalColumns: ['email', 'phone', 'address'],
    format: 'json',
  },
  disbursementsJson: {
    label: 'Disbursements',
    requiredColumns: [],
    strongSignalColumns: ['transactionid', 'subtotal', 'outstanding', 'matternumber', 'responsiblelawyerid'],
    weakSignalColumns: ['disbursementdate', 'clientid', 'departmentid'],
    format: 'json',
  },
  tasksJson: {
    label: 'Tasks',
    requiredColumns: [],
    strongSignalColumns: ['taskid', 'duedate', 'matterid', 'lawyerid', 'priority', 'taskstatus'],
    weakSignalColumns: ['title', 'description'],
    format: 'json',
  },
} as const;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface FileTypeDetectionResult {
  detected: string | null
  confidence: 'high' | 'medium' | 'low' | 'none'
  scores: Record<string, number>
  reasoning: string[]
  alternativeCandidates: Array<{ fileType: string; score: number }>
}

// ---------------------------------------------------------------------------
// Pre-normalised signatures (computed once at module load)
// ---------------------------------------------------------------------------

interface NormalisedSignature {
  key: string
  label: string
  format: 'csv' | 'json'
  required: string[]
  strong: string[]
  weak: string[]
}

const NORM_SIGNATURES: NormalisedSignature[] = Object.entries(FILE_TYPE_SIGNATURES).map(
  ([key, sig]) => ({
    key,
    label: sig.label,
    format: sig.format,
    required: sig.requiredColumns.map(simpleNorm),
    strong: sig.strongSignalColumns.map(simpleNorm),
    weak: sig.weakSignalColumns.map(simpleNorm),
  })
);

// ---------------------------------------------------------------------------
// detectFileType
// ---------------------------------------------------------------------------

export function detectFileType(parseResult: ParseResult): FileTypeDetectionResult {
  // 1. Build normalised + aliased input column set
  const normInputSet = new Set(
    parseResult.columns.map(c => {
      const normed = simpleNorm(c.originalHeader);
      return COLUMN_NAME_ALIASES[normed] ?? normed;
    })
  );

  // 2. Detect file format from ParseResult.fileType
  const inputFormat = parseResult.fileType === 'csv' ? 'csv'
    : parseResult.fileType === 'json' ? 'json'
    : null;

  const scores: Record<string, number> = {};
  const reasoningMap: Record<string, string[]> = {};

  // 3. Score each file type
  for (const sig of NORM_SIGNATURES) {
    const reasoning: string[] = [];

    // Required column check — any miss → score 0
    const missingRequired = sig.required.filter(r => !normInputSet.has(r));
    if (missingRequired.length > 0) {
      scores[sig.key] = 0;
      reasoning.push(`Missing required column(s): ${missingRequired.join(', ')}`);
      reasoningMap[sig.key] = reasoning;
      continue;
    }

    // Strong signal scoring (max 75)
    const strongMatches = sig.strong.filter(s => normInputSet.has(s));
    const strongMissing = sig.strong.filter(s => !normInputSet.has(s));
    const strongScore = Math.min(strongMatches.length * 15, 75);

    if (strongMatches.length > 0) {
      reasoning.push(
        `Found ${strongMatches.length} of ${sig.strong.length} strong signal columns: ${strongMatches.join(', ')}`
      );
    }
    if (strongMissing.length > 0) {
      reasoning.push(`Missing strong signal(s): ${strongMissing.join(', ')}`);
    }

    // Weak signal scoring (max 25)
    const weakMatches = sig.weak.filter(w => normInputSet.has(w));
    const weakScore = Math.min(weakMatches.length * 5, 25);

    if (weakMatches.length > 0) {
      reasoning.push(`Found ${weakMatches.length} weak signal column(s): ${weakMatches.join(', ')}`);
    }

    // Format bonus — only applied when at least one signal column matched
    // (prevents format alone from triggering a spurious detection)
    const signalScore = strongScore + weakScore;
    let formatBonus = 0;
    if (signalScore > 0 && inputFormat && inputFormat === sig.format) {
      formatBonus = 10;
      reasoning.push(`Format match: ${sig.format.toUpperCase()} ✓`);
    }

    scores[sig.key] = Math.min(signalScore + formatBonus, 100);
    reasoningMap[sig.key] = reasoning;
  }

  // 4. Rank results
  const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
  const [bestKey, bestScore] = sorted[0] ?? [null, 0];

  const detected = bestScore > 0 ? bestKey : null;

  const confidence: FileTypeDetectionResult['confidence'] =
    bestScore >= 60 ? 'high'
    : bestScore >= 35 ? 'medium'
    : bestScore > 0 ? 'low'
    : 'none';

  const alternativeCandidates = sorted
    .slice(1)
    .filter(([, s]) => s > 0)
    .map(([fileType, score]) => ({ fileType, score }));

  return {
    detected,
    confidence,
    scores,
    reasoning: detected ? (reasoningMap[detected] ?? []) : [],
    alternativeCandidates,
  };
}
