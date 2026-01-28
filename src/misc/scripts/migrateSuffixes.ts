#!/usr/bin/env node

import sequelize from '../../config/db.js';
import Level from '../../models/levels/Level.js';
import { initializeAssociations } from '../../models/associations.js';
import { logger } from '../../server/services/LoggerService.js';
import { safeTransactionRollback } from '../utils/Utility.js';
import SongService from '../../server/services/SongService.js';
import Song from '../../models/songs/Song.js';
import SongAlias from '../../models/songs/SongAlias.js';
import { Op } from 'sequelize';

// Configuration
const BATCH_SIZE = 100; // Process songs in batches
const CONFIRMATION_REQUIRED = false; // Set to false to skip confirmation prompt

interface MigrationStats {
  totalSongs: number;
  processedSongs: number;
  skippedSongs: number;
  errorSongs: number;
  songsRenamed: number;
  songsMerged: number;
  levelsUpdated: number;
  errors: Array<{ songId: number; error: string }>;
}

interface ParsedSuffix {
  baseName: string;
  suffix: string;
  originalName: string;
}

/**
 * Extract suffix from song name (case-insensitive)
 * Returns the first matching suffix found, or null if none found
 * Handles cases like "Song (nerfed) (nerfed)" by extracting only one instance
 */
function extractSuffix(songName: string, targetSuffix: string): ParsedSuffix | null {
  if (!songName || !targetSuffix) {
    return null;
  }

  // Normalize for case-insensitive matching
  const normalizedName = songName.toLowerCase();
  const normalizedSuffix = targetSuffix.toLowerCase();

  // Check if the suffix exists in the name (case-insensitive)
  if (!normalizedName.includes(normalizedSuffix)) {
    return null;
  }

  // Find the actual suffix in the original name (preserving case)
  // Use regex to find the suffix pattern, handling parentheses
  const escapedSuffix = targetSuffix.replace(/[()]/g, '\\$&');
  const regex = new RegExp(`\\s*${escapedSuffix}\\s*`, 'i');
  const match = songName.match(regex);

  if (!match) {
    return null;
  }

  // Find the position of the suffix in the original string (case-insensitive)
  const suffixStart = normalizedName.indexOf(normalizedSuffix);
  if (suffixStart === -1) {
    return null;
  }
  
  // Extract the suffix with original capitalization from the song name
  const actualSuffix = songName.substring(suffixStart, suffixStart + targetSuffix.length);

  // Remove the first occurrence of the suffix (preserving original case)
  // Build a regex that matches the actual suffix with its case
  const actualEscapedSuffix = actualSuffix.replace(/[()]/g, '\\$&');
  const actualRegex = new RegExp(`\\s*${actualEscapedSuffix}\\s*`);
  const baseName = songName.replace(actualRegex, '').trim();

  // Return the suffix with preserved capitalization from the song name
  return {
    baseName,
    suffix: actualSuffix, // Use the actual case from the song name
    originalName: songName
  };
}

/**
 * Find song by normalized name (checks both name and aliases)
 */
async function findSongByName(name: string): Promise<Song | null> {
  const songService = SongService.getInstance();
  const normalizedName = songService.normalizeSongName(name);

  // First, try to find by exact name match (case-insensitive)
  let song = await Song.findOne({
    where: {
      name: {
        [Op.like]: normalizedName
      }
    }
  });

  // If not found, check aliases
  if (!song) {
    const aliasMatch = await SongAlias.findOne({
      where: {
        alias: {
          [Op.like]: normalizedName
        }
      },
      include: [
        {
          model: Song,
          as: 'song'
        }
      ]
    });

    if (aliasMatch?.song) {
      song = aliasMatch.song;
    }
  }

  return song;
}

/**
 * Update level suffix field
 * Inserts suffix at position 0, prepending to existing suffix if any
 */
function updateLevelSuffix(currentSuffix: string | null, newSuffix: string): string {
  if (!currentSuffix) {
    return newSuffix;
  }

  // Prepend new suffix at position 0
  return `${newSuffix} ${currentSuffix}`.trim();
}

/**
 * Batch migrate songs for a specific suffix
 */
