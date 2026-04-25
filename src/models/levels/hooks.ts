import Level from './Level.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { getFileIdFromCdnUrl, isCdnUrl } from '@/misc/utils/Utility.js';

/**
 * Derive the indexed CDN `fileId` from a `dlLink` value.
 * Mirrors `getFileIdFromCdnUrl` semantics: only returns a value for a CDN URL
 * containing exactly one UUID; otherwise `null` (including `'removed'`).
 */
const deriveFileIdFromDlLink = (dlLink: unknown): string | null => {
  if (typeof dlLink !== 'string' || dlLink === '' || dlLink === 'removed') {
    return null;
  }
  if (!isCdnUrl(dlLink)) return null;
  return getFileIdFromCdnUrl(dlLink);
};

/**
 * Keep `fileId` in sync with `dlLink` on every write path so readers can hit
 * the indexed column instead of parsing the URL at runtime.
 *
 * Cache invalidation and Elasticsearch indexing are handled by CDC projectors
 * (`startCdcProjectors`) consuming MySQL binlog events.
 */
export function initializeLevelCacheHooks(): void {
  Level.addHook('beforeSave', 'syncFileIdFromDlLink', (level: Level) => {
    if (level.isNewRecord || level.changed('dlLink')) {
      level.fileId = deriveFileIdFromDlLink(level.dlLink);
    }
  });

  Level.addHook('beforeBulkCreate', 'syncFileIdFromDlLinkBulk', (instances: Level[]) => {
    for (const inst of instances) {
      if (inst.dlLink !== undefined) {
        inst.fileId = deriveFileIdFromDlLink(inst.dlLink);
      }
    }
  });

  Level.addHook('beforeBulkUpdate', 'syncFileIdFromDlLinkBulkUpdate', (options: any) => {
    const attrs = options?.attributes;
    if (!attrs) return;
    if (!Object.prototype.hasOwnProperty.call(attrs, 'dlLink')) return;
    if (attrs.dlLink === undefined) return; // Sequelize skips undefined; don't shadow-update fileId.
    attrs.fileId = deriveFileIdFromDlLink(attrs.dlLink);
    if (Array.isArray(options.fields) && !options.fields.includes('fileId')) {
      options.fields.push('fileId');
    }
  });

  logger.info('Level write hooks initialized (fileId sync only; CDC handles cache/ES)');
}
