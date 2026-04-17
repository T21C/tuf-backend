import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import Player from '@/models/players/Player.js';
import LevelLikes from '@/models/levels/LevelLikes.js';
import LevelTag from '@/models/levels/LevelTag.js';
import LevelTagAssignment from '@/models/levels/LevelTagAssignment.js';
import Curation from '@/models/curations/Curation.js';
import CurationCurationType from '@/models/curations/CurationCurationType.js';
import Song from '@/models/songs/Song.js';
import SongAlias from '@/models/songs/SongAlias.js';
import SongCredit from '@/models/songs/SongCredit.js';
import Artist from '@/models/artists/Artist.js';
import ArtistAlias from '@/models/artists/ArtistAlias.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { extractNumericIdsFromSequelizeWhereField } from '@/server/services/elasticsearch/misc/extractNumericIdsFromSequelizeWhereField.js';

export interface ElasticsearchHookApi {
  indexLevel(level: Level | number): Promise<void>;
  indexPass(pass: Pass | number): Promise<void>;
  deletePassDocumentById(passId: number): Promise<void>;
  reindexLevels(levelIds?: number[]): Promise<void>;
  reindexPasses(passIds?: number[]): Promise<void>;
  scheduleArtistReindex(levelIds: number[]): void;
  getLevelIdsBySongId(songId: number): Promise<number[]>;
  getLevelIdsByArtistId(artistId: number): Promise<number[]>;
  getLevelIdsByPlayerId(playerId: number): Promise<number[]>;
}

async function runAfterCommit(
  options: { transaction?: { afterCommit: (fn: () => void | Promise<void>) => Promise<unknown> } },
  fn: () => Promise<void>,
): Promise<void> {
  if (options.transaction) {
    await options.transaction.afterCommit(fn);
  } else {
    await fn();
  }
}

