import { Op } from 'sequelize';
import Artist from '../../models/artists/Artist.js';
import ArtistAlias from '../../models/artists/ArtistAlias.js';
import ArtistLink from '../../models/artists/ArtistLink.js';
import ArtistEvidence from '../../models/artists/ArtistEvidence.js';
import ArtistRelation from '../../models/artists/ArtistRelation.js';
import SongCredit from '../../models/songs/SongCredit.js';
import LevelSubmissionArtistRequest from '../../models/submissions/LevelSubmissionArtistRequest.js';
import { logger } from './LoggerService.js';
import { getFileIdFromCdnUrl, isCdnUrl } from '../../misc/utils/Utility.js';
import cdnServiceInstance from './CdnService.js';
import sequelize from '../../config/db.js';

class ArtistService {
  private static instance: ArtistService;

  private constructor() {}

  public static getInstance(): ArtistService {
    if (!ArtistService.instance) {
      ArtistService.instance = new ArtistService();
    }
    return ArtistService.instance;
  }

  /**
   * Normalize artist name for comparison
   */
  public normalizeArtistName(name: string): string {
    if (!name) return '';
    return name.trim().toLowerCase();
  }

  /**
   * Find or create artist with smart duplicate detection
   */
  public async findOrCreateArtist(
    name: string,
    aliases?: string[],
    verificationState?: Artist['verificationState']
  ): Promise<Artist> {
    const normalizedName = this.normalizeArtistName(name);
    let artist: Artist | null = null;
    // First, try to find by exact name match (case-insensitive)
    artist = await Artist.findOne({
      where: {
        name: {
          [Op.like]: normalizedName
        }
      },
      include: [
        {
          model: ArtistAlias,
          as: 'aliases'
        }
      ]
    });

    // If not found, check aliases
    if (!artist && aliases && aliases.length > 0) {
      const normalizedAliases = aliases.map(a => this.normalizeArtistName(a));
      const aliasMatch = await ArtistAlias.findOne({
        where: {
          alias: {
            [Op.in]: normalizedAliases
          }
        },
        include: [
          {
            model: Artist,
            as: 'artist',
            include: [
              {
                model: ArtistAlias,
                as: 'aliases'
              }
            ]
          }
        ]
      });

      if (aliasMatch?.artist) {
        artist = aliasMatch.artist;
      }
    }

    // If still not found, create new artist
    if (!artist) {
      artist = await Artist.create({
        name: name.trim(),
        verificationState: verificationState || 'unverified'
      });
      if (!artist) {
        throw new Error('Failed to create artist');
      }

      // Add aliases if provided
      if (aliases && aliases.length > 0) {
        const uniqueAliases = [...new Set(aliases.map(a => a.trim()).filter(a => a && a.toLowerCase() !== normalizedName))];
        if (uniqueAliases.length > 0) {
          await ArtistAlias.bulkCreate(
            uniqueAliases.map(alias => ({
              artistId: artist!.id,
              alias: alias.trim()
            })),
            { ignoreDuplicates: true } // Prevent duplicate artistId+alias combinations
          );
        }
      }
    } else {
      // Artist exists, add any new aliases
      if (aliases && aliases.length > 0) {
        const existingAliases = new Set(
          (artist.aliases || []).map(a => this.normalizeArtistName(a.alias))
        );
        existingAliases.add(this.normalizeArtistName(artist.name));

        const newAliases = aliases
          .map(a => a.trim())
          .filter(a => {
            const normalized = this.normalizeArtistName(a);
            return a && !existingAliases.has(normalized);
          });

        if (newAliases.length > 0) {
          await ArtistAlias.bulkCreate(
            newAliases.map(alias => ({
              artistId: artist!.id,
              alias: alias.trim()
            })),
            { ignoreDuplicates: true } // Prevent duplicate artistId+alias combinations
          );
        }
      }
    }

    return artist;
  }

