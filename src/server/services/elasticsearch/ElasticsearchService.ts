import client, {
  levelIndexName,
  passIndexName,
  playerIndexName,
  creatorIndexName,
  modIndexName,
  tournamentIndexName,
  initializeElasticsearch,
  updateMappingHash
} from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { ILevel, IPass } from '@/server/interfaces/models/index.js';
import { Op } from 'sequelize';
import Level from '@/models/levels/Level.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Pass from '@/models/passes/Pass.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import Mod from '@/models/misc/Mod.js';
import ModAssignee from '@/models/misc/ModAssignee.js';
import Tournament from '@/models/tournaments/Tournament.js';
import { searchLevels as runLevelSearch, searchLevelIds as runSearchLevelIds } from './search/levels/levelSearch.js';
import { searchPasses as runPassSearch } from './search/passes/passSearch.js';
import { searchPlayers as runPlayerSearch, PlayerSearchOptions, PlayerSearchResult } from './search/players/playerSearch.js';
import { searchCreators as runCreatorSearch, hydrateCreatorUsers, CreatorSearchOptions, CreatorSearchResult } from './search/creators/creatorSearch.js';
import { searchMods as runModSearch, type ModSearchOptions, type ModSearchResult } from './search/mods/modSearch.js';
import { searchTournaments as runTournamentSearch, type TournamentSearchOptions, type TournamentSearchResult } from './search/tournaments/tournamentSearch.js';
import { ARTIST_REINDEX_DEBOUNCE_MS, BATCH_SIZE, FULL_REINDEX_PAGE_SIZE, MAX_BATCH_SIZE } from './misc/constants.js';
import { fetchLevelWithRelations, fetchLevelsForBulkIndex, clearEsIndexRelationCaches } from './fetching/levelFetch.js';
import { fetchPassWithRelations, fetchPassesForBulkIndex, clearEsPassIndexRelationCaches, invalidateEsLevelCacheForLevelIds } from './fetching/passFetch.js';
import { fetchPlayersForBulkIndex } from './fetching/playerFetch.js';
import { fetchCreatorsForBulkIndex } from './fetching/creatorFetch.js';
import { fetchModsForBulkIndex } from './fetching/modFetch.js';
import { fetchTournamentsForBulkIndex } from './fetching/tournamentFetch.js';
import { buildLevelIndexDocument } from './indexing/levelIndexDocument.js';
import { buildPassIndexDocument } from './indexing/passIndexDocument.js';
import { decodePuaDeep } from '@/misc/utils/data/searchHelpers.js';
import { maskStellarPublicEsDoc, maskStellarPublicEsHits } from '@/misc/utils/subscriptions/tufStellarPublicGate.js';

class ElasticsearchService {
  private static instance: ElasticsearchService;
  private isInitialized = false;

  // Debounce queue for artist-related reindexing
  private artistReindexQueue: Set<number> = new Set();
  private artistReindexTimer: NodeJS.Timeout | null = null;

  private constructor() {}

  public static getInstance(): ElasticsearchService {
    if (!ElasticsearchService.instance) {
      ElasticsearchService.instance = new ElasticsearchService();
    }
    return ElasticsearchService.instance;
  }

  private isBeingInitialized = false;
  public async initialize(): Promise<void> {
    if (this.isInitialized || this.isBeingInitialized) {
      logger.info(`ElasticsearchService ${this.isInitialized ? 'already' : 'is being'} initialized`);
      return;
    }
    this.isBeingInitialized = true;
    try {
      logger.info('Starting ElasticsearchService initialization...');

      // Initialize Elasticsearch indices
      const { reindexedLevels, reindexedPasses, reindexedPlayers, reindexedCreators, reindexedMods, reindexedTournaments } = await initializeElasticsearch();

      if (reindexedLevels || reindexedPasses || reindexedPlayers || reindexedCreators || reindexedMods || reindexedTournaments) {
        if (reindexedLevels) logger.info('Reindexing levels...');
        if (reindexedPasses) logger.info('Reindexing passes...');
        if (reindexedPlayers) logger.info('Reindexing players...');
        if (reindexedCreators) logger.info('Reindexing creators...');
        if (reindexedMods) logger.info('Reindexing mods...');
        if (reindexedTournaments) logger.info('Reindexing tournaments...');
        const start = Date.now();
        if (reindexedLevels) {
          await this.reindexLevels();
        }
        if (reindexedPasses) {
          await this.reindexPasses();
        }
        if (reindexedPlayers) {
          await this.reindexAllPlayers();
        }
        if (reindexedCreators) {
          await this.reindexAllCreators();
        }
        if (reindexedMods) {
          await this.reindexAllMods();
        }
        if (reindexedTournaments) {
          await this.reindexAllTournaments();
        }
        const end = Date.now();
        logger.info(`Data reindexing completed successfully in ${Math.round((end - start)/100)/10}s`);
        await updateMappingHash({ reindexedLevels, reindexedPasses, reindexedPlayers, reindexedCreators, reindexedMods, reindexedTournaments });
      }

      this.isInitialized = true;
      logger.info('ElasticsearchService initialized successfully');
    } catch (error) {
      logger.error('Error initializing ElasticsearchService:', error);
      this.isInitialized = false;
      throw error;
    }
    this.isBeingInitialized = false;
  }

