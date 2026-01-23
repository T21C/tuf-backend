#!/usr/bin/env node

import sequelize from '../../config/db.js';
import Level from '../../models/levels/Level.js';
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
const CONFIRMATION_REQUIRED = true; // Set to false to skip confirmation prompt

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
  songAliases: string[];
  artistAliases: string[];
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

  // Collect potential aliases
  // For songs: variations with different casing, extra spaces
  const songAliases: string[] = [];
  if (songText !== songText.toLowerCase()) {
    songAliases.push(songText.toLowerCase());
  }
  if (songText !== songText.toUpperCase()) {
    songAliases.push(songText.toUpperCase());
  }

  // For artists: variations with different casing, split variations
  const artistAliases: string[] = [];
  artistNames.forEach(artist => {
    if (artist !== artist.toLowerCase()) {
      artistAliases.push(artist.toLowerCase());
    }
    if (artist !== artist.toUpperCase()) {
      artistAliases.push(artist.toUpperCase());
    }
  });

  return {
    songName,
    artistNames,
    songAliases: [...new Set(songAliases)],
    artistAliases: [...new Set(artistAliases)]
  };
}

/**
 * Check if artist exists (for tracking created vs matched)
 * Uses same logic as ArtistService.findOrCreateArtist
 */
async function artistExists(name: string): Promise<boolean> {
  const artistService = ArtistService.getInstance();
  const normalizedName = artistService.normalizeArtistName(name);
  
  // Check exact name match
  const artist = await Artist.findOne({
    where: {
      name: {
        [Op.like]: normalizedName
      }
    }
  });
  
  return !!artist;
}

/**
 * Check if song exists (for tracking created vs matched)
 * Uses same logic as SongService.findOrCreateSong
 */
async function songExists(name: string): Promise<boolean> {
  const songService = SongService.getInstance();
  const normalizedName = songService.normalizeSongName(name);
  
  // Check exact name match
  const song = await Song.findOne({
    where: {
      name: {
        [Op.like]: normalizedName
      }
    }
  });
  
  return !!song;
}

/**
 * Migrate a single level from text-based to normalized structure
 */