  /**
   * Merge source artist into target artist
   */
  public async mergeArtists(sourceId: number, targetId: number): Promise<void> {
    const source = await Artist.findByPk(sourceId, {
      include: [
        { model: ArtistAlias, as: 'aliases' },
        { model: ArtistLink, as: 'links' },
        { model: ArtistEvidence, as: 'evidences' }
      ]
    });
    const target = await Artist.findByPk(targetId, {
      include: [
        { model: ArtistAlias, as: 'aliases' },
        { model: ArtistLink, as: 'links' },
        { model: ArtistEvidence, as: 'evidences' }
      ]
    });

    if (!source || !target) {
      throw new Error('Source or target artist not found');
    }

    if (source.id === target.id) {
      throw new Error('Cannot merge artist into itself');
    }

    // Move aliases from source to target by updating artistId
    const targetAliases = new Set(
      (target.aliases || []).map(a => this.normalizeArtistName(a.alias))
    );
    targetAliases.add(this.normalizeArtistName(target.name));

    const sourceAliases = source.aliases || [];
    const sourceAliasesToMove = sourceAliases.filter(a => {
      const normalized = this.normalizeArtistName(a.alias);
      return !targetAliases.has(normalized);
    });

    // Update artistId for non-duplicate aliases (duplicates will be deleted when source is destroyed)
    if (sourceAliasesToMove.length > 0) {
      const aliasIds = sourceAliasesToMove.map(a => a.id);
      await ArtistAlias.update(
        { artistId: target.id },
        { where: { id: { [Op.in]: aliasIds } } }
      );
    }

    // Add source name as alias if not already present
    const sourceNameNormalized = this.normalizeArtistName(source.name);
    if (!targetAliases.has(sourceNameNormalized)) {
      // Check if alias already exists (case-insensitive)
      const existingAlias = await ArtistAlias.findOne({
        where: {
          artistId: target.id,
          alias: source.name
        }
      });
      if (!existingAlias) {
        await ArtistAlias.create({
          artistId: target.id,
          alias: source.name
        });
      }
    }

    // Merge links from source to target (avoid duplicates)
    // Since uniqueness is on artistId+link, check if target already has links for each artist
    const sourceLinks = source.links || [];
    if (sourceLinks.length > 0) {
      // Get all links that target already has
      const targetLinks = await ArtistLink.findAll({
        where: { artistId: target.id },
        attributes: ['link']
      });
      const targetLinksSet = new Set(
        targetLinks.map(l => l.link.toLowerCase().trim())
      );

      // Separate links into those that can be updated vs those that would create duplicates
      const linksToUpdate: ArtistLink[] = [];
      const linksToDelete: ArtistLink[] = [];

      for (const link of sourceLinks) {
        const normalizedLink = link.link.toLowerCase().trim();
        if (targetLinksSet.has(normalizedLink)) {
          // Target already has this link - delete source link to avoid duplicate
          linksToDelete.push(link);
        } else {
          // Target doesn't have this link - update source link to point to target
          linksToUpdate.push(link);
        }
      }

      // Update links that won't create duplicates
      if (linksToUpdate.length > 0) {
        const linkIdsToUpdate = linksToUpdate.map(l => l.id);
        await ArtistLink.update(
          { artistId: target.id },
          { where: { id: { [Op.in]: linkIdsToUpdate } } }
        );
      }

      // Delete links that would create duplicates
      if (linksToDelete.length > 0) {
        const linkIdsToDelete = linksToDelete.map(l => l.id);
        await ArtistLink.destroy({
          where: { id: { [Op.in]: linkIdsToDelete } }
        });
      }
    }

    // Merge evidences from source to target by updating artistId
    const targetEvidences = new Set(
      (target.evidences || []).map(e => e.link.toLowerCase().trim())
    );
    const sourceEvidences = source.evidences || [];
    const sourceEvidencesToMove = sourceEvidences.filter(evidence => {
      const normalizedLink = evidence.link.toLowerCase().trim();
      return !targetEvidences.has(normalizedLink);
    });

    // Update artistId for non-duplicate evidences (duplicates will be deleted when source is destroyed)
    if (sourceEvidencesToMove.length > 0) {
      const evidenceIds = sourceEvidencesToMove.map(e => e.id);
      await ArtistEvidence.update(
        { artistId: target.id },
        { where: { id: { [Op.in]: evidenceIds } } }
      );
    }

    // Update all references to point to target
    // Note: Levels no longer have direct artist relationship
    // They access artists through songs->songCredits->artists

    // Merge song credits from source to target (avoid duplicates)
    // Since uniqueness is on songId+artistId, check if target already has credits for each song
    const sourceCredits = await SongCredit.findAll({
      where: { artistId: source.id },
      attributes: ['id', 'songId', 'artistId', 'role']
    });

    if (sourceCredits.length > 0) {
      // Get all songs that target already has credits for
      const targetCredits = await SongCredit.findAll({
        where: { artistId: target.id },
        attributes: ['songId']
      });
      const targetSongsSet = new Set(targetCredits.map(c => c.songId));

      // Separate credits into those that can be updated vs those that would create duplicates
      const creditsToUpdate: SongCredit[] = [];
      const creditsToDelete: SongCredit[] = [];

      for (const credit of sourceCredits) {
        if (targetSongsSet.has(credit.songId)) {
          // Target already has a credit for this song - delete source credit to avoid duplicate
          creditsToDelete.push(credit);
        } else {
          // Target doesn't have this song - update source credit to point to target
          creditsToUpdate.push(credit);
        }
      }

      // Update credits that won't create duplicates
      if (creditsToUpdate.length > 0) {
        const creditIdsToUpdate = creditsToUpdate.map(c => c.id);
        await SongCredit.update(
          { artistId: target.id },
          { where: { id: { [Op.in]: creditIdsToUpdate } } }
        );
      }

      // Delete credits that would create duplicates
      if (creditsToDelete.length > 0) {
        const creditIdsToDelete = creditsToDelete.map(c => c.id);
        await SongCredit.destroy({
          where: { id: { [Op.in]: creditIdsToDelete } }
        });
      }
    }

    // Update level submission artist requests
    await LevelSubmissionArtistRequest.update(
      { artistId: target.id },
      { where: { artistId: source.id } }
    );

    // Merge artist relations
    // Find all relations where source is involved (as artistId1 or artistId2)
    const sourceRelations = await ArtistRelation.findAll({
      where: {
        [Op.or]: [
          { artistId1: source.id },
          { artistId2: source.id }
        ]
      }
    });

    if (sourceRelations.length > 0) {
      for (const relation of sourceRelations) {
        // Determine the other artist in the relation
        const otherArtistId = relation.artistId1 === source.id
          ? relation.artistId2
          : relation.artistId1;

        // Skip if the other artist is the target (source and target are merging, no need for relation)
        if (otherArtistId === target.id) {
          await relation.destroy();
          continue;
        }

        // Check if target already has a relation with the other artist
        const [id1, id2] = target.id < otherArtistId
          ? [target.id, otherArtistId]
          : [otherArtistId, target.id];

        const existingRelation = await ArtistRelation.findOne({
          where: {
            artistId1: id1,
            artistId2: id2
          }
        });

        if (existingRelation) {
          // Target already has this relation, delete source relation
          await relation.destroy();
        } else {
          // Update relation to point to target instead of source
          await relation.update({
            artistId1: id1,
            artistId2: id2
          });
        }
      }
    }

    // Delete source artist (cascade will handle aliases/links/evidences)
    await source.destroy();
  }

