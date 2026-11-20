import { normalizeDefinition, type BadgeDraft } from './params.js';

export type BadgeConfigSet = {
  name: string;
  kind: 'difficulty' | 'chart';
  values: (string | number)[];
};

export type BadgeConfigDocument = {
  sets: BadgeConfigSet[];
  definitions: Record<string, unknown>[];
};

const SET_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseBadgeConfig(
  raw: string | unknown,
): { ok: true; document: BadgeConfigDocument } | { ok: false; errors: string[] } {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ['Configuration is not valid JSON'] };
    }
  }
  if (Array.isArray(data)) data = { definitions: data };
  if (!data || typeof data !== 'object') return { ok: false, errors: ['Configuration must be an object'] };
  const record = data as Record<string, unknown>;
  if (record.sets != null && !Array.isArray(record.sets)) return { ok: false, errors: ['sets must be a list'] };
  if (!Array.isArray(record.definitions)) return { ok: false, errors: ['definitions must be a list'] };
  return {
    ok: true,
    document: {
      sets: (record.sets as BadgeConfigSet[] | undefined) ?? [],
      definitions: record.definitions as Record<string, unknown>[],
    },
  };
}

export function validateBadgeConfig(
  document: BadgeConfigDocument,
  packIds: Record<string, number> = {},
): { ok: boolean; errors: string[]; sets: BadgeConfigSet[]; definitions: BadgeDraft[] } {
  const errors: string[] = [];
  const source = structuredClone(document);
  const sets: BadgeConfigSet[] = [];
  const setNames = new Set<string>();
  for (const raw of source.sets ?? []) {
    if (!raw || typeof raw !== 'object') {
      errors.push('A set must be an object');
      continue;
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const kind = raw.kind === 'chart' ? 'chart' : raw.kind === 'difficulty' ? 'difficulty' : '';
    if (!SET_NAME.test(name) || name.length > 64) errors.push(`Set name "${name}" must be a short lowercase slug`);
    if (!kind) errors.push(`${name || 'set'}: kind must be difficulty or chart`);
    if (name && setNames.has(name)) errors.push(`Duplicate set ${name}`);
    if (name) setNames.add(name);
    if (!Array.isArray(raw.values)) {
      errors.push(`${name || 'set'}: values must be a list`);
      continue;
    }
    if (kind === 'chart') {
      const values: number[] = [];
      for (const value of raw.values) {
        const id = Number(value);
        if (!Number.isInteger(id) || id <= 0) {
          errors.push(`${name}: chart ids must be positive integers`);
          break;
        }
        values.push(id);
      }
      if (kind && name) sets.push({ name, kind, values });
    } else if (kind === 'difficulty') {
      const values: string[] = [];
      for (const value of raw.values) {
        if (typeof value !== 'string' || !value.trim()) {
          errors.push(`${name}: difficulty values must be text`);
          break;
        }
        values.push(value.trim());
      }
      if (name) sets.push({ name, kind, values });
    }
  }

  const definitions: BadgeDraft[] = [];
  const slugs = new Set<string>();
  for (const raw of source.definitions ?? []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push('A definition must be an object');
      continue;
    }
    const slug = typeof raw.slug === 'string' ? raw.slug : 'badge';
    const params = raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
      ? raw.params as Record<string, unknown>
      : null;
    if (params) {
      const packName = typeof params.packName === 'string' ? params.packName.trim() : '';
      if (packName) {
        const packId = packIds[packName];
        if (!Number.isInteger(packId) || packId <= 0) errors.push(`${slug}: pack "${packName}" was not found`);
        else params.packId = packId;
      }
    }
    if (slugs.has(slug)) errors.push(`Duplicate slug ${slug}`);
    slugs.add(slug);
    const normalized = normalizeDefinition(raw);
    if (!normalized.ok) errors.push(`${slug}: ${normalized.errors.join('; ')}`);
    else definitions.push(normalized.value);
  }

  return { ok: errors.length === 0, errors, sets, definitions };
}
