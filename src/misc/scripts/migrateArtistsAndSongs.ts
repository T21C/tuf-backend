#!/usr/bin/env node

import sequelize from '../../config/db.js';
import Level from '../../models/levels/Level.js';
import LevelTag from '../../models/levels/LevelTag.js';
import LevelTagAssignment from '../../models/levels/LevelTagAssignment.js';
import { initializeAssociations } from '../../models/associations.js';
import { logger } from '../../server/services/LoggerService.js';
import { safeTransactionRollback } from '../utils/Utility.js';
import ArtistService from '../../server/services/ArtistService.js';
import SongService from '../../server/services/SongService.js';
import SongCredit from '../../models/songs/SongCredit.js';
import Artist from '../../models/artists/Artist.js';
import Song from '../../models/songs/Song.js';
import { Op } from 'sequelize';

// Configuration
const BATCH_SIZE = 100; // Process levels in batches
const CONFIRMATION_REQUIRED = false; // Set to false to skip confirmation prompt

interface MigrationStats {
  totalLevels: number;
  processedLevels: number;
  skippedLevels: number;
  errorLevels: number;
  artistsCreated: number;
  artistsMatched: number;
  songsCreated: number;
  songsMatched: number;
  creditsCreated: number;
  levelsUpdated: number;
  errors: Array<{ levelId: number; error: string }>;
}

interface ParsedSongArtist {
  songName: string;
  artistNames: string[];
}

/**
 * Parse song and artist names from level text fields
 * Handles multiple artists separated by ampersand
 * Collects aliases from variations
 */
function parseSongAndArtist(level: Level): ParsedSongArtist | null {
  const songText = level.song?.trim();
  const artistText = level.artist?.trim();

  if (!songText || !artistText) {
    return null;
  }

  // Normalize to lowercase for processing
  const songName = songText;
  const artistNames = artistText.split('&').map(a => a.trim()).filter(a => a.length > 0);

  return {
    songName,
    artistNames
  };
}

/**
 * Batch check which artists exist (for tracking created vs matched)
 * Returns a Set of normalized names that exist
 */
async function batchCheckArtistsExist(names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  
  const artistService = ArtistService.getInstance();
  const normalizedNames = names.map(name => artistService.normalizeArtistName(name));
  
  const existingArtists = await Artist.findAll({
    where: {
      name: {
        [Op.in]: normalizedNames
      }
    },
    attributes: ['name']
  });
  
  const existingSet = new Set<string>();
  existingArtists.forEach(artist => {
    existingSet.add(artistService.normalizeArtistName(artist.name));
  });
  
  return existingSet;
}

/**
 * Batch check which songs exist (for tracking created vs matched)
 * Returns a Set of normalized names that exist
 */
async function batchCheckSongsExist(names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  
  const songService = SongService.getInstance();
  const normalizedNames = names.map(name => songService.normalizeSongName(name));
  
  const existingSongs = await Song.findAll({
    where: {
      name: {
        [Op.in]: normalizedNames
      }
    },
    attributes: ['name']
  });
  
  const existingSet = new Set<string>();
  existingSongs.forEach(song => {
    existingSet.add(songService.normalizeSongName(song.name));
  });
  
  return existingSet;
}

/**
 * Batch check existing song credits
 * Returns a Set of "songId-artistId" strings for existing credits
 * Checks for ANY credit regardless of role, since uniqueness is enforced on songId+artistId
 */
async function batchCheckCreditsExist(
  songIds: number[],
  artistIds: number[],
  transaction?: any
): Promise<Set<string>> {
  if (songIds.length === 0 || artistIds.length === 0) return new Set();
  
  const existingCredits = await SongCredit.findAll({
    where: {
      songId: { [Op.in]: songIds },
      artistId: { [Op.in]: artistIds }
      // Don't filter by role - check for ANY credit since uniqueness is on songId+artistId
    },
    attributes: ['songId', 'artistId'],
    transaction
  });
  
  const existingSet = new Set<string>();
  existingCredits.forEach(credit => {
    existingSet.add(`${credit.songId}-${credit.artistId}`);
  });
  
  return existingSet;
}

/**
 * Batch migrate multiple levels from text-based to normalized structure
 * This function processes levels in batches to minimize database queries
 */