  /**
   * Check if artists with given names already exist
   */
  public async checkExistingArtists(
    name1: string,
    name2: string,
    transaction?: any
  ): Promise<{existing1: Artist | null; existing2: Artist | null}> {
    const normalizedName1 = this.normalizeArtistName(name1.trim());
    const normalizedName2 = this.normalizeArtistName(name2.trim());

    const existing1 = await Artist.findOne({
      where: { name: { [Op.like]: normalizedName1 } },
      include: [
        { model: ArtistAlias, as: 'aliases' },
        { model: ArtistLink, as: 'links' },
        { model: ArtistEvidence, as: 'evidences' }
      ],
      transaction
    });
    const existing2 = await Artist.findOne({
      where: { name: { [Op.like]: normalizedName2 } },
      include: [
        { model: ArtistAlias, as: 'aliases' },
        { model: ArtistLink, as: 'links' },
        { model: ArtistEvidence, as: 'evidences' }
      ],
      transaction
    });

    return { existing1, existing2 };
  }

  /**
   * Split artist into two existing artists specified by IDs
   * Creates deep copies of all data (aliases, links, evidences, avatar) and duplicates song credits
   */
  public async splitArtist(
    sourceId: number,
    targetId1: number,
    targetId2: number,
    deleteOriginal = false,
    transaction?: any
  ): Promise<{artist1: Artist; artist2: Artist}> {
    const source = await Artist.findByPk(sourceId, {
      include: [
        { model: ArtistAlias, as: 'aliases' },
        { model: ArtistLink, as: 'links' },
        { model: ArtistEvidence, as: 'evidences' },
        { model: SongCredit, as: 'songCredits' }
      ],
      transaction
    });

    if (!source) {
      throw new Error('Source artist not found');
    }

    if (!targetId1 || !targetId2) {
      throw new Error('Both target IDs are required');
    }

    if (targetId1 === targetId2) {
      throw new Error('Target IDs must be different');
    }

    if (sourceId === targetId1 || sourceId === targetId2) {
      throw new Error('Source artist cannot be one of the target artists');
    }

    // Fetch target artists with their existing data
    const artist1 = await Artist.findByPk(targetId1, {
      include: [
        { model: ArtistAlias, as: 'aliases' },
        { model: ArtistLink, as: 'links' },
        { model: ArtistEvidence, as: 'evidences' }
      ],
      transaction
    });

    const artist2 = await Artist.findByPk(targetId2, {
      include: [
        { model: ArtistAlias, as: 'aliases' },
        { model: ArtistLink, as: 'links' },
        { model: ArtistEvidence, as: 'evidences' }
      ],
      transaction
    });

    if (!artist1) {
      throw new Error(`Target artist with ID ${targetId1} not found`);
    }

    if (!artist2) {
      throw new Error(`Target artist with ID ${targetId2} not found`);
    }

    // Copy aliases to both artists (only add new ones)
    const sourceAliases = source.aliases || [];
    if (sourceAliases.length > 0) {
      const aliasesForBoth = sourceAliases.map(alias => alias.alias);

      // For artist1: add aliases that don't already exist
      const existingAliases1 = new Set(
        (artist1.aliases || []).map(a => this.normalizeArtistName(a.alias))
      );
      existingAliases1.add(this.normalizeArtistName(artist1.name));

      const newAliases1 = aliasesForBoth.filter(alias => {
        const normalized = this.normalizeArtistName(alias);
        return !existingAliases1.has(normalized);
      });

      if (newAliases1.length > 0) {
        await ArtistAlias.bulkCreate(
          newAliases1.map(alias => ({
            artistId: artist1.id,
            alias: alias
          })),
          {
            transaction,
            ignoreDuplicates: true // Prevent duplicate artistId+alias combinations
          }
        );
      }

      // For artist2: add aliases that don't already exist
      const existingAliases2 = new Set(
        (artist2.aliases || []).map(a => this.normalizeArtistName(a.alias))
      );
      existingAliases2.add(this.normalizeArtistName(artist2.name));

      const newAliases2 = aliasesForBoth.filter(alias => {
        const normalized = this.normalizeArtistName(alias);
        return !existingAliases2.has(normalized);
      });

      if (newAliases2.length > 0) {
        await ArtistAlias.bulkCreate(
          newAliases2.map(alias => ({
            artistId: artist2.id,
            alias: alias
          })),
          {
            transaction,
            ignoreDuplicates: true // Prevent duplicate artistId+alias combinations
          }
        );
      }
    }

    // Copy links to both artists (only add new ones)
    const sourceLinks = source.links || [];
    if (sourceLinks.length > 0) {
      const linksForBoth = sourceLinks.map(link => link.link);

      // For artist1: add links that don't already exist
      const existingLinks1 = new Set((artist1.links || []).map(l => l.link));
      const newLinks1 = linksForBoth.filter(link => !existingLinks1.has(link));

      if (newLinks1.length > 0) {
        await ArtistLink.bulkCreate(
          newLinks1.map(link => ({
            artistId: artist1.id,
            link: link
          })),
          {
            transaction,
            ignoreDuplicates: true // Prevent duplicate artistId+link combinations
          }
        );
      }

      // For artist2: add links that don't already exist
      const existingLinks2 = new Set((artist2.links || []).map(l => l.link));
      const newLinks2 = linksForBoth.filter(link => !existingLinks2.has(link));

      if (newLinks2.length > 0) {
        await ArtistLink.bulkCreate(
          newLinks2.map(link => ({
            artistId: artist2.id,
            link: link
          })),
          {
            transaction,
            ignoreDuplicates: true // Prevent duplicate artistId+link combinations
          }
        );
      }
    }

    // Copy evidences to both artists (only add new ones)
    const sourceEvidences = source.evidences || [];
    if (sourceEvidences.length > 0) {
      const evidencesForBoth = sourceEvidences.map(e => ({ link: e.link }));

      // For artist1: add evidences that don't already exist
      const existingEvidences1 = new Set((artist1.evidences || []).map(e => e.link));
      const newEvidences1 = evidencesForBoth.filter(e => !existingEvidences1.has(e.link));

      if (newEvidences1.length > 0) {
        await ArtistEvidence.bulkCreate(
          newEvidences1.map(evidence => ({
            artistId: artist1.id,
            link: evidence.link
          })),
          { transaction }
        );
      }

      // For artist2: add evidences that don't already exist
      const existingEvidences2 = new Set((artist2.evidences || []).map(e => e.link));
      const newEvidences2 = evidencesForBoth.filter(e => !existingEvidences2.has(e.link));

      if (newEvidences2.length > 0) {
        await ArtistEvidence.bulkCreate(
          newEvidences2.map(evidence => ({
            artistId: artist2.id,
            link: evidence.link
          })),
          { transaction }
        );
      }
    }

    // Duplicate song credits for both artists (only add new ones)
    // Since uniqueness is on songId+artistId, check for existing credits regardless of role
    const sourceCredits = source.songCredits || [];
    if (sourceCredits.length > 0) {
      // For artist1: add credits that don't already exist (check by songId only, not role)
      const existingCredits1 = await SongCredit.findAll({
        where: { artistId: artist1.id },
        attributes: ['songId'],
        transaction
      });
      const existingSongsSet1 = new Set(
        existingCredits1.map(c => c.songId)
      );

      const newCredits1 = sourceCredits.filter(credit => {
        return !existingSongsSet1.has(credit.songId);
      });

      if (newCredits1.length > 0) {
        await SongCredit.bulkCreate(
          newCredits1.map(credit => ({
            songId: credit.songId,
            artistId: artist1.id,
            role: credit.role // Preserve role from source credit
          })),
          {
            transaction,
            ignoreDuplicates: true // Safety measure
          }
        );
      }

      // For artist2: add credits that don't already exist (check by songId only, not role)
      const existingCredits2 = await SongCredit.findAll({
        where: { artistId: artist2.id },
        attributes: ['songId'],
        transaction
      });
      const existingSongsSet2 = new Set(
        existingCredits2.map(c => c.songId)
      );

      const newCredits2 = sourceCredits.filter(credit => {
        return !existingSongsSet2.has(credit.songId);
      });

      if (newCredits2.length > 0) {
        await SongCredit.bulkCreate(
          newCredits2.map(credit => ({
            songId: credit.songId,
            artistId: artist2.id,
            role: credit.role // Preserve role from source credit
          })),
          {
            transaction,
            ignoreDuplicates: true // Safety measure
          }
        );
      }
    }

    // Copy artist relations to both target artists
    // Find all relations where source is involved
    const sourceRelations = await ArtistRelation.findAll({
      where: {
        [Op.or]: [
          { artistId1: source.id },
          { artistId2: source.id }
        ]
      },
      transaction
    });

    if (sourceRelations.length > 0) {
      for (const relation of sourceRelations) {
        // Determine the other artist in the relation
        const otherArtistId = relation.artistId1 === source.id
          ? relation.artistId2
          : relation.artistId1;

        // Skip if the other artist is one of the targets (they're splitting, relations will be handled separately)
        if (otherArtistId === artist1.id || otherArtistId === artist2.id) {
          continue;
        }

        // Create relation for artist1 if it doesn't already exist
        const [id1_1, id2_1] = artist1.id < otherArtistId
          ? [artist1.id, otherArtistId]
          : [otherArtistId, artist1.id];

        const existingRelation1 = await ArtistRelation.findOne({
          where: {
            artistId1: id1_1,
            artistId2: id2_1
          },
          transaction
        });

        if (!existingRelation1) {
          await ArtistRelation.create({
            artistId1: id1_1,
            artistId2: id2_1
          }, { transaction });
        }

        // Create relation for artist2 if it doesn't already exist
        const [id1_2, id2_2] = artist2.id < otherArtistId
          ? [artist2.id, otherArtistId]
          : [otherArtistId, artist2.id];

        const existingRelation2 = await ArtistRelation.findOne({
          where: {
            artistId1: id1_2,
            artistId2: id2_2
          },
          transaction
        });

        if (!existingRelation2) {
          await ArtistRelation.create({
            artistId1: id1_2,
            artistId2: id2_2
          }, { transaction });
        }
      }

      // Create relation between artist1 and artist2 if source had relations (they're splitting from same source)
      const [id1, id2] = artist1.id < artist2.id
        ? [artist1.id, artist2.id]
        : [artist2.id, artist1.id];

      const existingRelationBetweenTargets = await ArtistRelation.findOne({
        where: {
          artistId1: id1,
          artistId2: id2
        },
        transaction
      });

      if (!existingRelationBetweenTargets) {
        await ArtistRelation.create({
          artistId1: id1,
          artistId2: id2
        }, { transaction });
      }
    }

    // Optionally delete original artist
    if (deleteOriginal) {
      // Delete avatar from CDN if exists (before deleting artist)
      // Note: CDN deletion happens outside transaction as it's an external service
      if (source.avatarUrl) {
        try {
          const fileId = getFileIdFromCdnUrl(source.avatarUrl);
          if (fileId && isCdnUrl(source.avatarUrl)) {
            await cdnServiceInstance.deleteFile(fileId);
          }
        } catch (error) {
          logger.error('Failed to delete avatar during split:', error);
          // Continue with artist deletion even if CDN deletion fails
        }
      }
      await source.destroy({ transaction });
    }

    return { artist1, artist2 };
  }