  public async updatePlayerPasses(playerId: number): Promise<void> {
    const passRows = await Pass.findAll({
      where: {
        playerId,
        isDeleted: false,
        isHidden: false,
      },
      attributes: ['id'],
      raw: true,
    });
    const passIds = passRows.map((r: { id: number }) => r.id);
    if (passIds.length === 0) return;

    for (let i = 0; i < passIds.length; i += MAX_BATCH_SIZE) {
      const chunk = passIds.slice(i, i + MAX_BATCH_SIZE);
      const passes = await fetchPassesForBulkIndex(chunk);
      if (passes.length > 0) {
        await this.bulkIndexPasses(passes);
      }
    }
  }

  /**
   * Schedule debounced reindexing for artist-related changes
   * This prevents overwhelming the server when artists have thousands of levels
   */
  /**
   * Debounced fan-out reindex for levels affected by artist / artist_alias metadata changes.
   * Used by CDC projectors (replaces Sequelize hooks).
   */
  public scheduleDebouncedArtistReindex(levelIds: number[]): void {
    this.scheduleArtistReindex(levelIds);
  }

  private scheduleArtistReindex(levelIds: number[]): void {
    // Add level IDs to the queue
    levelIds.forEach(id => this.artistReindexQueue.add(id));
    const queueSize = this.artistReindexQueue.size;

    // Clear existing timer if it exists
    if (this.artistReindexTimer) {
      clearTimeout(this.artistReindexTimer);
      this.artistReindexTimer = null;
    }

    // Set new timer
    this.artistReindexTimer = setTimeout(async () => {
      const idsToReindex = Array.from(this.artistReindexQueue);
      this.artistReindexQueue.clear();
      this.artistReindexTimer = null;

      if (idsToReindex.length > 0) {
        logger.debug(`Debounced artist reindex: Processing ${idsToReindex.length} levels`);
        try {
          await this.reindexLevels(idsToReindex);
          logger.debug(`Debounced artist reindex: Completed ${idsToReindex.length} levels`);
        } catch (error) {
          logger.error('Error in debounced artist reindex:', error);
        }
      }
    }, ARTIST_REINDEX_DEBOUNCE_MS);

    logger.debug(`Scheduled debounced reindex for ${levelIds.length} levels (${queueSize} total queued)`);
  }

  private async getParsedLevel(id: number): Promise<ILevel | null> {
    const level = await fetchLevelWithRelations(id);
    if (!level) return null;
    const processedLevel = buildLevelIndexDocument(level);
    return processedLevel as ILevel;
  }

  private async getParsedPass(id: number): Promise<IPass | null> {
    const pass = await fetchPassWithRelations(id);
    if (!pass) return null;
    return buildPassIndexDocument(pass) as IPass;
  }

  public async indexLevel(level: Level | number): Promise<void> {
    const id = typeof level === 'number' ? level
    : typeof level === 'string' ? parseInt(level)
    : level.id;
    try {
      invalidateEsLevelCacheForLevelIds([id]);
      const processedLevel = await this.getParsedLevel(id);
      if (processedLevel) {
        await client.index({
          index: levelIndexName,
          id: id.toString(),
          document: processedLevel,
          refresh: true // Force refresh to make the document immediately searchable
        });
      }
    } catch (error) {
      logger.error(`Error indexing level ${id}:`, error);
      throw error;
    }
  }

  public async reindexByCreatorId(creatorId: number): Promise<void> {
    const levels = await Level.findAll({
      include: [
        {
          model: LevelCredit,
          as: 'levelCredits',
          where: {creatorId},
        },
      ],
    });
    await this.reindexLevels(levels.map(level => level.id));
  }