async function migrateLevelsBatch(
  levels: Level[],
  stats: MigrationStats,
  dryRun: boolean = false,
  transaction?: any
): Promise<void> {
  if (levels.length === 0) return;

  try {
    // Parse all levels first
    const levelData: Array<{
      level: Level;
      parsed: ParsedSongArtist;
      levelTags: LevelTag[];
    }> = [];

    for (const level of levels) {
      // Skip if already migrated
      if (level.songId !== null) {
        stats.skippedLevels++;
        continue;
      }

      // Skip if no text data
      if (!level.song || !level.artist) {
        stats.skippedLevels++;
        continue;
      }

      const parsed = parseSongAndArtist(level);
      if (!parsed) {
        stats.skippedLevels++;
        continue;
      }

      // Get tags (should already be loaded from batch query)
      const levelTags: LevelTag[] = (level as any).tags && Array.isArray((level as any).tags)
        ? (level as any).tags
        : [];

      levelData.push({ level, parsed, levelTags });
    }

    if (levelData.length === 0) return;

    // Collect all unique song and artist names for batch checking
    const allSongNames = new Set<string>();
    const allArtistNames = new Set<string>();
    
    levelData.forEach(({ parsed }) => {
      allSongNames.add(parsed.songName);
      parsed.artistNames.forEach(name => allArtistNames.add(name));
    });

    // Batch check existence
    const artistService = ArtistService.getInstance();
    const songService = SongService.getInstance();
    
    const existingSongsSet = await batchCheckSongsExist(Array.from(allSongNames));
    const existingArtistsSet = await batchCheckArtistsExist(Array.from(allArtistNames));

    // Process each level
    const songsToUpdate: Array<{ song: Song; newState: string }> = [];
    const creditsToCreate: Array<{ songId: number; artistId: number }> = [];
    const levelsToUpdate: Array<{ level: Level; songId: number }> = [];

    for (const { level, parsed, levelTags } of levelData) {
      try {
        logger.info(`\nProcessing Level ${level.id}:`);
        logger.info(`  Song: "${parsed.songName}"`);
        logger.info(`  Artists: ${parsed.artistNames.join(', ')}`);

        // Check if level has "Youtube Stream" tag
        const hasYoutubeStreamTag = levelTags.some(
          (tag: LevelTag) => tag.name === 'Youtube Stream'
        );

        // Determine song verification state
        let songVerificationState: 'declined' | 'pending' | 'conditional' | 'ysmod_only' | 'allowed' = 'allowed';
        if (hasYoutubeStreamTag) {
          songVerificationState = 'ysmod_only';
          logger.info(`  Level has "Youtube Stream" tag - setting song to YSMod Only`);
        } else if (!level.isDeleted) {
          songVerificationState = 'allowed';
          logger.info(`  Level not deleted - setting song to Allowed`);
        } else {
          songVerificationState = 'allowed';
          logger.info(`  Level is deleted - setting song to Allowed (default)`);
        }

        // Check if song existed before
        const normalizedSongName = songService.normalizeSongName(parsed.songName);
        const songExistedBefore = existingSongsSet.has(normalizedSongName);

        // Find or create song
        const song = await SongService.getInstance().findOrCreateSong(
          parsed.songName
        );

        if (!song) {
          throw new Error('Failed to find or create song');
        }

        // Track for batch update
        if (!songExistedBefore) {
          stats.songsCreated++;
          logger.info(`  Song CREATED: ${song.name} (ID: ${song.id})`);
          songsToUpdate.push({ song, newState: songVerificationState });
        } else {
          stats.songsMatched++;
          logger.info(`  Song MATCHED: ${song.name} (ID: ${song.id})`);
          if (song.verificationState !== songVerificationState) {
            songsToUpdate.push({ song, newState: songVerificationState });
            logger.info(`  Will update song verification state from ${song.verificationState} to: ${songVerificationState}`);
          }
        }

        // Find or create artists
        const artists: Array<{ id: number; name: string }> = [];
        for (const artistName of parsed.artistNames) {
          const normalizedArtistName = artistService.normalizeArtistName(artistName);
          const artistExistedBefore = existingArtistsSet.has(normalizedArtistName);

          const artist = await ArtistService.getInstance().findOrCreateArtist(
            artistName,
            undefined, // No aliases
            'allowed' // Set all new artists to 'allowed'
          );

          if (!artist) {
            throw new Error(`Failed to find or create artist: ${artistName}`);
          }

          if (!artistExistedBefore) {
            stats.artistsCreated++;
            logger.info(`  Artist CREATED: ${artist.name} (ID: ${artist.id}) with verificationState: allowed`);
          } else {
            stats.artistsMatched++;
            logger.info(`  Artist MATCHED: ${artist.name} (ID: ${artist.id})`);
          }

          artists.push({ id: artist.id, name: artist.name });
          
          // Track credits to create
          creditsToCreate.push({ songId: song.id, artistId: artist.id });
        }

        // Track level update
        levelsToUpdate.push({ level, songId: song.id });

        stats.processedLevels++;

      } catch (error: any) {
        stats.errorLevels++;
        const errorMsg = error.message || String(error);
        stats.errors.push({ levelId: level.id, error: errorMsg });
        logger.error(`Error migrating Level ${level.id}:`, errorMsg);
        // Continue with next level instead of throwing
      }
    }

    // Batch operations
    if (!dryRun) {
      // Batch update songs
      if (songsToUpdate.length > 0) {
        const songUpdates = songsToUpdate.map(({ song, newState }) => ({
          id: song.id,
          verificationState: newState
        }));

        // Group by verification state for efficient updates
        const updatesByState = new Map<string, number[]>();
        songUpdates.forEach(update => {
          if (!updatesByState.has(update.verificationState)) {
            updatesByState.set(update.verificationState, []);
          }
          updatesByState.get(update.verificationState)!.push(update.id);
        });

        // Execute batch updates
        for (const [state, ids] of updatesByState.entries()) {
          await Song.update(
            { verificationState: state as any },
            {
              where: { id: { [Op.in]: ids } },
              transaction
            }
          );
        }
        logger.info(`  Batch updated ${songsToUpdate.length} songs`);
      }

      // Batch check existing credits
      const songIds = [...new Set(creditsToCreate.map(c => c.songId))];
      const artistIds = [...new Set(creditsToCreate.map(c => c.artistId))];
      const existingCreditsSet = await batchCheckCreditsExist(songIds, artistIds, transaction);

      // Filter out existing credits
      const newCredits = creditsToCreate.filter(
        credit => !existingCreditsSet.has(`${credit.songId}-${credit.artistId}`)
      );

      // Batch create credits
      if (newCredits.length > 0) {
        // Ensure role is explicitly null for consistency
        const creditsWithRole = newCredits.map(credit => ({
          songId: credit.songId,
          artistId: credit.artistId,
          role: null // Explicitly set role to null
        }));
        
        await SongCredit.bulkCreate(creditsWithRole, { 
          transaction,
          ignoreDuplicates: true // Safety measure - prevents errors if duplicates somehow slip through
        });
        stats.creditsCreated += newCredits.length;
        logger.info(`  Batch created ${newCredits.length} credits`);
      }

      // Batch update levels
      if (levelsToUpdate.length > 0) {
        const levelUpdates = levelsToUpdate.map(({ level, songId }) => ({
          id: level.id,
          songId
        }));

        // Use Promise.all for parallel updates (more efficient than bulk update with different values)
        await Promise.all(
          levelUpdates.map(({ id, songId }) =>
            Level.update({ songId }, { where: { id }, transaction })
          )
        );
        stats.levelsUpdated += levelsToUpdate.length;
        logger.info(`  Batch updated ${levelsToUpdate.length} levels`);
      }
    } else {
      logger.info(`  [DRY RUN] Would update ${songsToUpdate.length} songs, create ${creditsToCreate.length} credits, update ${levelsToUpdate.length} levels`);
    }

  } catch (error: any) {
    logger.error('Error in batch migration:', error);
    throw error;
  }
}

