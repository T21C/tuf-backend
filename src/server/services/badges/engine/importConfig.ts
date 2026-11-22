import { normalizeDefinition, type BadgeDraft } from './params.js';

export type BadgeConfigSet = {
  name: string;
  kind: 'difficulty' | 'chart';
  values: (string | number)[];
};

export type BadgeConfigGroup = {
  id?: number;
  name: string;
  sortOrder: number;
};

export type ImportedDefinition = BadgeDraft & {
  groupId?: number | null;
  sortOrder?: number;
};

export type BadgeConfigDocument = {
  groups: Record<string, unknown>[];
  sets: BadgeConfigSet[];
  definitions: Record<string, unknown>[];
};

const SET_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GROUP_NAME_MAX = 80;

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
  if (record.groups != null && !Array.isArray(record.groups)) return { ok: false, errors: ['groups must be a list'] };
  if (record.sets != null && !Array.isArray(record.sets)) return { ok: false, errors: ['sets must be a list'] };
  if (!Array.isArray(record.definitions)) return { ok: false, errors: ['definitions must be a list'] };
  return {
    ok: true,
    document: {
      groups: (record.groups as Record<string, unknown>[] | undefined) ?? [],
      sets: (record.sets as BadgeConfigSet[] | undefined) ?? [],
      definitions: record.definitions as Record<string, unknown>[],
    },
  };
}

export function importDefinitionSource(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    ...raw,
    grant: raw.grant ?? raw.grantMode,
    identity: raw.identity ?? raw.identityMode,
    confirm: raw.confirm ?? raw.confirmMode,
  };
}

function parseGroupId(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value == null) return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function parseSortOrder(value: unknown): number | undefined {
  if (value == null) return undefined;
  const order = Number(value);
  if (!Number.isInteger(order)) return undefined;
  return order;
}

export function validateBadgeConfig(
  document: BadgeConfigDocument,
  packIds: Record<string, number> = {},
): {
  ok: boolean;
  errors: string[];
  groups: BadgeConfigGroup[];
  sets: BadgeConfigSet[];
  definitions: ImportedDefinition[];
} {
  const errors: string[] = [];
  const source = structuredClone(document);
  const groups: BadgeConfigGroup[] = [];
  const groupNames = new Set<string>();
  for (const raw of source.groups ?? []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push('A group must be an object');
      continue;
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      errors.push('A group name is required');
      continue;
    }
    if (name.length > GROUP_NAME_MAX) errors.push(`Group name "${name}" is too long`);
    if (groupNames.has(name)) errors.push(`Duplicate group ${name}`);
    groupNames.add(name);
    const id = parseGroupId(raw.id);
    groups.push({
      ...(typeof id === 'number' ? { id } : {}),
      name,
      sortOrder: parseSortOrder(raw.sortOrder) ?? 0,
    });
  }
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

  const definitions: ImportedDefinition[] = [];
  const slugs = new Set<string>();
  for (const raw of source.definitions ?? []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push('A definition must be an object');
      continue;
    }
    const mapped = importDefinitionSource(raw);
    const slug = typeof mapped.slug === 'string' ? mapped.slug : 'badge';
    const params = mapped.params && typeof mapped.params === 'object' && !Array.isArray(mapped.params)
      ? mapped.params as Record<string, unknown>
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
    const normalized = normalizeDefinition(mapped);
    if (!normalized.ok) errors.push(`${slug}: ${normalized.errors.join('; ')}`);
    else {
      const groupId = parseGroupId(raw.groupId);
      const sortOrder = parseSortOrder(raw.sortOrder);
      definitions.push({
        ...normalized.value,
        ...(groupId !== undefined ? { groupId } : {}),
        ...(sortOrder !== undefined ? { sortOrder } : {}),
      });
    }
  }

  return { ok: errors.length === 0, errors, groups, sets, definitions };
}
