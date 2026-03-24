/**
 * response-helpers.ts — Shared Netlify Function response utilities.
 */

import type { HandlerResponse } from '@netlify/functions';

export function successResponse(data: unknown, statusCode = 200): HandlerResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
}

export function errorResponse(
  message: string,
  statusCode: number,
  details?: unknown
): HandlerResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: message,
      ...(details !== undefined ? { details } : {}),
    }),
  };
}

export function paginatedResponse(
  data: unknown[],
  total: number,
  limit: number,
  offset: number
): HandlerResponse {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, total, limit, offset }),
  };
}
