import client, { 
  levelIndexName, 
  passIndexName, 
  levelMapping, 
  passMapping,
  storeMappingHash,
  initializeElasticsearch,
  indices,
  generateMappingHash,
  updateMappingHash
} from '../config/elasticsearch.js';
import { logger } from './LoggerService.js';
import { ILevel } from '../interfaces/models/index.js';
import { Op } from 'sequelize';
import Level from '../models/levels/Level.js';
import Difficulty from '../models/levels/Difficulty.js';
import LevelAlias from '../models/levels/LevelAlias.js';
import LevelCredit from '../models/levels/LevelCredit.js';
import Creator from '../models/credits/Creator.js';
import Team from '../models/credits/Team.js';
import Pass from '../models/passes/Pass.js';
import Player from '../models/players/Player.js';
import Judgement from '../models/passes/Judgement.js';
import { CreatorAlias } from '../models/credits/CreatorAlias.js';
import { TeamAlias } from '../models/credits/TeamAlias.js';
import path from 'path';
import fs from 'fs';

class ElasticsearchService {
  private static instance: ElasticsearchService;
  private isInitialized: boolean = false;

  private constructor() {}

  public static getInstance(): ElasticsearchService {
    if (!ElasticsearchService.instance) {
      ElasticsearchService.instance = new ElasticsearchService();
    }
    return ElasticsearchService.instance;
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.info('ElasticsearchService already initialized');
      return;
    }