async function migrateSuffixBatch(
  songs: Song[],
  suffix: string,
  stats: MigrationStats,
  dryRun = false,
  transaction?: any
): Promise<void> {
  if (songs.length === 0) return;

  try {
    const songService = SongService.getInstance();
    const songsToRename: Array<{ song: Song; newName: string }> = [];
    const songsToMerge: Array<{ sourceSong: Song; targetSong: Song }> = [];
    // Map targetSongId -> array of { levelId, suffix }
    const levelsToUpdateByTarget: Map<number, Array<{ levelId: number; suffix: string }>> = new Map();
    // Map songId -> array of { levelId, suffix } for rename operations
    const levelsToUpdateBySong: Map<number, Array<{ levelId: number; suffix: string }>> = new Map();

    for (const song of songs) {
      try {
        song.name = song.name.trim();
        logger.info(`\nProcessing Song ${song.id}:`);
        logger.info(`  Original name: "${song.name}"`);

        // Extract suffix
        const parsed = extractSuffix(song.name, suffix);
        if (!parsed) {
          stats.skippedSongs++;
          logger.info(`  Skipped: No "${suffix}" suffix found`);
          continue;
        }

        logger.info(`  Extracted suffix: "${parsed.suffix}"`);
        logger.info(`  Base name: "${parsed.baseName}"`);

        // Find if a song with the base name exists
        const targetSong = await findSongByName(parsed.baseName);

        // Get all levels for this song to update their suffix
        const levels = await Level.findAll({
          where: { songId: song.id },
          transaction
        });

        if (targetSong && targetSong.id !== song.id) {
          // Song exists - merge
          logger.info(`  Target song found: "${targetSong.name}" (ID: ${targetSong.id})`);
          logger.info(`  Will merge song ${song.id} into song ${targetSong.id}`);

          songsToMerge.push({ sourceSong: song, targetSong });

          // Store level updates for target song (after merge, levels will point to target)
          if (!levelsToUpdateByTarget.has(targetSong.id)) {
            levelsToUpdateByTarget.set(targetSong.id, []);
          }
          for (const level of levels) {
            const newSuffix = updateLevelSuffix(level.suffix, parsed.suffix);
            levelsToUpdateByTarget.get(targetSong.id)!.push({ levelId: level.id, suffix: newSuffix });
            logger.info(`    Level ${level.id} suffix: ${level.suffix ? `"${level.suffix}"` : 'null'} -> "${newSuffix}"`);
          }

          stats.songsMerged++;
        } else if (!targetSong) {
          // Song doesn't exist - rename
          logger.info(`  No target song found - will rename to "${parsed.baseName}"`);

          songsToRename.push({ song, newName: parsed.baseName });

          // Store level updates for this song (songId stays the same after rename)
          levelsToUpdateBySong.set(song.id, []);
          for (const level of levels) {
            const newSuffix = updateLevelSuffix(level.suffix, parsed.suffix);
            levelsToUpdateBySong.get(song.id)!.push({ levelId: level.id, suffix: newSuffix });
            logger.info(`    Level ${level.id} suffix: ${level.suffix ? `"${level.suffix}"` : 'null'} -> "${newSuffix}"`);
          }

          stats.songsRenamed++;
        } else {
          // Same song (shouldn't happen, but handle it)
          logger.info(`  Skipped: Base name matches current song`);
          stats.skippedSongs++;
          continue;
        }

        stats.processedSongs++;

      } catch (error: any) {
        stats.errorSongs++;
        const errorMsg = error.message || String(error);
        stats.errors.push({ songId: song.id, error: errorMsg });
        logger.error(`Error processing Song ${song.id}:`, errorMsg);
        // Continue with next song instead of throwing
      }
    }

    // Batch operations
    if (!dryRun) {
      // Batch rename songs
      if (songsToRename.length > 0) {
        for (const { song, newName } of songsToRename) {
          await Song.update(
            { name: newName },
            { where: { id: song.id }, transaction }
          );
        }
        logger.info(`  Batch renamed ${songsToRename.length} songs`);
      }

      // Batch merge songs
      if (songsToMerge.length > 0) {
        for (const { sourceSong, targetSong } of songsToMerge) {
          try {
            await songService.mergeSongs(sourceSong.id, targetSong.id);
            logger.info(`  Merged song ${sourceSong.id} into ${targetSong.id}`);
          } catch (error: any) {
            logger.error(`  Failed to merge song ${sourceSong.id} into ${targetSong.id}:`, error);
            // Continue with next merge
          }
        }
        logger.info(`  Batch merged ${songsToMerge.length} songs`);
      }

      // Batch update level suffixes
      // First, update levels for renamed songs (songId stays the same)
      for (const [songId, levelUpdates] of levelsToUpdateBySong.entries()) {
        // Group by suffix for efficient updates
        const updatesBySuffix = new Map<string, number[]>();
        levelUpdates.forEach(({ levelId, suffix }) => {
          if (!updatesBySuffix.has(suffix)) {
            updatesBySuffix.set(suffix, []);
          }
          updatesBySuffix.get(suffix)!.push(levelId);
        });

        // Execute batch updates
        for (const [suffix, levelIds] of updatesBySuffix.entries()) {
          await Level.update(
            { suffix },
            {
              where: { id: { [Op.in]: levelIds } },
              transaction
            }
          );
        }
        stats.levelsUpdated += levelUpdates.length;
      }

      // Then, update levels for merged songs (levels now point to target song)
      for (const [targetSongId, levelUpdates] of levelsToUpdateByTarget.entries()) {
        // Group by suffix for efficient updates
        const updatesBySuffix = new Map<string, number[]>();
        levelUpdates.forEach(({ levelId, suffix }) => {
          if (!updatesBySuffix.has(suffix)) {
            updatesBySuffix.set(suffix, []);
          }
          updatesBySuffix.get(suffix)!.push(levelId);
        });

        // Execute batch updates
        for (const [suffix, levelIds] of updatesBySuffix.entries()) {
          await Level.update(
            { suffix },
            {
              where: { id: { [Op.in]: levelIds } },
              transaction
            }
          );
        }
        stats.levelsUpdated += levelUpdates.length;
      }

      const totalLevelsUpdated = Array.from(levelsToUpdateBySong.values()).reduce((sum, arr) => sum + arr.length, 0) +
                                 Array.from(levelsToUpdateByTarget.values()).reduce((sum, arr) => sum + arr.length, 0);
      if (totalLevelsUpdated > 0) {
        logger.info(`  Batch updated ${totalLevelsUpdated} levels`);
      }
    } else {
      const totalLevelsToUpdate = Array.from(levelsToUpdateBySong.values()).reduce((sum, arr) => sum + arr.length, 0) +
                                   Array.from(levelsToUpdateByTarget.values()).reduce((sum, arr) => sum + arr.length, 0);
      logger.info(`  [DRY RUN] Would rename ${songsToRename.length} songs, merge ${songsToMerge.length} songs, update ${totalLevelsToUpdate} levels`);
    }

  } catch (error: any) {
    logger.error('Error in batch migration:', error);
    throw error;
  }
}

