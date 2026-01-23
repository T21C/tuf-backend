import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from './PassSubmission.js';
import LevelSubmission from './LevelSubmission.js';
import LevelSubmissionCreatorRequest from './LevelSubmissionCreatorRequest.js';
import LevelSubmissionTeamRequest from './LevelSubmissionTeamRequest.js';
import LevelSubmissionSongRequest from './LevelSubmissionSongRequest.js';
import LevelSubmissionArtistRequest from './LevelSubmissionArtistRequest.js';
import LevelSubmissionEvidence from './LevelSubmissionEvidence.js';
import Player from '../players/Player.js';
import User from '../auth/User.js';
import Creator from '../credits/Creator.js';
import Team from '../credits/Team.js';
import Song from '../songs/Song.js';
import Artist from '../artists/Artist.js';

export function initializeSubmissionsAssociations() {
  // PassSubmission <-> Player associations
  PassSubmission.belongsTo(Player, {
    foreignKey: 'assignedPlayerId',
    as: 'assignedPlayer',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // PassSubmission <-> PassSubmissionJudgements associations
  PassSubmission.hasOne(PassSubmissionJudgements, {
    foreignKey: 'passSubmissionId',
    as: 'judgements',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  PassSubmissionJudgements.belongsTo(PassSubmission, {
    foreignKey: 'passSubmissionId',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // PassSubmission <-> PassSubmissionFlags associations
  PassSubmission.hasOne(PassSubmissionFlags, {
    foreignKey: 'passSubmissionId',
    as: 'flags',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  PassSubmissionFlags.belongsTo(PassSubmission, {
    foreignKey: 'passSubmissionId',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // LevelSubmission <-> LevelSubmissionCreatorRequest associations
  LevelSubmission.hasMany(LevelSubmissionCreatorRequest, {
    foreignKey: 'submissionId',
    as: 'creatorRequests',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  LevelSubmissionCreatorRequest.belongsTo(LevelSubmission, {
    foreignKey: 'submissionId',
    as: 'submission'
  });

  // LevelSubmissionCreatorRequest <-> Creator associations
  LevelSubmissionCreatorRequest.belongsTo(Creator, {
    foreignKey: 'creatorId',
    as: 'creator'
  });

  // LevelSubmission <-> LevelSubmissionTeamRequest associations
  LevelSubmission.hasOne(LevelSubmissionTeamRequest, {
    foreignKey: 'submissionId',
    as: 'teamRequestData',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  LevelSubmissionTeamRequest.belongsTo(LevelSubmission, {
    foreignKey: 'submissionId',
    as: 'submission'
  });

  // LevelSubmissionTeamRequest <-> Team associations
  LevelSubmissionTeamRequest.belongsTo(Team, {
    foreignKey: 'teamId',
    as: 'team'
  });

  // LevelSubmission <-> User associations
  LevelSubmission.belongsTo(User, {
    foreignKey: 'userId',
    as: 'levelSubmitter'
  });

  // LevelSubmission <-> Song associations
  LevelSubmission.belongsTo(Song, {
    foreignKey: 'songId',
    as: 'songObject'
  });

  // LevelSubmission <-> Artist associations
  LevelSubmission.belongsTo(Artist, {
    foreignKey: 'artistId',
    as: 'artistObject'
  });

  // LevelSubmission <-> LevelSubmissionSongRequest associations
  LevelSubmission.hasOne(LevelSubmissionSongRequest, {
    foreignKey: 'submissionId',
    as: 'songRequest',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  LevelSubmissionSongRequest.belongsTo(LevelSubmission, {
    foreignKey: 'submissionId',
    as: 'submission'
  });

  LevelSubmissionSongRequest.belongsTo(Song, {
    foreignKey: 'songId',
    as: 'song'
  });

  // LevelSubmission <-> LevelSubmissionArtistRequest associations
  LevelSubmission.hasOne(LevelSubmissionArtistRequest, {
    foreignKey: 'submissionId',
    as: 'artistRequest',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  LevelSubmissionArtistRequest.belongsTo(LevelSubmission, {
    foreignKey: 'submissionId',
    as: 'submission'
  });

  LevelSubmissionArtistRequest.belongsTo(Artist, {
    foreignKey: 'artistId',
    as: 'artist'
  });

  // LevelSubmission <-> LevelSubmissionEvidence associations
  LevelSubmission.hasMany(LevelSubmissionEvidence, {
    foreignKey: 'submissionId',
    as: 'evidence',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  });

  LevelSubmissionEvidence.belongsTo(LevelSubmission, {
    foreignKey: 'submissionId',
    as: 'submission'
  });
}
