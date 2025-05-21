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

// Add these type definitions at the top of the file, after imports
type FieldSearch = {
  field: string;
  value: string;
  exact: boolean;
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

    // Level hooks should be external

    Level.addHook('afterUpdate', 'elasticsearchIndexUpdate', async (level: Level) => {
      await boundIndexLevel(level);
    });

    Level.addHook('afterDestroy', 'elasticsearchIndexDelete', async (level: Level) => {
      await boundDeleteLevel(level);
    });

    // Pass hooks should also be external

    Pass.addHook('afterUpdate', 'elasticsearchPassUpdate', async (pass: Pass) => {
      await boundIndexPass(pass);
    });

    Pass.addHook('afterDestroy', 'elasticsearchPassDelete', async (pass: Pass) => {
      await boundDeletePass(pass);
    });

    // LevelCredit hooks
    LevelCredit.addHook('afterCreate', 'elasticsearchCreditCreate', async (credit: LevelCredit) => {
      const level = await this.getLevelWithRelations(credit.get('levelId'));
      if (level) {
        await boundIndexLevel(level);
      }
    });

    LevelCredit.addHook('afterUpdate', 'elasticsearchCreditUpdate', async (credit: LevelCredit) => {
      const level = await this.getLevelWithRelations(credit.get('levelId'));
      if (level) {
        await boundIndexLevel(level);
      }
    });

    LevelCredit.addHook('afterDestroy', 'elasticsearchCreditDelete', async (credit: LevelCredit) => {
      const level = await this.getLevelWithRelations(credit.get('levelId'));
      if (level) {
        await boundIndexLevel(level);
      }
    });

    // Creator and Team hooks
    Creator.addHook('afterUpdate', 'elasticsearchCreatorUpdate', async (creator: Creator) => {
      const levels = await Level.findAll({
        include: [
          {
            model: LevelCredit,
            as: 'levelCredits',
            where: { creatorId: creator.id }
          }
        ]
      });
      for (const level of levels) {
        await boundIndexLevel(level);
      }
    });

    Team.addHook('afterUpdate', 'elasticsearchTeamUpdate', async (team: Team) => {
      const levels = await Level.findAll({
        where: { teamId: team.id }
      });
      for (const level of levels) {
        await boundIndexLevel(level);
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
        aliases: level.teamObject.aliases?.map(alias => ({
          ...alias.get({ plain: true }),
          name: convertToPUA(alias.name)
        }))
      } : null
    };
    return processedLevel as ILevel;
  }

  private async getPassWithRelations(passId: number): Promise<Pass | null> {
    return Pass.findByPk(passId, {
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
    const id = typeof level === 'number' ? level : level.id;
    try {
      const processedLevel = await this.getParsedLevel(id);
      if (processedLevel) {
        await client.index({
          index: levelIndexName,
          id: id.toString(),
          document: processedLevel
        });
      }
    } catch (error) {
      logger.error(`Error indexing level ${id}:`, error);
      throw error;
    }
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
              aliases: level.teamObject.aliases?.map(alias => ({
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
      logger.info(`Successfully indexed ${levels.length} levels in ${totalBatches} batches`);
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

  public async indexPass(pass: Pass): Promise<void> {
    try {
      logger.debug(`Indexing pass ${pass.id}`);
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
      logger.info(`Successfully indexed ${passes.length} passes in ${totalBatches} batches`);
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

    // Check for exact match with equals sign
    const exactMatch = trimmedTerm.match(/^(song|artist|charter|team|vfxer|creator)=(.+)$/i);
    if (exactMatch) {
      return {
        field: exactMatch[1].toLowerCase(),
        value: exactMatch[2].trim(),
        exact: true,
      };
    }

    // Check for partial match with colon
    const partialMatch = trimmedTerm.match(/^(song|artist|charter|team|vfxer|creator):(.+)$/i);
    if (partialMatch) {
      return {
        field: partialMatch[1].toLowerCase(),
        value: partialMatch[2].trim(),
        exact: false,
      };
    }

    return null;
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

  private buildFieldSearchQuery(fieldSearch: FieldSearch): any {
    const { field, value, exact } = fieldSearch;
    const searchValue = prepareSearchTerm(value);

    // For field-specific searches
    if (field !== 'any') {
      // For exact matches (using =), use term query with case-insensitive match
      if (exact) {
        // Handle role-based searches (charter, vfxer, creator)
        if (field === 'charter' || field === 'vfxer' || field === 'creator') {
          return {
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
          return {
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
                          {
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
                          }
                        ]
                      }
                    }
                  }
                }
              ]
            }
          };
        }

        return searchCondition;
      }

      // For partial matches (using :), use wildcard query
      const wildcardValue = `*${searchValue}*`;

      // Handle role-based searches for partial matches
      if (field === 'charter' || field === 'vfxer' || field === 'creator') {
        return {
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
                              {
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
                              }
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
        return {
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
                        {
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
                        }
                      ]
                    }
                  }
                }
              }
            ]
          }
        };
      }

      return searchCondition;
    }

    // For general searches (field === 'any'), use wildcard search across all fields
    const wildcardValue = `*${searchValue}*`;
    return {
      bool: {
        should: [
          { wildcard: { song: { value: wildcardValue, case_insensitive: true } } },
          { wildcard: { artist: { value: wildcardValue, case_insensitive: true } } },
          { wildcard: { creator: { value: wildcardValue, case_insensitive: true } } },
          {
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
          },
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
                    {
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
                    }
                  ]
                }
              }
            }
          }
        ]
      }
    };
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
            const andConditions = group.terms.map(term => this.buildFieldSearchQuery(term));

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

      // Log the query for debugging
      const debugQuery = {
        index: levelIndexName,
        query: searchQuery,
        sort: this.getSortOptions(filters.sort),
        from: filters.offset || 0,
        size: filters.limit || 30
      };
      
      logger.debug('Elasticsearch Query:', debugQuery);

      const response = await client.search(debugQuery);

      // Convert PUA characters back to original special characters in the results
      const hits = response.hits.hits.map(hit => {
        const source = hit._source as Record<string, any>;
        return {
          ...source,
          song: convertFromPUA(source.song as string),
          artist: convertFromPUA(source.artist as string),
          creator: convertFromPUA(source.creator as string),
          charter: convertFromPUA(source.charter as string),
          team: convertFromPUA(source.team as string),
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
          const andTerms = term.split(',').map(t => prepareSearchTerm(t.trim()));
          
          const termQueries = andTerms.map(andTerm => ({
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

      // Handle pagination
      const offset = Math.max(0, Number(filters.offset) || 0);
      const limit = Math.min(100, Math.max(1, Number(filters.limit) || 30));

      const response = await client.search({
        index: passIndexName,
        query: searchQuery,
        sort: this.getPassSortOptions(filters.sort),
        from: offset,
        size: limit,
        track_total_hits: true // Ensure we get accurate total count
      });

      // Convert PUA characters back to original special characters in the results
      const hits = response.hits.hits.map(hit => {
        const source = hit._source as Record<string, any>;
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