export function registerElasticsearchChangeListeners(api: ElasticsearchHookApi): void {
    // Remove existing hooks first to prevent duplicates
    Pass.removeHook('beforeSave', 'elasticsearchPassUpdate');
    Pass.removeHook('afterDestroy', 'elasticsearchPassDestroy');
    LevelLikes.removeHook('beforeSave', 'elasticsearchLevelLikesUpdate');
    Level.removeHook('beforeSave', 'elasticsearchLevelUpdate');
    Pass.removeHook('beforeBulkUpdate', 'elasticsearchPassBeforeBulkUpdate');
    Pass.removeHook('afterBulkUpdate', 'elasticsearchPassBulkUpdate');
    Pass.removeHook('afterBulkCreate', 'elasticsearchPassBulkCreate');
    Player.removeHook('afterSave', 'elasticsearchPlayerBanLevelReindex');
    Player.removeHook('beforeBulkUpdate', 'elasticsearchPlayerBeforeBulkUpdate');
    Player.removeHook('afterBulkUpdate', 'elasticsearchPlayerBulkUpdate');
    Level.removeHook('beforeBulkUpdate', 'elasticsearchLevelBeforeBulkUpdate');
    Level.removeHook('afterBulkUpdate', 'elasticsearchLevelBulkUpdate');
    LevelTag.removeHook('afterBulkUpdate', 'elasticsearchLevelTagBulkUpdate');
    LevelTagAssignment.removeHook('afterBulkCreate', 'elasticsearchLevelTagAssignmentBulkCreate');
    LevelTagAssignment.removeHook('afterBulkDestroy', 'elasticsearchLevelTagAssignmentBulkDelete');
    Curation.removeHook('beforeSave', 'elasticsearchCurationUpdate');
    Curation.removeHook('afterBulkUpdate', 'elasticsearchCurationBulkUpdate');
    Song.removeHook('afterSave', 'elasticsearchSongUpdate');
    Song.removeHook('afterBulkUpdate', 'elasticsearchSongBulkUpdate');
    SongAlias.removeHook('afterSave', 'elasticsearchSongAliasUpdate');
    SongAlias.removeHook('afterCreate', 'elasticsearchSongAliasCreate');
    SongAlias.removeHook('afterDestroy', 'elasticsearchSongAliasDestroy');
    Artist.removeHook('afterSave', 'elasticsearchArtistUpdate');
    Artist.removeHook('afterBulkUpdate', 'elasticsearchArtistBulkUpdate');
    ArtistAlias.removeHook('afterSave', 'elasticsearchArtistAliasUpdate');
    ArtistAlias.removeHook('afterCreate', 'elasticsearchArtistAliasCreate');
    ArtistAlias.removeHook('afterDestroy', 'elasticsearchArtistAliasDestroy');
    SongCredit.removeHook('afterSave', 'elasticsearchSongCreditUpdate');
    SongCredit.removeHook('afterCreate', 'elasticsearchSongCreditCreate');
    SongCredit.removeHook('afterDestroy', 'elasticsearchSongCreditDestroy');

    Pass.addHook('afterDestroy', 'elasticsearchPassDestroy', async (pass: Pass, options: any) => {
      try {
        await runAfterCommit(options, async () => {
          await api.deletePassDocumentById(pass.id);
          if (pass.levelId) {
            await api.indexLevel(pass.levelId);
          }
        });
      } catch (error) {
        logger.error(`Error in elasticsearch pass afterDestroy for pass ${pass.id}:`, error);
      }
    });

    // Add hooks with unique names
    Pass.addHook('beforeSave', 'elasticsearchPassUpdate', async (pass: Pass, options: any) => {
      logger.debug(`Pass saved hook triggered for pass ${pass.id}`);
      try {
        await runAfterCommit(options, async () => {
          logger.debug(`Indexing pass ${pass.id} and level ${pass.levelId} after transaction commit`);
          await api.indexPass(pass);
          await api.indexLevel(pass.levelId);
        });
      } catch (error) {
        logger.error(`Error in pass afterSave hook for pass ${pass.id}:`, error);
      }
      return;
    });

    // Pre-capture affected pass/level IDs for bulk updates whose WHERE clause
    // doesn't contain pass.id or pass.levelId directly (e.g. player merge uses
    // `where: { playerId }`). Without this, afterBulkUpdate couldn't determine
    // which levels to reindex and the ES clears count would drift.
    Pass.addHook('beforeBulkUpdate', 'elasticsearchPassBeforeBulkUpdate', async (options: any) => {
      try {
        const idsFromWhere = extractNumericIdsFromSequelizeWhereField(options.where?.id);
        const levelIdsFromWhere = extractNumericIdsFromSequelizeWhereField(options.where?.levelId);
        if (idsFromWhere.length > 0 && levelIdsFromWhere.length > 0) {
          return;
        }
        if (!options.where) return;
        const affectedPasses = await Pass.findAll({
          where: options.where,
          attributes: ['id', 'levelId'],
          transaction: options.transaction,
        });
        options.affectedPassIds = affectedPasses
          .map((p) => p.id)
          .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0);
        options.affectedLevelIdsFromPasses = [
          ...new Set(
            affectedPasses
              .map((p) => p.levelId)
              .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0),
          ),
        ];
        logger.debug(
          `Captured ${options.affectedPassIds.length} pass(es) / ${options.affectedLevelIdsFromPasses.length} level(s) before bulk update`,
        );
      } catch (error) {
        logger.error('Error in pass beforeBulkUpdate hook:', error);
      }
    });

    // Add afterBulkUpdate hook for Pass model
    Pass.addHook('afterBulkUpdate', 'elasticsearchPassBulkUpdate', async (options: any) => {
      logger.debug('Pass bulk update hook triggered');
      try {
        let passIds = extractNumericIdsFromSequelizeWhereField(options.where?.id);
        let levelIds = extractNumericIdsFromSequelizeWhereField(options.where?.levelId);

        if (passIds.length === 0 && Array.isArray(options.affectedPassIds)) {
          passIds = options.affectedPassIds;
        }
        if (levelIds.length === 0 && Array.isArray(options.affectedLevelIdsFromPasses)) {
          levelIds = options.affectedLevelIdsFromPasses;
        }

        const run = async () => {
          if (passIds.length > 0) {
            logger.debug(`Reindexing ${passIds.length} pass(es) after bulk update`, { passIds });
            await api.reindexPasses(passIds);
          }
          if (levelIds.length > 0) {
            logger.debug(`Reindexing ${levelIds.length} level(s) after pass bulk update`, { levelIds });
            await api.reindexLevels(levelIds);
          }
        };

        if (options.transaction) {
          await options.transaction.afterCommit(run);
        } else {
          await run();
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
              const levelIds = Array.from(
                new Set(
                  instances
                    .map((pass) => pass.levelId)
                    .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0),
                ),
              );
              const passIds = instances
                .map((pass) => pass.id)
                .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0);

              logger.debug(`Bulk indexing ${passIds.length} passes and ${levelIds.length} levels after bulk create`);

              // Bulk index all affected passes
              await api.reindexPasses(passIds);

              // Update all affected levels
              for (const levelId of levelIds) {
                await api.indexLevel(levelId);
              }
            }
          });
        } else {
          if (instances.length > 0) {
            const levelIds = Array.from(
              new Set(
                instances
                  .map((pass) => pass.levelId)
                  .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0),
              ),
            );
            const passIds = instances
              .map((pass) => pass.id)
              .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0);

            await api.reindexPasses(passIds);

            for (const levelId of levelIds) {
              await api.indexLevel(levelId);
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
            await api.indexLevel(levelLikes.levelId);
          });
        } else {
          logger.debug(`Indexing level ${levelLikes.levelId} outside of transaction`);
          await api.indexLevel(levelLikes.levelId);
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
            await api.indexLevel(level);
          });
        } else {
          logger.debug(`Indexing level ${level.id} outside of transaction`);
          await api.indexLevel(level);
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
              await api.reindexLevels(levelIds);
            });
          } else {
            logger.debug(`Indexing ${levelIds.length} levels after bulk update`);
            await api.reindexLevels(levelIds);
          }
        } else {
          logger.debug('No levels found to reindex after bulk update');
        }
      } catch (error) {
        logger.error('Error in level afterBulkUpdate hook:', error);
      }
    });

    // Player hooks: the ES level doc's `clears` filter excludes banned players,
    // but ban/unban never touches the passes table, so without these hooks the
    // level documents go stale whenever a player's ban state flips.
    Player.addHook('afterSave', 'elasticsearchPlayerBanLevelReindex', async (player: Player, options: any) => {
      try {
        const changedFn = (player as unknown as { changed?: (field?: string) => boolean | string[] | false }).changed;
        const didChangeIsBanned = typeof changedFn === 'function' ? Boolean(changedFn.call(player, 'isBanned')) : true;
        if (!didChangeIsBanned) return;
        const levelIds = await api.getLevelIdsByPlayerId(player.id);
        if (levelIds.length === 0) return;
        await runAfterCommit(options, async () => {
          logger.debug(`Reindexing ${levelIds.length} levels after player ${player.id} isBanned change`);
          await api.reindexLevels(levelIds);
        });
      } catch (error) {
        logger.error(`Error in player afterSave level-reindex hook for player ${player.id}:`, error);
      }
    });

    Player.addHook('beforeBulkUpdate', 'elasticsearchPlayerBeforeBulkUpdate', async (options: any) => {
      try {
        const fields: string[] | undefined = options.fields ?? (options.attributes ? Object.keys(options.attributes) : undefined);
        const touchesIsBanned = Array.isArray(fields) ? fields.includes('isBanned') : true;
        if (!touchesIsBanned) return;
        if (!options.where) return;
        const affectedPlayers = await Player.findAll({
          where: options.where,
          attributes: ['id'],
          transaction: options.transaction,
        });
        options.affectedPlayerIdsForLevelReindex = affectedPlayers.map((p) => p.id);
        logger.debug(
          `Found ${options.affectedPlayerIdsForLevelReindex.length} players to resolve level reindexes before bulk update`,
        );
      } catch (error) {
        logger.error('Error in player beforeBulkUpdate hook:', error);
      }
    });

    Player.addHook('afterBulkUpdate', 'elasticsearchPlayerBulkUpdate', async (options: any) => {
      try {
        const playerIds: number[] = options.affectedPlayerIdsForLevelReindex ?? [];
        if (playerIds.length === 0) return;
        const allLevelIds = new Set<number>();
        for (const pid of playerIds) {
          const ids = await api.getLevelIdsByPlayerId(pid);
          ids.forEach((id) => allLevelIds.add(id));
        }
        if (allLevelIds.size === 0) return;
        const run = async () => {
          logger.debug(`Reindexing ${allLevelIds.size} levels after player bulk update`);
          await api.reindexLevels(Array.from(allLevelIds));
        };
        if (options.transaction) {
          await options.transaction.afterCommit(run);
        } else {
          await run();
        }
      } catch (error) {
        logger.error('Error in player afterBulkUpdate level-reindex hook:', error);
      }
    });

    // Add hooks for Curation model

    Curation.addHook('beforeSave', 'elasticsearchCurationUpdate', async (curation: Curation, options: any) => {
      logger.debug(`Curation saved hook triggered for curation ${curation.id} (level ${curation.levelId})`);
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            logger.debug(`Indexing level ${curation.levelId} after curation transaction commit`);
            await api.indexLevel(curation.levelId);
          });
        } else {
          logger.debug(`Indexing level ${curation.levelId} outside of curation transaction`);
          await api.indexLevel(curation.levelId);
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
                await api.indexLevel(curation.levelId);
              }
            }
            // If we have a levelId directly, update that level
            if (options.where?.levelId) {
              logger.debug(`Indexing level ${options.where.levelId} after curation bulk update`);
              await api.indexLevel(options.where.levelId);
            }
          });
        } else {
          if (options.where?.id) {
            const curation = await Curation.findByPk(options.where.id);
            if (curation) {
              await api.indexLevel(curation.levelId);
            }
          }
          if (options.where?.levelId) {
            await api.indexLevel(options.where.levelId);
          }
        }
      } catch (error) {
        logger.error('Error in curation afterBulkUpdate hook:', error);
      }
    });

    const indexLevelForCurationId = async (curationId: number, transaction?: any) => {
      const c = await Curation.findByPk(curationId);
      if (!c) return;
      if (transaction) {
        await transaction.afterCommit(async () => {
          await api.indexLevel(c.levelId);
        });
      } else {
        await api.indexLevel(c.levelId);
      }
    };

    CurationCurationType.addHook('afterCreate', 'elasticsearchCurationTypeLink', async (row: any, options: any) => {
      try {
        await indexLevelForCurationId(row.curationId, options.transaction);
      } catch (error) {
        logger.error('Error in CurationCurationType afterCreate hook:', error);
      }
    });

    CurationCurationType.addHook('afterDestroy', 'elasticsearchCurationTypeUnlink', async (row: any, options: any) => {
      try {
        await indexLevelForCurationId(row.curationId, options.transaction);
      } catch (error) {
        logger.error('Error in CurationCurationType afterDestroy hook:', error);
      }
    });

    CurationCurationType.addHook('afterBulkCreate', 'elasticsearchCurationTypeBulkCreate', async (rows: any[], options: any) => {
      try {
        const ids = [...new Set(rows.map((r) => r.curationId))];
        for (const id of ids) {
          await indexLevelForCurationId(id, options.transaction);
        }
      } catch (error) {
        logger.error('Error in CurationCurationType afterBulkCreate hook:', error);
      }
    });

    LevelTagAssignment.addHook('afterBulkCreate', 'elasticsearchLevelTagAssignmentBulkCreate', async (options: any) => {
      logger.debug('LevelTagAssignment bulk create hook triggered', options[0].levelId);
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            await api.reindexLevels([options[0].levelId]);
          });
        } else {
          await api.reindexLevels([options[0].levelId]);
        }
      }
      catch (error) {
        logger.error('Error in level tag assignment afterBulkCreate hook:', error);
      }
    });

    LevelTagAssignment.addHook('afterBulkDestroy', 'elasticsearchLevelTagAssignmentDestroy', async (options: any) => {
      logger.debug('LevelTagAssignment destroy hook triggered', options.where.levelId);
      try {
        if (options.transaction) {
          await options.transaction.afterCommit(async () => {
            await api.reindexLevels([options.where.levelId]);
          });
        } else {
          await api.reindexLevels([options.where.levelId]);
        }
      }
      catch (error) {
        logger.error('Error in level tag assignment afterDestroy hook:', error);
      }
    });

    // Add hooks for Song model - reindex all levels using this song
    Song.addHook('afterSave', 'elasticsearchSongUpdate', async (song: Song, options: any) => {
      logger.debug(`Song saved hook triggered for song ${song.id}`);
      try {
        const levelIds = await api.getLevelIdsBySongId(song.id);
        if (levelIds.length > 0) {
          if (options.transaction) {
            await options.transaction.afterCommit(async () => {
              logger.debug(`Reindexing ${levelIds.length} levels after song ${song.id} update`);
              await api.reindexLevels(levelIds);
            });
          } else {
            logger.debug(`Reindexing ${levelIds.length} levels after song ${song.id} update`);
            await api.reindexLevels(levelIds);
          }
        }
      } catch (error) {
        logger.error(`Error in song afterSave hook for song ${song.id}:`, error);
      }
    });

    Song.addHook('afterBulkUpdate', 'elasticsearchSongBulkUpdate', async (options: any) => {
      logger.debug('Song bulk update hook triggered');
      try {
        let songIds: number[] = [];

        if (options.where?.id) {
          songIds = Array.isArray(options.where.id)
            ? options.where.id
            : [options.where.id];
        } else if (options.where) {
          const songs = await Song.findAll({
            where: options.where,
            attributes: ['id'],
            transaction: options.transaction
          });
          songIds = songs.map(s => s.id);
        }

        if (songIds.length > 0) {
          const allLevelIds = new Set<number>();
          for (const songId of songIds) {
            const levelIds = await api.getLevelIdsBySongId(songId);
            levelIds.forEach(id => allLevelIds.add(id));
          }

          if (allLevelIds.size > 0) {
            if (options.transaction) {
              await options.transaction.afterCommit(async () => {
                logger.debug(`Reindexing ${allLevelIds.size} levels after song bulk update`);
                await api.reindexLevels(Array.from(allLevelIds));
              });
            } else {
              logger.debug(`Reindexing ${allLevelIds.size} levels after song bulk update`);
              await api.reindexLevels(Array.from(allLevelIds));
            }
          }
        }
      } catch (error) {
        logger.error('Error in song afterBulkUpdate hook:', error);
      }
    });

    // Add hooks for SongAlias model - reindex all levels using this song
    SongAlias.addHook('afterSave', 'elasticsearchSongAliasUpdate', async (songAlias: SongAlias, options: any) => {
      logger.debug(`SongAlias saved hook triggered for song ${songAlias.songId}`);
      try {
        const levelIds = await api.getLevelIdsBySongId(songAlias.songId);
        if (levelIds.length > 0) {
          if (options.transaction) {
            await options.transaction.afterCommit(async () => {
              logger.debug(`Reindexing ${levelIds.length} levels after song alias update`);
              await api.reindexLevels(levelIds);
            });
          } else {
            logger.debug(`Reindexing ${levelIds.length} levels after song alias update`);
            await api.reindexLevels(levelIds);
          }
        }
      } catch (error) {
        logger.error(`Error in songAlias afterSave hook for song ${songAlias.songId}:`, error);
      }
    });

    SongAlias.addHook('afterCreate', 'elasticsearchSongAliasCreate', async (songAlias: SongAlias, options: any) => {
      logger.debug(`SongAlias created hook triggered for song ${songAlias.songId}`);
      try {
        const levelIds = await api.getLevelIdsBySongId(songAlias.songId);
        if (levelIds.length > 0) {
          if (options.transaction) {
            await options.transaction.afterCommit(async () => {
              logger.debug(`Reindexing ${levelIds.length} levels after song alias create`);
              await api.reindexLevels(levelIds);
            });
          } else {
            logger.debug(`Reindexing ${levelIds.length} levels after song alias create`);
            await api.reindexLevels(levelIds);
          }
        }
      } catch (error) {
        logger.error(`Error in songAlias afterCreate hook for song ${songAlias.songId}:`, error);
      }
    });

    SongAlias.addHook('afterDestroy', 'elasticsearchSongAliasDestroy', async (songAlias: SongAlias, options: any) => {
      logger.debug(`SongAlias destroyed hook triggered for song ${songAlias.songId}`);
      try {
        const levelIds = await api.getLevelIdsBySongId(songAlias.songId);
        if (levelIds.length > 0) {
          if (options.transaction) {
            await options.transaction.afterCommit(async () => {
              logger.debug(`Reindexing ${levelIds.length} levels after song alias destroy`);
              await api.reindexLevels(levelIds);
            });
          } else {
            logger.debug(`Reindexing ${levelIds.length} levels after song alias destroy`);
            await api.reindexLevels(levelIds);
          }
        }
      } catch (error) {
        logger.error(`Error in songAlias afterDestroy hook for song ${songAlias.songId}:`, error);
      }
    });

    // Add hooks for Artist model - reindex all levels that have songs with credits from this artist
    Artist.addHook('afterSave', 'elasticsearchArtistUpdate', async (artist: Artist, options: any) => {
      logger.debug(`Artist saved hook triggered for artist ${artist.id}`);
      try {
        const levelIds = await api.getLevelIdsByArtistId(artist.id);
        if (levelIds.length > 0) {
          if (options.transaction) {
            await options.transaction.afterCommit(async () => {
              logger.debug(`Scheduling debounced reindex for ${levelIds.length} levels after artist ${artist.id} update`);
              api.scheduleArtistReindex(levelIds);
            });
          } else {
            logger.debug(`Scheduling debounced reindex for ${levelIds.length} levels after artist ${artist.id} update`);
            api.scheduleArtistReindex(levelIds);
          }
        }
      } catch (error) {
        logger.error(`Error in artist afterSave hook for artist ${artist.id}:`, error);
      }
    });

    Artist.addHook('afterBulkUpdate', 'elasticsearchArtistBulkUpdate', async (options: any) => {
      logger.debug('Artist bulk update hook triggered');
      try {
        let artistIds: number[] = [];

        if (options.where?.id) {
          artistIds = Array.isArray(options.where.id)
            ? options.where.id
            : [options.where.id];
        } else if (options.where) {
          const artists = await Artist.findAll({
            where: options.where,
            attributes: ['id'],
            transaction: options.transaction
          });
          artistIds = artists.map(a => a.id);
        }

        if (artistIds.length > 0) {
          const allLevelIds = new Set<number>();
          for (const artistId of artistIds) {
            const levelIds = await api.getLevelIdsByArtistId(artistId);
            levelIds.forEach(id => allLevelIds.add(id));
          }

          if (allLevelIds.size > 0) {
            if (options.transaction) {
              await options.transaction.afterCommit(async () => {
                logger.debug(`Scheduling debounced reindex for ${allLevelIds.size} levels after artist bulk update`);
                api.scheduleArtistReindex(Array.from(allLevelIds));
              });
            } else {
              logger.debug(`Scheduling debounced reindex for ${allLevelIds.size} levels after artist bulk update`);
              api.scheduleArtistReindex(Array.from(allLevelIds));
            }
          }
        }
      } catch (error) {
        logger.error('Error in artist afterBulkUpdate hook:', error);
      }
    });

    // Add hooks for ArtistAlias model - reindex all levels that have songs with credits from this artist
    ArtistAlias.addHook('afterSave', 'elasticsearchArtistAliasUpdate', async (artistAlias: ArtistAlias, options: any) => {
      logger.debug(`ArtistAlias saved hook triggered for artist ${artistAlias.artistId}`);
      try {
        const levelIds = await api.getLevelIdsByArtistId(artistAlias.artistId);
        if (levelIds.length > 0) {
          if (options.transaction) {
            await options.transaction.afterCommit(async () => {
              logger.debug(`Scheduling debounced reindex for ${levelIds.length} levels after artist alias update`);
              api.scheduleArtistReindex(levelIds);
            });
          } else {
            logger.debug(`Scheduling debounced reindex for ${levelIds.length} levels after artist alias update`);
            api.scheduleArtistReindex(levelIds);
          }
        }
      } catch (error) {
        logger.error(`Error in artistAlias afterSave hook for artist ${artistAlias.artistId}:`, error);
      }
    });

    ArtistAlias.addHook('afterCreate', 'elasticsearchArtistAliasCreate', async (artistAlias: ArtistAlias, options: any) => {
      logger.debug(`ArtistAlias created hook triggered for artist ${artistAlias.artistId}`);
      try {
        const levelIds = await api.getLevelIdsByArtistId(artistAlias.artistId);
        if (levelIds.length > 0) {
          if (options.transaction) {
            await options.transaction.afterCommit(async () => {
              logger.debug(`Scheduling debounced reindex for ${levelIds.length} levels after artist alias create`);
              api.scheduleArtistReindex(levelIds);
            });
          } else {
            logger.debug(`Scheduling debounced reindex for ${levelIds.length} levels after artist alias create`);
            api.scheduleArtistReindex(levelIds);
          }
        }
      } catch (error) {
        logger.error(`Error in artistAlias afterCreate hook for artist ${artistAlias.artistId}:`, error);
      }
    });

    ArtistAlias.addHook('afterDestroy', 'elasticsearchArtistAliasDestroy', async (artistAlias: ArtistAlias, options: any) => {
      logger.debug(`ArtistAlias destroyed hook triggered for artist ${artistAlias.artistId}`);
      try {
        const levelIds = await api.getLevelIdsByArtistId(artistAlias.artistId);
        if (levelIds.length > 0) {
          if (options.transaction) {
            await options.transaction.afterCommit(async () => {
              logger.debug(`Scheduling debounced reindex for ${levelIds.length} levels after artist alias destroy`);
              api.scheduleArtistReindex(levelIds);
            });
          } else {
            logger.debug(`Scheduling debounced reindex for ${levelIds.length} levels after artist alias destroy`);
            api.scheduleArtistReindex(levelIds);
          }
        }
      } catch (error) {
        logger.error(`Error in artistAlias afterDestroy hook for artist ${artistAlias.artistId}:`, error);
      }
    });

    // Add hooks for SongCredit model - reindex all levels that use the song with this credit
    SongCredit.addHook('afterSave', 'elasticsearchSongCreditUpdate', async (songCredit: SongCredit, options: any) => {
      logger.debug(`SongCredit saved hook triggered for song ${songCredit.songId}`);
      try {
        const levelIds = await api.getLevelIdsBySongId(songCredit.songId);
        if (levelIds.length > 0) {
          if (options.transaction) {
            await options.transaction.afterCommit(async () => {
              logger.debug(`Reindexing ${levelIds.length} levels after song credit update`);
              await api.reindexLevels(levelIds);
            });
          } else {
            logger.debug(`Reindexing ${levelIds.length} levels after song credit update`);
            await api.reindexLevels(levelIds);
          }
        }
      } catch (error) {
        logger.error(`Error in songCredit afterSave hook for song ${songCredit.songId}:`, error);
      }
    });

    SongCredit.addHook('afterCreate', 'elasticsearchSongCreditCreate', async (songCredit: SongCredit, options: any) => {
      logger.debug(`SongCredit created hook triggered for song ${songCredit.songId}`);
      try {
        const levelIds = await api.getLevelIdsBySongId(songCredit.songId);
        if (levelIds.length > 0) {
          if (options.transaction) {
            await options.transaction.afterCommit(async () => {
              logger.debug(`Reindexing ${levelIds.length} levels after song credit create`);
              await api.reindexLevels(levelIds);
            });
          } else {
            logger.debug(`Reindexing ${levelIds.length} levels after song credit create`);
            await api.reindexLevels(levelIds);
          }
        }
      } catch (error) {
        logger.error(`Error in songCredit afterCreate hook for song ${songCredit.songId}:`, error);
      }
    });

    SongCredit.addHook('afterDestroy', 'elasticsearchSongCreditDestroy', async (songCredit: SongCredit, options: any) => {
      logger.debug(`SongCredit destroyed hook triggered for song ${songCredit.songId}`);
      try {
        const levelIds = await api.getLevelIdsBySongId(songCredit.songId);
        if (levelIds.length > 0) {
          if (options.transaction) {
            await options.transaction.afterCommit(async () => {
              logger.debug(`Reindexing ${levelIds.length} levels after song credit destroy`);
              await api.reindexLevels(levelIds);
            });
          } else {
            logger.debug(`Reindexing ${levelIds.length} levels after song credit destroy`);
            await api.reindexLevels(levelIds);
          }
        }
      } catch (error) {
        logger.error(`Error in songCredit afterDestroy hook for song ${songCredit.songId}:`, error);
      }
    });
}
