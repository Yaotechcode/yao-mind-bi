/**
 * mapping-templates-service.ts
 *
 * CRUD for mapping_templates in Supabase.
 * Every function takes firmId as its first parameter — never trusted from the
 * request body.
 */

import { getServerClient } from '../lib/supabase.js';
import type { MappingTemplate } from '../../shared/mapping/types.js';

// ---------------------------------------------------------------------------
// DB row type (snake_case as stored in Supabase)
// ---------------------------------------------------------------------------

interface MappingTemplateRow {
  id: string;
  firm_id: string;
  name: string;
  file_type: string;
  mappings: Record<string, string>;
  type_overrides: Record<string, string>;
  created_at: string;
  updated_at: string;
}

function rowToTemplate(row: MappingTemplateRow): MappingTemplate {
  return {
    id: row.id,
    firmId: row.firm_id,
    name: row.name,
    fileType: row.file_type,
    mappings: row.mappings,
    typeOverrides: row.type_overrides as MappingTemplate['typeOverrides'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// listMappingTemplates
// ---------------------------------------------------------------------------

export async function listMappingTemplates(
  firmId: string,
  fileType?: string,
): Promise<MappingTemplate[]> {
  const db = getServerClient();

  let query = db
    .from('mapping_templates')
    .select('*')
    .eq('firm_id', firmId)
    .order('created_at', { ascending: false });

  if (fileType) {
    query = query.eq('file_type', fileType);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list mapping templates: ${error.message}`);

  return (data as MappingTemplateRow[]).map(rowToTemplate);
}

// ---------------------------------------------------------------------------
// getMappingTemplate
// ---------------------------------------------------------------------------

export async function getMappingTemplate(
  firmId: string,
  templateId: string,
): Promise<MappingTemplate | null> {
  const db = getServerClient();

  const { data, error } = await db
    .from('mapping_templates')
    .select('*')
    .eq('firm_id', firmId)
    .eq('id', templateId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // not found
    throw new Error(`Failed to get mapping template: ${error.message}`);
  }

  return rowToTemplate(data as MappingTemplateRow);
}

// ---------------------------------------------------------------------------
// createMappingTemplate
// ---------------------------------------------------------------------------

export interface CreateMappingTemplateInput {
  name: string;
  fileType: string;
  mappings: Record<string, string>;
  typeOverrides?: Record<string, string>;
}

export async function createMappingTemplate(
  firmId: string,
  input: CreateMappingTemplateInput,
): Promise<MappingTemplate> {
  const db = getServerClient();

  const { data, error } = await db
    .from('mapping_templates')
    .insert({
      firm_id: firmId,
      name: input.name,
      file_type: input.fileType,
      mappings: input.mappings,
      type_overrides: input.typeOverrides ?? {},
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create mapping template: ${error.message}`);

  return rowToTemplate(data as MappingTemplateRow);
}

// ---------------------------------------------------------------------------
// updateMappingTemplate
// ---------------------------------------------------------------------------

export interface UpdateMappingTemplateInput {
  name?: string;
  mappings?: Record<string, string>;
  typeOverrides?: Record<string, string>;
}

export async function updateMappingTemplate(
  firmId: string,
  templateId: string,
  input: UpdateMappingTemplateInput,
): Promise<MappingTemplate> {
  const db = getServerClient();

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) updates['name'] = input.name;
  if (input.mappings !== undefined) updates['mappings'] = input.mappings;
  if (input.typeOverrides !== undefined) updates['type_overrides'] = input.typeOverrides;

  const { data, error } = await db
    .from('mapping_templates')
    .update(updates)
    .eq('firm_id', firmId)
    .eq('id', templateId)
    .select()
    .single();

  if (error) throw new Error(`Failed to update mapping template: ${error.message}`);

  return rowToTemplate(data as MappingTemplateRow);
}

// ---------------------------------------------------------------------------
// deleteMappingTemplate
// ---------------------------------------------------------------------------

export async function deleteMappingTemplate(
  firmId: string,
  templateId: string,
): Promise<void> {
  const db = getServerClient();

  const { error } = await db
    .from('mapping_templates')
    .delete()
    .eq('firm_id', firmId)
    .eq('id', templateId);

  if (error) throw new Error(`Failed to delete mapping template: ${error.message}`);
}
