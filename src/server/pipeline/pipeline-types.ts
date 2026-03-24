// src/server/pipeline/pipeline-types.ts
// Shared types for pipeline orchestration results.
// No imports from pipeline modules — this file has no dependencies.

export type PipelineStage =
  | 'normalise'
  | 'crossReference'
  | 'index'
  | 'join'
  | 'enrich'
  | 'aggregate';

export interface PipelineWarning {
  stage: PipelineStage;
  message: string;
  severity: 'error' | 'warning' | 'info';
  count?: number;
}

export interface PipelineRunResult {
  uploadId: string;
  stagesCompleted: PipelineStage[];
  warnings: PipelineWarning[];
  recordsProcessed: number;
  recordsPersisted: number;
  duration_ms: number;
}