  /**
   * Upload avatar image to CDN and update avatarUrl
   */
  public async uploadAvatar(artistId: number, imageFile: Express.Multer.File): Promise<string> {
    const artist = await Artist.findByPk(artistId);
    if (!artist) {
      throw new Error('Artist not found');
    }

    // Delete old avatar if exists
    if (artist.avatarUrl) {
      await this.deleteAvatar(artistId);
    }

    // Upload to CDN
    const uploadResult = await cdnServiceInstance.uploadImage(imageFile.buffer, imageFile.originalname, 'PROFILE');
    const cdnUrl = uploadResult.urls.original;
    // Update artist
    await artist.update({ avatarUrl: cdnUrl });

    return cdnUrl;
  }

  /**
   * Delete avatar image from CDN
   */
  public async deleteAvatar(artistId: number): Promise<void> {
    const artist = await Artist.findByPk(artistId);
    if (!artist || !artist.avatarUrl) {
      return;
    }

    const fileId = getFileIdFromCdnUrl(artist.avatarUrl);
    if (fileId && isCdnUrl(artist.avatarUrl)) {
      try {
        await cdnServiceInstance.deleteFile(fileId);
      } catch (error) {
        logger.error(`Failed to delete avatar for artist ${artistId}:`, error);
      }
    }

    await artist.update({ avatarUrl: null });
  }

