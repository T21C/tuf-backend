#!/usr/bin/env node

import axios from 'axios';
import sequelize from '../../config/db.js';
import { initializeAssociations } from '../../models/associations.js';
import { logger } from '../../server/services/LoggerService.js';
import { safeTransactionRollback } from '../utils/Utility.js';
import ArtistService from '../../server/services/ArtistService.js';
import EvidenceService from '../../server/services/EvidenceService.js';
import Artist from '../../models/artists/Artist.js';
import ArtistAlias from '../../models/artists/ArtistAlias.js';
import ArtistLink from '../../models/artists/ArtistLink.js';
import ArtistEvidence from '../../models/artists/ArtistEvidence.js';
import cdnServiceInstance from '../../server/services/CdnService.js';
import { Op } from 'sequelize';
import { isCdnUrl, getFileIdFromCdnUrl } from '../utils/Utility.js';

// Configuration
const API_URL = 'https://7thbe.at/wapi/getArtists';
const CONFIRMATION_REQUIRED = false;
const DRY_RUN = process.argv.includes('--dry-run');

// Parse search argument: --search "artist name"
function getSearchName(): string | null {
  const searchIndex = process.argv.indexOf('--search');
  if (searchIndex !== -1 && process.argv[searchIndex + 1]) {
    return process.argv[searchIndex + 1];
  }
  return null;
}

const SEARCH_NAME = getSearchName();

interface SevenBGArtist {
  id: number;
  name: string;
  aliases: string[];
  status: number;
  status_new: number;
  evidence_url: string;
  evidenceArray: string[];
  link_1: string | null;
  link_2: string | null;
  adofai_artist_disclaimers: Array<{
    id: number;
    text: string;
    lang: string;
  }>;
}

interface MigrationStats {
  totalArtists: number;
  processedArtists: number;
  skippedArtists: number;
  errorArtists: number;
  artistsCreated: number;
  artistsUpdated: number;
  aliasesAdded: number;
  linksAdded: number;
  evidencesAdded: number;
  errors: Array<{ artistName: string; error: string }>;
}

/**
 * Map 7BG status to verification state
 * Status 1 = pending/unverified
 * Status 2 = allowed
 */
function mapStatusToVerificationState(status: number): 'unverified' | 'pending' | 'declined' | 'mostly declined' | 'mostly allowed' | 'allowed' {
  switch (status) {
    case 0:
      return 'pending';
    case 1:
      return 'allowed';
    case 2:
      return 'mostly declined';
    case 3:
      return 'declined';
    case 4:
      return 'mostly allowed';
    default:
      return 'unverified';
  }
}

/**
 * Check if URL is an image based on extension or content-type
 */
function isImageUrl(url: string): boolean {
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
  const lowerUrl = url.toLowerCase();
  
  // Check extension
  if (imageExtensions.some(ext => lowerUrl.includes(ext))) {
    return true;
  }
  
  // Check for common image CDN patterns
  if (lowerUrl.includes('/images/') || lowerUrl.includes('/image/') || lowerUrl.includes('evidence')) {
    return true;
  }
  
  return false;
}

/**
 * Download image from URL and return buffer with timeout protection
 */
async function downloadImage(url: string): Promise<Buffer | null> {
  const timeoutMs = 45000; // 45 second timeout
  
  const downloadPromise = (async () => {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 400,
        // Add headers that might help with S3 presigned URLs
        headers: {
          'Accept': 'image/*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      // Check content-type
      const contentType = response.headers['content-type'] || '';
      if (!contentType.startsWith('image/')) {
        logger.warn(`URL ${url} does not have image content-type: ${contentType}`);
        return null;
      }
      
      return Buffer.from(response.data);
    } catch (error: any) {
      if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
        logger.warn(`Download timeout for ${url} after ${timeoutMs}ms`);
      } else {
        logger.error(`Failed to download image from ${url}:`, error.message);
      }
      return null;
    }
  })();

  // Race against timeout wrapper as backup (in case axios timeout doesn't work)
  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => {
      logger.warn(`Download timeout wrapper triggered for ${url} (axios timeout may have failed)`);
      resolve(null);
    }, timeoutMs + 2000); // Slightly longer than axios timeout
  });

  return Promise.race([downloadPromise, timeoutPromise]);
}

/**
 * Upload image to CDN and return CDN URL
 */
