import client, { 
  levelIndexName, 
  passIndexName, 
  initializeElasticsearch,
  updateMappingHash
} from '../config/elasticsearch.js';
import { logger } from './LoggerService.js';
import { ILevel, IPass } from '../interfaces/models/index.js';
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
import { prepareSearchTerm, convertToPUA, convertFromPUA } from '../utils/searchHelpers.js';
import sequelize from '../config/db.js';
import LevelLikes from '../models/levels/LevelLikes.js';

// Add these type definitions at the top of the file, after imports
type FieldSearch = {
  field: string;
  value: string;
  exact: boolean;
  isNot: boolean;
};

type SearchGroup = {
  terms: FieldSearch[];
  operation: 'AND' | 'OR';
};

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
      this.setupChangeListeners()
      logger.info('Database change listeners set up successfully');

      
      if (needsReindex) {
        logger.info('Starting data reindexing...');
        await Promise.all([
          this.reindexLevels().catch(error => {
            logger.error('Failed to reindex levels:', error);
            throw error;
          }),
          this.reindexPasses().catch(error => {
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

  private setupChangeListeners() {
    // Remove existing hooks first to prevent duplicates
    Pass.removeHook('beforeSave', 'elasticsearchPassUpdate');
    LevelLikes.removeHook('beforeSave', 'elasticsearchLevelLikesUpdate');
    Level.removeHook('beforeSave', 'elasticsearchLevelUpdate');
    Pass.removeHook('afterBulkUpdate', 'elasticsearchPassBulkUpdate');
    Level.removeHook('afterBulkUpdate', 'elasticsearchLevelBulkUpdate');

    // Add hooks with unique names
    Pass.addHook('beforeSave', 'elasticsearchPassUpdate', async (pass: Pass, options: any) => {
      logger.debug(`Pass saved hook triggered for pass ${pass.id}`);
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            logger.debug(`Indexing pass ${pass.id} and level ${pass.levelId} after transaction commit`);
            await this.indexPass(pass);
            await this.indexLevel(pass.levelId);
          });
        } else {
          logger.debug(`Indexing pass ${pass.id} and level ${pass.levelId} outside of transaction`);
          await this.indexPass(pass);
          await this.indexLevel(pass.levelId);
        }
      } catch (error) {
        logger.error(`Error in pass afterSave hook for pass ${pass.id}:`, error);
      }
      return;
    });

    // Add afterBulkUpdate hook for Pass model
    Pass.addHook('afterBulkUpdate', 'elasticsearchPassBulkUpdate', async (options: any) => {
      logger.debug(`Pass bulk update hook triggered`);
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            // If we have a specific pass ID, update that pass
            if (options.where?.id) {
              logger.debug(`Indexing pass ${options.where.id} after bulk update`);
              await this.indexPass(options.where.id);
            }
            // If we have a levelId, update all passes for that level
            if (options.where?.levelId) {
              logger.debug(`Indexing level ${options.where.levelId} after bulk update`);
              await this.indexLevel(options.where.levelId);
            }
          });
        } else {
          if (options.where?.id) {
            await this.indexPass(options.where.id);
          }
          if (options.where?.levelId) {
            await this.indexLevel(options.where.levelId);
          }
        }
      } catch (error) {
        logger.error(`Error in pass afterBulkUpdate hook:`, error);
      }
    });

    LevelLikes.addHook('beforeSave', 'elasticsearchLevelLikesUpdate', async (levelLikes: LevelLikes, options: any) => {
      logger.debug(`LevelLikes saved hook triggered for level ${levelLikes.levelId}`);
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            logger.debug(`Indexing level ${levelLikes.levelId} after transaction commit`);
            await this.indexLevel(levelLikes.levelId);
          });
        } else {
          logger.debug(`Indexing level ${levelLikes.levelId} outside of transaction`);
          await this.indexLevel(levelLikes.levelId);
        }
      } catch (error) {
        logger.error(`Error in levelLikes afterSave hook for level ${levelLikes.levelId}:`, error);
      }
      return;
    });

    Level.addHook('afterSave', 'elasticsearchLevelUpdate', async (level: Level, options: any) => {
      logger.debug(`Level saved hook triggered for level ${level.id}`);
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            logger.debug(`Indexing level ${level.id} after transaction commit`);
            await this.indexLevel(level);
          });
        } else {
          logger.debug(`Indexing level ${level.id} outside of transaction`);
          await this.indexLevel(level);
        }
      } catch (error) {
        logger.error(`Error in level afterSave hook for level ${level.id}:`, error);
      }
      return;
    });

    // Add afterBulkUpdate hook for Level model
    Level.addHook('afterBulkUpdate', 'elasticsearchLevelBulkUpdate', async (options: any) => {
      logger.debug(`Level bulk update hook triggered`);
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            if (options.where?.id) {
              logger.debug(`Indexing level ${options.where.id} ${typeof options.where.id} after bulk update`);
              await this.indexLevel(options.where.id);
            }
          });
        } else {
          if (options.where?.id) {
            logger.debug(`Indexing level ${options.where.id} ${typeof options.where.id} after bulk update`);
            await this.indexLevel(options.where.id);
          }
        }
      } catch (error) {
        logger.error(`Error in level afterBulkUpdate hook:`, error);
      }
    });
  }

  private async getLevelWithRelations(levelId: number): Promise<Level | null> {
    logger.debug(`Getting level with relations for level ${levelId} ${typeof levelId}`);
    try {
      const level = await Level.findByPk(levelId, {
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
        ],
      });
      logger.debug(`Level ${level}`);
      if (!level) return null;
      logger.debug(`Level ${level.id} isDeleted: ${level.isDeleted}`);
      const clears = await Pass.count({
        where: {
          levelId: levelId,
          isDeleted: false,
          isHidden: false,
        },
        include: [
          {
            model: Player,
            as: 'player',
            where: {
              isBanned: false
            }
          }
        ]
      });
      level.clears = clears;
      logger.debug(`Level ${level.id} has ${clears} clears`);
      return level;
    } catch (error) {
      throw error;
    }
  }

  private async getParsedLevel(id: number): Promise<ILevel | null> {
    const level = await this.getLevelWithRelations(id);
    if (!level) return null;
    const processedLevel = {
      ...level.get({ plain: true }),
      song: convertToPUA(level.song),
      artist: convertToPUA(level.artist),
      creator: convertToPUA(level.creator),
      charter: convertToPUA(level.charter),
      team: convertToPUA(level.team),
      videoLink: level.videoLink ? convertToPUA(level.videoLink) : null,
      dlLink: level.dlLink ? convertToPUA(level.dlLink) : null,
      legacyDllink: level.legacyDllink ? convertToPUA(level.legacyDllink) : null,
      // Process nested fields
      aliases: level.aliases?.map(alias => ({
        ...alias.get({ plain: true }),
        originalValue: convertToPUA(alias.originalValue),
        alias: convertToPUA(alias.alias)
      })),
      levelCredits: level.levelCredits?.map(credit => ({
        ...credit.get({ plain: true }),
        creator: credit.creator ? {
          ...credit.creator.get({ plain: true }),
          name: convertToPUA(credit.creator.name),
          creatorAliases: credit.creator.creatorAliases?.map(alias => ({
            ...alias.get({ plain: true }),
            name: convertToPUA(alias.name)
          }))
        } : null
      })),
      teamObject: level.teamObject ? {
        ...level.teamObject.get({ plain: true }),
        name: convertToPUA(level.teamObject.name),
        aliases: level.teamObject.teamAliases?.map(alias => ({
          ...alias.get({ plain: true }),
          name: convertToPUA(alias.name)
        }))
      } : null
    };
    logger.debug(`Processed level ${id} videoLink: ${processedLevel.videoLink}`);
    return processedLevel as ILevel;
  }

  private async getPassWithRelations(passId: number): Promise<Pass | null> {
    const transaction = await sequelize.transaction();
    try {
      const pass = await Pass.findByPk(passId, {
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
            },
            {
              model: LevelAlias,
              as: 'aliases'
            }
          ]
        },
        {
          model: Judgement,
          as: 'judgements'
        }
      ]
    });
    await transaction.commit();
    return pass;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
  
  private async getParsedPass(id: number): Promise<IPass | null> {
    const pass = await this.getPassWithRelations(id);
    if (!pass) return null;
    const processedPass = {
      ...pass.get({ plain: true }),
      vidTitle: pass.vidTitle ? convertToPUA(pass.vidTitle) : null,
      videoLink: pass.videoLink ? convertToPUA(pass.videoLink) : null,
      player: pass.player ? {
        ...pass.player.get({ plain: true }),
        name: convertToPUA(pass.player.name)
      } : null,
      level: pass.level ? {
        ...pass.level.get({ plain: true }),
        song: convertToPUA(pass.level.song),
        artist: convertToPUA(pass.level.artist)
      } : null
    };
    return processedPass as IPass;
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
      const BATCH_SIZE = 200;
      const totalBatches = Math.ceil(levels.length / BATCH_SIZE);
      
      for (let i = 0; i < levels.length; i += BATCH_SIZE) {
        const batch = levels.slice(i, i + BATCH_SIZE);
        const operations = batch.flatMap(level => {

          const processedLevel = {
            ...level.get({ plain: true }), // Convert to plain object
            song: convertToPUA(level.song),
            artist: convertToPUA(level.artist),
            creator: convertToPUA(level.creator),
            videoLink: convertToPUA(level.videoLink),
            dlLink: convertToPUA(level.dlLink),
            legacyDllink: level.legacyDllink ? convertToPUA(level.legacyDllink) : null,
            charter: convertToPUA(level.charter),
            team: convertToPUA(level.team),
            // Process nested fields
            aliases: level.aliases?.map(alias => ({
              ...alias.get({ plain: true }),
              originalValue: convertToPUA(alias.originalValue),
              alias: convertToPUA(alias.alias)
            })),
            levelCredits: level.levelCredits?.map(credit => ({
              ...credit.get({ plain: true }),
              creator: credit.creator ? {
                ...credit.creator.get({ plain: true }),
                name: convertToPUA(credit.creator.name),
                creatorAliases: credit.creator.creatorAliases?.map(alias => ({
                  ...alias.get({ plain: true }),
                  name: convertToPUA(alias.name)
                }))
              } : null
            })),
            teamObject: level.teamObject ? {
              ...level.teamObject.get({ plain: true }),
              name: convertToPUA(level.teamObject.name),
              aliases: level.teamObject.teamAliases?.map(alias => ({
                ...alias.get({ plain: true }),
                name: convertToPUA(alias.name)
              }))
            } : null
          };
          return [
            { index: { _index: levelIndexName, _id: level.id.toString() } },
            processedLevel
          ];
        });

        if (operations.length > 0) {
          await client.bulk({ operations });
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
    const id = typeof pass === 'number' ? pass : pass.id;
    try {
      const pass = await this.getPassWithRelations(id);
      if (pass) {
      logger.debug(`Indexing pass ${id}`);
      // If we have a direct pass object with relations, use it directly
      const processedPass = pass.player && pass.level && pass.judgements ? {
        ...pass.get({ plain: true }),
        vidTitle: pass.vidTitle ? convertToPUA(pass.vidTitle) : null,
        videoLink: pass.videoLink ? convertToPUA(pass.videoLink) : null,
        player: pass.player ? {
          ...pass.player.get({ plain: true }),
          name: convertToPUA(pass.player.name)
        } : null,
        level: pass.level ? {
          ...pass.level.get({ plain: true }),
          song: convertToPUA(pass.level.song),
          artist: convertToPUA(pass.level.artist)
        } : null
      } : await this.getParsedPass(pass.id);

      if (!processedPass) {
        logger.error(`Pass ${pass.id} not found`);
        return;
      }

      await client.index({
        index: passIndexName,
        id: pass.id.toString(),
        document: processedPass,
        refresh: true
        });
        logger.debug(`Successfully indexed pass ${pass.id}`);
      }
    } catch (error) {
      logger.error(`Error indexing pass ${id}:`, error);
      throw error;
    }
  }

  public async bulkIndexPasses(passes: any[]): Promise<void> {
    try {
      const BATCH_SIZE = 100;
      const totalBatches = Math.ceil(passes.length / BATCH_SIZE);
      
      for (let i = 0; i < passes.length; i += BATCH_SIZE) {
        const batch = passes.slice(i, i + BATCH_SIZE);
        const operations = batch.flatMap(pass => {
          const processedPass = {
            ...pass.get({ plain: true }),
            vidTitle: convertToPUA(pass.vidTitle),
            videoLink: convertToPUA(pass.videoLink),
            player: pass.player ? {
              ...pass.player.get({ plain: true }),
              name: convertToPUA(pass.player.name)
            } : null,
            level: pass.level ? {
              ...pass.level.get({ plain: true }),
              song: convertToPUA(pass.level.song),
              artist: convertToPUA(pass.level.artist)
            } : null
          };
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
    try {
      await client.delete({
        index: passIndexName,
        id: pass.id.toString()
      });
    } catch (error) {
      logger.error(`Error deleting pass ${pass.id} from index:`, error);
      throw error;
    }
  }

  public async reindexLevels(levelIds?: number[]): Promise<void> {
    try {
      const levels = await Level.findAll({
        where: levelIds ? { id: { [Op.in]: levelIds } } : undefined,
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
    } catch (error) {
      logger.error('Error reindexing all levels:', error);
      throw error;
    }
  }

  public async reindexPasses(passIds?: number[]): Promise<void> {
    try {
      const passes = await Pass.findAll({
        where: passIds ? { id: { [Op.in]: passIds } } : undefined,
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

  private parseFieldSearch(term: string): FieldSearch | null {
    // Trim the term here when parsing
    const trimmedTerm = term.trim();
    if (!trimmedTerm) return null;

    // Check for NOT operator
    const isNot = trimmedTerm.startsWith('\\!');
    const searchTerm = isNot ? trimmedTerm.slice(2) : trimmedTerm;

    // Check for exact match with equals sign
    const exactMatch = searchTerm.match(/^(song|artist|charter|team|vfxer|creator|dlLink|legacyDllink|videolink)=(.+)$/i);
    if (exactMatch) {
      const field = exactMatch[1].toLowerCase();
      const value = exactMatch[2].trim();
      const puaValue = convertToPUA(value);
      logger.debug(`Exact match search - Field: ${field}, Original value: ${value}, PUA value: ${puaValue}`);
      return {
        field,
        value: puaValue,
        exact: true,
        isNot
      };
    }

    // Check for partial match with colon
    const partialMatch = searchTerm.match(/^(song|artist|charter|team|vfxer|creator|dlLink|legacyDllink|videolink):(.+)$/i);
    if (partialMatch) {
      const field = partialMatch[1].toLowerCase();
      const value = partialMatch[2].trim();
      const puaValue = convertToPUA(value);
      logger.debug(`Partial match search - Field: ${field}, Original value: ${value}, PUA value: ${puaValue}`);
      return {
        field,
        value: puaValue,
        exact: false,
        isNot
      };
    }

    // Handle general search term with NOT operator
    const puaValue = convertToPUA(searchTerm.trim());
    logger.debug(`General search - Original value: ${searchTerm.trim()}, PUA value: ${puaValue}`);
    return {
      field: 'any',
      value: puaValue,
      exact: false,
      isNot
    };
  }

  private parseSearchQuery(query: string): SearchGroup[] {
    if (!query) return [];

    // Split by | for OR groups and handle trimming here
    const groups = query
      .split('|')
      .map(group => {
        // Split by comma for AND terms within each group
        const terms = group
          .split(',')
          .map(term => term.trim())
          .filter(term => term.length > 0)
          .map(term => {
            const fieldSearch = this.parseFieldSearch(term);
            if (fieldSearch) {
              return fieldSearch;
            }
            return {
              field: 'any',
              value: term.trim(),
              exact: false,
              isNot: false
            };
          });

        return {
          terms,
          operation: 'AND' as const,
        };
      })
      .filter(group => group.terms.length > 0); // Remove empty groups

    return groups;
  }

  private buildFieldSearchQuery(fieldSearch: FieldSearch, excludeAliases: boolean = false): any {
    const { field, value, exact, isNot } = fieldSearch;
    // Note: value is already converted to PUA in parseFieldSearch
    const searchValue = prepareSearchTerm(value);
    logger.debug(`Building search query - Field: ${field}, PUA value: ${value}, Prepared value: ${searchValue}`);

    // For field-specific searches
    if (field !== 'any') {
      // For exact matches (using =), use term query with case-insensitive match
      if (exact) {
        // Handle role-based searches (charter, vfxer, creator)
        if (field === 'charter' || field === 'vfxer' || field === 'creator') {
          const query = {
            bool: {
              should: [
                // Search in root level creator field
                {
                  term: {
                    'creator.keyword': {
                      value: searchValue,
                      case_insensitive: true
                    }
                  }
                },
                // Search in nested levelCredits
                {
                  nested: {
                    path: 'levelCredits',
                    query: {
                      bool: {
                        must: [
                          {
                            term: {
                              'levelCredits.creator.name.keyword': {
                                value: searchValue,
                                case_insensitive: true
                              }
                            }
                          },
                          ...(field === 'charter' ? [{
                            term: {
                              'levelCredits.role.keyword': 'charter'
                            }
                          }] : []),
                          ...(field === 'vfxer' ? [{
                            term: {
                              'levelCredits.role.keyword': 'vfxer'
                            }
                          }] : [])
                        ]
                      }
                    }
                  }
                }
              ],
              minimum_should_match: 1
            }
          };
          return isNot ? { bool: { must_not: [query] } } : query;
        }

        // Handle download link search
        if (field === 'dllink') {
          const query = {
            term: {
              'dlLink.keyword': {
                value: searchValue,
                case_insensitive: true
              }
            }
          };
          return isNot ? { bool: { must_not: [query] } } : query;
        }

        if (field === 'legacydllink') {
          const query = {
            term: {
              'legacyDllink.keyword': {
                value: searchValue,
                case_insensitive: true
              }
            }
          };
          return isNot ? { bool: { must_not: [query] } } : query;
        }

        // Handle video link search
        if (field === 'videolink') {
          const wildcardValue = `*${searchValue}*`;
          const query = {
            bool: {
              should: [
                {
                  wildcard: {
                    'videoLink': {
                      value: wildcardValue,
                      case_insensitive: true
                    }
                  }
                }
              ],
              minimum_should_match: 1
            }
          };
          return isNot ? { bool: { must_not: [query] } } : query;
        }

        // Handle other exact matches
        const searchCondition = {
          term: {
            [`${field}.keyword`]: {
              value: searchValue,
              case_insensitive: true
            }
          }
        };

        // Handle team special case
        if (field === 'team') {
          const query = {
            bool: {
              should: [
                searchCondition,
                {
                  nested: {
                    path: 'teamObject',
                    query: {
                      bool: {
                        should: [
                          {
                            term: {
                              'teamObject.name.keyword': {
                                value: searchValue,
                                case_insensitive: true
                              }
                            }
                          },
                          ...(excludeAliases ? [] : [{
                            nested: {
                              path: 'teamObject.aliases',
                              query: {
                                term: {
                                  'teamObject.aliases.name.keyword': {
                                    value: searchValue,
                                    case_insensitive: true
                                  }
                                }
                              }
                            }
                          }])
                        ]
                      }
                    }
                  }
                }
              ]
            }
          };
          return isNot ? { bool: { must_not: [query] } } : query;
        }

        return isNot ? { bool: { must_not: [searchCondition] } } : searchCondition;
      }

      // For partial matches (using :), use wildcard query
      const wildcardValue = `*${searchValue}*`;

      // Handle role-based searches for partial matches
      if (field === 'charter' || field === 'vfxer' || field === 'creator') {
        const query = {
          bool: {
            should: [
              // Search in root level creator field
              {
                wildcard: {
                  'creator': {
                    value: wildcardValue,
                    case_insensitive: true
                  }
                }
              },
              // Search in nested levelCredits
              {
                nested: {
                  path: 'levelCredits',
                  query: {
                    bool: {
                      must: [
                        {
                          bool: {
                            should: [
                              {
                                wildcard: {
                                  'levelCredits.creator.name': {
                                    value: wildcardValue,
                                    case_insensitive: true
                                  }
                                }
                              },
                              ...(excludeAliases ? [] : [{
                                nested: {
                                  path: 'levelCredits.creator.creatorAliases',
                                  query: {
                                    wildcard: {
                                      'levelCredits.creator.creatorAliases.name': {
                                        value: wildcardValue,
                                        case_insensitive: true
                                      }
                                    }
                                  }
                                }
                              }])
                            ]
                          }
                        },
                        ...(field === 'charter' ? [{
                          term: {
                            'levelCredits.role.keyword': 'charter'
                          }
                        }] : []),
                        ...(field === 'vfxer' ? [{
                          term: {
                            'levelCredits.role.keyword': 'vfxer'
                          }
                        }] : [])
                      ]
                    }
                  }
                }
              }
            ],
            minimum_should_match: 1
          }
        };
        return isNot ? { bool: { must_not: [query] } } : query;
      }

      if (field === 'legacydllink') {
        const query = {
          wildcard: {
            'legacyDllink': {
              value: wildcardValue,
              case_insensitive: true
            }
          }
        };
        return isNot ? { bool: { must_not: [query] } } : query;
      }

      // Handle download link partial match
      if (field === 'dllink') {
        const query = {
          wildcard: {
            'dlLink': {
              value: wildcardValue,
              case_insensitive: true
            }
          }
        };
        return isNot ? { bool: { must_not: [query] } } : query;
      }

      // Handle video link partial match
      if (field === 'videolink') {
        const query = {
          wildcard: {
            'videoLink': {
              value: wildcardValue,
              case_insensitive: true
            }
          }
        };
        return isNot ? { bool: { must_not: [query] } } : query;
      }

      // Handle other partial matches
      const searchCondition = {
        wildcard: {
          [field]: {
            value: wildcardValue,
            case_insensitive: true
          }
        }
      };

      // Handle team special case
      if (field === 'team') {
        const query = {
          bool: {
            should: [
              searchCondition,
              {
                nested: {
                  path: 'teamObject',
                  query: {
                    bool: {
                      should: [
                        {
                          wildcard: {
                            'teamObject.name': {
                              value: wildcardValue,
                              case_insensitive: true
                            }
                          }
                        },
                        ...(excludeAliases ? [] : [{
                          nested: {
                            path: 'teamObject.aliases',
                            query: {
                              wildcard: {
                                'teamObject.aliases.name': {
                                  value: wildcardValue,
                                  case_insensitive: true
                                }
                              }
                            }
                          }
                        }])
                      ]
                    }
                  }
                }
              }
            ]
          }
        };
        return isNot ? { bool: { must_not: [query] } } : query;
      }

      return isNot ? { bool: { must_not: [searchCondition] } } : searchCondition;
    }

    // For general searches (field === 'any'), use wildcard search across all fields
    const wildcardValue = `*${searchValue}*`;
    const query = {
      bool: {
        should: [
          { wildcard: { song: { value: wildcardValue, case_insensitive: true } } },
          { wildcard: { artist: { value: wildcardValue, case_insensitive: true } } },
          { wildcard: { creator: { value: wildcardValue, case_insensitive: true } } },
          ...(excludeAliases ? [] : [{
            nested: {
              path: 'aliases',
              query: {
                wildcard: {
                  'aliases.alias': {
                    value: wildcardValue,
                    case_insensitive: true
                  }
                }
              }
            }
          }]),
          {
            nested: {
              path: 'levelCredits',
              query: {
                bool: {
                  should: [
                    {
                      wildcard: {
                        'levelCredits.creator.name': {
                          value: wildcardValue,
                          case_insensitive: true
                        }
                      }
                    },
                    ...(excludeAliases ? [] : [{
                      nested: {
                        path: 'levelCredits.creator.creatorAliases',
                        query: {
                          wildcard: {
                            'levelCredits.creator.creatorAliases.name': {
                              value: wildcardValue,
                              case_insensitive: true
                            }
                          }
                        }
                      }
                    }])
                  ]
                }
              }
            }
          }
        ]
      }
    };
    return isNot ? { bool: { must_not: [query] } } : query;
  }

  public async searchLevels(query: string, filters: any = {}): Promise<{ hits: any[], total: number }> {
    try {
      const must: any[] = [];
      const should: any[] = [];

      // Handle text search with new parsing
      if (query) {
        const searchGroups = this.parseSearchQuery(query.trim());
        if (searchGroups.length > 0) {
          const orConditions = searchGroups.map(group => {
            const andConditions = group.terms.map(term => this.buildFieldSearchQuery(term, filters.excludeAliases === 'true'));

            return andConditions.length === 1
              ? andConditions[0]
              : { bool: { must: andConditions } };
          });

          should.push(...orConditions);
        }
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

      if (filters.availableDlFilter === 'only') {
        must.push({
          bool: {
            should: [
              { term: { isExternallyAvailable: true } },
              {
                bool: {
                  must: [
                    { exists: { field: 'dlLink' } },
                    { 
                      bool: {
                        must_not: [
                          { term: { 'dlLink.keyword': '' } }
                        ]
                      }
                    }
                  ]
                }
              },
              {
                bool: {
                  must: [
                    { exists: { field: 'workshopLink' } },
                    { 
                      bool: {
                        must_not: [
                          { term: { 'workshopLink.keyword': '' } }
                        ]
                      }
                    }
                  ]
                }
              }
            ],
            minimum_should_match: 1
          }
        });
      } else if (filters.availableDlFilter === 'hide') {
        must.push({
          bool: {
            must_not: [
              {
                bool: {
                  should: [
                    { term: { isExternallyAvailable: true } },
                    {
                      bool: {
                        must: [
                          { exists: { field: 'dlLink' } },
                          { 
                            bool: {
                              must_not: [
                                { term: { 'dlLink.keyword': '' } }
                              ]
                            }
                          }
                        ]
                      }
                    },
                    {
                      bool: {
                        must: [
                          { exists: { field: 'workshopLink' } },
                          { 
                            bool: {
                              must_not: [
                                { term: { 'workshopLink.keyword': '' } }
                              ]
                            }
                          }
                        ]
                      }
                    }
                  ],
                  minimum_should_match: 1
                }
              }
            ]
          }
        });
      }

      // Handle hideVerified filter
      if (filters.hideVerified === 'true') {
        must.push({
          bool: {
            must: [
              {
                nested: {
                  path: 'levelCredits',
                  query: {
                    bool: {
                      must: [
                        { term: { 'levelCredits.isVerified': false } }
                      ]
                    }
                  }
                }
              }
            ]
          }
        });
      }

      // Handle liked levels filter
      if (filters.likedLevelIds?.length > 0) {
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

      // Validate and limit offset to prevent integer overflow
      const maxOffset = 2147483647; // Maximum 32-bit integer
      const maxResultWindow = 10000; // Elasticsearch's default max_result_window
      const offset = Math.min(Math.max(0, Number(filters.offset) || 0), maxOffset);
      const limit = Math.min(100, Math.max(1, Number(filters.limit) || 30));

      // If we need to access results beyond maxResultWindow, use scroll API
      if (offset + limit > maxResultWindow) {
        return this.searchLevelsWithScroll(searchQuery, filters.sort, offset, limit);
      }

      // Regular search for results within maxResultWindow
      const response = await client.search({
        index: levelIndexName,
        query: searchQuery,
        sort: this.getSortOptions(filters.sort),
        from: offset,
        size: limit
      });

      // Convert PUA characters back to original special characters in the results
      const hits = response.hits.hits.map(hit => {
        const source = hit._source as Record<string, any>;
        return this.convertPUAFields(source);
      });

      return {
        hits,
        total: response.hits.total ? (typeof response.hits.total === 'number' ? response.hits.total : response.hits.total.value) : 0
      };
    } catch (error) {
      logger.error('Error searching levels:', error);
      throw error;
    }
  }

  private async searchLevelsWithScroll(
    searchQuery: any,
    sort: string | undefined,
    offset: number,
    limit: number
  ): Promise<{ hits: any[], total: number }> {
    try {
      // Get sort options
      const sortOptions = this.getSortOptions(sort);
      
      // Check if we should use regular search instead of scroll
      if (this.shouldUseRegularSearch(sortOptions)) {
        logger.warn('Using regular search instead of scroll due to sort type');
        return this.searchLevelsWithRegularSearch(searchQuery, sortOptions, offset, limit);
      }

      // Initialize scroll with optimized settings
      const initialResponse = await client.search({
        index: levelIndexName,
        query: this.optimizeQueryForScroll(searchQuery),
        sort: sortOptions,
        size: Math.min(1000, offset + limit),
        scroll: '1m',
        track_total_hits: true, // Ensure accurate total count
        track_scores: true // Keep scores for sorting
      });

      const scrollId = initialResponse._scroll_id;
      let hits: any[] = [];
      let total = initialResponse.hits.total ? 
        (typeof initialResponse.hits.total === 'number' ? initialResponse.hits.total : initialResponse.hits.total.value) : 0;

      try {
        // Process initial batch
        hits = initialResponse.hits.hits.map(hit => {
          const source = hit._source as Record<string, any>;
          return this.convertPUAFields(source);
        });

        // If we need more results, continue scrolling
        let scrollCount = 0;
        const maxScrolls = Math.ceil((offset + limit) / 1000) + 1; // Add 1 for safety

        while (hits.length < offset + limit && scrollCount < maxScrolls) {
          const scrollResponse = await client.scroll({
            scroll_id: scrollId,
            scroll: '1m'
          });

          if (scrollResponse.hits.hits.length === 0) {
            break; // No more results
          }

          const newHits = scrollResponse.hits.hits.map(hit => {
            const source = hit._source as Record<string, any>;
            return this.convertPUAFields(source);
          });

          hits = hits.concat(newHits);
          scrollCount++;

          // Log progress for long-running scrolls
          if (scrollCount % 5 === 0) {
            logger.debug(`Scroll progress: ${hits.length} results fetched after ${scrollCount} scrolls`);
          }
        }

        // Slice the results to get the requested range
        hits = hits.slice(offset, offset + limit);

        return { hits, total };
      } finally {
        // Clean up scroll context
        if (scrollId) {
          await client.clearScroll({ scroll_id: scrollId });
        }
      }
    } catch (error) {
      logger.error('Error in scroll search:', error);
      throw error;
    }
  }

  private shouldUseRegularSearch(sortOptions: any[]): boolean {
    // Check if any sort option uses random or script
    return sortOptions.some(option => 
      option._script !== undefined || 
      (typeof option === 'object' && Object.keys(option).some(key => key === '_script'))
    );
  }

  private async searchLevelsWithRegularSearch(
    searchQuery: any,
    sortOptions: any[],
    offset: number,
    limit: number
  ): Promise<{ hits: any[], total: number }> {
    try {
      // For random sorting, we'll use a different approach
      if (this.isRandomSort(sortOptions)) {
        return this.searchLevelsWithRandomSort(searchQuery, offset, limit);
      }

      // For other cases, use regular search with increased max_result_window
      const response = await client.search({
        index: levelIndexName,
        query: searchQuery,
        sort: sortOptions,
        from: offset,
        size: limit,
        track_total_hits: true
      });

      const hits = response.hits.hits.map(hit => {
        const source = hit._source as Record<string, any>;
        return this.convertPUAFields(source);
      });

      return {
        hits,
        total: response.hits.total ? (typeof response.hits.total === 'number' ? response.hits.total : response.hits.total.value) : 0
      };
    } catch (error) {
      logger.error('Error in regular search:', error);
      throw error;
    }
  }

  private isRandomSort(sortOptions: any[]): boolean {
    return sortOptions.some(option => 
      option._script?.script === 'Math.random()'
    );
  }

  private async searchLevelsWithRandomSort(
    searchQuery: any,
    offset: number,
    limit: number
  ): Promise<{ hits: any[], total: number }> {
    try {
      // For random sorting, we'll use a different approach:
      // 1. Get total count
      const countResponse = await client.count({
        index: levelIndexName,
        query: searchQuery
      });

      const total = countResponse.count;

      // 2. Generate random offsets
      const randomOffsets = new Set<number>();
      while (randomOffsets.size < limit) {
        const randomOffset = Math.floor(Math.random() * total);
        randomOffsets.add(randomOffset);
      }

      // 3. Fetch results for each random offset
      const hits = await Promise.all(
        Array.from(randomOffsets).map(async (randomOffset) => {
          const response = await client.search({
            index: levelIndexName,
            query: searchQuery,
            from: randomOffset,
            size: 1
          });

          if (response.hits.hits.length > 0) {
            const source = response.hits.hits[0]._source as Record<string, any>;
            return this.convertPUAFields(source);
          }
          return null;
        })
      );

      return {
        hits: hits.filter(hit => hit !== null),
        total
      };
    } catch (error) {
      logger.error('Error in random sort search:', error);
      throw error;
    }
  }

  private optimizeQueryForScroll(searchQuery: any): any {
    // Create a deep copy of the query
    const optimizedQuery = JSON.parse(JSON.stringify(searchQuery));

    // Optimize wildcard queries
    if (optimizedQuery.bool) {
      if (optimizedQuery.bool.should) {
        optimizedQuery.bool.should = optimizedQuery.bool.should.map((should: any) => {
          if (should.wildcard) {
            // Convert leading wildcards to match_phrase for better performance
            Object.keys(should.wildcard).forEach(field => {
              const value = should.wildcard[field].value;
              if (value.startsWith('*') && !value.endsWith('*')) {
                should.match_phrase = {
                  [field]: value.substring(1)
                };
                delete should.wildcard;
              }
            });
          }
          return should;
        });
      }
    }

    return optimizedQuery;
  }

  private convertPUAFields(source: Record<string, any>): any {
    return {
      ...source,
      song: convertFromPUA(source.song as string),
      artist: convertFromPUA(source.artist as string),
      creator: convertFromPUA(source.creator as string),
      charter: convertFromPUA(source.charter as string),
      team: convertFromPUA(source.team as string),
      videoLink: convertFromPUA(source.videoLink as string),
      dlLink: convertFromPUA(source.dlLink as string),
      legacyDllink: convertFromPUA(source.legacyDllink as string),
      aliases: source.aliases?.map((alias: Record<string, any>) => ({
        ...alias,
        originalValue: convertFromPUA(alias.originalValue as string),
        alias: convertFromPUA(alias.alias as string)
      })),
      levelCredits: source.levelCredits?.map((credit: Record<string, any>) => ({
        ...credit,
        creator: credit.creator ? {
          ...credit.creator,
          name: convertFromPUA(credit.creator.name as string),
          creatorAliases: credit.creator.creatorAliases?.map((alias: Record<string, any>) => ({
            ...alias,
            name: convertFromPUA(alias.name as string)
          }))
        } : null
      })),
      teamObject: source.teamObject ? {
        ...source.teamObject,
        name: convertFromPUA(source.teamObject.name as string),
        aliases: source.teamObject.aliases?.map((alias: Record<string, any>) => ({
          ...alias,
          name: convertFromPUA(alias.name as string)
        }))
      } : null
    };
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
          const andTerms = term.split(',').map(t => {
            const trimmedTerm = t.trim();
            // Check for NOT operator
            const isNot = trimmedTerm.startsWith('\\!');
            const searchTerm = isNot ? trimmedTerm.slice(2) : trimmedTerm;
            return {
              term: prepareSearchTerm(searchTerm),
              isNot
            };
          });
          
          const termQueries = andTerms.map(({ term: andTerm, isNot }) => {
            const query = {
              bool: {
                should: [
                  { 
                    wildcard: { 
                      'player.name': { 
                        value: `*${andTerm}*`,
                        case_insensitive: true
                      } 
                    } 
                  },
                  { 
                    wildcard: { 
                      'level.song': { 
                        value: `*${andTerm}*`,
                        case_insensitive: true
                      } 
                    } 
                  },
                  { 
                    wildcard: { 
                      'level.artist': { 
                        value: `*${andTerm}*`,
                        case_insensitive: true
                      } 
                    } 
                  },
                  { 
                    wildcard: { 
                      'videoLink': { 
                        value: `*${andTerm}*`,
                        case_insensitive: true
                      } 
                    } 
                  },
                  { 
                    wildcard: { 
                      'vidTitle': { 
                        value: `*${andTerm}*`,
                        case_insensitive: true
                      } 
                    } 
                  },
                  {
                    wildcard: {
                      'level.dlLink': {
                        value: `*${andTerm}*`,
                        case_insensitive: true
                      }
                    }
                  }
                ],
                minimum_should_match: 1
              }
            };
            return isNot ? { bool: { must_not: [query] } } : query;
          });
          
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
        must.push({ term: { 'level.isHidden': false } });
        must.push({ term: { 'level.isDeleted': false } });
      } else if (filters.deletedFilter === 'only') {
        must.push({ term: { isDeleted: true } });
        must.push({ term: { 'level.isHidden': true } });
        must.push({ term: { 'level.isDeleted': true } });
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

      // Validate and limit offset to prevent integer overflow
      const maxOffset = 2147483647; // Maximum 32-bit integer
      const maxResultWindow = 10000; // Elasticsearch's default max_result_window
      const offset = Math.min(Math.max(0, Number(filters.offset) || 0), maxOffset);
      const limit = Math.min(100, Math.max(1, Number(filters.limit) || 30));

      // If we need to access results beyond maxResultWindow, use scroll API
      if (offset + limit > maxResultWindow) {
        return this.searchPassesWithScroll(searchQuery, filters.sort, offset, limit);
      }

      // Regular search for results within maxResultWindow
      const response = await client.search({
        index: passIndexName,
        query: searchQuery,
        sort: this.getPassSortOptions(filters.sort),
        from: offset,
        size: limit,
        track_total_hits: true
      });

      // Convert PUA characters back to original special characters in the results
      const hits = response.hits.hits.map(hit => {
        const source = hit._source as Record<string, any>;
        return this.convertPassPUAFields(source);
      });

      return {
        hits,
        total: response.hits.total ? (typeof response.hits.total === 'number' ? response.hits.total : response.hits.total.value) : 0
      };
    } catch (error) {
      logger.error('Error searching passes:', error);
      throw error;
    }
  }

  private async searchPassesWithScroll(
    searchQuery: any,
    sort: string | undefined,
    offset: number,
    limit: number
  ): Promise<{ hits: any[], total: number }> {
    try {
      // Get sort options
      const sortOptions = this.getPassSortOptions(sort);
      
      // Check if we should use regular search instead of scroll
      if (this.shouldUseRegularSearch(sortOptions)) {
        logger.warn('Using regular search instead of scroll due to sort type');
        return this.searchPassesWithRegularSearch(searchQuery, sortOptions, offset, limit);
      }

      // Initialize scroll with optimized settings
      const initialResponse = await client.search({
        index: passIndexName,
        query: this.optimizeQueryForScroll(searchQuery),
        sort: sortOptions,
        size: Math.min(1000, offset + limit),
        scroll: '1m',
        track_total_hits: true,
        track_scores: true
      });

      const scrollId = initialResponse._scroll_id;
      let hits: any[] = [];
      let total = initialResponse.hits.total ? 
        (typeof initialResponse.hits.total === 'number' ? initialResponse.hits.total : initialResponse.hits.total.value) : 0;

      try {
        // Process initial batch
        hits = initialResponse.hits.hits.map(hit => {
          const source = hit._source as Record<string, any>;
          return this.convertPassPUAFields(source);
        });

        // If we need more results, continue scrolling
        let scrollCount = 0;
        const maxScrolls = Math.ceil((offset + limit) / 1000) + 1; // Add 1 for safety

        while (hits.length < offset + limit && scrollCount < maxScrolls) {
          const scrollResponse = await client.scroll({
            scroll_id: scrollId,
            scroll: '1m'
          });

          if (scrollResponse.hits.hits.length === 0) {
            break; // No more results
          }

          const newHits = scrollResponse.hits.hits.map(hit => {
            const source = hit._source as Record<string, any>;
            return this.convertPassPUAFields(source);
          });

          hits = hits.concat(newHits);
          scrollCount++;

          // Log progress for long-running scrolls
          if (scrollCount % 5 === 0) {
            logger.debug(`Scroll progress: ${hits.length} results fetched after ${scrollCount} scrolls`);
          }
        }

        // Slice the results to get the requested range
        hits = hits.slice(offset, offset + limit);

        return { hits, total };
      } finally {
        // Clean up scroll context
        if (scrollId) {
          await client.clearScroll({ scroll_id: scrollId });
        }
      }
    } catch (error) {
      logger.error('Error in scroll search:', error);
      throw error;
    }
  }

  private async searchPassesWithRegularSearch(
    searchQuery: any,
    sortOptions: any[],
    offset: number,
    limit: number
  ): Promise<{ hits: any[], total: number }> {
    try {
      // For random sorting, we'll use a different approach
      if (this.isRandomSort(sortOptions)) {
        return this.searchPassesWithRandomSort(searchQuery, offset, limit);
      }

      // For other cases, use regular search with increased max_result_window
      const response = await client.search({
        index: passIndexName,
        query: searchQuery,
        sort: sortOptions,
        from: offset,
        size: limit,
        track_total_hits: true
      });

      const hits = response.hits.hits.map(hit => {
        const source = hit._source as Record<string, any>;
        return this.convertPassPUAFields(source);
      });

      return {
        hits,
        total: response.hits.total ? (typeof response.hits.total === 'number' ? response.hits.total : response.hits.total.value) : 0
      };
    } catch (error) {
      logger.error('Error in regular search:', error);
      throw error;
    }
  }

  private async searchPassesWithRandomSort(
    searchQuery: any,
    offset: number,
    limit: number
  ): Promise<{ hits: any[], total: number }> {
    try {
      // For random sorting, we'll use a different approach:
      // 1. Get total count
      const countResponse = await client.count({
        index: passIndexName,
        query: searchQuery
      });

      const total = countResponse.count;

      // 2. Generate random offsets
      const randomOffsets = new Set<number>();
      while (randomOffsets.size < limit) {
        const randomOffset = Math.floor(Math.random() * total);
        randomOffsets.add(randomOffset);
      }

      // 3. Fetch results for each random offset
      const hits = await Promise.all(
        Array.from(randomOffsets).map(async (randomOffset) => {
          const response = await client.search({
            index: passIndexName,
            query: searchQuery,
            from: randomOffset,
            size: 1
          });

          if (response.hits.hits.length > 0) {
            const source = response.hits.hits[0]._source as Record<string, any>;
            return this.convertPassPUAFields(source);
          }
          return null;
        })
      );

      return {
        hits: hits.filter(hit => hit !== null),
        total
      };
    } catch (error) {
      logger.error('Error in random sort search:', error);
      throw error;
    }
  }

  private convertPassPUAFields(source: Record<string, any>): any {
    return {
      ...source,
      vidTitle: convertFromPUA(source.vidTitle as string),
      videoLink: convertFromPUA(source.videoLink as string),
      player: source.player ? {
        ...source.player,
        name: convertFromPUA(source.player.name as string)
      } : null,
      level: source.level ? {
        ...source.level,
        song: convertFromPUA(source.level.song as string),
        artist: convertFromPUA(source.level.artist as string)
      } : null
    };
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