async function migrateLevel(
  level: Level,
  stats: MigrationStats,
  dryRun: boolean = false,
  transaction?: any
): Promise<void> {
  try {
    // Skip if already migrated (only check songId, not artistId)
    // Levels only relate to songs, not directly to artists
    if (level.songId !== null) {
      stats.skippedLevels++;
      logger.debug(`Level ${level.id}: Already migrated (songId: ${level.songId})`);
      return;
    }

    // Skip if no text data
    if (!level.song || !level.artist) {
      stats.skippedLevels++;
      logger.debug(`Level ${level.id}: Missing song or artist text fields`);
      return;
    }

    const parsed = parseSongAndArtist(level);
    if (!parsed) {
      stats.skippedLevels++;
      logger.debug(`Level ${level.id}: Could not parse song/artist`);
      return;
    }

    logger.info(`\nProcessing Level ${level.id}:`);
    logger.info(`  Song: "${parsed.songName}"`);
    logger.info(`  Artists: ${parsed.artistNames.join(', ')}`);

    // Check if song exists before creating (for stats)
    const songExistedBefore = await songExists(parsed.songName);

    // Find or create song
    const song = await SongService.getInstance().findOrCreateSong(
      parsed.songName,
      parsed.songAliases.length > 0 ? parsed.songAliases : undefined
    );

    if (!song) {
      throw new Error('Failed to find or create song');
    }

    if (!songExistedBefore) {
      stats.songsCreated++;
      logger.info(`  Song CREATED: ${song.name} (ID: ${song.id})`);
    } else {
      stats.songsMatched++;
      logger.info(`  Song MATCHED: ${song.name} (ID: ${song.id})`);
    }

    // Find or create artists
    const artists: Array<{ id: number; name: string }> = [];
    for (const artistName of parsed.artistNames) {
      // Check if artist exists before creating (for stats)
      const artistExistedBefore = await artistExists(artistName);

      const artist = await ArtistService.getInstance().findOrCreateArtist(
        artistName,
        parsed.artistAliases.length > 0 ? parsed.artistAliases : undefined
      );

      if (!artist) {
        throw new Error(`Failed to find or create artist: ${artistName}`);
      }

      if (!artistExistedBefore) {
        stats.artistsCreated++;
        logger.info(`  Artist CREATED: ${artist.name} (ID: ${artist.id})`);
      } else {
        stats.artistsMatched++;
        logger.info(`  Artist MATCHED: ${artist.name} (ID: ${artist.id})`);
      }

      artists.push({ id: artist.id, name: artist.name });
    }

    // Create song credits (link song to artists)
    // Note: Levels only relate to songs, not directly to artists
    // Artists are accessed through songs->songCredits->artists
    
    if (!dryRun) {
      // Create credits for all artists
      for (const artist of artists) {
        const existingCredit = await SongCredit.findOne({
          where: {
            songId: song.id,
            artistId: artist.id,
            role: null
          },
          transaction
        });

        if (!existingCredit) {
          await SongCredit.create({
            songId: song.id,
            artistId: artist.id,
            role: null
          }, { transaction });
          stats.creditsCreated++;
          logger.info(`  Created credit: Song ${song.id} -> Artist ${artist.id}`);
        }
      }

      // Update level with normalized songId only (not artistId)
      // Levels access artists through songs->songCredits->artists
      await level.update({
        songId: song.id
      }, { transaction });
      stats.levelsUpdated++;
      logger.info(`  Updated Level ${level.id} with songId=${song.id}`);
    } else {
      logger.info(`  [DRY RUN] Would create credits and update level`);
    }

    stats.processedLevels++;

  } catch (error: any) {
    stats.errorLevels++;
    const errorMsg = error.message || String(error);
    stats.errors.push({ levelId: level.id, error: errorMsg });
    logger.error(`Error migrating Level ${level.id}:`, errorMsg);
    throw error; // Re-throw to allow transaction rollback
  }
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

    const level = await Level.findByPk(levelId, { transaction });
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
    let currentOffset = startOffset;
    let processedInBatch = 0;
    while (currentOffset < totalCount && processedInBatch < maxLevels) {
      const batchTransaction = await sequelize.transaction();
      
      try {
        // Calculate how many levels to fetch in this batch
        const remainingToProcess = maxLevels - processedInBatch;
        const batchLimit = Math.min(BATCH_SIZE, remainingToProcess);
        
        const levels = await Level.findAll({
          where: {
            songId: null,
            isDeleted: false
          },
          limit: batchLimit,
          offset: currentOffset,
          order: [['id', 'ASC']],
          transaction: batchTransaction
        });

        if (levels.length === 0) break;

        const batchNumber = Math.floor(currentOffset / BATCH_SIZE) + 1;
        const totalBatches = isBatchMode 
          ? Math.ceil(stats.totalLevels / BATCH_SIZE)
          : Math.ceil(totalCount / BATCH_SIZE);
        
        logger.info(`\nProcessing batch ${batchNumber}${isBatchMode ? ` (${batchNumber}/${totalBatches} in this batch)` : `/${totalBatches}`} (${levels.length} levels)`);

        for (const level of levels) {
          try {
            await migrateLevel(level, stats, dryRun, batchTransaction);
          } catch (error) {
            // Error already logged in migrateLevel, continue with next level
            // Transaction will be rolled back for this batch if needed
          }
        }

        if (!dryRun) {
          await batchTransaction.commit();
          logger.info(`Batch ${batchNumber} committed successfully`);
        } else {
          await safeTransactionRollback(batchTransaction);
        }

        currentOffset += levels.length;
        processedInBatch += levels.length;

        // Progress update
        const processed = stats.processedLevels + stats.skippedLevels + stats.errorLevels;
        if (isBatchMode) {
          logger.info(`Progress: ${processed}/${stats.totalLevels} levels processed in this batch (${((processed / stats.totalLevels) * 100).toFixed(1)}%)`);
          logger.info(`Overall offset: ${currentOffset}/${totalCount} total levels`);
        } else {
          logger.info(`Progress: ${processed}/${stats.totalLevels} levels processed (${((processed / stats.totalLevels) * 100).toFixed(1)}%)`);
        }

      } catch (error: any) {
        await safeTransactionRollback(batchTransaction);
        logger.error(`Error in batch ${Math.floor(currentOffset / BATCH_SIZE) + 1}:`, error);
        // Continue with next batch
        currentOffset += BATCH_SIZE;
        processedInBatch += BATCH_SIZE;
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
