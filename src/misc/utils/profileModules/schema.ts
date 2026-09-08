import { z } from 'zod';
import {
  MAX_FAVORITE_ITEMS,
  MAX_PROFILE_MODULE_ID_LENGTH,
  PROFILE_MODULE_VERSION,
  FAVORITE_ITEM_KINDS,
  isModuleTypeForKind,
  isSingletonModuleType,
  stockModuleId,
  stockModuleTypesForKind,
  type FavoriteItemKind,
  type ProfileEntityKind,
} from './catalog.js';

export class ProfileModulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileModulesError';
  }
}

export type FavoriteItem = {
  kind: FavoriteItemKind;
  id: number;
};

export type ProfileModuleInstance = {
  id: string;
  type: string;
  config: Record<string, unknown>;
};

export type ProfileModulesDocument = {
  version: typeof PROFILE_MODULE_VERSION;
  modules: ProfileModuleInstance[];
};

const MODULE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STOCK_ID_RE = /^stock-[a-zA-Z0-9_-]+$/;

export function createProfileModuleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `mod-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function parseModuleId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.length || raw.length > MAX_PROFILE_MODULE_ID_LENGTH) {
    return null;
  }
  if (MODULE_ID_RE.test(raw) || STOCK_ID_RE.test(raw) || /^[a-zA-Z0-9_-]+$/.test(raw)) {
    return raw;
  }
  return null;
}

const favoriteItemSchema = z.object({
  kind: z.enum(FAVORITE_ITEM_KINDS),
  id: z.number().int().positive(),
});

function parseFavoriteItems(raw: unknown): FavoriteItem[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new ProfileModulesError('favorite config.items must be an array');
  }
  if (raw.length > MAX_FAVORITE_ITEMS) {
    throw new ProfileModulesError(`Favorite can have at most ${MAX_FAVORITE_ITEMS} items`);
  }
  const seen = new Set<string>();
  const items: FavoriteItem[] = [];
  for (const row of raw) {
    const parsed = favoriteItemSchema.safeParse(row);
    if (!parsed.success) {
      throw new ProfileModulesError('Invalid favorite item');
    }
    const key = `${parsed.data.kind}:${parsed.data.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(parsed.data);
  }
  return items;
}

function parseModuleConfig(type: string, raw: unknown): Record<string, unknown> {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (type === 'favorite') {
    return { items: parseFavoriteItems(data.items) };
  }
  return {};
}

export function createStockLayout(kind: ProfileEntityKind): ProfileModulesDocument {
  return {
    version: PROFILE_MODULE_VERSION,
    modules: stockModuleTypesForKind(kind).map((type) => ({
      id: stockModuleId(type),
      type,
      config: {},
    })),
  };
}

export function resolveLayout(
  document: ProfileModulesDocument | null | undefined,
  kind: ProfileEntityKind,
): ProfileModuleInstance[] {
  if (!document) return createStockLayout(kind).modules;
  return document.modules;
}

export function previousModuleCount(
  stored: ProfileModulesDocument | null | undefined,
  kind: ProfileEntityKind,
): number {
  if (!stored) return createStockLayout(kind).modules.length;
  return stored.modules.length;
}

export function assertModuleCountAllowed(opts: {
  previousCount: number;
  nextCount: number;
  cap: number;
}): void {
  const { previousCount, nextCount, cap } = opts;
  if (nextCount > cap && nextCount > previousCount) {
    throw new ProfileModulesError(
      `Too many modules (${nextCount}). Maximum is ${cap}. Remove a module or subscribe to TUFStellar for more slots.`,
    );
  }
}

export function parseProfileModulesDocument(
  raw: unknown,
  kind: ProfileEntityKind,
): ProfileModulesDocument {
  if (raw == null) {
    throw new ProfileModulesError('Profile modules payload is required');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProfileModulesError('Profile modules payload must be an object');
  }

  const body = raw as Record<string, unknown>;
  const version = body.version == null ? PROFILE_MODULE_VERSION : body.version;
  if (version !== PROFILE_MODULE_VERSION) {
    throw new ProfileModulesError('Unsupported profile modules version');
  }
  if (!Array.isArray(body.modules)) {
    throw new ProfileModulesError('modules must be an array');
  }

  const ids = new Set<string>();
  const types = new Set<string>();
  const modules: ProfileModuleInstance[] = [];

  for (const [index, row] of body.modules.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new ProfileModulesError(`Module ${index + 1} must be an object`);
    }
    const rec = row as Record<string, unknown>;
    const id = parseModuleId(rec.id);
    if (!id) {
      throw new ProfileModulesError(`Module ${index + 1} has an invalid id`);
    }
    if (ids.has(id)) {
      throw new ProfileModulesError('Duplicate module id');
    }
    ids.add(id);

    if (typeof rec.type !== 'string' || !rec.type.trim()) {
      throw new ProfileModulesError(`Module ${index + 1} is missing a type`);
    }
    const type = rec.type.trim();
    if (!isModuleTypeForKind(kind, type)) {
      throw new ProfileModulesError(`Unknown module type "${type}" for this profile`);
    }
    if (isSingletonModuleType(type) && types.has(type)) {
      throw new ProfileModulesError(`Module type "${type}" can only appear once`);
    }
    types.add(type);

    modules.push({
      id,
      type,
      config: parseModuleConfig(type, rec.config),
    });
  }

  return { version: PROFILE_MODULE_VERSION, modules };
}

export function readStoredProfileModules(raw: unknown): ProfileModulesDocument | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.modules)) return null;
  return {
    version: PROFILE_MODULE_VERSION,
    modules: body.modules.filter(
      (row): row is ProfileModuleInstance =>
        Boolean(row) &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        typeof (row as ProfileModuleInstance).id === 'string' &&
        typeof (row as ProfileModuleInstance).type === 'string',
    ).map((row) => {
      const rec = row as ProfileModuleInstance;
      let config: Record<string, unknown> = {};
      try {
        config = parseModuleConfig(rec.type, rec.config);
      } catch {
        config = rec.type === 'favorite' ? { items: [] } : {};
      }
      return { id: rec.id, type: rec.type, config };
    }),
  };
}

export function collectFavoriteItems(document: ProfileModulesDocument | null): FavoriteItem[] {
  if (!document) return [];
  const items: FavoriteItem[] = [];
  for (const mod of document.modules) {
    if (mod.type !== 'favorite') continue;
    const raw = mod.config?.items;
    if (!Array.isArray(raw)) continue;
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue;
      const kind = (row as FavoriteItem).kind;
      const id = Number((row as FavoriteItem).id);
      if (!FAVORITE_ITEM_KINDS.includes(kind) || !Number.isInteger(id) || id <= 0) continue;
      items.push({ kind, id });
    }
  }
  return items;
}
