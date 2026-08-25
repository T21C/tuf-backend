import { logger } from '@/server/services/core/LoggerService.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';
import { invalidatePackLevelsCachesForLevelIds } from '@/server/services/packs/packDetailCacheService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { CDC_PASS_MAX_COALESCE_MS } from '@/server/services/elasticsearch/misc/constants.js';
import { syncClearerVoteWeightsForPairs } from '@/server/services/data/communityTagVoteService.js';
import * as Sentry from '@sentry/node';

export interface PassCdcDebouncePayload {
  passId?: number | null;
  levelIds?: Iterable<number>;
  playerId?: number | null;
  deletePassId?: number | null;
  tagVotePairs?: Iterable<{ playerId: number; levelId: number }>;
}

/**
 * Coalesces CDC pass-row effects until the `cdc:passes` stream consumer is idle
 * (no pending messages + handlers drained), then runs one bulk ES/cache update.
 */
class CdcPassProjectorDebounce {
  private passIds = new Set<number>();
  private levelIds = new Set<number>();
  private playerIds = new Set<number>();
  private deletePassIds = new Set<number>();
  private tagVotePairs = new Map<string, { playerId: number; levelId: number }>();
  private flushing = false;
  private flushAgain = false;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;

  schedule(payload: PassCdcDebouncePayload): void {
    if (payload.deletePassId != null && Number.isFinite(payload.deletePassId)) {
      this.deletePassIds.add(payload.deletePassId);
      this.passIds.delete(payload.deletePassId);
    }
    if (payload.passId != null && Number.isFinite(payload.passId)) {
      this.passIds.add(payload.passId);
    }
    if (payload.playerId != null && Number.isFinite(payload.playerId)) {
      this.playerIds.add(payload.playerId);
    }
    if (payload.levelIds) {
      for (const lid of payload.levelIds) {
        if (Number.isFinite(lid)) this.levelIds.add(lid);
      }
    }
    if (payload.tagVotePairs) {
      for (const pair of payload.tagVotePairs) {
        if (!Number.isFinite(pair.playerId) || !Number.isFinite(pair.levelId)) continue;
        this.tagVotePairs.set(`${pair.playerId}:${pair.levelId}`, pair);
      }
    }
    this.armSafetyTimer();
  }

  /** Invoked when `cdc:passes` XREADGROUP returns empty and slot handlers have settled. */
  async flushOnStreamIdle(): Promise<void> {
    if (!this.hasPendingWork()) return;
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    await this.flush();
  }

  private armSafetyTimer(): void {
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = setTimeout(() => {
      this.safetyTimer = null;
      if (!this.hasPendingWork()) return;
      logger.debug('[cdc-projectors] Pass coalesce safety flush (max wait elapsed)');
      void this.flushOnStreamIdle();
    }, CDC_PASS_MAX_COALESCE_MS);
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer) {
      clearTimeout(this.safetyTimer);
      this.safetyTimer = null;
    }
  }

  private hasPendingWork(): boolean {
    return (
      this.deletePassIds.size > 0 ||
      this.passIds.size > 0 ||
      this.levelIds.size > 0 ||
      this.playerIds.size > 0 ||
      this.tagVotePairs.size > 0
    );
  }

  private takeSnapshot(): {
    deletePassIds: number[];
    passIds: number[];
    levelIds: number[];
    playerIds: number[];
    tagVotePairs: Array<{ playerId: number; levelId: number }>;
  } {
    const snapshot = {
      deletePassIds: [...this.deletePassIds],
      passIds: [...this.passIds],
      levelIds: [...this.levelIds],
      playerIds: [...this.playerIds],
      tagVotePairs: [...this.tagVotePairs.values()],
    };
    this.deletePassIds.clear();
    this.passIds.clear();
    this.levelIds.clear();
    this.playerIds.clear();
    this.tagVotePairs.clear();
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

        const { deletePassIds, passIds, levelIds, playerIds, tagVotePairs } = this.takeSnapshot();
        const es = ElasticsearchService.getInstance();

        await Sentry.startSpan(
          {
            name: 'cdc.projector.passes.flush',
            op: 'queue.process',
            forceTransaction: true,
            attributes: {
              'cdc.pass_ids': passIds.length,
              'cdc.level_ids': levelIds.length,
              'cdc.player_ids': playerIds.length,
              'cdc.delete_ids': deletePassIds.length,
              'cdc.tag_vote_pairs': tagVotePairs.length,
            },
          },
          async () => {
            if (tagVotePairs.length > 0) {
              await syncClearerVoteWeightsForPairs(tagVotePairs);
            }

            for (const id of deletePassIds) {
              await es.deletePassDocumentById(id);
            }

            if (passIds.length > 0) {
              await es.reindexPasses(passIds);
            }
            if (levelIds.length > 0) {
              await es.reindexLevels(levelIds);
            }
            if (playerIds.length > 0) {
              await es.reindexPlayers(playerIds);
            }

            if (levelIds.length > 0) {
              const tags = ['levels:all', 'Passes', ...levelIds.map((id) => `level:${id}`)];
              await CacheInvalidation.invalidateTags(tags);
              await invalidatePackLevelsCachesForLevelIds(levelIds);
            }

            logger.debug(
              `[cdc-projectors] Coalesced pass flush: ${passIds.length} passes, ${levelIds.length} levels, ${playerIds.length} players, ${deletePassIds.length} deletes`,
            );
          },
        );
      } while (this.hasPendingWork());
    } catch (error) {
      logger.error('[cdc-projectors] Coalesced pass flush failed:', error);
    } finally {
      this.flushing = false;
      if (!this.hasPendingWork()) {
        this.clearSafetyTimer();
      } else if (this.flushAgain) {
        this.flushAgain = false;
        await this.flush();
      } else {
        this.armSafetyTimer();
      }
    }
  }
}

export const cdcPassProjectorDebounce = new CdcPassProjectorDebounce();
