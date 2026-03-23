// src/shared/types/pipeline.ts
// Pipeline-specific types for Stages 2–8.
// Separate from index.ts (entity/config types) to avoid circular imports.

// =============================================================================
// Stage 2: Normalise
// =============================================================================

/**
 * A single normalised record. All identifier fields are optional — the
 * cross-reference engine fills in the missing forms. Fields prefixed with _
 * are metadata (data provenance) and must never be shown to end users.
 */
export interface NormalisedRecord {
  // --- Matter identifiers ---
  matterId?: string;
  matterNumber?: string;
  _matterIdSource?: 'original' | 'cross_reference';
  _matterNumberSource?: 'original' | 'cross_reference';

  // --- Fee earner identifiers (WIP / time entries) ---
  lawyerId?: string;
  lawyerName?: string;
  _lawyerIdSource?: 'original' | 'cross_reference';
  _lawyerNameSource?: 'original' | 'cross_reference';

  // --- Responsible lawyer (matters / invoices use this field name) ---
  responsibleLawyerId?: string;
  responsibleLawyer?: string;
  _responsibleLawyerIdSource?: 'original' | 'cross_reference';
  _responsibleLawyerNameSource?: 'original' | 'cross_reference';

  // --- Client identifiers ---
  contactId?: string;
  displayName?: string;
  _contactIdSource?: 'original' | 'cross_reference';
  _displayNameSource?: 'original' | 'cross_reference';

  // --- Department identifiers ---
  departmentId?: string;
  department?: string;
  _departmentIdSource?: 'original' | 'cross_reference';
  _departmentNameSource?: 'original' | 'cross_reference';

  // All other domain fields (billing, dates, etc.)
  [key: string]: unknown;
}

/** Output of Stage 2 (Normalise). One NormaliseResult per uploaded file type. */
export interface NormaliseResult {
  fileType: string;
  records: NormalisedRecord[];
  recordCount: number;
  normalisedAt: string; // ISO timestamp
}

// =============================================================================
// Stage 3: Cross-Reference
// =============================================================================

export interface CrossReferenceRegistry {
  firmId: string;
  builtAt: string; // ISO timestamp

  matters: {
    idToNumber: Map<string, string>;   // matterId (UUID) → matterNumber (string)
    numberToId: Map<string, string>;   // matterNumber → matterId
    confidence: Map<string, 'certain' | 'inferred'>;  // keyed by matterId
    sourceDatasets: Map<string, string[]>;             // matterId → dataset names
  };

  feeEarners: {
    idToName: Map<string, string>;     // lawyerId → canonical display name
    nameToId: Map<string, string>;     // normalised name variant → lawyerId
    nameVariants: Map<string, string>; // name variant → canonical name
    confidence: Map<string, 'certain' | 'inferred'>;
    sourceDatasets: Map<string, string[]>;
  };

  clients: {
    idToName: Map<string, string>;     // contactId → displayName
    nameToId: Map<string, string>;     // normalised displayName → contactId
    confidence: Map<string, 'certain' | 'inferred'>;
    sourceDatasets: Map<string, string[]>;
  };

  departments: {
    idToName: Map<string, string>;     // departmentId → name
    nameToId: Map<string, string>;     // normalised name → departmentId
    confidence: Map<string, 'certain' | 'inferred'>;
    sourceDatasets: Map<string, string[]>;
  };

  stats: CrossReferenceStats;
}

export interface CrossReferenceStats {
  matters: {
    totalMappings: number;
    certainMappings: number;
    inferredMappings: number;
    conflictingMappings: number;
    conflicts: CrossReferenceConflict[];
  };
  feeEarners: {
    totalMappings: number;
    certainMappings: number;
    nameVariantsResolved: number;
    unresolvedLawyerNames: string[];
  };
  clients: {
    totalMappings: number;
    certainMappings: number;
    inferredMappings: number;
  };
  departments: {
    totalMappings: number;
    certainMappings: number;
    inferredMappings: number;
  };
}

export interface CrossReferenceConflict {
  entityType: 'matter' | 'feeEarner' | 'client' | 'department';
  idForm: string;
  mappingA: string;
  sourceA: string;
  mappingB: string;
  sourceB: string;
  resolution: 'kept_a' | 'kept_b' | 'flagged';
  resolutionReason: string;
}

/**
 * Serialised form of CrossReferenceRegistry — all Maps converted to plain
 * objects so the registry can be stored as JSON in MongoDB.
 */
export interface CrossReferenceRegistrySerialised {
  firmId: string;
  builtAt: string;
  matters: {
    idToNumber: Record<string, string>;
    numberToId: Record<string, string>;
    confidence: Record<string, 'certain' | 'inferred'>;
    sourceDatasets: Record<string, string[]>;
  };
  feeEarners: {
    idToName: Record<string, string>;
    nameToId: Record<string, string>;
    nameVariants: Record<string, string>;
    confidence: Record<string, 'certain' | 'inferred'>;
    sourceDatasets: Record<string, string[]>;
  };
  clients: {
    idToName: Record<string, string>;
    nameToId: Record<string, string>;
    confidence: Record<string, 'certain' | 'inferred'>;
    sourceDatasets: Record<string, string[]>;
  };
  departments: {
    idToName: Record<string, string>;
    nameToId: Record<string, string>;
    confidence: Record<string, 'certain' | 'inferred'>;
    sourceDatasets: Record<string, string[]>;
  };
  stats: CrossReferenceStats;
}

/** Added to DataQualityReport.crossReference */
export interface CrossReferenceQualityStats {
  matterMappingCoverage: number;       // % of matter records with both ID forms
  feeEarnerMappingCoverage: number;    // % of fee earner refs with both ID + name
  conflicts: CrossReferenceConflict[];
  unresolvedMatterIds: number;
  unresolvedMatterNumbers: number;
  unresolvedLawyerNames: string[];
}
