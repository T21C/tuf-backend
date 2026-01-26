import client, {
  levelIndexName,
  passIndexName,
  initializeElasticsearch,
  updateMappingHash
} from '../../config/elasticsearch.js';
import { logger } from './LoggerService.js';
import { ILevel, IPass } from '../interfaces/models/index.js';
import { Op } from 'sequelize';
import Level from '../../models/levels/Level.js';
import Difficulty from '../../models/levels/Difficulty.js';
import LevelAlias from '../../models/levels/LevelAlias.js';
import LevelCredit from '../../models/levels/LevelCredit.js';
import LevelTag from '../../models/levels/LevelTag.js';
import Creator from '../../models/credits/Creator.js';
import Team from '../../models/credits/Team.js';
import Pass from '../../models/passes/Pass.js';
import Player from '../../models/players/Player.js';
import Judgement from '../../models/passes/Judgement.js';
import { CreatorAlias } from '../../models/credits/CreatorAlias.js';
import { TeamAlias } from '../../models/credits/TeamAlias.js';
import { prepareSearchTerm, convertToPUA, convertFromPUA } from '../../misc/utils/data/searchHelpers.js';
import sequelize from '../../config/db.js';
import LevelLikes from '../../models/levels/LevelLikes.js';
import Rating from '../../models/levels/Rating.js';
import { formatCreatorDisplay, safeTransactionRollback } from '../../misc/utils/Utility.js';
import User from '../../models/auth/User.js';
import Curation from '../../models/curations/Curation.js';
import CurationType from '../../models/curations/CurationType.js';
import { parseSearchQuery, queryParserConfigs, type FieldSearch, type SearchGroup } from '../../misc/utils/data/queryParser.js';
import LevelTagAssignment from '../../models/levels/LevelTagAssignment.js';
import Song from '../../models/songs/Song.js';
import SongAlias from '../../models/songs/SongAlias.js';
import SongCredit from '../../models/songs/SongCredit.js';
import Artist from '../../models/artists/Artist.js';
import ArtistAlias from '../../models/artists/ArtistAlias.js';

const MAX_BATCH_SIZE = 4000;
const BATCH_SIZE = 500;


class ElasticsearchService {
  private static instance: ElasticsearchService;
  private isInitialized = false;

  private constructor() {}

  public static getInstance(): ElasticsearchService {
    if (!ElasticsearchService.instance) {
      ElasticsearchService.instance = new ElasticsearchService();
    }
    return ElasticsearchService.instance;
  }

