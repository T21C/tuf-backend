import client, {
  levelIndexName,
  passIndexName,
  initializeElasticsearch,
  updateMappingHash
} from '@/config/elasticsearch.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { ILevel, IPass } from '@/server/interfaces/models/index.js';
import { Op } from 'sequelize';
import Level from '@/models/levels/Level.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Pass from '@/models/passes/Pass.js';
import SongCredit from '@/models/songs/SongCredit.js';
import { searchLevels as runLevelSearch } from '@/server/services/elasticsearch/search/levelSearch.js';
import { searchPasses as runPassSearch } from '@/server/services/elasticsearch/search/passSearch.js';
import { ARTIST_REINDEX_DEBOUNCE_MS, BATCH_SIZE, MAX_BATCH_SIZE } from '@/server/services/elasticsearch/constants.js';
import { fetchLevelWithRelations } from '@/server/services/elasticsearch/levelFetch.js';
import { fetchPassWithRelations } from '@/server/services/elasticsearch/passFetch.js';
import { fetchLevelsForBulkIndex, clearEsIndexRelationCaches } from '@/server/services/elasticsearch/levelBulkFetch.js';
import { fetchPassesForBulkIndex, clearEsPassIndexRelationCaches } from '@/server/services/elasticsearch/passBulkFetch.js';
import { buildLevelIndexDocument } from '@/server/services/elasticsearch/levelIndexDocument.js';
import { buildPassIndexDocument } from '@/server/services/elasticsearch/passIndexDocument.js';
import { registerElasticsearchChangeListeners } from '@/server/services/elasticsearch/listeners/registerElasticsearchChangeListeners.js';

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
      const { reindexedLevels, reindexedPasses } = await initializeElasticsearch();

      // Set up database change listeners
      this.setupChangeListeners();
      logger.info('Database change listeners set up successfully');


      if (reindexedLevels || reindexedPasses) {
        if (reindexedLevels) logger.info('Reindexing levels...');
        if (reindexedPasses) logger.info('Reindexing passes...');
        const start = Date.now();
        await Promise.all([
          reindexedLevels
            ? this.reindexLevels().catch(error => {
                logger.error('Failed to reindex levels:', error);
                throw error;
              })
            : Promise.resolve(),
          reindexedPasses
            ? this.reindexPasses().catch(error => {
                logger.error('Failed to reindex passes:', error);
                throw error;
              })
            : Promise.resolve(),
        ]);
        const end = Date.now();
        logger.info(`Data reindexing completed successfully in ${Math.round((end - start)/100)/10}s`);
        updateMappingHash({ reindexedLevels, reindexedPasses });
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
    const passes = await Pass.findAll({
      where: {
        playerId: playerId,
        isDeleted: false,
        isHidden: false,
      }
    });
    for (const pass of passes) {
      await this.indexPass(pass.id);
    }
  }

  /**
   * Get all level IDs that use a specific song
   */
  private async getLevelIdsBySongId(songId: number): Promise<number[]> {
    try {
      const levels = await Level.findAll({
        where: {
          songId: songId,
          isDeleted: false
        },
        attributes: ['id']
      });
      return levels.map(level => level.id);
    } catch (error) {
      logger.error(`Error getting level IDs for song ${songId}:`, error);
      return [];
    }
  }

  /**
   * Get all level IDs that have songs with credits from a specific artist
   */
  private async getLevelIdsByArtistId(artistId: number): Promise<number[]> {
    try {
      // Find all songs that have credits from this artist
      const songCredits = await SongCredit.findAll({
        where: {
          artistId: artistId
        },
        attributes: ['songId'],
        group: ['songId']
      });

      if (songCredits.length === 0) {
        return [];
      }

      const songIds = songCredits.map(credit => credit.songId);

      // Find all levels that use these songs
      const levels = await Level.findAll({
        where: {
          songId: { [Op.in]: songIds },
          isDeleted: false
        },
        attributes: ['id']
      });

      return levels.map(level => level.id);
    } catch (error) {
      logger.error(`Error getting level IDs for artist ${artistId}:`, error);
      return [];
    }
  }

  /**
   * Schedule debounced reindexing for artist-related changes
   * This prevents overwhelming the server when artists have thousands of levels
   */
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

  private setupChangeListeners(): void {
    registerElasticsearchChangeListeners({
      indexLevel: (level) => this.indexLevel(level),
      indexPass: (pass) => this.indexPass(pass),
      deletePassDocumentById: (id) => this.deletePassDocumentById(id),
      reindexLevels: (ids) => this.reindexLevels(ids),
      reindexPasses: (ids) => this.reindexPasses(ids),
      scheduleArtistReindex: (ids) => this.scheduleArtistReindex(ids),
      getLevelIdsBySongId: (id) => this.getLevelIdsBySongId(id),
      getLevelIdsByArtistId: (id) => this.getLevelIdsByArtistId(id),
    });
  }

  private async getParsedLevel(id: number): Promise<ILevel | null> {
    const level = await fetchLevelWithRelations(id);
    if (!level) return null;
    const processedLevel = buildLevelIndexDocument(level);
    logger.debug(`Processed level ${id} videoLink: ${processedLevel.videoLink}`);
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
            limit: MAX_BATCH_SIZE,
            raw: true,
          });
          const idList = idRows.map((r: { id: number }) => r.id);
          if (idList.length === 0) break;

          const levels = await fetchLevelsForBulkIndex(idList);
          await this.bulkIndexLevels(levels);
          processedCount += levels.length;
          logger.debug(`Reindexed ${processedCount} levels...`);

          afterId = idList[idList.length - 1];
          if (idList.length < MAX_BATCH_SIZE) break;
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
            limit: MAX_BATCH_SIZE,
            raw: true,
          });
          const idList = idRows.map((r: { id: number }) => r.id);
          if (idList.length === 0) break;

          const passes = await fetchPassesForBulkIndex(idList);
          await this.bulkIndexPasses(passes);
          processedCount += passes.length;
          logger.debug(`Reindexed ${processedCount} passes...`);

          afterId = idList[idList.length - 1];
          if (idList.length < MAX_BATCH_SIZE) break;
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

  public async searchPasses(query: string, filters: any = {}, userPlayerId?: number, isSuperAdmin = false): Promise<{ hits: any[], total: number }> {
    return runPassSearch(query, filters, userPlayerId, isSuperAdmin);
  }
}

export default ElasticsearchService;
