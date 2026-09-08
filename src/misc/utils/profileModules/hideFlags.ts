import type { FavoriteItemKind } from './catalog.js';

/** Mirrors `LevelPackViewModes` without importing Sequelize models. */
const PACK_VIEW_LINKONLY = 2;
const PACK_VIEW_PRIVATE = 3;
const PACK_VIEW_FORCED_PRIVATE = 4;

export function isFavoritePassHidden(pass: {
  isDeleted?: boolean | null;
  isHidden?: boolean | null;
  level?: { isDeleted?: boolean | null; isHidden?: boolean | null } | null;
  player?: { isBanned?: boolean | null } | null;
} | null | undefined): boolean {
  if (!pass) return true;
  if (pass.isDeleted || pass.isHidden) return true;
  if (!pass.level || pass.level.isDeleted || pass.level.isHidden) return true;
  if (pass.player?.isBanned) return true;
  return false;
}

export function isFavoriteLevelHidden(level: {
  isDeleted?: boolean | null;
  isHidden?: boolean | null;
} | null | undefined): boolean {
  if (!level) return true;
  return Boolean(level.isDeleted || level.isHidden);
}

export function isFavoritePackHidden(pack: { viewMode?: number | null } | null | undefined): boolean {
  if (!pack) return true;
  const mode = Number(pack.viewMode);
  return (
    mode === PACK_VIEW_LINKONLY ||
    mode === PACK_VIEW_PRIVATE ||
    mode === PACK_VIEW_FORCED_PRIVATE
  );
}

export function isFavoritePlayerHidden(player: {
  isBanned?: boolean | null;
} | null | undefined): boolean {
  if (!player) return true;
  return Boolean(player.isBanned);
}

export function isFavoriteEntityHidden(
  kind: FavoriteItemKind,
  entity: Record<string, unknown> | null | undefined,
): boolean {
  if (!entity) return true;
  if (kind === 'pass') return isFavoritePassHidden(entity);
  if (kind === 'level') return isFavoriteLevelHidden(entity);
  if (kind === 'pack') return isFavoritePackHidden(entity);
  return isFavoritePlayerHidden(entity);
}