/**
 * Migrate a single level from text-based to normalized structure
 * (Kept for backward compatibility, but now uses batch processing internally)
 */
/**
 * Migrate a single level from text-based to normalized structure
 * (Kept for backward compatibility, but now uses batch processing internally)
 */
async function migrateLevel(
  level: Level,
  stats: MigrationStats,
  dryRun: boolean = false,
  transaction?: any
): Promise<void> {
  await migrateLevelsBatch([level], stats, dryRun, transaction);
}

/**
 * Migrate a single level by ID (for testing)
 */
async function migrateSingleLevel(levelId: number, dryRun: boolean = false): Promise<void> {
  const transaction = await sequelize.transaction();
  const stats: MigrationStats = {
    totalLevels: 1,
    processedLevels: 0,
    skippedLevels: 0,
    errorLevels: 0,
    artistsCreated: 0,
    artistsMatched: 0,
    songsCreated: 0,
    songsMatched: 0,
    creditsCreated: 0,
    levelsUpdated: 0,
    errors: []
  };

  try {
    logger.info(`\n=== Single Level Migration Test (Level ID: ${levelId}) ===`);
    if (dryRun) {
      logger.info('DRY RUN MODE - No changes will be saved');
    }

    const level = await Level.findByPk(levelId, {
      include: [{
        model: LevelTag,
        as: 'tags',
        through: {
          attributes: []
        },
        required: false
      }],
      transaction
    });
    if (!level) {
      throw new Error(`Level ${levelId} not found`);
    }

    await migrateLevel(level, stats, dryRun, transaction);

    if (!dryRun) {
      await transaction.commit();
      logger.info('\n=== Migration completed successfully ===');
    } else {
      await safeTransactionRollback(transaction);
      logger.info('\n=== Dry run completed (no changes saved) ===');
    }

    printStats(stats);

  } catch (error: any) {
    await safeTransactionRollback(transaction);
    logger.error('Migration failed:', error);
    throw error;
  }
}