    try {
      logger.info('Starting ElasticsearchService initialization...');
      
      // Initialize Elasticsearch indices
      const needsReindex = await initializeElasticsearch();
      
      // Set up database change listeners
      await this.setupChangeListeners();
      logger.info('Database change listeners set up successfully');

      
      if (needsReindex) {
        logger.info('Starting data reindexing...');
        await Promise.all([
          this.reindexAllLevels().catch(error => {
            logger.error('Failed to reindex levels:', error);
            throw error;
          }),
          this.reindexAllPasses().catch(error => {
            logger.error('Failed to reindex passes:', error);
            throw error;
          }),
        ]);
        logger.info('Data reindexing completed successfully');
        updateMappingHash();
      }

      this.isInitialized = true;
      logger.info('ElasticsearchService initialized successfully');
    } catch (error) {
      logger.error('Error initializing ElasticsearchService:', error);
      this.isInitialized = false;
      throw error;
    }
  }

  private async setupChangeListeners(): Promise<void> {
    // Bind the methods to this instance
    const boundIndexLevel = this.indexLevel.bind(this);
    const boundDeleteLevel = this.deleteLevel.bind(this);
    const boundIndexPass = this.indexPass.bind(this);
    const boundDeletePass = this.deletePass.bind(this);

    // Level hooks
    Level.addHook('afterCreate', 'elasticsearchIndexCreate', async (level: Level) => {
      await boundIndexLevel(level.get());
    });

    Level.addHook('afterUpdate', 'elasticsearchIndexUpdate', async (level: Level) => {
      await boundIndexLevel(level.get());
    });

    Level.addHook('afterDestroy', 'elasticsearchIndexDelete', async (level: Level) => {
      await boundDeleteLevel(level.get('id'));
    });

    // Pass hooks
    Pass.addHook('afterCreate', 'elasticsearchPassCreate', async (pass: Pass) => {
      await boundIndexPass(pass.get());
    });

    Pass.addHook('afterUpdate', 'elasticsearchPassUpdate', async (pass: Pass) => {
      await boundIndexPass(pass.get());
    });

    Pass.addHook('afterDestroy', 'elasticsearchPassDelete', async (pass: Pass) => {
      await boundDeletePass(pass.get('id'));
    });

    // LevelCredit hooks
    LevelCredit.addHook('afterCreate', 'elasticsearchCreditCreate', async (credit: LevelCredit) => {
      const level = await this.getLevelWithRelations(credit.get('levelId'));
      if (level) {
        await boundIndexLevel(level.get());
      }
    });

    LevelCredit.addHook('afterUpdate', 'elasticsearchCreditUpdate', async (credit: LevelCredit) => {
      const level = await this.getLevelWithRelations(credit.get('levelId'));
      if (level) {
        await boundIndexLevel(level.get());
      }
    });

    LevelCredit.addHook('afterDestroy', 'elasticsearchCreditDelete', async (credit: LevelCredit) => {
      const level = await this.getLevelWithRelations(credit.get('levelId'));
      if (level) {
        await boundIndexLevel(level.get());
      }
    });

    // Creator and Team hooks
    Creator.addHook('afterUpdate', 'elasticsearchCreatorUpdate', async (creator: Creator) => {
      const levels = await Level.findAll({
        include: [
          {
            model: LevelCredit,
            as: 'levelCredits',
            where: { creatorId: creator.get('id') }
          }
        ]
      });
      for (const level of levels) {
        await boundIndexLevel(level.get());
      }
    });

    Team.addHook('afterUpdate', 'elasticsearchTeamUpdate', async (team: Team) => {
      const levels = await Level.findAll({
        where: { teamId: team.get('id') }
      });
      for (const level of levels) {
        await boundIndexLevel(level.get());
      }
    });
  }

  private async getLevelWithRelations(levelId: number): Promise<Level | null> {
    return Level.findByPk(levelId, {
      include: [
        {
          model: Difficulty,
          as: 'difficulty'
        },
        {
          model: LevelAlias,
          as: 'aliases'
        },
        {
          model: LevelCredit,
          as: 'levelCredits',
          include: [
            {
              model: Creator,
              as: 'creator',
              include: [
                {
                  model: CreatorAlias,
                  as: 'creatorAliases'
                }
              ]
            }
          ]
        },
        {
          model: Team,
          as: 'teamObject',
          include: [
            {
              model: TeamAlias,
              as: 'teamAliases'
            }
          ]
        }
      ]
    });
  }

  public async indexLevel(level: ILevel): Promise<void> {
    try {
      const levelWithRelations = await this.getLevelWithRelations(level.id);
      if (levelWithRelations) {
        await client.index({
          index: levelIndexName,
          id: level.id.toString(),
          document: levelWithRelations
        });
      }
    } catch (error) {
      logger.error(`Error indexing level ${level.id}:`, error);
      throw error;
    }
  }

  public async bulkIndexLevels(levels: ILevel[]): Promise<void> {
    try {
      const BATCH_SIZE = 200;
      const totalBatches = Math.ceil(levels.length / BATCH_SIZE);
      
      for (let i = 0; i < levels.length; i += BATCH_SIZE) {
        const batch = levels.slice(i, i + BATCH_SIZE);
        const operations = batch.flatMap(level => [
          { index: { _index: levelIndexName, _id: level.id.toString() } },
          level
        ]);

        if (operations.length > 0) {
          await client.bulk({ operations });
        }
      }
      logger.info(`Successfully indexed ${levels.length} levels in ${totalBatches} batches`);
    } catch (error) {
      logger.error('Error bulk indexing levels:', error);
      throw error;
    }
  }

  public async deleteLevel(levelId: number): Promise<void> {
    try {
      await client.delete({
        index: levelIndexName,
        id: levelId.toString()
      });
    } catch (error) {
      logger.error(`Error deleting level ${levelId} from index:`, error);
      throw error;
    }
  }

  public async indexPass(pass: any): Promise<void> {
    try {
      await client.index({
        index: passIndexName,
        id: pass.id.toString(),
        document: pass
      });
    } catch (error) {
      logger.error(`Error indexing pass ${pass.id}:`, error);
      throw error;
    }
  }

  public async bulkIndexPasses(passes: any[]): Promise<void> {
    try {
      const BATCH_SIZE = 100;
      const totalBatches = Math.ceil(passes.length / BATCH_SIZE);
      
      for (let i = 0; i < passes.length; i += BATCH_SIZE) {
        const batch = passes.slice(i, i + BATCH_SIZE);
        const operations = batch.flatMap(pass => [
          { index: { _index: passIndexName, _id: pass.id.toString() } },
          pass
        ]);

        if (operations.length > 0) {
          await client.bulk({ operations });
        }
      }
      logger.info(`Successfully indexed ${passes.length} passes in ${totalBatches} batches`);
    } catch (error) {
      logger.error('Error bulk indexing passes:', error);
      throw error;
    }
  }

  public async deletePass(passId: number): Promise<void> {
    try {
      await client.delete({
        index: passIndexName,
        id: passId.toString()
      });
    } catch (error) {
      logger.error(`Error deleting pass ${passId} from index:`, error);
      throw error;
    }
  }

  public async reindexAllLevels(): Promise<void> {
    try {
      const levels = await Level.findAll({
        include: [
          {
            model: Difficulty,
            as: 'difficulty'
          },
          {
            model: LevelAlias,
            as: 'aliases'
          },
          {
            model: LevelCredit,
            as: 'levelCredits',
            include: [
              {
                model: Creator,
                as: 'creator',
                include: [
                  {
                    model: CreatorAlias,
                    as: 'creatorAliases'
                  }
                ]
              }
            ]
          },
          {
            model: Team,
            as: 'teamObject',
            include: [
              {
                model: TeamAlias,
                as: 'teamAliases'
              }
            ]
          }
        ]
      });

      await this.bulkIndexLevels(levels);
      
      // Update hash after successful reindexing
      const currentHash = generateMappingHash({
        [levelIndexName]: levelMapping,
        [passIndexName]: passMapping
      });
      storeMappingHash(currentHash);
    } catch (error) {
      logger.error('Error reindexing all levels:', error);
      throw error;
    }
  }

  public async reindexAllPasses(): Promise<void> {
    try {
      const passes = await Pass.findAll({
        include: [
          {
            model: Player,
            as: 'player',
            attributes: ['name', 'country', 'isBanned']
          },
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty'
              }
            ]
          },
          {
            model: Judgement,
            as: 'judgements'
          }
        ]
      });

      await this.bulkIndexPasses(passes);
      
      // Update hash after successful reindexing
      const currentHash = generateMappingHash({
        [levelIndexName]: levelMapping,
        [passIndexName]: passMapping
      });
      storeMappingHash(currentHash);
    } catch (error) {
      logger.error('Error reindexing all passes:', error);
      throw error;
    }
  }

  private async resolveDifficultyRange(minDiff?: string, maxDiff?: string): Promise<number[]> {
    try {
      const [fromDiff, toDiff] = await Promise.all([
        minDiff
          ? Difficulty.findOne({
              where: { name: minDiff, type: 'PGU' },
              attributes: ['id', 'sortOrder'],
            })
          : null,
        maxDiff
          ? Difficulty.findOne({
              where: { name: maxDiff, type: 'PGU' },
              attributes: ['id', 'sortOrder'],
            })
          : null,
      ]);

      if (fromDiff || toDiff) {
        const pguDifficulties = await Difficulty.findAll({
          where: {
            type: 'PGU',
            sortOrder: {
              ...(fromDiff && { [Op.gte]: fromDiff.sortOrder }),
              ...(toDiff && { [Op.lte]: toDiff.sortOrder }),
            },
          },
          attributes: ['id'],
        });

        return pguDifficulties.map(d => d.id);
      }

      return [];
    } catch (error) {
      logger.error('Error resolving difficulty range:', error);
      return [];
    }
  }

  private async resolveSpecialDifficulties(specialDifficulties?: string[]): Promise<number[]> {
    try {
      if (!specialDifficulties?.length) return [];

      const specialDiffs = await Difficulty.findAll({
        where: {
          name: { [Op.in]: specialDifficulties },
          type: 'SPECIAL',
        },
        attributes: ['id'],
      });

      return specialDiffs.map(d => d.id);
    } catch (error) {
      logger.error('Error resolving special difficulties:', error);
      return [];
    }
  }

  public async searchLevels(query: string, filters: any = {}): Promise<{ hits: any[], total: number }> {
    try {
      const must: any[] = [];
      const should: any[] = [];

      // Handle text search with composite operators
      if (query) {
        // Split by OR operator first
        const orTerms = query.split('|').map(term => term.trim());
        
        orTerms.forEach(term => {
          // Split each OR term by AND operator
          const andTerms = term.split(',').map(t => t.trim());
          
          const termQueries = andTerms.map(andTerm => ({
            bool: {
              should: [
                { wildcard: { 'song': { value: `*${andTerm}*`, case_insensitive: true } } },
                { wildcard: { 'artist': { value: `*${andTerm}*`, case_insensitive: true } } },
                { wildcard: { 'charter': { value: `*${andTerm}*`, case_insensitive: true } } },
                { wildcard: { 'team': { value: `*${andTerm}*`, case_insensitive: true } } },
                { wildcard: { 'creator': { value: `*${andTerm}*`, case_insensitive: true } } },
                // Handle level aliases
                {
                  nested: {
                    path: 'aliases',
                    query: {
                      wildcard: { 'aliases.alias': { value: `*${andTerm}*`, case_insensitive: true } }
                    }
                  }
                },
                // Handle creator search with nested aliases
                {
                  nested: {
                    path: 'levelCredits',
                    query: {
                      bool: {
                        should: [
                          { wildcard: { 'levelCredits.creator.name': { value: `*${andTerm}*`, case_insensitive: true } } },
                          {
                            nested: {
                              path: 'levelCredits.creator',
                              query: {
                                nested: {
                                  path: 'levelCredits.creator.creatorAliases',
                                  query: {
                                    wildcard: { 'levelCredits.creator.creatorAliases.name': { value: `*${andTerm}*`, case_insensitive: true } }
                                  }
                                }
                              }
                            }
                          }
                        ]
                      }
                    }
                  }
                },
                // Handle team search with nested aliases
                {
                  nested: {
                    path: 'teamObject',
                    query: {
                      bool: {
                        should: [
                          { wildcard: { 'teamObject.name': { value: `*${andTerm}*`, case_insensitive: true } } },
                          {
                            nested: {
                              path: 'teamObject.aliases',
                              query: {
                                wildcard: { 'teamObject.aliases.name': { value: `*${andTerm}*`, case_insensitive: true } }
                              }
                            }
                          }
                        ]
                      }
                    }
                  }
                }
              ],
              minimum_should_match: 1
            }
          }));
          
          // If there are multiple AND terms, they all must match
          if (termQueries.length > 1) {
            should.push({
              bool: {
                must: termQueries
              }
            });
          } else {
            should.push(termQueries[0]);
          }
        });
      }

      // Handle filters
      if (filters.deletedFilter === 'hide') {
        must.push({ term: { isDeleted: false } });
        must.push({ term: { isHidden: false } });
      } else if (filters.deletedFilter === 'only') {
        must.push({ bool: { should: [{ term: { isDeleted: true } }, { term: { isHidden: true } }] } });
      }

      if (filters.clearedFilter === 'hide') {
        must.push({ term: { clears: 0 } });
      } else if (filters.clearedFilter === 'only') {
        must.push({ range: { clears: { gt: 0 } } });
      }

      // Handle liked levels filter
      if (filters.onlyMyLikes && filters.likedLevelIds?.length > 0) {
        must.push({
          terms: {
            id: filters.likedLevelIds
          }
        });
      }

      // Handle difficulty filters
      if (filters.pguRange || filters.specialDifficulties) {
        const difficultyConditions = [];
        
        // Resolve PGU range to IDs
        if (filters.pguRange) {
          const { from, to } = filters.pguRange;
          const pguIds = await this.resolveDifficultyRange(from, to);
          if (pguIds.length > 0) {
            difficultyConditions.push({
              terms: {
                "diffId": pguIds
              }
            });
          }
        }

        // Resolve special difficulties to IDs
        if (filters.specialDifficulties?.length > 0) {
          const specialIds = await this.resolveSpecialDifficulties(filters.specialDifficulties);
          if (specialIds.length > 0) {
            difficultyConditions.push({
              terms: {
                "diffId": specialIds
              }
            });
          }
        }

        if (difficultyConditions.length > 0) {
          must.push({ bool: { should: difficultyConditions } });
        }
      }

      const searchQuery = {
        bool: {
          must,
          ...(should.length > 0 && { should, minimum_should_match: 1 })
        }
      };

      const response = await client.search({
        index: levelIndexName,
        query: searchQuery,
        sort: this.getSortOptions(filters.sort),
        from: filters.offset || 0,
        size: filters.limit || 30
      });

      return {
        hits: response.hits.hits.map(hit => hit._source),
        total: response.hits.total ? (typeof response.hits.total === 'number' ? response.hits.total : response.hits.total.value) : 0
      };
    } catch (error) {
      logger.error('Error searching levels:', error);
      throw error;
    }
  }

  private getSortOptions(sort?: string): any[] {
    const direction = sort?.split('_').pop() === 'ASC' ? 'asc' : 'desc';
    
    switch (sort?.split('_').slice(0, -1).join('_')) {
      case 'RECENT':
        return [{ id: direction }];
      case 'DIFF':
        return [{ 'difficulty.sortOrder': direction }, { id: 'desc' }];
      case 'CLEARS':
        return [{ clears: direction }, { id: 'desc' }];
      case 'LIKES':
        return [{ likes: direction }, { id: 'desc' }];
      case 'RATING_ACCURACY':
        return [{ ratingAccuracy: direction }, { id: 'desc' }];
      case 'RATING_ACCURACY_VOTES':
        return [{ totalRatingAccuracyVotes: direction }, { id: 'desc' }];
      case 'RANDOM':
        return [{ _script: { script: 'Math.random()', type: 'number' } }];
      default:
        return [{ id: 'desc' }];
    }
  }

  public async searchPasses(query: string, filters: any = {}): Promise<{ hits: any[], total: number }> {
    try {
      const must: any[] = [];
      const should: any[] = [];

      // Handle text search with composite operators
      if (query) {
        // Split by OR operator first
        const orTerms = query.split('|').map(term => term.trim());
        
        orTerms.forEach(term => {
          // Split each OR term by AND operator
          const andTerms = term.split(',').map(t => t.trim());
          
          const termQueries = andTerms.map(andTerm => ({
            bool: {
              should: [
                { wildcard: { 'player.name': { value: `*${andTerm}*`, case_insensitive: true } } },
                { wildcard: { 'level.song': { value: `*${andTerm}*`, case_insensitive: true } } },
                { wildcard: { 'level.artist': { value: `*${andTerm}*`, case_insensitive: true } } },
                { wildcard: { 'videoLink': { value: `*${andTerm}*`, case_insensitive: true } } },
                { wildcard: { 'vidTitle': { value: `*${andTerm}*`, case_insensitive: true } } }
              ],
              minimum_should_match: 1
            }
          }));
          
          // If there are multiple AND terms, they all must match
          if (termQueries.length > 1) {
            should.push({
              bool: {
                must: termQueries
              }
            });
          } else {
            should.push(termQueries[0]);
          }
        });
      }

      // Handle filters
      if (filters.deletedFilter === 'hide') {
        must.push({ term: { isDeleted: false } });
      } else if (filters.deletedFilter === 'only') {
        must.push({ term: { isDeleted: true } });
      }

      // Handle key flag filter
      if (filters.keyFlag) {
        switch (filters.keyFlag) {
          case '12k':
            must.push({ term: { is12K: true } });
            break;
          case '16k':
            must.push({ term: { is16K: true } });
            break;
        }
      }

      // Handle difficulty filters
      if (filters.minDiff || filters.maxDiff || filters.specialDifficulties) {
        const difficultyConditions = [];
        
        // Handle PGU range
        if (filters.minDiff || filters.maxDiff) {
          const [fromDiff, toDiff] = await Promise.all([
            filters.minDiff
              ? Difficulty.findOne({
                  where: { name: filters.minDiff, type: 'PGU' },
                  attributes: ['id', 'sortOrder'],
                })
              : null,
            filters.maxDiff
              ? Difficulty.findOne({
                  where: { name: filters.maxDiff, type: 'PGU' },
                  attributes: ['id', 'sortOrder'],
                })
              : null,
          ]);

          if (fromDiff || toDiff) {
            const pguDifficulties = await Difficulty.findAll({
              where: {
                type: 'PGU',
                sortOrder: {
                  ...(fromDiff && { [Op.gte]: fromDiff.sortOrder }),
                  ...(toDiff && { [Op.lte]: toDiff.sortOrder }),
                },
              },
              attributes: ['id'],
            });

            if (pguDifficulties.length > 0) {
              difficultyConditions.push({
                terms: {
                  "level.diffId": pguDifficulties.map(d => d.id)
                }
              });
            }
          }
        }

        // Handle special difficulties
        if (filters.specialDifficulties?.length > 0) {
          const specialDiffs = await Difficulty.findAll({
            where: {
              name: { [Op.in]: filters.specialDifficulties },
              type: 'SPECIAL',
            },
            attributes: ['id'],
          });

          if (specialDiffs.length > 0) {
            difficultyConditions.push({
              terms: {
                "level.diffId": specialDiffs.map(d => d.id)
              }
            });
          }
        }

        if (difficultyConditions.length > 0) {
          must.push({ bool: { should: difficultyConditions } });
        }
      }

      const searchQuery = {
        bool: {
          must,
          ...(should.length > 0 && { should, minimum_should_match: 1 })
        }
      };

      const response = await client.search({
        index: passIndexName,
        query: searchQuery,
        sort: this.getPassSortOptions(filters.sort),
        from: filters.offset || 0,
        size: filters.limit || 30
      });

      return {
        hits: response.hits.hits.map(hit => hit._source),
        total: response.hits.total ? (typeof response.hits.total === 'number' ? response.hits.total : response.hits.total.value) : 0
      };
    } catch (error) {
      logger.error('Error searching passes:', error);
      throw error;
    }
  }

  private getPassSortOptions(sort?: string): any[] {
    const direction = sort?.split('_').pop() === 'ASC' ? 'asc' : 'desc';
    
    switch (sort?.split('_').slice(0, -1).join('_')) {
      case 'RECENT':
        return [{ vidUploadTime: direction }];
      case 'SCORE':
        return [{ scoreV2: direction }, { id: 'desc' }];
      case 'XACC':
        return [{ accuracy: direction }, { scoreV2: 'desc' }, { id: 'desc' }];
      case 'DIFF':
        return [{ 'level.difficulty.sortOrder': direction }, { scoreV2: 'desc' }, { id: 'desc' }];
      case 'RANDOM':
        return [{ _script: { script: 'Math.random()', type: 'number' } }];
      default:
        return [{ scoreV2: 'desc' }, { id: 'desc' }];
    }
  }
}

export default ElasticsearchService; 