  private isBeingInitialized: boolean = false;
  public async initialize(): Promise<void> {
    if (this.isInitialized || this.isBeingInitialized) {
      logger.info(`ElasticsearchService ${this.isInitialized ? 'already' : 'is being'} initialized`);
      return;
    }
    this.isBeingInitialized = true;
    try {
      logger.info('Starting ElasticsearchService initialization...');

      // Initialize Elasticsearch indices
      const needsReindex = await initializeElasticsearch();

      // Set up database change listeners
      this.setupChangeListeners()
      logger.info('Database change listeners set up successfully');


      if (needsReindex) {
        logger.info('Starting data reindexing...');
        const start = Date.now();
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
        const end = Date.now();
        logger.info(`Data reindexing completed successfully in ${Math.round((end - start)/100)/10}s`);
        updateMappingHash();
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

  private setupChangeListeners() {
    // Remove existing hooks first to prevent duplicates
    Pass.removeHook('beforeSave', 'elasticsearchPassUpdate');
    LevelLikes.removeHook('beforeSave', 'elasticsearchLevelLikesUpdate');
    Level.removeHook('beforeSave', 'elasticsearchLevelUpdate');
    Pass.removeHook('afterBulkUpdate', 'elasticsearchPassBulkUpdate');
    Pass.removeHook('afterBulkCreate', 'elasticsearchPassBulkCreate');
    Level.removeHook('beforeBulkUpdate', 'elasticsearchLevelBeforeBulkUpdate');
    Level.removeHook('afterBulkUpdate', 'elasticsearchLevelBulkUpdate');
    LevelTag.removeHook('afterBulkUpdate', 'elasticsearchLevelTagBulkUpdate');
    LevelTagAssignment.removeHook('afterBulkCreate', 'elasticsearchLevelTagAssignmentBulkCreate');
    LevelTagAssignment.removeHook('afterBulkDestroy', 'elasticsearchLevelTagAssignmentBulkDelete');
    Curation.removeHook('beforeSave', 'elasticsearchCurationUpdate');
    Curation.removeHook('afterBulkUpdate', 'elasticsearchCurationBulkUpdate');

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
      logger.debug('Pass bulk update hook triggered');
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
        logger.error('Error in pass afterBulkUpdate hook:', error);
      }
    });

    // Add afterBulkCreate hook for Pass model (for bulkCreate with updateOnDuplicate)
    Pass.addHook('afterBulkCreate', 'elasticsearchPassBulkCreate', async (instances: Pass[], options: any) => {
      logger.debug(`Pass bulk create hook triggered for ${instances.length} passes`);
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            if (instances.length > 0) {
              // Get unique level IDs from the passes
              const levelIds = Array.from(new Set(instances.map(pass => pass.levelId)));
              const passIds = instances.map(pass => pass.id);
              
              logger.debug(`Bulk indexing ${passIds.length} passes and ${levelIds.length} levels after bulk create`);
              
              // Bulk index all affected passes
              await this.reindexPasses(passIds);
              
              // Update all affected levels
              for (const levelId of levelIds) {
                await this.indexLevel(levelId);
              }
            }
          });
        } else {
          if (instances.length > 0) {
            const levelIds = Array.from(new Set(instances.map(pass => pass.levelId)));
            const passIds = instances.map(pass => pass.id);
            
            await this.reindexPasses(passIds);
            
            for (const levelId of levelIds) {
              await this.indexLevel(levelId);
            }
          }
        }
      } catch (error) {
        logger.error('Error in pass afterBulkCreate hook:', error);
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

    // Add beforeBulkUpdate hook to capture affected level IDs before update
    // This is needed because the WHERE clause might reference fields that get updated
    Level.addHook('beforeBulkUpdate', 'elasticsearchLevelBeforeBulkUpdate', async (options: any) => {
      try {
        if (options.where) {
          // Find affected level IDs BEFORE the update happens
          const affectedLevels = await Level.findAll({ 
            where: options.where, 
            attributes: ['id'],
            transaction: options.transaction 
          });
          // Store the IDs in options so afterBulkUpdate can use them
          options.affectedLevelIds = affectedLevels.map(level => level.id);
          logger.debug(`Found ${options.affectedLevelIds.length} levels to reindex before bulk update`);
        }
      } catch (error) {
        logger.error('Error in level beforeBulkUpdate hook:', error);
      }
    });

    // Add afterBulkUpdate hook for Level model
    Level.addHook('afterBulkUpdate', 'elasticsearchLevelBulkUpdate', async (options: any) => {
      logger.debug('Level bulk update hook triggered');
      try {
        // Use pre-captured IDs if available (from beforeBulkUpdate hook)
        // Otherwise fall back to finding by WHERE clause (for cases where WHERE fields weren't updated)
        let levelIds: number[] = [];
        
        if (options.affectedLevelIds && options.affectedLevelIds.length > 0) {
          // Use IDs captured before the update
          levelIds = options.affectedLevelIds;
        } else if (options.where) {
          // Fallback: try to find by WHERE clause (works if WHERE fields weren't updated)
          const foundLevels = await Level.findAll({ 
            where: options.where, 
            attributes: ['id'],
            transaction: options.transaction 
          });
          levelIds = foundLevels.map(level => level.id);
        }

        if (levelIds.length > 0) {
          if (options.transaction) {
            await options.transaction.afterCommit(async () => {
              logger.debug(`Indexing ${levelIds.length} levels after bulk update`);
              await this.reindexLevels(levelIds);
            });
          } else {
            logger.debug(`Indexing ${levelIds.length} levels after bulk update`);
            await this.reindexLevels(levelIds);
          }
        } else {
          logger.debug('No levels found to reindex after bulk update');
        }
      } catch (error) {
        logger.error('Error in level afterBulkUpdate hook:', error);
      }
    });

    // Add hooks for Curation model

    Curation.addHook('beforeSave', 'elasticsearchCurationUpdate', async (curation: Curation, options: any) => {
      logger.debug(`Curation saved hook triggered for curation ${curation.id} (level ${curation.levelId})`);
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            logger.debug(`Indexing level ${curation.levelId} after curation transaction commit`);
            await this.indexLevel(curation.levelId);
          });
        } else {
          logger.debug(`Indexing level ${curation.levelId} outside of curation transaction`);
          await this.indexLevel(curation.levelId);
        }
      } catch (error) {
        logger.error(`Error in curation afterSave hook for level ${curation.levelId}:`, error);
      }
      return;
    });

    // Add afterBulkUpdate hook for Curation model
    Curation.addHook('afterBulkUpdate', 'elasticsearchCurationBulkUpdate', async (options: any) => {
      logger.debug('Curation bulk update hook triggered');
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            // If we have a specific curation ID, update that curation's level
            if (options.where?.id) {
              const curation = await Curation.findByPk(options.where.id);
              if (curation) {
                logger.debug(`Indexing level ${curation.levelId} after curation bulk update`);
                await this.indexLevel(curation.levelId);
              }
            }
            // If we have a levelId directly, update that level
            if (options.where?.levelId) {
              logger.debug(`Indexing level ${options.where.levelId} after curation bulk update`);
              await this.indexLevel(options.where.levelId);
            }
          });
        } else {
          if (options.where?.id) {
            const curation = await Curation.findByPk(options.where.id);
            if (curation) {
              await this.indexLevel(curation.levelId);
            }
          }
          if (options.where?.levelId) {
            await this.indexLevel(options.where.levelId);
          }
        }
      } catch (error) {
        logger.error('Error in curation afterBulkUpdate hook:', error);
      }
    });

    LevelTagAssignment.addHook('afterBulkCreate', 'elasticsearchLevelTagAssignmentBulkCreate', async (options: any) => {
      logger.debug(`LevelTagAssignment bulk create hook triggered`, options[0].levelId);
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            await this.reindexLevels([options[0].levelId]);
          });
        } else {
          await this.reindexLevels([options[0].levelId]);
        }
      }
      catch (error) {
        logger.error('Error in level tag assignment afterBulkCreate hook:', error);
      }
    });

    LevelTagAssignment.addHook('afterBulkDestroy', 'elasticsearchLevelTagAssignmentDestroy', async (options: any) => {
      logger.debug(`LevelTagAssignment destroy hook triggered`, options.where.levelId);
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            await this.reindexLevels([options.where.levelId]);
          });
        } else {
          await this.reindexLevels([options.where.levelId]);
        }
      }
      catch (error) {
        logger.error('Error in level tag assignment afterDestroy hook:', error);
      }
    });
  }
  



  private levelIncludes = [
      {
        model: Difficulty,
        as: 'difficulty'
      },
      {
        model: LevelAlias,
        as: 'aliases',
        attributes: ['alias']
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
                as: 'creatorAliases',
                attributes: ['name']
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
            as: 'teamAliases',
            attributes: ['name']
          }
        ]
      },
      {
        model: Curation,
        as: 'curation',
        include: [
          {
            model: CurationType,
            as: 'type'
          }
        ]
      },
      {
        model: Rating,
        as: 'ratings',
        where: {
          [Op.not]: {confirmedAt: null}
        },
        limit: 1,
        required: false,
        order: [['confirmedAt', 'DESC']] as any,
        attributes: ['id', 'levelId', 'currentDifficultyId', 'lowDiff', 'requesterFR', 'averageDifficultyId', 'communityDifficultyId', 'confirmedAt']
      },
      {
        model: LevelTag,
        as: 'tags',
        required: false,
        through: {
          attributes: []
        }
      },
      {
        model: Song,
        as: 'songObject',
        required: false,
        include: [
          {
            model: SongAlias,
            as: 'aliases',
            attributes: ['alias']
          },
          {
            model: SongCredit,
            as: 'credits',
            include: [
              {
                model: Artist,
                as: 'artist',
                include: [
                  {
                    model: ArtistAlias,
                    as: 'aliases',
                    attributes: ['alias']
                  }
                ]
              }
            ]
          }
        ]
      }
    ];

  private passIncludes = [
    {
    model: Player,
    as: 'player',
    attributes: ['name', 'country', 'isBanned'],
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['avatarUrl', 'username']
      }
    ]
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
            as: 'teamAliases',
            attributes: ['name']
          }
        ]
      },
      {
        model: LevelAlias,
        as: 'aliases',
        attributes: ['alias']
      },
      {
        model: LevelTag,
        as: 'tags',
        required: false,
        through: {
          attributes: []
        }
      }
    ]
  },
  {
    model: Judgement,
    as: 'judgements'
  }
]

  private async getLevelWithRelations(levelId: number): Promise<Level | null> {
    logger.debug(`Getting level with relations for level ${levelId}`);
    const level = await Level.findByPk(levelId,
      {include: this.levelIncludes}
    );
    if (!level) return null;
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
    logger.debug(`Level ${level.id} curationtype: ${level.curation?.type?.name}`);
    level.clears = clears;
    logger.debug(`Level ${level.id} has ${clears} clears`);
    return level;
  }


  private parseFields(level: Level): any {
    // Get normalized song data
    // For nested type in Elasticsearch, we need to provide an array
    const songObject = level.songObject ? {
      id: level.songObject.id,
      name: convertToPUA(level.songObject.name),
      verificationState: level.songObject.verificationState,
      aliases: (level.songObject.aliases || []).map(alias => ({
        alias: convertToPUA(alias.alias)
      }))
    } : null;

    // Get normalized artists data (from song credits)
    const artists = level.songObject?.credits?.map(credit => ({
      id: credit.artist.id,
      name: convertToPUA(credit.artist.name),
      avatarUrl: credit.artist.avatarUrl,
      verificationState: credit.artist.verificationState,
      role: credit.role,
      aliases: credit.artist.aliases?.map(alias => ({
        alias: convertToPUA(alias.alias)
      })) || []
    })) || [];

    return {
        ...level.get({ plain: true }),
        song: convertToPUA(level.song), // Keep text field for backward compatibility
        artist: convertToPUA(level.artist), // Keep text field for backward compatibility
        songId: level.songId || null,
        suffix: level.suffix ? convertToPUA(level.suffix) : null,
        // For nested type, use array format. Omit field if null to avoid empty array issues
        songObject: songObject ? {
          ...songObject,
          name: convertToPUA(songObject.name),
          verificationState: songObject.verificationState,
          aliases: songObject.aliases?.map(alias => ({
            alias: convertToPUA(alias.alias)
          }))
        } : null,
        artists: artists.length > 0 ? artists.map(artist => ({
          ...artist,
          name: convertToPUA(artist.name),
          avatarUrl: artist.avatarUrl,
          verificationState: artist.verificationState,
          role: artist.role,
          aliases: artist.aliases?.map(alias => ({
            alias: convertToPUA(alias.alias)
          }))
        })) : null,
        team: convertToPUA(level.teamObject?.name),
        videoLink: level.videoLink ? convertToPUA(level.videoLink) : null,
        dlLink: level.dlLink ? convertToPUA(level.dlLink) : null,
        legacyDllink: level.legacyDllink ? convertToPUA(level.legacyDllink) : null,
        // Process nested fields
        aliases: level.aliases?.map(alias => ({
          alias: convertToPUA(alias.alias)
        })),
        creator: convertToPUA(formatCreatorDisplay(level)),
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
        rating: {
          ...level.ratings?.[0]?.get({ plain: true }),
        },
        teamObject: level.teamObject ? {
          ...level.teamObject.get({ plain: true }),
          name: convertToPUA(level.teamObject.name),
          aliases: level.teamObject.teamAliases?.map(alias => ({
            ...alias.get({ plain: true }),
            name: convertToPUA(alias.name)
          }))
        } : null,
        curation: level.curation ? {
          ...level.curation.get({ plain: true }),
        } : null,
        isCurated: !!level.curation,
        tags: ((level as any).tags as LevelTag[] | undefined)?.map((tag: LevelTag) => ({
          id: tag.id,
          name: tag.name,
          icon: tag.icon,
          color: tag.color,
          group: tag.group
        })) || []

    };
  }

  private async getParsedLevel(id: number): Promise<ILevel | null> {
    const level = await this.getLevelWithRelations(id);
    if (!level) return null;
    const processedLevel = this.parseFields(level);
    logger.debug(`Processed level ${id} videoLink: ${processedLevel.videoLink}`);
    return processedLevel as ILevel;
  }

  private async getPassWithRelations(passId: number): Promise<Pass | null> {
    const transaction = await sequelize.transaction();
    try {
      const pass = await Pass.findByPk(passId, {
        include: this.passIncludes
    });
    await transaction.commit();
    return pass;
    } catch (error) {
      await safeTransactionRollback(transaction);
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
      const totalBatches = Math.ceil(levels.length / BATCH_SIZE);
      // Process in batches for Elasticsearch
      for (let i = 0; i < levels.length; i += BATCH_SIZE) {
        const batch = levels.slice(i, i + BATCH_SIZE);

        const operations = batch.flatMap(level => {
          const processedLevel = this.parseFields(level);
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
          name: convertToPUA(pass.player.name),
          username: pass.player.user?.username,
          avatarUrl: pass.player.user?.avatarUrl || null
        } : null,
        level: pass.level ? {
          ...pass.level.get({ plain: true }),
          song: convertToPUA(pass.level.song),
          artist: convertToPUA(pass.level.artist),
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
              name: convertToPUA(pass.player.name),
              username: pass.player.user?.username,
              avatarUrl: pass.player.user?.avatarUrl || null
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
      const whereClause = levelIds ? { id: { [Op.in]: levelIds } } : undefined;
      let offset = 0;
      let processedCount = 0;

      // Fetch first batch
      let levels = await Level.findAll({
        where: whereClause,
        include: this.levelIncludes as any,
        offset: offset,
        limit: MAX_BATCH_SIZE
      });

      while (levels.length > 0) {
        const currentBatchSize = levels.length;

        // Concurrently fetch next batch and index current batch
        const nextLevels = await Promise.all([
          this.bulkIndexLevels(levels),
          levels.length === MAX_BATCH_SIZE
            ? Level.findAll({
                where: whereClause,
                include: this.levelIncludes as any,
                offset: offset + MAX_BATCH_SIZE,
                limit: MAX_BATCH_SIZE
              })
            : Promise.resolve([])
        ]).then(([_, next]) => next);

        processedCount += currentBatchSize;
        logger.debug(`Reindexed ${processedCount} levels...`);

        // Move to next batch
        offset += MAX_BATCH_SIZE;
        levels = nextLevels;
      }

      logger.debug(`Reindexing complete. Total levels indexed: ${processedCount}`);
    } catch (error) {
      logger.error('Error reindexing levels:', error);
      throw error;
    }
  }


  public async reindexPasses(passIds?: number[]): Promise<void> {
    try {
      const whereClause = passIds ? { id: { [Op.in]: passIds } } : undefined;
      let offset = 0;
      let processedCount = 0;

      // Fetch first batch
      let passes = await Pass.findAll({
        where: whereClause,
        include: this.passIncludes as any,
        offset: offset,
        limit: MAX_BATCH_SIZE
      });

      while (passes.length > 0) {
        const currentBatchSize = passes.length;

        // Concurrently fetch next batch and index current batch
        const nextPasses = await Promise.all([
          this.bulkIndexPasses(passes),
          passes.length === MAX_BATCH_SIZE
            ? Pass.findAll({
                where: whereClause,
                include: this.passIncludes as any,
                offset: offset + MAX_BATCH_SIZE,
                limit: MAX_BATCH_SIZE
              })
            : Promise.resolve([])
        ]).then(([_, next]) => next);

        processedCount += currentBatchSize;
        logger.debug(`Reindexed ${processedCount} passes...`);

        // Move to next batch
        offset += MAX_BATCH_SIZE;
        passes = nextPasses;
      }

      logger.debug(`Reindexing complete. Total passes indexed: ${processedCount}`);
    } catch (error) {
      logger.error('Error reindexing passes:', error);
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

  private async resolveCurationTypes(curationTypeNames?: string[]): Promise<number[]> {
    try {
      if (!curationTypeNames?.length) return [];

      const curationTypes = await CurationType.findAll({
        where: {
          name: { [Op.in]: curationTypeNames },
        },
        attributes: ['id'],
      });

      return curationTypes.map(t => t.id);
    } catch (error) {
      logger.error('Error resolving curation types:', error);
      return [];
    }
  }

  private async resolveTags(tagNames?: string[]): Promise<number[]> {
    try {
      if (!tagNames?.length) return [];

      const tags = await LevelTag.findAll({
        where: {
          name: { [Op.in]: tagNames },
        },
        attributes: ['id'],
      });

      return tags.map(t => t.id);
    } catch (error) {
      logger.error('Error resolving tags:', error);
      return [];
    }
  }

  private parseSearchQuery(query: string, isPassSearch = false): SearchGroup[] {
    const config = isPassSearch ? queryParserConfigs.pass : queryParserConfigs.level;
    const groups = parseSearchQuery(query, config);

    // Convert all values to PUA for Elasticsearch
    return groups.map(group => ({
      ...group,
      terms: group.terms.map(term => ({
        ...term,
        value: convertToPUA(term.value)
      }))
    }));
  }

  private buildFieldSearchQuery(fieldSearch: FieldSearch, excludeAliases = false): any {
    const { field, value, exact, isNot } = fieldSearch;
    // Note: value is already converted to PUA in parseFieldSearch
    const searchValue = prepareSearchTerm(value);
    logger.debug(`Building search query - Field: ${field}, PUA value: ${value}, Prepared value: ${searchValue}`);

    // Check if this is a numeric field (like id)
    const numericFields = queryParserConfigs.level.numericFields || [];
    const isNumericField = numericFields.includes(field);

    // Handle numeric fields specially
    if (isNumericField && field !== 'any') {
      const numericValue = parseInt(searchValue, 10);

      // For numeric fields, use term query for exact matches
      if (!isNaN(numericValue)) {
        const query = {
          term: {
            [field]: numericValue
          }
        };
        return isNot ? { bool: { must_not: [query] } } : query;
      } else {
        return { bool: { must_not: [{ match_all: {} }] } };
      }
    }

    // For field-specific searches
    if (field !== 'any') {
      const wildcardValue = exact ? searchValue : `*${searchValue}*`;
      // Handle role-based searches for partial matches
      if (field === 'charter' || field === 'vfxer' || field === 'creator') {
        const query = {
          nested: {
            path: 'levelCredits',
            query: {
              bool: {
                must: [
                  // Check creator name/alias
                  {
                    nested: {
                      path: 'levelCredits.creator',
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
                          ],
                          minimum_should_match: 1
                        }
                      }
                    }
                  },
                  // Check role (only for charter/vfxer)
                  ...(field === 'charter' || field === 'vfxer' ? [{
                    term: {
                      'levelCredits.role': {
                        value: field,
                        case_insensitive: true
                      }
                    }
                  }] : [])
                ]
              }
            }
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

      // Handle song search (prefer normalized, fallback to text)
      if (field === 'song') {
        const query = {
          bool: {
            should: [
              // Search normalized song
              {
                nested: {
                  path: 'songObject',
                  ignore_unmapped: true,
                  query: {
                    bool: {
                      should: [
                        {
                          wildcard: {
                            'songObject.name': {
                              value: wildcardValue,
                              case_insensitive: true
                            }
                          }
                        },
                        ...(excludeAliases ? [] : [{
                          nested: {
                            path: 'songObject.aliases',
                            ignore_unmapped: true,
                            query: {
                              wildcard: {
                                'songObject.aliases.alias': {
                                  value: wildcardValue,
                                  case_insensitive: true
                                }
                              }
                            }
                          }
                        }])
                      ],
                      minimum_should_match: 1
                    }
                  }
                }
              },
              // Fallback to text field
              {
                wildcard: {
                  song: {
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

      // Handle artist search (prefer normalized, fallback to text)
      if (field === 'artist') {
        const query = {
          bool: {
            should: [
              // Search normalized primary artist
              {
                nested: {
                  path: 'primaryArtist',
                  ignore_unmapped: true,
                  query: {
                    bool: {
                      should: [
                        {
                          wildcard: {
                            'primaryArtist.name': {
                              value: wildcardValue,
                              case_insensitive: true
                            }
                          }
                        },
                        ...(excludeAliases ? [] : [{
                          nested: {
                            path: 'primaryArtist.aliases',
                            ignore_unmapped: true,
                            query: {
                              wildcard: {
                                'primaryArtist.aliases.alias': {
                                  value: wildcardValue,
                                  case_insensitive: true
                                }
                              }
                            }
                          }
                        }])
                      ],
                      minimum_should_match: 1
                    }
                  }
                }
              },
              // Search normalized artists array
              {
                nested: {
                  path: 'artists',
                  ignore_unmapped: true,
                  query: {
                    bool: {
                      should: [
                        {
                          wildcard: {
                            'artists.name': {
                              value: wildcardValue,
                              case_insensitive: true
                            }
                          }
                        },
                        ...(excludeAliases ? [] : [{
                          nested: {
                            path: 'artists.aliases',
                            ignore_unmapped: true,
                            query: {
                              wildcard: {
                                'artists.aliases.alias': {
                                  value: wildcardValue,
                                  case_insensitive: true
                                }
                              }
                            }
                          }
                        }])
                      ],
                      minimum_should_match: 1
                    }
                  }
                }
              },
              // Fallback to text field
              {
                wildcard: {
                  artist: {
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
    const wildcardValue = exact ? searchValue : `*${searchValue}*`;
    const query = {
      bool: {
        should: [
          // Search normalized song
          {
            nested: {
              path: 'songObject',
              ignore_unmapped: true,
              query: {
                bool: {
                  should: [
                    { wildcard: { 'songObject.name': { value: wildcardValue, case_insensitive: true } } },
                    ...(excludeAliases ? [] : [{
                      nested: {
                        path: 'songObject.aliases',
                        ignore_unmapped: true,
                        query: {
                          wildcard: { 'songObject.aliases.alias': { value: wildcardValue, case_insensitive: true } }
                        }
                      }
                    }])
                  ],
                  minimum_should_match: 1
                }
              }
            }
          },
          // Fallback to text song field
          { wildcard: { song: { value: wildcardValue, case_insensitive: true } } },
          // Search normalized artists
          {
            nested: {
              path: 'primaryArtist',
              ignore_unmapped: true,
              query: {
                bool: {
                  should: [
                    { wildcard: { 'primaryArtist.name': { value: wildcardValue, case_insensitive: true } } },
                    ...(excludeAliases ? [] : [{
                      nested: {
                        path: 'primaryArtist.aliases',
                        ignore_unmapped: true,
                        query: {
                          wildcard: { 'primaryArtist.aliases.alias': { value: wildcardValue, case_insensitive: true } }
                        }
                      }
                    }])
                  ],
                  minimum_should_match: 1
                }
              }
            }
          },
          {
            nested: {
              path: 'artists',
              ignore_unmapped: true,
              query: {
                bool: {
                  should: [
                    { wildcard: { 'artists.name': { value: wildcardValue, case_insensitive: true } } },
                    ...(excludeAliases ? [] : [{
                      nested: {
                        path: 'artists.aliases',
                        ignore_unmapped: true,
                        query: {
                          wildcard: { 'artists.aliases.alias': { value: wildcardValue, case_insensitive: true } }
                        }
                      }
                    }])
                  ],
                  minimum_should_match: 1
                }
              }
            }
          },
          // Fallback to text artist field
          { wildcard: { artist: { value: wildcardValue, case_insensitive: true } } },
          {
            nested: {
              path: 'levelCredits',
              query: {
                nested: {
                  path: 'levelCredits.creator',
                  query: {
                    bool: {
                      should: [
                        { wildcard: { 'levelCredits.creator.name': { value: wildcardValue, case_insensitive: true } } },
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
            }
          },
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
          }

        ]
      }
    };
    return isNot ? { bool: { must_not: [query] } } : query;
  }

  public async searchLevels(query: string, filters: any = {}, isSuperAdmin = false): Promise<{ hits: any[], total: number }> {
    try {
      const must: any[] = [];
      const should: any[] = [];



      // Handle text search with new parsing
      if (query) {
        if (query.length > 255) {
          query = query.substring(0, 255);
        }
        const searchGroups = this.parseSearchQuery(query.trim(), false);
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
      if (!filters.deletedFilter || filters.deletedFilter === 'hide') {
        must.push({ term: { isDeleted: false } });
      } else if (filters.deletedFilter === 'only' && isSuperAdmin) {
        must.push({ bool: { should: [
          { term: { isDeleted: true } }, 
          { term: { isHidden: true } }
        ] } });
      } else if (!isSuperAdmin) {
        must.push({ term: { isDeleted: false } })
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

      // Handle curated types filter
      if (filters.curatedTypesFilter === 'only') {
        must.push({ term: { isCurated: true } });
      } else if (filters.curatedTypesFilter === 'hide') {
        must.push({ term: { isCurated: false } });
      } else if (filters.curatedTypesFilter && filters.curatedTypesFilter !== 'show') {
        // Handle specific curation type names (comma-separated)
        const curationTypeNames = filters.curatedTypesFilter.split(',').map((name: string) => name.trim());
        if (curationTypeNames.length > 0) {
          const curationTypeIds = await this.resolveCurationTypes(curationTypeNames);
          if (curationTypeIds.length > 0) {
            must.push({
              nested: {
                path: 'curation',
                query: {
                  bool: {
                    should: curationTypeIds.map(typeId => ({
                      term: { 'curation.typeId': typeId }
                    })),
                    minimum_should_match: 1
                  }
                }
              }
            });
          }
        }
      }

      // Handle tags filter
      if (filters.tagGroups && Object.keys(filters.tagGroups).length > 0) {
        // Use grouped tags: OR within groups, AND between groups
        const tagGroups = filters.tagGroups as { [groupKey: string]: number[] };
        const groupQueries = Object.values(tagGroups).map((tagIds: number[]) => {
          // If only one tag in the group, return a single nested query
          if (tagIds.length === 1) {
            return {
              nested: {
                path: 'tags',
                query: {
                  term: { 'tags.id': tagIds[0] }
                }
              }
            };
          }
          
          // Multiple tags in group: use OR logic (should array)
          return {
            nested: {
              path: 'tags',
              query: {
                bool: {
                  should: tagIds.map(tagId => ({
                    term: { 'tags.id': tagId }
                  })),
                  minimum_should_match: 1
                }
              }
            }
          };
        });
        
        // All groups must match (AND logic between groups)
        must.push({
          bool: {
            must: groupQueries
          }
        });
      } else if (filters.tagsFilter && filters.tagsFilter !== 'show') {
        // Fallback to old behavior: handle specific tag names (comma-separated)
        const tagNames = filters.tagsFilter.split(',').map((name: string) => name.trim());
        if (tagNames.length > 0) {
          const tagIds = await this.resolveTags(tagNames);
          if (tagIds.length > 0) {
            // Require ALL selected tags to match (AND logic)
            // Each tag requires a separate nested query since a single nested document can only have one tag ID
            const tagQueries = tagIds.map(tagId => ({
              nested: {
                path: 'tags',
                query: {
                  term: { 'tags.id': tagId }
                }
              }
            }));
            
            // All tag queries must match
            must.push({
              bool: {
                must: tagQueries
              }
            });
          }
        }
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

      // Handle songId filter
      if (filters.songId) {
        const songIdValue = parseInt(filters.songId);
        if (!isNaN(songIdValue) && songIdValue > 0) {
          must.push({ term: { songId: songIdValue } });
        }
      }

      // Handle hideVerified filter
      if (filters.creatorId && !isSuperAdmin) {
        if (filters.deletedFilter === 'show') {
            should.push({
              bool: {
                should: [
                  {
                    nested: {
                      path: 'levelCredits',
                      query: {
                        bool: {
                          should: [
                            { term: { 'levelCredits.creatorId': filters.creatorId } }
                          ]
                        }
                      }
                    }
                  },
                  {
                    term: { 'isHidden': false }
                  }
                ],
                minimum_should_match: 1
              }
            });
          }
        else if (filters.deletedFilter === 'only') {
          should.push({
            bool: {
              must: [
                {
                  nested: {
                    path: 'levelCredits',
                    query: {
                      bool: {
                        should: [
                          { term: { 'levelCredits.creatorId': filters.creatorId } }
                        ]
                      }
                    }
                  }
                },
                {
                  term: { 'isHidden': true }
                }
              ]
            }
          });
        }
        else {
          must.push({ term: { isHidden: false } });
        }
      }
      else if (isSuperAdmin) {
        if (filters.deletedFilter === 'hide') {
          must.push({ term: { isHidden: false } });
        }
      }
      else {
        must.push({ term: { isHidden: false } });
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
                'diffId': pguIds
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
                'diffId': specialIds
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
        size: limit,
        track_total_hits: true, // Ensure accurate total count
        track_scores: true // Keep scores for sorting
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
      const total = initialResponse.hits.total ?
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
      suffix: source.suffix ? convertFromPUA(source.suffix as string) : null,
      team: convertFromPUA(source.team as string),
      videoLink: convertFromPUA(source.videoLink as string),
      dlLink: convertFromPUA(source.dlLink as string),
      legacyDllink: convertFromPUA(source.legacyDllink as string),
      aliases: source.aliases?.map((alias: Record<string, any>) => ({
        ...alias,
        originalValue: convertFromPUA(alias.originalValue as string),
        alias: convertFromPUA(alias.alias as string)
      })),
      songObject: source.songObject && Array.isArray(source.songObject) && source.songObject.length > 0 ? source.songObject.map((song: Record<string, any>) => ({
        ...song,
        name: convertFromPUA(song.name as string),
        aliases: song.aliases?.map((alias: Record<string, any>) => ({
          ...alias,
          alias: convertFromPUA(alias.alias as string)
        })) || []
      })) : null,
      artists: source.artists?.map((artist: Record<string, any>) => ({
        ...artist,
        name: convertFromPUA(artist.name as string),
        aliases: artist.aliases?.map((alias: Record<string, any>) => ({
          ...alias,
          alias: convertFromPUA(alias.alias as string)
        })) || []
      })),
      primaryArtist: source.primaryArtist && Array.isArray(source.primaryArtist) && source.primaryArtist.length > 0 ? source.primaryArtist.map((artist: Record<string, any>) => ({
        ...artist,
        name: convertFromPUA(artist.name as string),
        aliases: artist.aliases?.map((alias: Record<string, any>) => ({
          ...alias,
          alias: convertFromPUA(alias.alias as string)
        })) || []
      })) : null,
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

  public async searchPasses(query: string, filters: any = {}, userPlayerId?: number, isSuperAdmin = false): Promise<{ hits: any[], total: number }> {
    try {
      const must: any[] = [];
      const should: any[] = [];



      // Handle text search with new parsing
      if (query) {
        if (query.length > 255) {
          query = query.substring(0, 255);
        }
        const searchGroups = this.parseSearchQuery(query.trim(), true);
        if (searchGroups.length > 0) {
          const orConditions = searchGroups.map(group => {
            const andConditions = group.terms.map(term => this.buildPassFieldSearchQuery(term));

            return andConditions.length === 1
              ? andConditions[0]
              : { bool: { must: andConditions } };
          });

          should.push(...orConditions);
        }
      }

      // Handle filters
      if (!filters.deletedFilter || filters.deletedFilter === 'hide') {
        must.push({ term: { isDeleted: false } });
        must.push({ term: { 'level.isHidden': false } });
        must.push({ term: { 'level.isDeleted': false } });
        must.push({ term: { 'player.isBanned': false } });
        
        // Filter out hidden passes unless the user is the owner
        if (userPlayerId !== undefined) {
          // User is logged in - show their hidden passes but hide others' hidden passes
          must.push({
            bool: {
              should: [
                { term: { isHidden: false } },
                { 
                  bool: {
                    must: [
                      { term: { isHidden: true } },
                      { term: { 'player.id': userPlayerId } }
                    ]
                  }
                }
              ],
              minimum_should_match: 1
            }
          });
        } else {
          // User is not logged in - hide all hidden passes
          must.push({ term: { isHidden: false } });
        }
      } else if (filters.deletedFilter === 'only' && isSuperAdmin) {
        must.push({
          bool: {
            should: [
              { term: { isDeleted: true } },
              { term: { 'level.isHidden': true } },
              { term: { 'level.isDeleted': true } },
              { term: { 'player.isBanned': true } }
            ]
          }
        });
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

      // Handle speed filter when sorting by speed
      const sortType = filters.sort?.split('_').slice(0, -1).join('_');
      if (sortType === 'SPEED') {
        must.push({
          range: {
            speed: { gt: 1 }
          }
        });
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
                  'level.diffId': pguDifficulties.map(d => d.id)
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
                'level.diffId': specialDiffs.map(d => d.id)
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
      const total = initialResponse.hits.total ?
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
      case 'SPEED':
        return [{ speed: direction }, { speed: 'desc' }, { id: 'desc' }];
      case 'DIFF':
        return [{ 'level.difficulty.sortOrder': direction }, { scoreV2: 'desc' }, { id: 'desc' }];
      case 'RANDOM':
        return [{ _script: { script: 'Math.random()', type: 'number' } }];
      default:
        return [{ scoreV2: 'desc' }, { id: 'desc' }];
    }
  }

  private buildPassFieldSearchQuery(fieldSearch: FieldSearch): any {
    const { field, value, exact, isNot } = fieldSearch;
    // Note: value is already converted to PUA in parseFieldSearch
    const searchValue = prepareSearchTerm(value);
    logger.debug(`Building pass search query - Field: ${field}, PUA value: ${value}, Prepared value: ${searchValue}`);

    // Check if this is a numeric field
    const numericFields = queryParserConfigs.pass.numericFields || [];
    const isNumericField = numericFields.includes(field);

    // Handle numeric fields specially
    if (isNumericField && field !== 'any') {
      const numericValue = parseInt(searchValue, 10);

      // For numeric fields, use term query for exact matches
      if (!isNaN(numericValue)) {
        const query = {
          term: {
            [field]: numericValue
          }
        };
        return isNot ? { bool: { must_not: [query] } } : query;
      } else {
        // If the value isn't a valid number, return a query that matches nothing
        logger.warn(`Invalid numeric value for field ${field}: ${searchValue}`);
        return { bool: { must_not: [{ match_all: {} }] } };
      }
    }

    // For field-specific searches
    if (field !== 'any') {
      // For partial matches (using :), use wildcard query
      const wildcardValue = exact ? searchValue : `*${searchValue}*`;

      // Handle player search for partial matches
      if (field === 'player') {
        const query = {
          bool: {
            should: [
              { wildcard: { 'player.name': { value: wildcardValue, case_insensitive: true } } },
              { wildcard: { 'player.username': { value: wildcardValue, case_insensitive: true } } }
            ],
            minimum_should_match: 1
          }
        };
        return isNot ? { bool: { must_not: [query] } } : query;
      }

      // Handle video link partial match
      if (field === 'video') {
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

      // Handle video title partial match
      if (field === 'vidtitle') {
        const query = {
          wildcard: {
            'vidTitle': {
              value: wildcardValue,
              case_insensitive: true
            }
          }
        };
        return isNot ? { bool: { must_not: [query] } } : query;
      }

      // Handle level song partial match
      if (field === 'level.song') {
        const query = {
          wildcard: {
            'level.song': {
              value: wildcardValue,
              case_insensitive: true
            }
          }
        };
        return isNot ? { bool: { must_not: [query] } } : query;
      }

      // Handle level artist partial match
      if (field === 'level.artist') {
        const query = {
          wildcard: {
            'level.artist': {
              value: wildcardValue,
              case_insensitive: true
            }
          }
        };
        return isNot ? { bool: { must_not: [query] } } : query;
      }

      // Handle level download link partial match
      if (field === 'level.dlLink') {
        const query = {
          wildcard: {
            'level.dlLink': {
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
      return isNot ? { bool: { must_not: [searchCondition] } } : searchCondition;
    }

    // For general searches (field === 'any'), use wildcard search across all pass fields
    const wildcardValue = `*${searchValue}*`;
    const query = {
      bool: {
        should: [
          { wildcard: { 'player.name': { value: wildcardValue, case_insensitive: true } } },
          { wildcard: { 'player.username': { value: wildcardValue, case_insensitive: true } } },
          { wildcard: { 'level.song': { value: wildcardValue, case_insensitive: true } } },
          { wildcard: { 'level.artist': { value: wildcardValue, case_insensitive: true } } },
          { wildcard: { 'videoLink': { value: wildcardValue, case_insensitive: true } } },
          { wildcard: { 'vidTitle': { value: wildcardValue, case_insensitive: true } } },
          { wildcard: { 'level.dlLink': { value: wildcardValue, case_insensitive: true } } },
          { nested: {
            path: 'level.aliases',
            query: {
              wildcard: { 'level.aliases.alias': { value: wildcardValue, case_insensitive: true } }
            }
          }}
        ],
        minimum_should_match: 1
      }
    };
    return isNot ? { bool: { must_not: [query] } } : query;
  }
}

export default ElasticsearchService;