/**
 * Migrate all levels in batches
 */
async function migrateAllLevels(dryRun: boolean = false, limit?: number, offset?: number): Promise<void> {
  const stats: MigrationStats = {
    totalLevels: 0,
    processedLevels: 0,
    skippedLevels: 0,
    errorLevels: 0,
    artistsCreated: 0,
    artistsMatched: 0,
    songsCreated: 0,
    songsMatched: 0,
    creditsCreated: 0,
    levelsUpdated: 0,
    errors: []
  };

  try {
    const isBatchMode = limit !== undefined;
    const startOffset = offset ?? 0;
    const maxLevels = limit ?? Infinity;
    
    logger.info(`\n=== ${isBatchMode ? 'Batch' : 'Full'} Migration ${dryRun ? '(DRY RUN)' : ''} ===`);
    if (dryRun) {
      logger.info('DRY RUN MODE - No changes will be saved');
    }
    if (isBatchMode && limit !== undefined) {
      logger.info(`Batch mode: Processing ${limit} levels starting from offset ${startOffset}`);
    }

    // Get total count
    const totalCount = await Level.count({
      where: {
        [Op.or]: [
          { songId: null }
        ],
        isDeleted: false
      }
    });

    stats.totalLevels = isBatchMode && limit !== undefined ? Math.min(limit, totalCount - startOffset) : totalCount;
    
    logger.info(`Found ${totalCount} total levels to migrate`);
    if (isBatchMode && limit !== undefined) {
      logger.info(`Processing ${stats.totalLevels} levels (offset: ${startOffset}, limit: ${limit})`);
    } else {
      logger.info(`Processing all ${stats.totalLevels} levels`);
    }

    if (CONFIRMATION_REQUIRED && !dryRun && !isBatchMode) {
      logger.info('\nWARNING: This operation will update songId for all levels.');
      logger.info('Note: Levels only relate to songs. Artists are accessed through songs->songCredits->artists.');
      logger.info('Make sure you have backed up your database before proceeding.');
      logger.info('Press Ctrl+C to cancel or wait 10 seconds to continue...');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }

    // Process in batches (each batch gets its own transaction)
    // Note: We always use offset: 0 because the WHERE clause (songId: null) naturally excludes
    // already-processed levels. As levels are migrated, their songId changes, so they won't
    // match the WHERE clause anymore. This avoids skipping records due to offset misalignment.
    let batchNumber = 0;
    let processedInBatch = 0;
    
    while (processedInBatch < maxLevels) {
      const batchTransaction = await sequelize.transaction();
      
      try {
        // Calculate how many levels to fetch in this batch
        const remainingToProcess = maxLevels - processedInBatch;
        const batchLimit = Math.min(BATCH_SIZE, remainingToProcess);
        
        // Always use offset: 0 since WHERE clause excludes already-processed levels
        const levels = await Level.findAll({
          where: {
            songId: null,
            isDeleted: false
          },
          limit: batchLimit,
          offset: 0, // Always start from beginning - WHERE clause handles filtering
          order: [['id', 'ASC']],
          include: [{
            model: LevelTag,
            as: 'tags',
            through: {
              attributes: []
            },
            required: false
          }],
          transaction: batchTransaction
        });

        // If no levels found, we're done
        if (levels.length === 0) {
          logger.info('No more levels to migrate');
          break;
        }

        batchNumber++;
        const totalBatches = isBatchMode 
          ? Math.ceil(stats.totalLevels / BATCH_SIZE)
          : Math.ceil(totalCount / BATCH_SIZE);
        
        logger.info(`\nProcessing batch ${batchNumber}${isBatchMode ? ` (${batchNumber}/${totalBatches} in this batch)` : `/${totalBatches}`} (${levels.length} levels)`);

        // Process all levels in this batch together
        try {
          await migrateLevelsBatch(levels, stats, dryRun, batchTransaction);
        } catch (error) {
          // Error already logged in migrateLevelsBatch
          throw error; // Re-throw to trigger batch rollback
        }

        if (!dryRun) {
          await batchTransaction.commit();
          logger.info(`Batch ${batchNumber} committed successfully`);
        } else {
          await safeTransactionRollback(batchTransaction);
        }

        processedInBatch += levels.length;

        // Progress update
        const processed = stats.processedLevels + stats.skippedLevels + stats.errorLevels;
        if (isBatchMode) {
          logger.info(`Progress: ${processed}/${stats.totalLevels} levels processed in this batch (${((processed / stats.totalLevels) * 100).toFixed(1)}%)`);
        } else {
          logger.info(`Progress: ${processed}/${stats.totalLevels} levels processed (${((processed / stats.totalLevels) * 100).toFixed(1)}%)`);
        }

        // If we got fewer levels than requested, we've processed all remaining levels
        if (levels.length < batchLimit) {
          logger.info('All remaining levels have been processed');
          break;
        }

      } catch (error: any) {
        await safeTransactionRollback(batchTransaction);
        logger.error(`Error in batch ${batchNumber}:`, error);
        // Break on error to avoid infinite loop - user can restart migration
        logger.error('Stopping migration due to error. You can restart from where it left off.');
        break;
      }
    }

    logger.info('\n=== Migration completed ===');
    printStats(stats);

  } catch (error: any) {
    logger.error('Migration failed:', error);
    throw error;
  }
}