  /**
   * Update avatarUrl (can be CDN URL or external URL)
   */
  public async updateAvatarUrl(artistId: number, url: string | null): Promise<void> {
    const artist = await Artist.findByPk(artistId);
    if (!artist) {
      throw new Error('Artist not found');
    }

    await artist.update({ avatarUrl: url });
  }

  /**
   * Get related artists for a single artist (bidirectional)
   * Uses the artist_relations_bidirectional view for efficient querying
   */
  public async getRelatedArtists(artistId: number): Promise<Artist[]> {
    const results = await sequelize.query(`
      SELECT DISTINCT a.id, a.name, a.avatarUrl, a.verificationState
      FROM artist_relations_bidirectional ar
      INNER JOIN artists a ON a.id = ar.relatedArtistId
      WHERE ar.artistId = :artistId
      ORDER BY a.name ASC
    `, {
      replacements: { artistId },
      type: 'SELECT' as const
    }) as any[];

    return results.map((row: any) => ({
      id: row.id,
      name: row.name,
      avatarUrl: row.avatarUrl,
      verificationState: row.verificationState
    } as Artist));
  }

  /**
   * Get related artists for multiple artists (bidirectional, batch)
   * Returns a map of artistId -> related artists array
   */
  public async getRelatedArtistsBatch(artistIds: number[]): Promise<Map<number, Artist[]>> {
    if (artistIds.length === 0) {
      return new Map();
    }

    const results = await sequelize.query(`
      SELECT 
        ar.artistId,
        a.id,
        a.name,
        a.avatarUrl,
        a.verificationState
      FROM artist_relations_bidirectional ar
      INNER JOIN artists a ON a.id = ar.relatedArtistId
      WHERE ar.artistId IN (:artistIds)
      ORDER BY ar.artistId, a.name ASC
    `, {
      replacements: { artistIds },
      type: 'SELECT' as const
    }) as any[];

    const relationsMap = new Map<number, Artist[]>();

    // Initialize map with empty arrays
    artistIds.forEach(id => relationsMap.set(id, []));

    // Group results by artistId
    results.forEach((row: any) => {
      const artistId = row.artistId;
      const relatedArtist = {
        id: row.id,
        name: row.name,
        avatarUrl: row.avatarUrl,
        verificationState: row.verificationState
      } as Artist;

      const relations = relationsMap.get(artistId) || [];
      relations.push(relatedArtist);
      relationsMap.set(artistId, relations);
    });

    return relationsMap;
  }
}

export default ArtistService;
