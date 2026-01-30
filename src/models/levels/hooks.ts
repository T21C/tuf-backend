import Level from './Level.js';
import Pass from '../passes/Pass.js';
import Rating from './Rating.js';
import Curation from '../curations/Curation.js';
import LevelCredit from './LevelCredit.js';
import LevelAlias from './LevelAlias.js';
import LevelTag from './LevelTag.js';
import LevelTagAssignment from './LevelTagAssignment.js';
import LevelLikes from './LevelLikes.js';
import Song from '../songs/Song.js';
import Artist from '../artists/Artist.js';
import SongCredit from '../songs/SongCredit.js';
import SongAlias from '../songs/SongAlias.js';
import ArtistAlias from '../artists/ArtistAlias.js';
import { CacheInvalidation } from '../../server/middleware/cache.js';
import { logger } from '../../server/services/LoggerService.js';
import { Op } from 'sequelize';

/**
 * Invalidate cache for a specific level
 */
const invalidateLevelCache = async (levelId: number): Promise<void> => {
  try {
    const tags = [`level:${levelId}`, 'levels:all'];
    await CacheInvalidation.invalidateTags(tags);
    logger.debug(`Cache invalidated for level ${levelId}`);
  } catch (error) {
    logger.error(`Error invalidating level cache for level ${levelId}:`, error);
  }
};

/**
 * Invalidate cache for multiple levels
 */
const invalidateLevelsCache = async (levelIds: number[]): Promise<void> => {
  if (levelIds.length === 0) return;
  
  try {
    const tags = ['levels:all'];
    const levelTags = levelIds.map(id => `level:${id}`);
    await CacheInvalidation.invalidateTags([...tags, ...levelTags]);
    logger.debug(`Cache invalidated for ${levelIds.length} levels`);
  } catch (error) {
    logger.error(`Error invalidating level cache for ${levelIds.length} levels:`, error);
  }
};

/**
 * Get all level IDs that use a specific song
 */
const getLevelIdsBySongId = async (songId: number): Promise<number[]> => {
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
};

/**
 * Get all level IDs that have songs with credits from a specific artist
 */
const getLevelIdsByArtistId = async (artistId: number): Promise<number[]> => {
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
};

/**
 * Initialize Level model hooks for cache invalidation
 */
