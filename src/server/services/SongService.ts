import { Op } from 'sequelize';
import Song from '../../models/songs/Song.js';
import SongAlias from '../../models/songs/SongAlias.js';
import SongLink from '../../models/songs/SongLink.js';
import SongEvidence from '../../models/songs/SongEvidence.js';
import SongCredit from '../../models/songs/SongCredit.js';
import Artist from '../../models/artists/Artist.js';
import Level from '../../models/levels/Level.js';
import LevelSubmissionSongRequest from '../../models/submissions/LevelSubmissionSongRequest.js';
import { logger } from './LoggerService.js';

class SongService {
  private static instance: SongService;

  private constructor() {}

  public static getInstance(): SongService {
    if (!SongService.instance) {
      SongService.instance = new SongService();
    }
    return SongService.instance;
  }

  /**
   * Normalize song name for comparison
   */
  public normalizeSongName(name: string): string {
    if (!name) return '';
    return name.trim().toLowerCase();
  }

  /**
   * Find or create song with smart duplicate detection
   */
  public async findOrCreateSong(
    name: string,
    aliases?: string[]
  ): Promise<Song> {
    const normalizedName = this.normalizeSongName(name);
    
    // First, try to find by exact name match (case-insensitive)
    let song = await Song.findOne({
      where: {
        name: {
          [Op.like]: normalizedName
        }
      },
      include: [
        {
          model: SongAlias,
          as: 'aliases'
        }
      ]
    });

    // If not found, check aliases
    if (!song && aliases && aliases.length > 0) {
      const normalizedAliases = aliases.map(a => this.normalizeSongName(a));
      const aliasMatch = await SongAlias.findOne({
        where: {
          alias: {
            [Op.in]: normalizedAliases
          }
        },
        include: [
          {
            model: Song,
            as: 'song',
            include: [
              {
                model: SongAlias,
                as: 'aliases'
              }
            ]
          }
        ]
      });

      if (aliasMatch?.song) {
        song = aliasMatch.song;
      }
    }

    // If still not found, create new song
    if (!song) {
      song = await Song.create({
        name: name.trim(),
        verificationState: 'unverified'
      });
      if (!song) {
        throw new Error('Failed to create song');
      }
      // Add aliases if provided
      if (aliases && aliases.length > 0) {
        const uniqueAliases = [...new Set(aliases.map(a => a.trim()).filter(a => a && a.toLowerCase() !== normalizedName))];
        if (uniqueAliases.length > 0) {
          await SongAlias.bulkCreate(
            uniqueAliases.map(alias => ({
              songId: song!.id,
              alias: alias.trim()
            }))
          );
        }
      }
    } else {
      // Song exists, add any new aliases
      if (aliases && aliases.length > 0) {
        const existingAliases = new Set(
          (song.aliases || []).map(a => this.normalizeSongName(a.alias))
        );
        existingAliases.add(this.normalizeSongName(song.name));

        const newAliases = aliases
          .map(a => a.trim())
          .filter(a => {
            const normalized = this.normalizeSongName(a);
            return a && !existingAliases.has(normalized);
          });

        if (newAliases.length > 0) {
          await SongAlias.bulkCreate(
            newAliases.map(alias => ({
              songId: song!.id,
              alias: alias.trim()
            }))
          );
        }
      }
    }

    return song;
  }