/**
 * Migrate all songs for a specific suffix
 */
async function migrateSuffix(
  suffix: string,
  dryRun = false,
  limit?: number,
  offset?: number
): Promise<void> {
  const stats: MigrationStats = {
    totalSongs: 0,
    processedSongs: 0,
    skippedSongs: 0,
    errorSongs: 0,
    songsRenamed: 0,
    songsMerged: 0,
    levelsUpdated: 0,
    errors: []
  };

  try {
    const isBatchMode = limit !== undefined;
    const startOffset = offset ?? 0;
    const maxSongs = limit ?? Infinity;

    logger.info(`\n=== ${isBatchMode ? 'Batch' : 'Full'} Migration for suffix "${suffix}" ${dryRun ? '(DRY RUN)' : ''} ===`);
    if (dryRun) {
      logger.info('DRY RUN MODE - No changes will be saved');
    }
    if (isBatchMode && limit !== undefined) {
      logger.info(`Batch mode: Processing ${limit} songs starting from offset ${startOffset}`);
    }

    // Build query to find songs containing the suffix (case-insensitive)
    // For SQL LIKE, we use the suffix directly (parentheses are not special characters)
    // MySQL LIKE is case-insensitive by default for most collations
    const suffixPattern = `%${suffix}%`;

    // Get total count
    const totalCount = await Song.count({
      where: {
        name: {
          [Op.like]: suffixPattern
        }
      }
    });

    stats.totalSongs = isBatchMode && limit !== undefined ? Math.min(limit, totalCount - startOffset) : totalCount;

    logger.info(`Found ${totalCount} total songs with suffix "${suffix}"`);
    if (isBatchMode && limit !== undefined) {
      logger.info(`Processing ${stats.totalSongs} songs (offset: ${startOffset}, limit: ${limit})`);
    } else {
      logger.info(`Processing all ${stats.totalSongs} songs`);
    }

    if (CONFIRMATION_REQUIRED && !dryRun && !isBatchMode) {
      logger.info(`\nWARNING: This operation will migrate songs with suffix "${suffix}".`);
      logger.info('Make sure you have backed up your database before proceeding.');
      logger.info('Press Ctrl+C to cancel or wait 10 seconds to continue...');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }

    // Process in batches
    let batchNumber = 0;
    let processedInBatch = 0;

    while (processedInBatch < maxSongs) {
      const batchTransaction = await sequelize.transaction();

      try {
        // Calculate how many songs to fetch in this batch
        const remainingToProcess = maxSongs - processedInBatch;
        const batchLimit = Math.min(BATCH_SIZE, remainingToProcess);

        // Fetch songs with the suffix
        const songs = await Song.findAll({
          where: {
            name: {
              [Op.like]: suffixPattern
            }
          },
          limit: batchLimit,
          offset: isBatchMode ? (startOffset + processedInBatch) : processedInBatch,
          order: [['id', 'ASC']],
          transaction: batchTransaction
        });

        // If no songs found, we're done
        if (songs.length === 0) {
          logger.info('No more songs to migrate');
          break;
        }

        batchNumber++;
        const totalBatches = isBatchMode
          ? Math.ceil(stats.totalSongs / BATCH_SIZE)
          : Math.ceil(totalCount / BATCH_SIZE);

        logger.info(`\nProcessing batch ${batchNumber}${isBatchMode ? ` (${batchNumber}/${totalBatches} in this batch)` : `/${totalBatches}`} (${songs.length} songs)`);

        // Process all songs in this batch together
        await migrateSuffixBatch(songs, suffix, stats, dryRun, batchTransaction);

        if (!dryRun) {
          await batchTransaction.commit();
          logger.info(`Batch ${batchNumber} committed successfully`);
        } else {
          await safeTransactionRollback(batchTransaction);
        }

        processedInBatch += songs.length;

        // Progress update
        const processed = stats.processedSongs + stats.skippedSongs + stats.errorSongs;
        if (isBatchMode) {
          logger.info(`Progress: ${processed}/${stats.totalSongs} songs processed in this batch (${((processed / stats.totalSongs) * 100).toFixed(1)}%)`);
        } else {
          logger.info(`Progress: ${processed}/${stats.totalSongs} songs processed (${((processed / stats.totalSongs) * 100).toFixed(1)}%)`);
        }

        // If we got fewer songs than requested, we've processed all remaining songs
        if (songs.length < batchLimit) {
          logger.info('All remaining songs have been processed');
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

    logger.info(`\n=== Migration for suffix "${suffix}" completed ===`);
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
  logger.info(`Total songs: ${stats.totalSongs}`);
  logger.info(`Processed: ${stats.processedSongs}`);
  logger.info(`Skipped: ${stats.skippedSongs}`);
  logger.info(`Errors: ${stats.errorSongs}`);
  logger.info(`Songs renamed: ${stats.songsRenamed}`);
  logger.info(`Songs merged: ${stats.songsMerged}`);
  logger.info(`Levels updated: ${stats.levelsUpdated}`);

  if (stats.errors.length > 0) {
    logger.info(`\nErrors encountered (${stats.errors.length}):`);
    stats.errors.slice(0, 20).forEach(({ songId, error }) => {
      logger.error(`  Song ${songId}: ${error}`);
    });
    if (stats.errors.length > 20) {
      logger.info(`  ... and ${stats.errors.length - 20} more errors`);
    }
  }
}

/**
 * Show preview of what would be migrated for a specific suffix
 */
async function previewSuffix(suffix: string, limit = 10): Promise<void> {
  logger.info(`\n=== Migration Preview for suffix "${suffix}" (showing first ${limit} songs) ===`);

  const suffixPattern = `%${suffix}%`;

  const songs = await Song.findAll({
    where: {
      name: {
        [Op.like]: suffixPattern
      }
    },
    limit,
    order: [['id', 'ASC']]
  });

  logger.info(`Found ${songs.length} songs to preview:\n`);

  for (const song of songs) {
    const parsed = extractSuffix(song.name, suffix);
    if (parsed) {
      const targetSong = await findSongByName(parsed.baseName);
      logger.info(`Song ${song.id}:`);
      logger.info(`  Original: "${song.name}"`);
      logger.info(`  Suffix: "${parsed.suffix}"`);
      logger.info(`  Base name: "${parsed.baseName}"`);
      if (targetSong && targetSong.id !== song.id) {
        logger.info(`  Action: MERGE into song ${targetSong.id} ("${targetSong.name}")`);
      } else if (!targetSong) {
        logger.info(`  Action: RENAME to "${parsed.baseName}"`);
      } else {
        logger.info(`  Action: SKIP (base name matches current song)`);
      }
      logger.info('');
    }
  }

  const totalCount = await Song.count({
    where: {
      name: {
        [Op.like]: suffixPattern
      }
    }
  });

  logger.info(`\n=== Preview Summary ===`);
  logger.info(`Total songs that would be migrated: ${totalCount}`);
}

/**
 * Main function
 */
async function main() {
  const command = process.argv[2];
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];
  const arg3 = process.argv[5];
  const arg4 = process.argv[6];

  try {
    await sequelize.authenticate();
    initializeAssociations();
    logger.info('Database connection established successfully.');

    switch (command) {
      case 'preview':
        // Preview what would be migrated for a specific suffix
        if (!arg1) {
          logger.error('Usage: preview <suffix> [limit]');
          process.exit(1);
        }
        const previewLimit = arg2 ? parseInt(arg2) : 10;
        await previewSuffix(arg1, previewLimit);
        break;

      case 'migrate':
        // Migrate a specific suffix
        if (!arg1) {
          logger.error('Usage: migrate <suffix> [dry-run] [limit] [offset]');
          process.exit(1);
        }
        const isDryRun = arg2 === 'dry-run';
        const migrateLimit = isDryRun ? (arg3 ? parseInt(arg3) : undefined) : (arg2 ? parseInt(arg2) : undefined);
        const migrateOffset = isDryRun ? (arg4 ? parseInt(arg4) : undefined) : (arg3 ? parseInt(arg3) : undefined);
        await migrateSuffix(arg1, isDryRun, migrateLimit, migrateOffset);
        break;

      case 'dry-run':
        // Dry run (alias for migrate dry-run)
        if (!arg1) {
          logger.error('Usage: dry-run <suffix> [limit] [offset]');
          process.exit(1);
        }
        const dryRunLimit = arg2 ? parseInt(arg2) : undefined;
        const dryRunOffset = arg3 ? parseInt(arg3) : undefined;
        await migrateSuffix(arg1, true, dryRunLimit, dryRunOffset);
        break;

      default:
        logger.info(`
Suffix Migration Script

Usage: node migrateSuffixes.ts [command] [arguments]

Commands:
  preview <suffix> [limit]              - Preview what would be migrated for a suffix (default: 10 songs)
  migrate <suffix> [dry-run] [limit] [offset] - Migrate a specific suffix
  dry-run <suffix> [limit] [offset]    - Dry run for a specific suffix

Examples:
  node migrateSuffixes.ts preview "(nerfed)" 20
  node migrateSuffixes.ts migrate "(nerfed)" dry-run
  node migrateSuffixes.ts migrate "(nerfed)"
  node migrateSuffixes.ts migrate "(nerfed)" 50 0
  node migrateSuffixes.ts dry-run "(nerfed)" 100

Migration Process:
  1. Finds all songs containing the specified suffix (case-insensitive)
  2. Extracts the suffix from the song name
  3. Looks up if a song with the base name exists
  4. If exists: merges source song into target song using SongService.mergeSongs()
  5. If doesn't exist: renames the song to the base name
  6. Updates level suffix field by prepending the extracted suffix at position 0
  7. Handles duplicate suffixes like "Song (nerfed) (nerfed)" by extracting only one
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
await main();