async function uploadImageToCdn(imageBuffer: Buffer, filename: string): Promise<string | null> {
  try {
    const uploadResult = await cdnServiceInstance.uploadImage(
      imageBuffer,
      filename,
      'EVIDENCE' // Evidence images use EVIDENCE type
    );
    
    return uploadResult.urls.original;
  } catch (error: any) {
    logger.error(`Failed to upload image to CDN:`, error.message);
    return null;
  }
}

/**
 * Process a single artist from 7BG API
 */
async function processArtist(
  sevenBGArtist: SevenBGArtist,
  stats: MigrationStats,
  transaction?: any
): Promise<void> {
  try {
    logger.info(`\nProcessing artist: ${sevenBGArtist.name} (7BG ID: ${sevenBGArtist.id})`);

    // Map verification state
    const verificationState = mapStatusToVerificationState(sevenBGArtist.status_new || sevenBGArtist.status);
    logger.info(`  Verification state: ${verificationState}`);

    // Prepare extraInfo from disclaimers
    const extraInfo = sevenBGArtist.adofai_artist_disclaimers
      .map(d => `[${d.lang.toUpperCase()}] ${d.text}`)
      .join('\n\n') || null;

    // Check if artist exists before creating
    const artistService = ArtistService.getInstance();
    const normalizedName = artistService.normalizeArtistName(sevenBGArtist.name);
    const existingArtist = await Artist.findOne({
      where: {
        name: {
          [Op.like]: normalizedName
        }
      }
    });

    const artistExistedBefore = !!existingArtist;

    // Find or create artist
    const artist = await ArtistService.getInstance().findOrCreateArtist(
      sevenBGArtist.name,
      sevenBGArtist.aliases.length > 0 ? sevenBGArtist.aliases : undefined,
      verificationState
    );

    if (!artist) {
      throw new Error('Failed to find or create artist');
    }

    if (!artistExistedBefore) {
      stats.artistsCreated++;
      logger.info(`  Artist CREATED: ${artist.name} (ID: ${artist.id})`);
    } else {
      stats.artistsUpdated++;
      logger.info(`  Artist MATCHED/UPDATED: ${artist.name} (ID: ${artist.id})`);
    }

    // Update verification state and extraInfo if needed
    if (!DRY_RUN) {
      const updates: any = {};
      if (artist.verificationState !== verificationState) {
        updates.verificationState = verificationState;
      }
      if (artist.extraInfo !== extraInfo) {
        updates.extraInfo = extraInfo;
      }
      if (Object.keys(updates).length > 0) {
        await artist.update(updates, { transaction });
        logger.info(`  Updated artist: ${Object.keys(updates).join(', ')}`);
      }
    }

    // Add aliases
    if (sevenBGArtist.aliases && sevenBGArtist.aliases.length > 0) {
      for (const alias of sevenBGArtist.aliases) {
        if (!DRY_RUN) {
          const existingAlias = await ArtistAlias.findOne({
            where: {
              artistId: artist.id,
              alias: alias.trim()
            },
            transaction
          });

          if (!existingAlias) {
            await ArtistAlias.create({
              artistId: artist.id,
              alias: alias.trim()
            }, { transaction });
            stats.aliasesAdded++;
            logger.info(`  Added alias: ${alias}`);
          }
        } else {
          stats.aliasesAdded++;
          logger.info(`  [DRY RUN] Would add alias: ${alias}`);
        }
      }
    }

    // Add links (link_1, link_2)
    const links = [sevenBGArtist.link_1, sevenBGArtist.link_2].filter(Boolean) as string[];
    for (const link of links) {
      if (!DRY_RUN) {
        const existingLink = await ArtistLink.findOne({
          where: {
            artistId: artist.id,
            link: link.trim()
          },
          transaction
        });

        if (!existingLink) {
          await ArtistLink.create({
            artistId: artist.id,
            link: link.trim()
          }, { transaction });
          stats.linksAdded++;
          logger.info(`  Added link: ${link}`);
        }
      } else {
        stats.linksAdded++;
        logger.info(`  [DRY RUN] Would add link: ${link}`);
      }
    }

    // Process evidences
    if (sevenBGArtist.evidenceArray && sevenBGArtist.evidenceArray.length > 0) {
      // Delete all existing evidence for this artist before creating new ones
      if (!DRY_RUN) {
        const existingEvidences = await ArtistEvidence.findAll({
          where: {
            artistId: artist.id
          },
          transaction
        });

        if (existingEvidences.length > 0) {
          logger.info(`  Deleting ${existingEvidences.length} existing evidence entries...`);
          
          // Delete CDN files for evidence that are stored on CDN
          for (const evidence of existingEvidences) {
            const fileId = getFileIdFromCdnUrl(evidence.link);
            if (fileId && isCdnUrl(evidence.link)) {
              try {
                await cdnServiceInstance.deleteFile(fileId);
                logger.info(`  Deleted CDN file: ${evidence.link}`);
              } catch (error: any) {
                logger.warn(`  Failed to delete CDN file ${evidence.link}: ${error.message}`);
              }
            }
          }

          // Delete all evidence records from database
          await ArtistEvidence.destroy({
            where: {
              artistId: artist.id
            },
            transaction
          });
          logger.info(`  Deleted all existing evidence entries`);
        }
      } else {
        logger.info(`  [DRY RUN] Would delete existing evidence entries`);
      }

      // Separate image URLs from non-image URLs
      const imageUrls: string[] = [];
      const nonImageUrls: string[] = [];

      for (const evidenceUrl of sevenBGArtist.evidenceArray) {
        if (!evidenceUrl || !evidenceUrl.trim()) continue;
        const trimmedUrl = evidenceUrl.trim();
        if (isImageUrl(trimmedUrl)) {
          imageUrls.push(trimmedUrl);
        } else {
          nonImageUrls.push(trimmedUrl);
        }
      }

      // Download all images in parallel (unawaited async tasks)
      if (imageUrls.length > 0) {
        logger.info(`  Downloading ${imageUrls.length} evidence images in parallel...`);
        
        if (!DRY_RUN) {
          // Start all downloads in parallel
          const downloadPromises = imageUrls.map(async (url) => {
            logger.info(`  Downloading evidence image: ${url}`);
            const imageBuffer = await downloadImage(url);
            return { url, imageBuffer };
          });

          // Wait for all downloads to complete (or timeout)
          const downloadResults = await Promise.allSettled(downloadPromises);
          
          // Process download results sequentially for uploading and database operations
          for (let i = 0; i < downloadResults.length; i++) {
            const result = downloadResults[i];
            const url = imageUrls[i];

            if (result.status === 'fulfilled') {
              const { imageBuffer } = result.value;
              
              if (imageBuffer) {
                // Upload to CDN
                const filename = url.split('/').pop()?.split('?')[0] || `evidence_${Date.now()}.png`;
                const cdnUrl = await uploadImageToCdn(imageBuffer, filename);
                
                if (cdnUrl) {
                  await ArtistEvidence.create({
                    artistId: artist.id,
                    link: cdnUrl
                  }, { transaction });
                  stats.evidencesAdded++;
                  logger.info(`  Added evidence (CDN): ${cdnUrl}`);
                } else {
                  // If CDN upload failed, save as external evidence link
                  logger.warn(`  CDN upload failed for ${url}, saving as external evidence link`);
                  await ArtistEvidence.create({
                    artistId: artist.id,
                    link: url
                  }, { transaction });
                  stats.evidencesAdded++;
                  logger.info(`  Added evidence (external link): ${url}`);
                }
              } else {
                // Download failed, save as external evidence link
                logger.warn(`  Image download failed for ${url}, saving as external evidence link`);
                await ArtistEvidence.create({
                  artistId: artist.id,
                  link: url
                }, { transaction });
                stats.evidencesAdded++;
                logger.info(`  Added evidence (external link): ${url}`);
              }
            } else {
              // Promise rejected, save as external evidence link
              logger.warn(`  Image download error for ${url}: ${result.reason}, saving as external evidence link`);
              await ArtistEvidence.create({
                artistId: artist.id,
                link: url
              }, { transaction });
              stats.evidencesAdded++;
              logger.info(`  Added evidence (external link): ${url}`);
            }
          }
        } else {
          // Dry run mode
          for (const url of imageUrls) {
            stats.evidencesAdded++;
            logger.info(`  [DRY RUN] Would process evidence image: ${url}`);
          }
        }
      }

      // Process non-image URLs (external links)
      for (const trimmedUrl of nonImageUrls) {
        logger.info(`  Processing evidence link: ${trimmedUrl}`);
        
        if (!DRY_RUN) {
          await ArtistEvidence.create({
            artistId: artist.id,
            link: trimmedUrl
          }, { transaction });
          stats.evidencesAdded++;
          logger.info(`  Added evidence (external link): ${trimmedUrl}`);
        } else {
          stats.evidencesAdded++;
          logger.info(`  [DRY RUN] Would add evidence (external link): ${trimmedUrl}`);
        }
      }
    }

    stats.processedArtists++;

  } catch (error: any) {
    stats.errorArtists++;
    const errorMsg = error.message || String(error);
    stats.errors.push({ artistName: sevenBGArtist.name, error: errorMsg });
    logger.error(`Error processing artist ${sevenBGArtist.name}:`, errorMsg);
    // Don't throw - continue with next artist
  }
}

