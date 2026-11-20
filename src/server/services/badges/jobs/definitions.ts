import { logger } from '@/server/services/core/LoggerService.js';
import { normalizeDefinition, type BadgeDraft } from '../engine/params.js';

export type DefinitionRow = {
  id: number;
  audience: string;
  slug: string;
  name: string;
  secret: number;
  enabled: number;
  reducer: string;
  grantMode: string;
  identityMode: string;
  backfill: string;
  curve: unknown;
  tierLabels: unknown;
  weight: number;
  display: unknown;
  confirmMode: string;
  params: unknown;
  publishedAt: Date | null;
};

export function definitionFromRow(row: DefinitionRow): BadgeDraft | null {
  const normalized = normalizeDefinition({
    audience: row.audience,
    slug: row.slug,
    name: row.name,
    secret: Boolean(row.secret),
    enabled: Boolean(row.enabled),
    reducer: row.reducer,
    grant: row.grantMode,
    identity: row.identityMode,
    backfill: row.backfill,
    curve: row.curve,
    tierLabels: row.tierLabels,
    weight: Number(row.weight),
    display: row.display,
    confirm: row.confirmMode,
    params: row.params,
    publishedAt: row.publishedAt ? new Date(row.publishedAt).toISOString() : null,
  });
  if (!normalized.ok) {
    logger.error(`[badges] definition ${row.id} is invalid`, normalized.errors);
    return null;
  }
  normalized.value.id = row.id;
  return normalized.value;
}
