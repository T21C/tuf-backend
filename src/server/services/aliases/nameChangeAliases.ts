/**
 * Re-exports rename/merge alias helpers from aliasAppend for route imports.
 * @deprecated Import from aliasAppend.js directly in new code.
 */
export {
  appendPlayerAliasFromRename,
  appendCreatorAliasFromRename,
  migratePlayerAliasesOnMerge,
  appendPlayerAliasSimple,
  appendCreatorAliasSimple,
} from '@/server/services/aliases/aliasAppend.js';