  /**
   * Merge source song into target song
   */
  public async mergeSongs(sourceId: number, targetId: number): Promise<void> {
    const source = await Song.findByPk(sourceId, {
      include: [
        { model: SongAlias, as: 'aliases' },
        { model: SongLink, as: 'links' },
        { model: SongEvidence, as: 'evidences' },
        { model: SongCredit, as: 'credits' }
      ]
    });
    const target = await Song.findByPk(targetId, {
      include: [
        { model: SongAlias, as: 'aliases' },
        { model: SongLink, as: 'links' },
        { model: SongEvidence, as: 'evidences' },
        { model: SongCredit, as: 'credits' }
      ]
    });

    if (!source || !target) {
      throw new Error('Source or target song not found');
    }

    if (source.id === target.id) {
      throw new Error('Cannot merge song into itself');
    }

    // Move aliases from source to target by updating songId
    const targetAliases = new Set(
      (target.aliases || []).map(a => this.normalizeSongName(a.alias))
    );
    targetAliases.add(this.normalizeSongName(target.name));

    const sourceAliases = source.aliases || [];
    const sourceAliasesToMove = sourceAliases.filter(a => {
      const normalized = this.normalizeSongName(a.alias);
      return !targetAliases.has(normalized);
    });

    // Update songId for non-duplicate aliases (duplicates will be deleted when source is destroyed)
    if (sourceAliasesToMove.length > 0) {
      const aliasIds = sourceAliasesToMove.map(a => a.id);
      await SongAlias.update(
        { songId: target.id },
        { where: { id: { [Op.in]: aliasIds } } }
      );
    }

    // Add source name as alias if not already present
    const sourceNameNormalized = this.normalizeSongName(source.name);
    if (!targetAliases.has(sourceNameNormalized)) {
      await SongAlias.create({
        songId: target.id,
        alias: source.name
      });
    }

    // Merge links from source to target by updating songId
    const targetLinks = new Set(
      (target.links || []).map(l => l.link.toLowerCase().trim())
    );
    const sourceLinks = source.links || [];
    const sourceLinksToMove = sourceLinks.filter(link => {
      const normalizedLink = link.link.toLowerCase().trim();
      return !targetLinks.has(normalizedLink);
    });

    // Update songId for non-duplicate links (duplicates will be deleted when source is destroyed)
    if (sourceLinksToMove.length > 0) {
      const linkIds = sourceLinksToMove.map(l => l.id);
      await SongLink.update(
        { songId: target.id },
        { where: { id: { [Op.in]: linkIds } } }
      );
    }

    // Merge evidences from source to target by updating songId
    const targetEvidences = new Set(
      (target.evidences || []).map(e => e.link.toLowerCase().trim())
    );
    const sourceEvidences = source.evidences || [];
    const sourceEvidencesToMove = sourceEvidences.filter(evidence => {
      const normalizedLink = evidence.link.toLowerCase().trim();
      return !targetEvidences.has(normalizedLink);
    });

    // Update songId for non-duplicate evidences (duplicates will be deleted when source is destroyed)
    if (sourceEvidencesToMove.length > 0) {
      const evidenceIds = sourceEvidencesToMove.map(e => e.id);
      await SongEvidence.update(
        { songId: target.id },
        { where: { id: { [Op.in]: evidenceIds } } }
      );
    }

    // Move credits from source to target (avoid duplicates)
    const targetCredits = new Set(
      (target.credits || []).map(c => `${c.artistId}-${c.role || ''}`)
    );

    const sourceCredits = source.credits || [];
    const newCredits = sourceCredits.filter(c => {
      const key = `${c.artistId}-${c.role || ''}`;
      return !targetCredits.has(key);
    });

    if (newCredits.length > 0) {
      await SongCredit.bulkCreate(
        newCredits.map(credit => ({
          songId: target.id,
          artistId: credit.artistId,
          role: credit.role
        }))
      );
    }

    // Update all references to point to target
    // Update levels
    await Level.update(
      { songId: target.id },
      { where: { songId: source.id } }
    );

    // Update level submission song requests
    await LevelSubmissionSongRequest.update(
      { songId: target.id },
      { where: { songId: source.id } }
    );

    // Delete source song (cascade will handle aliases/links/evidences/credits)
    await source.destroy();
  }

  /**
   * Add artist credit to song
   */
  public async addArtistCredit(
    songId: number,
    artistId: number,
    role?: string | null
  ): Promise<SongCredit> {
    const [credit, created] = await SongCredit.findOrCreate({
      where: {
        songId,
        artistId,
        role: role || null
      },
      defaults: {
        songId,
        artistId,
        role: role || null
      }
    });

    return credit;
  }

  /**
   * Remove artist credit from song
   */
  public async removeArtistCredit(
    songId: number,
    artistId: number
  ): Promise<void> {
    await SongCredit.destroy({
      where: {
        songId,
        artistId
      }
    });
  }
}

export default SongService;
