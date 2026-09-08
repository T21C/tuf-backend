export const PROFILE_MODULE_VERSION = 1 as const;

export const PROFILE_MODULES_FREE_CAP = 10;
export const PROFILE_MODULES_STELLAR_CAP = 20;
export const MAX_FAVORITE_ITEMS = 20;
export const MAX_PROFILE_MODULE_ID_LENGTH = 64;

export const PROFILE_ENTITY_KINDS = ['player', 'creator'] as const;
export type ProfileEntityKind = (typeof PROFILE_ENTITY_KINDS)[number];

export const FAVORITE_ITEM_KINDS = ['pass', 'level', 'pack', 'player'] as const;
export type FavoriteItemKind = (typeof FAVORITE_ITEM_KINDS)[number];

export const PLAYER_STOCK_MODULE_TYPES = [
  'bio',
  'tournaments',
  'scoreBreakdown',
  'difficulty',
  'rankHistory',
  'scores',
] as const;

export const CREATOR_STOCK_MODULE_TYPES = [
  'bio',
  'tournaments',
  'difficulty',
  'charts',
] as const;

export const EXTRA_PROFILE_MODULE_TYPES = ['favorite'] as const;

export const PLAYER_MODULE_TYPES = [
  ...PLAYER_STOCK_MODULE_TYPES,
  ...EXTRA_PROFILE_MODULE_TYPES,
] as const;

export const CREATOR_MODULE_TYPES = [
  ...CREATOR_STOCK_MODULE_TYPES,
  ...EXTRA_PROFILE_MODULE_TYPES,
] as const;

export type PlayerModuleType = (typeof PLAYER_MODULE_TYPES)[number];
export type CreatorModuleType = (typeof CREATOR_MODULE_TYPES)[number];
export type ProfileModuleType = PlayerModuleType | CreatorModuleType;

const PLAYER_TYPE_SET = new Set<string>(PLAYER_MODULE_TYPES);
const CREATOR_TYPE_SET = new Set<string>(CREATOR_MODULE_TYPES);

export function moduleTypesForKind(kind: ProfileEntityKind): readonly string[] {
  return kind === 'player' ? PLAYER_MODULE_TYPES : CREATOR_MODULE_TYPES;
}

export function stockModuleTypesForKind(kind: ProfileEntityKind): readonly string[] {
  return kind === 'player' ? PLAYER_STOCK_MODULE_TYPES : CREATOR_STOCK_MODULE_TYPES;
}

export const PLAYER_REQUIRED_MODULE_TYPES = ['scores'] as const;
export const CREATOR_REQUIRED_MODULE_TYPES = ['charts'] as const;

export function requiredModuleTypesForKind(kind: ProfileEntityKind): readonly string[] {
  return kind === 'player' ? PLAYER_REQUIRED_MODULE_TYPES : CREATOR_REQUIRED_MODULE_TYPES;
}

export function isRequiredModuleType(kind: ProfileEntityKind, type: string): boolean {
  return (requiredModuleTypesForKind(kind) as readonly string[]).includes(type);
}

export function isModuleTypeForKind(kind: ProfileEntityKind, type: string): boolean {
  return kind === 'player' ? PLAYER_TYPE_SET.has(type) : CREATOR_TYPE_SET.has(type);
}

export function isSingletonModuleType(type: string): boolean {
  return type !== '';
}

export function profileModulesCap(stellarActive: boolean): number {
  return stellarActive ? PROFILE_MODULES_STELLAR_CAP : PROFILE_MODULES_FREE_CAP;
}

/** Fields mirrored onto the auth user, same idea as `tufStellarEnabled`. */
export function profileModulesAuthCaps(): {
  profileModulesFreeCap: number;
  profileModulesStellarCap: number;
  profileModulesMaxFavoriteItems: number;
} {
  return {
    profileModulesFreeCap: PROFILE_MODULES_FREE_CAP,
    profileModulesStellarCap: PROFILE_MODULES_STELLAR_CAP,
    profileModulesMaxFavoriteItems: MAX_FAVORITE_ITEMS,
  };
}

export function stockModuleId(type: string): string {
  return `stock-${type}`;
}