/**
 * Fetch artists from 7BG API
 */
async function fetchArtists(searchName?: string | null): Promise<SevenBGArtist[]> {
  try {
    if (searchName) {
      logger.info(`Fetching artists from ${API_URL} with search: "${searchName}"...`);
      const response = await axios.post(API_URL, {
        search: searchName
      }, {
        timeout: 60000,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      if (response.data.result !== 1 || !response.data.artists) {
        throw new Error('Invalid API response format');
      }

      logger.info(`Fetched ${response.data.artists.length} artists from API (search: "${searchName}")`);
      return response.data.artists;
    } else {
      logger.info(`Fetching all artists from ${API_URL}...`);
      const response = await axios.get(API_URL, {
        timeout: 60000,
        headers: {
          'Accept': 'application/json'
        }
      });

      if (response.data.result !== 1 || !response.data.artists) {
        throw new Error('Invalid API response format');
      }

      logger.info(`Fetched ${response.data.artists.length} artists from API`);
      return response.data.artists;
    }
  } catch (error: any) {
    logger.error('Failed to fetch artists from API:', error.message);
    throw error;
  }
}

/**
 * Main migration function
 */
async function migrateArtists(): Promise<void> {
  const transaction = await sequelize.transaction();
  const stats: MigrationStats = {
    totalArtists: 0,
    processedArtists: 0,
    skippedArtists: 0,
    errorArtists: 0,
    artistsCreated: 0,
    artistsUpdated: 0,
    aliasesAdded: 0,
    linksAdded: 0,
    evidencesAdded: 0,
    errors: []
  };

  try {
    logger.info(`\n=== 7BG Artist Verification List Migration ${DRY_RUN ? '(DRY RUN)' : ''} ===`);
    if (DRY_RUN) {
      logger.info('DRY RUN MODE - No changes will be saved');
    }

    if (CONFIRMATION_REQUIRED && !DRY_RUN) {
      logger.info('\nWARNING: This operation will create/update artists and their data.');
      logger.info('Make sure you have backed up your database before proceeding.');
      logger.info('Press Ctrl+C to cancel or wait 10 seconds to continue...');
      await new Promise(resolve => setTimeout(resolve, 10000));
    }

    // Fetch artists from API
    const artists = await fetchArtists(SEARCH_NAME);
    stats.totalArtists = artists.length;
    
    if (SEARCH_NAME) {
      logger.info(`Filtered to ${artists.length} artists matching search: "${SEARCH_NAME}"`);
    }

    logger.info(`\nProcessing ${artists.length} artists...`);

    // Process each artist
    for (const artist of artists) {
      await processArtist(artist, stats, transaction);
    }

    if (!DRY_RUN) {
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
    printStats(stats);
    throw error;
  }
}

/**
 * Print migration statistics
 */
function printStats(stats: MigrationStats): void {
  logger.info('\n=== Migration Statistics ===');
  logger.info(`Total artists: ${stats.totalArtists}`);
  logger.info(`Processed: ${stats.processedArtists}`);
  logger.info(`Skipped: ${stats.skippedArtists}`);
  logger.info(`Errors: ${stats.errorArtists}`);
  logger.info(`\nArtists:`);
  logger.info(`  Created: ${stats.artistsCreated}`);
  logger.info(`  Updated: ${stats.artistsUpdated}`);
  logger.info(`\nData:`);
  logger.info(`  Aliases added: ${stats.aliasesAdded}`);
  logger.info(`  Links added: ${stats.linksAdded}`);
  logger.info(`  Evidences added: ${stats.evidencesAdded}`);

  if (stats.errors.length > 0) {
    logger.info(`\nErrors encountered (${stats.errors.length}):`);
    stats.errors.slice(0, 20).forEach(({ artistName, error }) => {
      logger.error(`  ${artistName}: ${error}`);
    });
    if (stats.errors.length > 20) {
      logger.info(`  ... and ${stats.errors.length - 20} more errors`);
    }
  }
}

/**
 * Main function
 */
async function main() {
  try {
    await sequelize.authenticate();
    initializeAssociations();
    logger.info('Database connection established successfully.');

    await migrateArtists();

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