  public async bulkIndexLevels(levels: Level[]): Promise<void> {
    try {
      const totalBatches = Math.ceil(levels.length / BATCH_SIZE);
      for (let i = 0; i < levels.length; i += BATCH_SIZE) {
        const batch = levels.slice(i, i + BATCH_SIZE);

        const operations = batch.flatMap((level) => {
          //if (i == 0) logger.debug(`sample input level:`, level);
          const processedLevel = buildLevelIndexDocument(level);
          //if (i == 0) logger.debug(`sample processed level:`, processedLevel);
          return [
            { index: { _index: levelIndexName, _id: level.id.toString() } },
            processedLevel
          ];
        });

        if (operations.length > 0) {
          await client.bulk({
            operations,
            refresh: false // Don't refresh after each batch for better performance
          });
        }
      }
      logger.debug(`Successfully indexed ${levels.length} levels in ${totalBatches} batches`);
    } catch (error) {
      logger.error('Error bulk indexing levels:', error);
      throw error;
    }
  }

  public async deleteLevel(level: Level): Promise<void> {
    try {
      await client.delete({
        index: levelIndexName,
        id: level.id.toString()
      });
    } catch (error) {
      logger.error(`Error deleting level ${level.id} from index:`, error);
      throw error;
    }
  }

  public async indexPass(pass: Pass | number): Promise<void> {
    const id =
      typeof pass === 'number'
        ? pass
        : pass != null && typeof pass === 'object' && 'id' in pass
          ? (pass as Pass).id
          : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      logger.warn('indexPass skipped: invalid pass id', { pass });
      return;
    }
    try {
      const passMeta = await Pass.findByPk(id, { attributes: ['levelId'] });
      if (passMeta?.levelId) {
        invalidateEsLevelCacheForLevelIds([passMeta.levelId]);
      }
      const loaded = await fetchPassWithRelations(id);
      if (!loaded) {
        logger.error(`Pass ${id} not found`);
        return;
      }
      logger.debug(`Indexing pass ${id}`);
      const processedPass =
        loaded.player && loaded.level && loaded.judgements
          ? buildPassIndexDocument(loaded)
          : await this.getParsedPass(id);

      if (!processedPass) {
        logger.error(`Pass ${id} not found`);
        return;
      }

      await client.index({
        index: passIndexName,
        id: loaded.id.toString(),
        document: processedPass,
        refresh: true,
      });
      logger.debug(`Successfully indexed pass ${loaded.id}`);
    } catch (error) {
      logger.error(`Error indexing pass ${id}:`, error);
      throw error;
    }
  }

  public async bulkIndexPasses(passes: any[]): Promise<void> {
    try {
      const totalBatches = Math.ceil(passes.length / BATCH_SIZE);

      for (let i = 0; i < passes.length; i += BATCH_SIZE) {
        const batch = passes.slice(i, i + BATCH_SIZE);
        const operations = batch.flatMap(pass => {
          const processedPass = buildPassIndexDocument(pass);
          return [
            { index: { _index: passIndexName, _id: pass.id.toString() } },
            processedPass
          ];
        });

        if (operations.length > 0) {
          await client.bulk({ operations });
        }
      }
      logger.debug(`Successfully indexed ${passes.length} passes in ${totalBatches} batches`);
    } catch (error) {
      logger.error('Error bulk indexing passes:', error);
      throw error;
    }
  }

  public async deletePass(pass: Pass): Promise<void> {
    await this.deletePassDocumentById(pass.id);
  }

  /**
   * Remove a pass document from the passes index (e.g. after destroy or DB CASCADE where hooks do not run).
   */
  public async deletePassDocumentById(passId: number): Promise<void> {
    try {
      await client.delete({
        index: passIndexName,
        id: passId.toString(),
      });
    } catch (error: unknown) {
      const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
      if (status === 404) {
        return;
      }
      logger.error(`Error deleting pass ${passId} from index:`, error);
      throw error;
    }
  }

  /**
   * Bulk-delete pass documents (used when many passes are removed without per-row Sequelize hooks).
   */
  public async bulkDeletePassDocumentsFromIndex(passIds: number[]): Promise<void> {
    if (passIds.length === 0) return;
    try {
      for (let i = 0; i < passIds.length; i += BATCH_SIZE) {
        const batch = passIds.slice(i, i + BATCH_SIZE);
        const operations = batch.flatMap((id) => [
          { delete: { _index: passIndexName, _id: String(id) } },
        ]);
        if (operations.length > 0) {
          await client.bulk({ operations, refresh: false });
        }
      }
      logger.debug(`Removed ${passIds.length} pass documents from Elasticsearch`);
    } catch (error) {
      logger.error('Error bulk deleting passes from index:', error);
      throw error;
    }
  }

  public async reindexLevels(levelIds?: number[]): Promise<void> {
    try {
      let processedCount = 0;
      clearEsIndexRelationCaches();

      if (levelIds !== undefined && levelIds.length > 0) {
        const sortedUnique = [...new Set(levelIds)].sort((a, b) => a - b);
        for (let i = 0; i < sortedUnique.length; i += MAX_BATCH_SIZE) {
          const chunk = sortedUnique.slice(i, i + MAX_BATCH_SIZE);
          const levels = await fetchLevelsForBulkIndex(chunk);
          if (levels.length > 0) {
            await this.bulkIndexLevels(levels);
            processedCount += levels.length;
            logger.debug(`Reindexed ${processedCount} levels...`);
          }
        }
      } else {
        let afterId = 0;
        while (true) {
          const idRows = await Level.findAll({
            where: { id: { [Op.gt]: afterId } },
            attributes: ['id'],
            order: [['id', 'ASC']],
            limit: FULL_REINDEX_PAGE_SIZE,
            raw: true,
          });
          const idList = idRows.map((r: { id: number }) => r.id);
          if (idList.length === 0) break;

          const levels = await fetchLevelsForBulkIndex(idList);
          await this.bulkIndexLevels(levels);
          processedCount += levels.length;
          logger.debug(`Reindexed ${processedCount} levels...`);

          afterId = idList[idList.length - 1];
          if (idList.length < FULL_REINDEX_PAGE_SIZE) break;
        }
      }

      logger.debug(`Reindexing complete. Total levels indexed: ${processedCount}`);
    } catch (error) {
      logger.error('Error reindexing levels:', error);
      throw error;
    }
  }


  public async reindexPasses(passIds?: number[]): Promise<void> {
    try {
      let processedCount = 0;

      if (passIds !== undefined && passIds.length > 0) {
        const sortedUnique = [...new Set(passIds)].sort((a, b) => a - b);
        const passLevelRows = await Pass.findAll({
          where: { id: { [Op.in]: sortedUnique } },
          attributes: ['levelId'],
          raw: true,
        });
        invalidateEsLevelCacheForLevelIds(
          (passLevelRows as { levelId: number }[]).map((r) => r.levelId),
        );
        for (let i = 0; i < sortedUnique.length; i += MAX_BATCH_SIZE) {
          const chunk = sortedUnique.slice(i, i + MAX_BATCH_SIZE);
          const passes = await fetchPassesForBulkIndex(chunk);
          if (passes.length > 0) {
            await this.bulkIndexPasses(passes);
            processedCount += passes.length;
            logger.debug(`Reindexed ${processedCount} passes...`);
          }
        }
      } else {
        clearEsPassIndexRelationCaches();
        let afterId = 0;
        while (true) {
          const idRows = await Pass.findAll({
            where: { id: { [Op.gt]: afterId } },
            attributes: ['id'],
            order: [['id', 'ASC']],
            limit: FULL_REINDEX_PAGE_SIZE,
            raw: true,
          });
          const idList = idRows.map((r: { id: number }) => r.id);
          if (idList.length === 0) break;

          const passes = await fetchPassesForBulkIndex(idList);
          await this.bulkIndexPasses(passes);
          processedCount += passes.length;
          logger.debug(`Reindexed ${processedCount} passes...`);

          afterId = idList[idList.length - 1];
          if (idList.length < FULL_REINDEX_PAGE_SIZE) break;
        }
      }

      logger.debug(`Reindexing complete. Total passes indexed: ${processedCount}`);
    } catch (error) {
      logger.error('Error reindexing passes:', error);
      throw error;
    }
  }

  public async searchLevels(query: string, filters: any = {}, isSuperAdmin = false): Promise<{ hits: any[], total: number }> {
    return runLevelSearch(query, filters, isSuperAdmin);
  }

  public async searchLevelIds(query: string, filters: any = {}, isSuperAdmin = false): Promise<number[]> {
    return runSearchLevelIds(query, filters, isSuperAdmin);
  }

  public async searchPasses(query: string, filters: any = {}, userPlayerId?: number, isSuperAdmin = false): Promise<{ hits: any[], total: number }> {
    return runPassSearch(query, filters, userPlayerId, isSuperAdmin);
  }

  /**
   * Index or upsert a single player document.
   */
  public async indexPlayer(playerId: number): Promise<void> {
    if (!Number.isFinite(playerId) || playerId <= 0) {
      logger.warn(`indexPlayer skipped: invalid id ${playerId}`);
      return;
    }
    try {
      const docs = await fetchPlayersForBulkIndex([playerId]);
      const prepared = docs[0];
      if (!prepared) {
        logger.warn(`indexPlayer: player ${playerId} not found in DB — removing from index if present`);
        await this.deletePlayerDocumentById(playerId).catch(() => {});
        return;
      }
      await client.index({
        index: playerIndexName,
        id: prepared.id.toString(),
        document: prepared.document,
        refresh: true,
      });
      logger.debug(`Successfully indexed player ${prepared.id}`);
    } catch (error) {
      logger.error(`Error indexing player ${playerId}:`, error);
      throw error;
    }
  }

  /**
   * Reindex a specific set of players in bulk. Recomputes their stats from
   * `player_pass_summary`, rebuilds documents, and writes them to the players index.
   */
  public async reindexPlayers(playerIds: number[]): Promise<void> {
    if (!playerIds || playerIds.length === 0) return;
    try {
      const uniqueIds = [...new Set(playerIds)].filter((id) => Number.isFinite(id) && id > 0);
      if (uniqueIds.length === 0) return;

      let processedCount = 0;
      for (let i = 0; i < uniqueIds.length; i += MAX_BATCH_SIZE) {
        const chunk = uniqueIds.slice(i, i + MAX_BATCH_SIZE);
        const docs = await fetchPlayersForBulkIndex(chunk);
        if (docs.length === 0) continue;

        for (let j = 0; j < docs.length; j += BATCH_SIZE) {
          const batch = docs.slice(j, j + BATCH_SIZE);
          const operations = batch.flatMap((doc) => [
            { index: { _index: playerIndexName, _id: doc.id.toString() } },
            doc.document,
          ]);
          if (operations.length > 0) {
            await client.bulk({ operations, refresh: false });
          }
        }
        processedCount += docs.length;
      }
      logger.debug(`Reindexed ${processedCount} players (requested ${uniqueIds.length})`);
    } catch (error) {
      logger.error('Error reindexing players:', error);
      throw error;
    }
  }

  /**
   * Remove a player document from the players index. Safe to call when the doc doesn't exist.
   */
  public async deletePlayerDocumentById(playerId: number): Promise<void> {
    try {
      await client.delete({
        index: playerIndexName,
        id: playerId.toString(),
      });
    } catch (error: unknown) {
      const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
      if (status === 404) return;
      logger.error(`Error deleting player ${playerId} from index:`, error);
      throw error;
    }
  }

  /**
   * Reindex every player currently in the database (chunked bulk). Called on boot only when
   * the players index is freshly created or its mapping changed.
   */
  public async reindexAllPlayers(): Promise<void> {
    try {
      let processedCount = 0;
      let afterId = 0;
      while (true) {
        const idRows = await Player.findAll({
          where: { id: { [Op.gt]: afterId } },
          attributes: ['id'],
          order: [['id', 'ASC']],
          limit: FULL_REINDEX_PAGE_SIZE,
          raw: true,
        });
        const idList = idRows.map((r: { id: number }) => r.id);
        if (idList.length === 0) break;

        const docs = await fetchPlayersForBulkIndex(idList);
        for (let j = 0; j < docs.length; j += BATCH_SIZE) {
          const batch = docs.slice(j, j + BATCH_SIZE);
          const operations = batch.flatMap((doc) => [
            { index: { _index: playerIndexName, _id: doc.id.toString() } },
            doc.document,
          ]);
          if (operations.length > 0) {
            await client.bulk({ operations, refresh: false });
          }
        }
        processedCount += docs.length;
        logger.debug(`Reindexed ${processedCount} players...`);

        afterId = idList[idList.length - 1];
        if (idList.length < FULL_REINDEX_PAGE_SIZE) break;
      }
      logger.info(`Player reindexing complete. Total indexed: ${processedCount}`);
    } catch (error) {
      logger.error('Error reindexing all players:', error);
      throw error;
    }
  }

  public async searchPlayers(options: PlayerSearchOptions): Promise<PlayerSearchResult> {
    const r = await runPlayerSearch(options);
    return { ...r, hits: maskStellarPublicEsHits(r.hits) };
  }

  /**
   * Fetch a single player document by id from Elasticsearch. Returns null when missing.
   */
  public async getPlayerDocumentById(playerId: number): Promise<any | null> {
    try {
      const response = await client.get({
        index: playerIndexName,
        id: playerId.toString(),
      });
      const src = (response as any)._source ?? null;
      return maskStellarPublicEsDoc(src);
    } catch (error: unknown) {
      const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
      if (status === 404) return null;
      logger.error(`Error fetching player ${playerId} from index:`, error);
      throw error;
    }
  }

  /**
   * Fetch a single level document by id from Elasticsearch. Returns null when missing.
   */
  public async getLevelDocumentById(levelId: number): Promise<any | null> {
    try {
      const response = await client.get({
        index: levelIndexName,
        id: levelId.toString(),
      });
      const src = (response as any)._source ?? null;
      // ES level docs are stored with certain text fields encoded into PUA for search;
      // decode for API consumers so they see original characters.
      return src ? decodePuaDeep(src) : null;
    } catch (error: unknown) {
      const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
      if (status === 404) return null;
      logger.error(`Error fetching level ${levelId} from index:`, error);
      throw error;
    }
  }

  /**
   * Index or upsert a single creator document.
   */
  public async indexCreator(creatorId: number): Promise<void> {
    if (!Number.isFinite(creatorId) || creatorId <= 0) {
      logger.warn(`indexCreator skipped: invalid id ${creatorId}`);
      return;
    }
    try {
      const docs = await fetchCreatorsForBulkIndex([creatorId]);
      const prepared = docs[0];
      if (!prepared) {
        logger.warn(`indexCreator: creator ${creatorId} not found in DB — removing from index if present`);
        await this.deleteCreatorDocumentById(creatorId).catch(() => {});
        return;
      }
      await client.index({
        index: creatorIndexName,
        id: prepared.id.toString(),
        document: prepared.document,
        refresh: true,
      });
      logger.debug(`Successfully indexed creator ${prepared.id}`);
    } catch (error) {
      logger.error(`Error indexing creator ${creatorId}:`, error);
      throw error;
    }
  }

  /**
   * Reindex a specific set of creators in bulk. Recomputes their stats from
   * `level_credits + levels`, rebuilds documents, and writes them to the creators index.
   */
  public async reindexCreators(creatorIds: number[]): Promise<void> {
    if (!creatorIds || creatorIds.length === 0) return;
    try {
      const uniqueIds = [...new Set(creatorIds)].filter((id) => Number.isFinite(id) && id > 0);
      if (uniqueIds.length === 0) return;

      let processedCount = 0;
      for (let i = 0; i < uniqueIds.length; i += MAX_BATCH_SIZE) {
        const chunk = uniqueIds.slice(i, i + MAX_BATCH_SIZE);
        const docs = await fetchCreatorsForBulkIndex(chunk);
        if (docs.length === 0) continue;

        for (let j = 0; j < docs.length; j += BATCH_SIZE) {
          const batch = docs.slice(j, j + BATCH_SIZE);
          const operations = batch.flatMap((doc) => [
            { index: { _index: creatorIndexName, _id: doc.id.toString() } },
            doc.document,
          ]);
          if (operations.length > 0) {
            await client.bulk({ operations, refresh: false });
          }
        }
        processedCount += docs.length;
      }
      logger.debug(`Reindexed ${processedCount} creators (requested ${uniqueIds.length})`);
    } catch (error) {
      logger.error('Error reindexing creators:', error);
      throw error;
    }
  }

  /**
   * Remove a creator document from the creators index. Safe to call when the doc doesn't exist.
   */
  public async deleteCreatorDocumentById(creatorId: number): Promise<void> {
    try {
      await client.delete({
        index: creatorIndexName,
        id: creatorId.toString(),
      });
    } catch (error: unknown) {
      const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
      if (status === 404) return;
      logger.error(`Error deleting creator ${creatorId} from index:`, error);
      throw error;
    }
  }

  /**
   * Reindex every creator currently in the database (chunked bulk). Called on boot only when
   * the creators index is freshly created or its mapping changed.
   */
  public async reindexAllCreators(): Promise<void> {
    try {
      let processedCount = 0;
      let afterId = 0;
      while (true) {
        const idRows = await Creator.findAll({
          where: { id: { [Op.gt]: afterId } },
          attributes: ['id'],
          order: [['id', 'ASC']],
          limit: FULL_REINDEX_PAGE_SIZE,
          raw: true,
        });
        const idList = idRows.map((r: { id: number }) => r.id);
        if (idList.length === 0) break;

        const docs = await fetchCreatorsForBulkIndex(idList);
        for (let j = 0; j < docs.length; j += BATCH_SIZE) {
          const batch = docs.slice(j, j + BATCH_SIZE);
          const operations = batch.flatMap((doc) => [
            { index: { _index: creatorIndexName, _id: doc.id.toString() } },
            doc.document,
          ]);
          if (operations.length > 0) {
            await client.bulk({ operations, refresh: false });
          }
        }
        processedCount += docs.length;
        logger.debug(`Reindexed ${processedCount} creators...`);

        afterId = idList[idList.length - 1];
        if (idList.length < FULL_REINDEX_PAGE_SIZE) break;
      }
      logger.info(`Creator reindexing complete. Total indexed: ${processedCount}`);
    } catch (error) {
      logger.error('Error reindexing all creators:', error);
      throw error;
    }
  }

  public async searchCreators(options: CreatorSearchOptions): Promise<CreatorSearchResult> {
    const r = await runCreatorSearch(options);
    return { ...r, hits: maskStellarPublicEsHits(r.hits) };
  }

  /**
   * Fetch a single creator document by id from Elasticsearch. Returns null when missing.
   */
  public async getCreatorDocumentById(creatorId: number): Promise<any | null> {
    try {
      const response = await client.get({
        index: creatorIndexName,
        id: creatorId.toString(),
      });
      const source = (response as any)._source ?? null;
      if (!source) return null;
      const [hydrated] = await hydrateCreatorUsers([source]);
      return maskStellarPublicEsDoc(hydrated);
    } catch (error: unknown) {
      const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
      if (status === 404) return null;
      logger.error(`Error fetching creator ${creatorId} from index:`, error);
      throw error;
    }
  }

  public async indexMod(modId: number): Promise<void> {
    if (!Number.isFinite(modId) || modId <= 0) {
      logger.warn(`indexMod skipped: invalid id ${modId}`);
      return;
    }
    try {
      const docs = await fetchModsForBulkIndex([modId]);
      const prepared = docs[0];
      if (!prepared) {
        logger.warn(`indexMod: mod ${modId} not found in DB — removing from index if present`);
        await this.deleteMod(modId).catch(() => {});
        return;
      }
      await client.index({
        index: modIndexName,
        id: prepared.id.toString(),
        document: prepared.document,
        refresh: true,
      });
    } catch (error) {
      logger.error(`Error indexing mod ${modId}:`, error);
      throw error;
    }
  }

  public async reindexMods(modIds: number[]): Promise<void> {
    if (!modIds || modIds.length === 0) return;
    try {
      const uniqueIds = [...new Set(modIds)].filter((id) => Number.isFinite(id) && id > 0);
      if (uniqueIds.length === 0) return;

      let processedCount = 0;
      for (let i = 0; i < uniqueIds.length; i += MAX_BATCH_SIZE) {
        const chunk = uniqueIds.slice(i, i + MAX_BATCH_SIZE);
        const docs = await fetchModsForBulkIndex(chunk);
        if (docs.length === 0) continue;

        for (let j = 0; j < docs.length; j += BATCH_SIZE) {
          const batch = docs.slice(j, j + BATCH_SIZE);
          const operations = batch.flatMap((doc) => [
            { index: { _index: modIndexName, _id: doc.id.toString() } },
            doc.document,
          ]);
          if (operations.length > 0) {
            await client.bulk({ operations, refresh: false });
          }
        }
        processedCount += docs.length;
      }
      logger.debug(`Reindexed ${processedCount} mods (requested ${uniqueIds.length})`);
    } catch (error) {
      logger.error('Error reindexing mods:', error);
      throw error;
    }
  }

  public async deleteMod(modId: number): Promise<void> {
    try {
      await client.delete({
        index: modIndexName,
        id: modId.toString(),
      });
    } catch (error: unknown) {
      const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
      if (status === 404) return;
      logger.error(`Error deleting mod ${modId} from index:`, error);
      throw error;
    }
  }

  public async reindexAllMods(): Promise<void> {
    try {
      let processedCount = 0;
      let afterId = 0;
      while (true) {
        const idRows = await Mod.findAll({
          where: { id: { [Op.gt]: afterId } },
          attributes: ['id'],
          order: [['id', 'ASC']],
          limit: FULL_REINDEX_PAGE_SIZE,
          raw: true,
        });
        const idList = idRows.map((r: { id: number }) => r.id);
        if (idList.length === 0) break;

        const docs = await fetchModsForBulkIndex(idList);
        for (let j = 0; j < docs.length; j += BATCH_SIZE) {
          const batch = docs.slice(j, j + BATCH_SIZE);
          const operations = batch.flatMap((doc) => [
            { index: { _index: modIndexName, _id: doc.id.toString() } },
            doc.document,
          ]);
          if (operations.length > 0) {
            await client.bulk({ operations, refresh: false });
          }
        }
        processedCount += docs.length;
        logger.debug(`Reindexed ${processedCount} mods...`);

        afterId = idList[idList.length - 1];
        if (idList.length < FULL_REINDEX_PAGE_SIZE) break;
      }
      logger.info(`Mod reindexing complete. Total indexed: ${processedCount}`);
    } catch (error) {
      logger.error('Error reindexing all mods:', error);
      throw error;
    }
  }

  public async reindexModsForUser(userId: string): Promise<void> {
    if (!userId) return;
    const [assigneeRows, postedRows] = await Promise.all([
      ModAssignee.findAll({
        where: { userId },
        attributes: ['modId'],
      }),
      Mod.findAll({
        where: { postedByUserId: userId },
        attributes: ['id'],
      }),
    ]);
    const ids = [
      ...assigneeRows.map((row) => row.modId),
      ...postedRows.map((row) => row.id),
    ];
    await this.reindexMods(ids);
  }

  public async searchMods(options: ModSearchOptions): Promise<ModSearchResult> {
    return runModSearch(options);
  }

  public async indexTournament(tournamentId: number): Promise<void> {
    if (!Number.isFinite(tournamentId) || tournamentId <= 0) {
      logger.warn(`indexTournament skipped: invalid id ${tournamentId}`);
      return;
    }
    try {
      const docs = await fetchTournamentsForBulkIndex([tournamentId]);
      const prepared = docs[0];
      if (!prepared) {
        logger.warn(`indexTournament: tournament ${tournamentId} not found in DB — removing from index if present`);
        await this.deleteTournament(tournamentId).catch(() => {});
        return;
      }
      await client.index({
        index: tournamentIndexName,
        id: prepared.id.toString(),
        document: prepared.document,
        refresh: true,
      });
    } catch (error) {
      logger.error(`Error indexing tournament ${tournamentId}:`, error);
      throw error;
    }
  }

  public async reindexTournaments(tournamentIds: number[]): Promise<void> {
    if (!tournamentIds || tournamentIds.length === 0) return;
    try {
      const uniqueIds = [...new Set(tournamentIds)].filter((id) => Number.isFinite(id) && id > 0);
      if (uniqueIds.length === 0) return;

      let processedCount = 0;
      for (let i = 0; i < uniqueIds.length; i += MAX_BATCH_SIZE) {
        const chunk = uniqueIds.slice(i, i + MAX_BATCH_SIZE);
        const docs = await fetchTournamentsForBulkIndex(chunk);
        if (docs.length === 0) continue;

        for (let j = 0; j < docs.length; j += BATCH_SIZE) {
          const batch = docs.slice(j, j + BATCH_SIZE);
          const operations = batch.flatMap((doc) => [
            { index: { _index: tournamentIndexName, _id: doc.id.toString() } },
            doc.document,
          ]);
          if (operations.length > 0) {
            await client.bulk({ operations, refresh: false });
          }
        }
        processedCount += docs.length;
      }
      logger.debug(`Reindexed ${processedCount} tournaments (requested ${uniqueIds.length})`);
    } catch (error) {
      logger.error('Error reindexing tournaments:', error);
      throw error;
    }
  }

  public async deleteTournament(tournamentId: number): Promise<void> {
    try {
      await client.delete({
        index: tournamentIndexName,
        id: tournamentId.toString(),
      });
    } catch (error: unknown) {
      const status = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
      if (status === 404) return;
      logger.error(`Error deleting tournament ${tournamentId} from index:`, error);
      throw error;
    }
  }

  public async reindexAllTournaments(): Promise<void> {
    try {
      let processedCount = 0;
      let afterId = 0;
      while (true) {
        const idRows = await Tournament.findAll({
          where: { id: { [Op.gt]: afterId } },
          attributes: ['id'],
          order: [['id', 'ASC']],
          limit: FULL_REINDEX_PAGE_SIZE,
          raw: true,
        });
        const idList = idRows.map((r: { id: number }) => r.id);
        if (idList.length === 0) break;

        const docs = await fetchTournamentsForBulkIndex(idList);
        for (let j = 0; j < docs.length; j += BATCH_SIZE) {
          const batch = docs.slice(j, j + BATCH_SIZE);
          const operations = batch.flatMap((doc) => [
            { index: { _index: tournamentIndexName, _id: doc.id.toString() } },
            doc.document,
          ]);
          if (operations.length > 0) {
            await client.bulk({ operations, refresh: false });
          }
        }
        processedCount += docs.length;
        logger.debug(`Reindexed ${processedCount} tournaments...`);

        afterId = idList[idList.length - 1];
        if (idList.length < FULL_REINDEX_PAGE_SIZE) break;
      }
      logger.info(`Tournament reindexing complete. Total indexed: ${processedCount}`);
    } catch (error) {
      logger.error('Error reindexing all tournaments:', error);
      throw error;
    }
  }

  public async searchTournaments(options: TournamentSearchOptions): Promise<TournamentSearchResult> {
    return runTournamentSearch(options);
  }
}

export default ElasticsearchService;
