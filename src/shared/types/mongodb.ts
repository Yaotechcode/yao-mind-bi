import type { ObjectId } from 'mongodb';

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
  status: 'pending' | 'processing' | 'processed' | 'error';
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