/**
 * Print migration statistics
 */
function printStats(stats: MigrationStats): void {
  logger.info('\n=== Migration Statistics ===');
  logger.info(`Total levels: ${stats.totalLevels}`);
  logger.info(`Processed: ${stats.processedLevels}`);
  logger.info(`Skipped: ${stats.skippedLevels}`);
  logger.info(`Errors: ${stats.errorLevels}`);
  logger.info(`\nArtists:`);
  logger.info(`  Created: ${stats.artistsCreated}`);
  logger.info(`  Matched: ${stats.artistsMatched}`);
  logger.info(`\nSongs:`);
  logger.info(`  Created: ${stats.songsCreated}`);
  logger.info(`  Matched: ${stats.songsMatched}`);
  logger.info(`\nLevels updated: ${stats.levelsUpdated}`);
  logger.info(`Credits created: ${stats.creditsCreated}`);

  if (stats.errors.length > 0) {
    logger.info(`\nErrors encountered (${stats.errors.length}):`);
    stats.errors.slice(0, 20).forEach(({ levelId, error }) => {
      logger.error(`  Level ${levelId}: ${error}`);
    });
    if (stats.errors.length > 20) {
      logger.info(`  ... and ${stats.errors.length - 20} more errors`);
    }
  }
}

/**
 * Show preview of what would be migrated
 */
async function previewMigration(limit: number = 10): Promise<void> {
  logger.info(`\n=== Migration Preview (showing first ${limit} levels) ===`);

  const levels = await Level.findAll({
    where: {
      songId: null,
      isDeleted: false,
      song: { [Op.not]: undefined },
      artist: { [Op.not]: undefined }
    },
    limit,
    order: [['id', 'ASC']]
  });

  logger.info(`Found ${levels.length} levels to preview:\n`);

  const uniqueSongs = new Set<string>();
  const uniqueArtists = new Set<string>();
  let multiArtistCount = 0;

  for (const level of levels) {
    const parsed = parseSongAndArtist(level);
    if (parsed) {
      logger.info(`Level ${level.id}:`);
      logger.info(`  Song: "${parsed.songName}"`);
      logger.info(`  Artists: ${parsed.artistNames.join(', ')}`);
      logger.info(`  Current: songId=${level.songId || 'null'}`);
      
      uniqueSongs.add(parsed.songName.toLowerCase());
      parsed.artistNames.forEach(a => uniqueArtists.add(a.toLowerCase()));
      if (parsed.artistNames.length > 1) {
        multiArtistCount++;
      }
      
      logger.info('');
    }
  }

  const totalCount = await Level.count({
    where: {
      songId: null,
      isDeleted: false
    }
  });

  logger.info(`\n=== Preview Summary ===`);
  logger.info(`Total levels that would be migrated: ${totalCount}`);
  logger.info(`Unique songs (case-insensitive): ${uniqueSongs.size}`);
  logger.info(`Unique artists (case-insensitive): ${uniqueArtists.size}`);
  logger.info(`Levels with multiple artists: ${multiArtistCount}`);
}