export function initializeLevelCacheHooks(): void {
  // Level hooks - invalidate cache when levels are created, updated, or deleted
  Level.addHook('afterCreate', 'cacheInvalidationLevelCreate', async (level: Level, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        await invalidateLevelCache(level.id);
      });
    } else {
      await invalidateLevelCache(level.id);
    }
  });

  Level.addHook('afterUpdate', 'cacheInvalidationLevelUpdate', async (level: Level, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        await invalidateLevelCache(level.id);
      });
    } else {
      await invalidateLevelCache(level.id);
    }
  });

  Level.addHook('afterDestroy', 'cacheInvalidationLevelDestroy', async (level: Level, options: any) => {
    const levelId = level.id;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        await invalidateLevelCache(levelId);
      });
    } else {
      await invalidateLevelCache(levelId);
    }
  });

  Level.addHook('afterBulkUpdate', 'cacheInvalidationLevelBulkUpdate', async (options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        // Get all affected level IDs
        const affectedLevels = await Level.findAll({
          where: options.where,
          attributes: ['id']
        });
        const tags = ['levels:all'];
        const levelTags = affectedLevels.map(l => `level:${l.id}`);
        await CacheInvalidation.invalidateTags([...tags, ...levelTags]);
        logger.debug(`Cache invalidated for ${affectedLevels.length} levels (bulk update)`);
      });
    } else {
      const affectedLevels = await Level.findAll({
        where: options.where,
        attributes: ['id']
      });
      const tags = ['levels:all'];
      const levelTags = affectedLevels.map(l => `level:${l.id}`);
      await CacheInvalidation.invalidateTags([...tags, ...levelTags]);
    }
  });

  // Pass hooks - invalidate cache when passes are created/updated/deleted (affects level display)
  Pass.addHook('afterCreate', 'cacheInvalidationPassCreate', async (pass: Pass, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (pass.levelId) await invalidateLevelCache(pass.levelId);
      });
    } else {
      if (pass.levelId) await invalidateLevelCache(pass.levelId);
    }
  });

  Pass.addHook('afterUpdate', 'cacheInvalidationPassUpdate', async (pass: Pass, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (pass.levelId) await invalidateLevelCache(pass.levelId);
      });
    } else {
      if (pass.levelId) await invalidateLevelCache(pass.levelId);
    }
  });

  Pass.addHook('afterDestroy', 'cacheInvalidationPassDestroy', async (pass: Pass, options: any) => {
    const levelId = pass.levelId;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (levelId) await invalidateLevelCache(levelId);
      });
    } else {
      if (levelId) await invalidateLevelCache(levelId);
    }
  });

  // Rating hooks - invalidate cache when ratings are created/updated/deleted
  Rating.addHook('afterCreate', 'cacheInvalidationRatingCreate', async (rating: Rating, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (rating.levelId) await invalidateLevelCache(rating.levelId);
      });
    } else {
      if (rating.levelId) await invalidateLevelCache(rating.levelId);
    }
  });

  Rating.addHook('afterUpdate', 'cacheInvalidationRatingUpdate', async (rating: Rating, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (rating.levelId) await invalidateLevelCache(rating.levelId);
      });
    } else {
      if (rating.levelId) await invalidateLevelCache(rating.levelId);
    }
  });

  Rating.addHook('afterDestroy', 'cacheInvalidationRatingDestroy', async (rating: Rating, options: any) => {
    const levelId = rating.levelId;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (levelId) await invalidateLevelCache(levelId);
      });
    } else {
      if (levelId) await invalidateLevelCache(levelId);
    }
  });

  // Curation hooks - invalidate cache when curations are created/updated/deleted
  Curation.addHook('afterCreate', 'cacheInvalidationCurationCreate', async (curation: Curation, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (curation.levelId) await invalidateLevelCache(curation.levelId);
      });
    } else {
      if (curation.levelId) await invalidateLevelCache(curation.levelId);
    }
  });

  Curation.addHook('afterUpdate', 'cacheInvalidationCurationUpdate', async (curation: Curation, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (curation.levelId) await invalidateLevelCache(curation.levelId);
      });
    } else {
      if (curation.levelId) await invalidateLevelCache(curation.levelId);
    }
  });

  Curation.addHook('afterDestroy', 'cacheInvalidationCurationDestroy', async (curation: Curation, options: any) => {
    const levelId = curation.levelId;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (levelId) await invalidateLevelCache(levelId);
      });
    } else {
      if (levelId) await invalidateLevelCache(levelId);
    }
  });

  // LevelCredit hooks - invalidate cache when credits are created/updated/deleted
  LevelCredit.addHook('afterCreate', 'cacheInvalidationLevelCreditCreate', async (credit: LevelCredit, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (credit.levelId) await invalidateLevelCache(credit.levelId);
      });
    } else {
      if (credit.levelId) await invalidateLevelCache(credit.levelId);
    }
  });

  LevelCredit.addHook('afterUpdate', 'cacheInvalidationLevelCreditUpdate', async (credit: LevelCredit, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (credit.levelId) await invalidateLevelCache(credit.levelId);
      });
    } else {
      if (credit.levelId) await invalidateLevelCache(credit.levelId);
    }
  });

  LevelCredit.addHook('afterDestroy', 'cacheInvalidationLevelCreditDestroy', async (credit: LevelCredit, options: any) => {
    const levelId = credit.levelId;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (levelId) await invalidateLevelCache(levelId);
      });
    } else {
      if (levelId) await invalidateLevelCache(levelId);
    }
  });

  // LevelAlias hooks - invalidate cache when aliases are created/updated/deleted
  LevelAlias.addHook('afterCreate', 'cacheInvalidationLevelAliasCreate', async (alias: LevelAlias, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (alias.levelId) await invalidateLevelCache(alias.levelId);
      });
    } else {
      if (alias.levelId) await invalidateLevelCache(alias.levelId);
    }
  });

  LevelAlias.addHook('afterUpdate', 'cacheInvalidationLevelAliasUpdate', async (alias: LevelAlias, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (alias.levelId) await invalidateLevelCache(alias.levelId);
      });
    } else {
      if (alias.levelId) await invalidateLevelCache(alias.levelId);
    }
  });

  LevelAlias.addHook('afterDestroy', 'cacheInvalidationLevelAliasDestroy', async (alias: LevelAlias, options: any) => {
    const levelId = alias.levelId;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (levelId) await invalidateLevelCache(levelId);
      });
    } else {
      if (levelId) await invalidateLevelCache(levelId);
    }
  });

  // LevelTagAssignment hooks - invalidate cache when tag assignments change
  LevelTagAssignment.addHook('afterCreate', 'cacheInvalidationLevelTagAssignmentCreate', async (assignment: LevelTagAssignment, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (assignment.levelId) await invalidateLevelCache(assignment.levelId);
      });
    } else {
      if (assignment.levelId) await invalidateLevelCache(assignment.levelId);
    }
  });

  LevelTagAssignment.addHook('afterDestroy', 'cacheInvalidationLevelTagAssignmentDestroy', async (assignment: LevelTagAssignment, options: any) => {
    const levelId = assignment.levelId;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (levelId) await invalidateLevelCache(levelId);
      });
    } else {
      if (levelId) await invalidateLevelCache(levelId);
    }
  });

  // LevelLikes hooks - invalidate cache when likes change (affects isLiked in response)
  LevelLikes.addHook('afterCreate', 'cacheInvalidationLevelLikesCreate', async (like: LevelLikes, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (like.levelId) await invalidateLevelCache(like.levelId);
      });
    } else {
      if (like.levelId) await invalidateLevelCache(like.levelId);
    }
  });

  LevelLikes.addHook('afterDestroy', 'cacheInvalidationLevelLikesDestroy', async (like: LevelLikes, options: any) => {
    const levelId = like.levelId;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (levelId) await invalidateLevelCache(levelId);
      });
    } else {
      if (levelId) await invalidateLevelCache(levelId);
    }
  });

  // Song hooks - invalidate cache for all levels using this song when song changes
  Song.addHook('afterUpdate', 'cacheInvalidationSongUpdate', async (song: Song, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        const levelIds = await getLevelIdsBySongId(song.id);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      });
    } else {
      const levelIds = await getLevelIdsBySongId(song.id);
      if (levelIds.length > 0) {
        await invalidateLevelsCache(levelIds);
      }
    }
  });

  Song.addHook('afterDestroy', 'cacheInvalidationSongDestroy', async (song: Song, options: any) => {
    const songId = song.id;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        const levelIds = await getLevelIdsBySongId(songId);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      });
    } else {
      const levelIds = await getLevelIdsBySongId(songId);
      if (levelIds.length > 0) {
        await invalidateLevelsCache(levelIds);
      }
    }
  });

  // Artist hooks - invalidate cache for all levels using songs with credits from this artist
  Artist.addHook('afterUpdate', 'cacheInvalidationArtistUpdate', async (artist: Artist, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        const levelIds = await getLevelIdsByArtistId(artist.id);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      });
    } else {
      const levelIds = await getLevelIdsByArtistId(artist.id);
      if (levelIds.length > 0) {
        await invalidateLevelsCache(levelIds);
      }
    }
  });

  Artist.addHook('afterDestroy', 'cacheInvalidationArtistDestroy', async (artist: Artist, options: any) => {
    const artistId = artist.id;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        const levelIds = await getLevelIdsByArtistId(artistId);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      });
    } else {
      const levelIds = await getLevelIdsByArtistId(artistId);
      if (levelIds.length > 0) {
        await invalidateLevelsCache(levelIds);
      }
    }
  });

  // SongCredit hooks - invalidate cache for all levels using the song when credits change
  SongCredit.addHook('afterCreate', 'cacheInvalidationSongCreditCreate', async (credit: SongCredit, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (credit.songId) {
          const levelIds = await getLevelIdsBySongId(credit.songId);
          if (levelIds.length > 0) {
            await invalidateLevelsCache(levelIds);
          }
        }
      });
    } else {
      if (credit.songId) {
        const levelIds = await getLevelIdsBySongId(credit.songId);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      }
    }
  });

  SongCredit.addHook('afterUpdate', 'cacheInvalidationSongCreditUpdate', async (credit: SongCredit, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (credit.songId) {
          const levelIds = await getLevelIdsBySongId(credit.songId);
          if (levelIds.length > 0) {
            await invalidateLevelsCache(levelIds);
          }
        }
      });
    } else {
      if (credit.songId) {
        const levelIds = await getLevelIdsBySongId(credit.songId);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      }
    }
  });

  SongCredit.addHook('afterDestroy', 'cacheInvalidationSongCreditDestroy', async (credit: SongCredit, options: any) => {
    const songId = credit.songId;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (songId) {
          const levelIds = await getLevelIdsBySongId(songId);
          if (levelIds.length > 0) {
            await invalidateLevelsCache(levelIds);
          }
        }
      });
    } else {
      if (songId) {
        const levelIds = await getLevelIdsBySongId(songId);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      }
    }
  });

  // SongAlias hooks - invalidate cache for all levels using this song when aliases change
  SongAlias.addHook('afterCreate', 'cacheInvalidationSongAliasCreate', async (alias: SongAlias, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (alias.songId) {
          const levelIds = await getLevelIdsBySongId(alias.songId);
          if (levelIds.length > 0) {
            await invalidateLevelsCache(levelIds);
          }
        }
      });
    } else {
      if (alias.songId) {
        const levelIds = await getLevelIdsBySongId(alias.songId);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      }
    }
  });

  SongAlias.addHook('afterUpdate', 'cacheInvalidationSongAliasUpdate', async (alias: SongAlias, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (alias.songId) {
          const levelIds = await getLevelIdsBySongId(alias.songId);
          if (levelIds.length > 0) {
            await invalidateLevelsCache(levelIds);
          }
        }
      });
    } else {
      if (alias.songId) {
        const levelIds = await getLevelIdsBySongId(alias.songId);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      }
    }
  });

  SongAlias.addHook('afterDestroy', 'cacheInvalidationSongAliasDestroy', async (alias: SongAlias, options: any) => {
    const songId = alias.songId;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (songId) {
          const levelIds = await getLevelIdsBySongId(songId);
          if (levelIds.length > 0) {
            await invalidateLevelsCache(levelIds);
          }
        }
      });
    } else {
      if (songId) {
        const levelIds = await getLevelIdsBySongId(songId);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      }
    }
  });

  // ArtistAlias hooks - invalidate cache for all levels using songs with credits from this artist
  ArtistAlias.addHook('afterCreate', 'cacheInvalidationArtistAliasCreate', async (alias: ArtistAlias, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (alias.artistId) {
          const levelIds = await getLevelIdsByArtistId(alias.artistId);
          if (levelIds.length > 0) {
            await invalidateLevelsCache(levelIds);
          }
        }
      });
    } else {
      if (alias.artistId) {
        const levelIds = await getLevelIdsByArtistId(alias.artistId);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      }
    }
  });

  ArtistAlias.addHook('afterUpdate', 'cacheInvalidationArtistAliasUpdate', async (alias: ArtistAlias, options: any) => {
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (alias.artistId) {
          const levelIds = await getLevelIdsByArtistId(alias.artistId);
          if (levelIds.length > 0) {
            await invalidateLevelsCache(levelIds);
          }
        }
      });
    } else {
      if (alias.artistId) {
        const levelIds = await getLevelIdsByArtistId(alias.artistId);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      }
    }
  });

  ArtistAlias.addHook('afterDestroy', 'cacheInvalidationArtistAliasDestroy', async (alias: ArtistAlias, options: any) => {
    const artistId = alias.artistId;
    if (options.transaction) {
      await options.transaction.afterCommit(async () => {
        if (artistId) {
          const levelIds = await getLevelIdsByArtistId(artistId);
          if (levelIds.length > 0) {
            await invalidateLevelsCache(levelIds);
          }
        }
      });
    } else {
      if (artistId) {
        const levelIds = await getLevelIdsByArtistId(artistId);
        if (levelIds.length > 0) {
          await invalidateLevelsCache(levelIds);
        }
      }
    }
  });

  logger.info('Level cache hooks initialized');
}
