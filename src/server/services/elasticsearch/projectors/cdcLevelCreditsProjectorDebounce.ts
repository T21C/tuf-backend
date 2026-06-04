import { logger } from '@/server/services/core/LoggerService.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { invalidatePackLevelsCachesForLevelIds } from '@/server/services/packs/packDetailCacheService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { CDC_LEVEL_CREDITS_COALESCE_MS } from '@/server/services/elasticsearch/misc/constants.js';

export interface LevelCreditsCdcDebouncePayload {
  levelId?: number | null;
  creatorId?: number | null;
}

/**
 * Coalesces `level_credits` CDC effects over a short fixed window, then runs a
 * single bulk level reindex + bulk creator reindex (plus one cache flush).
 *
 * A level credit edit destroys + recreates every credit row, emitting one CDC
 * event each. Handled naively that fans out into one `indexLevel` and one
 * single-id `reindexCreators` per row. Batching collapses that burst into one
 * pass per affected level and one bulk pass over all touched creators.
 */
class CdcLevelCreditsProjectorDebounce {
  private levelIds = new Set<number>();
  private creatorIds = new Set<number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private flushAgain = false;

  schedule(payload: LevelCreditsCdcDebouncePayload): void {
    if (payload.levelId != null && Number.isFinite(payload.levelId)) {
      this.levelIds.add(payload.levelId);
    }
    if (payload.creatorId != null && Number.isFinite(payload.creatorId)) {
      this.creatorIds.add(payload.creatorId);
    }
    this.arm();
  }

  // Fixed-window coalescing: arm only when idle so a burst flushes at most
  // CDC_LEVEL_CREDITS_COALESCE_MS after its first event (bounded latency),
  // instead of resetting the timer on every event.
  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, CDC_LEVEL_CREDITS_COALESCE_MS);
  }

  private hasPendingWork(): boolean {
    return this.levelIds.size > 0 || this.creatorIds.size > 0;
  }

  private takeSnapshot(): { levelIds: number[]; creatorIds: number[] } {
    const snapshot = {
      levelIds: [...this.levelIds],
      creatorIds: [...this.creatorIds],
    };
    this.levelIds.clear();
    this.creatorIds.clear();
    return snapshot;
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    this.flushAgain = false;
    try {
      do {
        if (!this.hasPendingWork()) break;

        const { levelIds, creatorIds } = this.takeSnapshot();
        const es = ElasticsearchService.getInstance();

        if (levelIds.length > 0) {
          await es.reindexLevels(levelIds);
        }
        if (creatorIds.length > 0) {
          await es.reindexCreators(creatorIds);
        }

        if (levelIds.length > 0) {
          const tags = ['levels:all', ...levelIds.map((id) => `level:${id}`)];
          await CacheInvalidation.invalidateTags(tags);
          await invalidatePackLevelsCachesForLevelIds(levelIds);
        }

        logger.debug(
          `[cdc-projectors] Coalesced level_credits flush: ${levelIds.length} levels, ${creatorIds.length} creators`,
        );
      } while (this.hasPendingWork());
    } catch (error) {
      logger.error('[cdc-projectors] Coalesced level_credits flush failed:', error);
    } finally {
      this.flushing = false;
      if (this.flushAgain) {
        this.flushAgain = false;
        await this.flush();
      } else if (this.hasPendingWork()) {
        this.arm();
      }
    }
  }
}

export const cdcLevelCreditsProjectorDebounce = new CdcLevelCreditsProjectorDebounce();
