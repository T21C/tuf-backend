import { Op } from 'sequelize';
import Artist from '../../models/artists/Artist.js';
import ArtistAlias from '../../models/artists/ArtistAlias.js';
import ArtistLink from '../../models/artists/ArtistLink.js';
import ArtistEvidence from '../../models/artists/ArtistEvidence.js';
import SongCredit from '../../models/songs/SongCredit.js';
import Level from '../../models/levels/Level.js';
import LevelSubmissionArtistRequest from '../../models/submissions/LevelSubmissionArtistRequest.js';
import { logger } from './LoggerService.js';
import { getFileIdFromCdnUrl, isCdnUrl } from '../../misc/utils/Utility.js';
import cdnServiceInstance from './CdnService.js';

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
    verificationState?: 'unverified' | 'pending' | 'ysmod_only' | 'declined' | 'mostly_declined' | 'mostly_allowed' | 'allowed'
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
            }))
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
            }))
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
      await ArtistAlias.create({
        artistId: target.id,
        alias: source.name
      });
    }

    // Merge links from source to target by updating artistId
    const targetLinks = new Set(
      (target.links || []).map(l => l.link.toLowerCase().trim())
    );
    const sourceLinks = source.links || [];
    const sourceLinksToMove = sourceLinks.filter(link => {
      const normalizedLink = link.link.toLowerCase().trim();
      return !targetLinks.has(normalizedLink);
    });

    // Update artistId for non-duplicate links (duplicates will be deleted when source is destroyed)
    if (sourceLinksToMove.length > 0) {
      const linkIds = sourceLinksToMove.map(l => l.id);
      await ArtistLink.update(
        { artistId: target.id },
        { where: { id: { [Op.in]: linkIds } } }
      );
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
    
    // Update song credits
    await SongCredit.update(
      { artistId: target.id },
      { where: { artistId: source.id } }
    );

    // Update level submission artist requests
    await LevelSubmissionArtistRequest.update(
      { artistId: target.id },
      { where: { artistId: source.id } }
    );

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
    deleteOriginal: boolean = false,
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
          { transaction }
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
          { transaction }
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
          { transaction }
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
          { transaction }
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
          logger.error(`Failed to delete avatar during split:`, error);
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
}

export default ArtistService;
