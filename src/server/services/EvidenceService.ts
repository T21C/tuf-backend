import { Op } from 'sequelize';
import LevelSubmissionEvidence from '../../models/submissions/LevelSubmissionEvidence.js';
import ArtistEvidence from '../../models/artists/ArtistEvidence.js';
import SongEvidence from '../../models/songs/SongEvidence.js';
import { getFileIdFromCdnUrl, isCdnUrl } from '../../misc/utils/Utility.js';
import cdnServiceInstance from './CdnService.js';
import { logger } from './LoggerService.js';

class EvidenceService {
  private static instance: EvidenceService;

  private constructor() {}

  public static getInstance(): EvidenceService {
    if (!EvidenceService.instance) {
      EvidenceService.instance = new EvidenceService();
    }
    return EvidenceService.instance;
  }

  /**
   * Upload evidence images to CDN for a submission
   */
  public async uploadEvidenceImages(
    submissionId: number,
    files: Express.Multer.File[],
    type: 'song' | 'artist',
    requestId?: number | null,
    transaction?: any
  ): Promise<LevelSubmissionEvidence[]> {
    const evidenceRecords: LevelSubmissionEvidence[] = [];

    for (const file of files) {
      // Upload to CDN
      const uploadResult = await cdnServiceInstance.uploadImage(
        file.buffer,
        file.originalname,
        'EVIDENCE' // Evidence images use EVIDENCE type
      );

      const cdnUrl = uploadResult.urls.original;

      // Create evidence record within transaction if provided
      const evidence = await LevelSubmissionEvidence.create({
        submissionId,
        link: cdnUrl,
        type,
        requestId: requestId || null
      }, transaction ? { transaction } : {});

      evidenceRecords.push(evidence);
    }

    return evidenceRecords;
  }

  /**
   * Delete evidence image from CDN and DB
   */
  public async deleteEvidenceImage(evidenceId: number): Promise<void> {
    const evidence = await LevelSubmissionEvidence.findByPk(evidenceId);
    if (!evidence) {
      throw new Error('Evidence not found');
    }

    // Extract fileId and delete from CDN
    const fileId = getFileIdFromCdnUrl(evidence.link);
    if (fileId && isCdnUrl(evidence.link)) {
      try {
        await cdnServiceInstance.deleteFile(fileId);
      } catch (error) {
        logger.error(`Failed to delete evidence ${evidenceId} from CDN:`, error);
      }
    }

    // Delete from DB
    await evidence.destroy();
  }

  /**
   * Get all evidence for a submission
   */
  public async getEvidenceForSubmission(submissionId: number): Promise<LevelSubmissionEvidence[]> {
    return await LevelSubmissionEvidence.findAll({
      where: { submissionId },
      order: [['createdAt', 'ASC']]
    });
  }

  /**
   * Delete all evidence for a submission (for declined submissions)
   */
  public async deleteAllEvidenceForSubmission(submissionId: number): Promise<void> {
    const evidenceList = await LevelSubmissionEvidence.findAll({
      where: { submissionId }
    });

    for (const evidence of evidenceList) {
      const fileId = getFileIdFromCdnUrl(evidence.link);
      if (fileId && isCdnUrl(evidence.link)) {
        try {
          await cdnServiceInstance.deleteFile(fileId);
        } catch (error) {
          logger.error(`Failed to delete evidence ${evidence.id} from CDN:`, error);
        }
      }
    }

    // Delete all evidence records
    await LevelSubmissionEvidence.destroy({
      where: { submissionId }
    });
  }

  /**
   * Add evidence to song (managers only)
   */
  public async addEvidenceToSong(
    songId: number,
    link: string,
  ): Promise<SongEvidence> {
    return await SongEvidence.create({
      songId,
      link,
    });
  }

  /**
   * Add evidence to artist (managers only)
   */
  public async addEvidenceToArtist(
    artistId: number,
    link: string
  ): Promise<ArtistEvidence> {
    return await ArtistEvidence.create({
      artistId,
      link
    });
  }

  /**
   * Get evidence for song
   */
  public async getEvidenceForSong(songId: number): Promise<SongEvidence[]> {
    return await SongEvidence.findAll({
      where: { songId },
      order: [['createdAt', 'ASC']]
    });
  }

  /**
   * Get evidence for artist
   */
  public async getEvidenceForArtist(artistId: number): Promise<ArtistEvidence[]> {
    return await ArtistEvidence.findAll({
      where: { artistId },
      order: [['createdAt', 'ASC']]
    });
  }

  /**
   * Update evidence for song (only for external links, CDN links cannot be updated)
   */
  public async updateSongEvidence(
    evidenceId: number,
    link: string,
    extraInfo?: string | null
  ): Promise<SongEvidence> {
    const evidence = await SongEvidence.findByPk(evidenceId);
    if (!evidence) {
      throw new Error('Evidence not found');
    }

    // Prevent updating CDN links
    if (isCdnUrl(evidence.link)) {
      throw new Error('Cannot update CDN evidence links. Delete and re-upload instead.');
    }

    evidence.link = link.trim();
    if (extraInfo !== undefined) {
      evidence.extraInfo = extraInfo?.trim() || null;
    }
    await evidence.save();
    return evidence;
  }

  /**
   * Update evidence for artist (only for external links, CDN links cannot be updated)
   */
  public async updateArtistEvidence(
    evidenceId: number,
    link: string,
    extraInfo?: string | null
  ): Promise<ArtistEvidence> {
    const evidence = await ArtistEvidence.findByPk(evidenceId);
    if (!evidence) {
      throw new Error('Evidence not found');
    }

    // Prevent updating CDN links
    if (isCdnUrl(evidence.link)) {
      throw new Error('Cannot update CDN evidence links. Delete and re-upload instead.');
    }

    evidence.link = link.trim();
    if (extraInfo !== undefined) {
      evidence.extraInfo = extraInfo?.trim() || null;
    }
    await evidence.save();
    return evidence;
  }

  /**
   * Delete evidence from song
   */
  public async deleteSongEvidence(evidenceId: number): Promise<void> {
    const evidence = await SongEvidence.findByPk(evidenceId);
    if (!evidence) {
      throw new Error('Evidence not found');
    }

    const fileId = getFileIdFromCdnUrl(evidence.link);
    if (fileId && isCdnUrl(evidence.link)) {
      try {
        await cdnServiceInstance.deleteFile(fileId);
      } catch (error) {
        logger.error(`Failed to delete song evidence ${evidenceId} from CDN:`, error);
      }
    }

    await evidence.destroy();
  }

  /**
   * Delete evidence from artist
   */
  public async deleteArtistEvidence(evidenceId: number): Promise<void> {
    const evidence = await ArtistEvidence.findByPk(evidenceId);
    if (!evidence) {
      throw new Error('Evidence not found');
    }

    const fileId = getFileIdFromCdnUrl(evidence.link);
    if (fileId && isCdnUrl(evidence.link)) {
      try {
        await cdnServiceInstance.deleteFile(fileId);
      } catch (error) {
        logger.error(`Failed to delete artist evidence ${evidenceId} from CDN:`, error);
      }
    }

    await evidence.destroy();
  }

  /**
   * Extract fileId from CDN link
   */
  public extractFileIdFromLink(link: string): string | null {
    return getFileIdFromCdnUrl(link);
  }

  /**
   * Check if link is a CDN URL
   */
  public isCdnLink(link: string): boolean {
    return isCdnUrl(link);
  }
}

export default EvidenceService;