/**
 * Main function
 */
async function main() {
  const command = process.argv[2];
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];

  try {
    await sequelize.authenticate();
    initializeAssociations();
    logger.info('Database connection established successfully.');

    switch (command) {
      case 'test':
        // Test single level migration
        if (!arg1) {
          logger.error('Usage: test <levelId> [dry-run]');
          process.exit(1);
        }
        const levelId = parseInt(arg1);
        if (isNaN(levelId)) {
          logger.error('Invalid level ID');
          process.exit(1);
        }
        await migrateSingleLevel(levelId, arg2 === 'dry-run');
        break;

      case 'preview':
        // Preview what would be migrated
        const limit = arg1 ? parseInt(arg1) : 10;
        await previewMigration(limit);
        break;

      case 'migrate':
        // Full migration
        await migrateAllLevels(arg1 === 'dry-run');
        break;

      case 'dry-run':
        // Dry run (alias for migrate dry-run)
        await migrateAllLevels(true);
        break;

      case 'batch':
        // Batch processing with limit and optional offset
        if (!arg1) {
          logger.error('Usage: batch <limit> [offset] [dry-run]');
          logger.error('Examples:');
          logger.error('  batch 50              - Process 50 levels from offset 0');
          logger.error('  batch 50 100          - Process 50 levels from offset 100');
          logger.error('  batch 50 0 dry-run    - Dry run 50 levels from offset 0');
          logger.error('  batch 50 dry-run      - Dry run 50 levels from offset 0');
          process.exit(1);
        }
        const batchLimit = parseInt(arg1);
        if (isNaN(batchLimit) || batchLimit <= 0) {
          logger.error('Invalid limit. Must be a positive number.');
          process.exit(1);
        }
        // Check if arg2 is 'dry-run' or a number
        let batchOffset = 0;
        let batchDryRun = false;
        if (arg2) {
          if (arg2 === 'dry-run') {
            batchDryRun = true;
          } else {
            batchOffset = parseInt(arg2);
            if (isNaN(batchOffset) || batchOffset < 0) {
              logger.error('Invalid offset. Must be a non-negative number.');
              process.exit(1);
            }
            // Check if there's a third argument for dry-run
            batchDryRun = process.argv[5] === 'dry-run';
          }
        }
        await migrateAllLevels(batchDryRun, batchLimit, batchOffset);
        break;

      default:
        logger.info(`
Artist & Song Migration Script

Usage: node migrateArtistsAndSongs.ts [command] [arguments]

Commands:
  test <levelId> [dry-run]    - Test migration on a single level
  preview [limit]              - Preview what would be migrated (default: 10 levels)
  migrate [dry-run]            - Migrate all levels (add 'dry-run' to test without saving)
  batch <limit> [offset] [dry-run] - Process N levels starting from offset
  dry-run                      - Alias for 'migrate dry-run'

Examples:
  node migrateArtistsAndSongs.ts test 123
  node migrateArtistsAndSongs.ts test 123 dry-run
  node migrateArtistsAndSongs.ts preview 20
  node migrateArtistsAndSongs.ts migrate dry-run
  node migrateArtistsAndSongs.ts migrate
  node migrateArtistsAndSongs.ts batch 50 0
  node migrateArtistsAndSongs.ts batch 100 500 dry-run
  node migrateArtistsAndSongs.ts dry-run

Migration Process:
  1. Processes levels with null songId
  2. Parses song and artist names from text fields
  3. Handles multiple artists (split by '&')
  4. Finds or creates normalized artists and songs
  5. Creates song credits (links songs to artists)
  6. Updates levels with songId only (not artistId)
  7. Levels access artists through songs->songCredits->artists
  8. Preserves original text fields for backward compatibility
        `);
    }

    logger.info('\nScript completed successfully.');
    process.exit(0);

  } catch (error: any) {
    logger.error('Script failed:', error);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

// Execute
main();
