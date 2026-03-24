import type { ObjectId } from 'mongodb';
import type { CrossReferenceRegistrySerialised } from './pipeline.js';

// =============================================================================
// MongoDB Document Interfaces
// All documents carry firm_id for application-layer data isolation.
// =============================================================================

// raw_uploads — one document per uploaded file
export interface RawUploadDocument {
  _id?: ObjectId;
  /** Supabase firm UUID */
  firm_id: string;
  /** e.g. 'matters', 'lawyer_time', 'invoices' */
  file_type: string;
  original_filename: string;
  upload_date: Date;
  /** Supabase user UUID */
  uploaded_by: string;
  /** Parsed rows from the file */
  raw_content: Record<string, unknown>[];
  record_count: number;
  status: 'pending' | 'processing' | 'processed' | 'error' | 'deleted';
  error_message?: string;
  processing_started_at?: Date;
  processing_completed_at?: Date;
}

// enriched_entities — one document per (firm, entity_type, data_version)
export interface EnrichedEntitiesDocument {
  _id?: ObjectId;
  firm_id: string;
  /** Matches EntityType enum values, e.g. 'feeEarner', 'matter' */
  entity_type: string;
  /** ISO timestamp string used as an immutable version key */
  data_version: string;
  /** Array of raw_uploads _id strings that contributed to this version */
  source_uploads: string[];
  records: Record<string, unknown>[];
  record_count: number;
  data_quality?: {
    quality_score: number;
    issue_count: number;
    issues: unknown[];
  };
  created_at?: Date;
}

// calculated_kpis — one document per calculation run
export interface CalculatedKpisDocument {
  _id?: ObjectId;
  firm_id: string;
  calculated_at: Date;
  /** Version of firm_config used during calculation */
  config_version: string;
  /** data_version of the enriched_entities snapshot used */
  data_version: string;
  kpis: Record<string, unknown>;
}

// historical_snapshots — periodic point-in-time summaries
export interface HistoricalSnapshotDocument {
  _id?: ObjectId;
  firm_id: string;
  snapshot_date: Date;
  period: 'weekly' | 'monthly' | 'quarterly' | 'annual';
  firm_summary: Record<string, unknown>;
  created_at?: Date;
}

// custom_entity_records — user-managed records for custom entity types
export interface CustomEntityRecordDocument {
  _id?: ObjectId;
  firm_id: string;
  entity_type: string;
  records: Record<string, unknown>[];
  updated_at: Date;
}

// normalised_datasets — one upserted document per (firm_id, file_type)
// Stores normalised records so subsequent uploads can incorporate prior data
// into cross-reference building without re-parsing raw files.
export interface NormalisedDatasetDocument {
  _id?: ObjectId;
  firm_id: string;
  /** Pipeline file-type key, e.g. 'wipJson', 'fullMattersJson' */
  file_type: string;
  /** Entity-type key used by normaliser rules, e.g. 'timeEntry', 'matter' */
  entity_key: string;
  /** Source upload _id that produced this normalised dataset */
  source_upload_id: string;
  records: Record<string, unknown>[];
  record_count: number;
  normalised_at: Date;
}

// recalculation_flags — one document per firm_id
// Set when new data is uploaded; cleared when formula engine runs.
export interface RecalculationFlagDocument {
  _id?: ObjectId;
  firm_id: string;
  is_stale: boolean;
  stale_since: Date;
}

// cross_reference_registries — one document per firm, upserted on every pipeline run
export interface CrossReferenceRegistryDocument {
  _id?: ObjectId;
  firm_id: string;
  /** Full serialised registry — Maps converted to plain objects for JSON storage */
  data: CrossReferenceRegistrySerialised;
  /** Always reflects last write time (upsert semantics) */
  updated_at: Date;
}
