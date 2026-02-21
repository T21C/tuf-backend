import Level from './levels/Level.js';
import Pass from './passes/Pass.js';
import Player from './players/Player.js';
import Rating from './levels/Rating.js';
import RatingDetail from './levels/RatingDetail.js';
import Judgement from './passes/Judgement.js';
import LevelSubmission from './submissions/LevelSubmission.js';
import Difficulty from './levels/Difficulty.js';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from './submissions/PassSubmission.js';
import sequelize from '../config/db.js';
import {initializeAssociations} from './associations.js';
import User from './auth/User.js';
import OAuthProvider from './auth/OAuthProvider.js';
import RefreshToken from './auth/RefreshToken.js';
import Creator from './credits/Creator.js';
import LevelCredit from './levels/LevelCredit.js';
import Team from './credits/Team.js';
import TeamMember from './credits/TeamMember.js';
import PlayerStats from './players/PlayerStats.js';
import UsernameChange from './auth/UsernameChange.js';
import AnnouncementChannel from './announcements/AnnouncementChannel.js';
import AnnouncementRole from './announcements/AnnouncementRole.js';
import AnnouncementDirective from './announcements/AnnouncementDirective.js';
import DirectiveAction from './announcements/DirectiveAction.js';
import RateLimit from './auth/RateLimit.js';
import LevelSearchView from './levels/LevelSearchView.js';
import AuditLog from './admin/AuditLog.js';
import {CurationType, Curation, CurationSchedule} from './curations/index.js';
import {LevelPack, LevelPackItem} from './packs/index.js';
import Artist from './artists/Artist.js';
import ArtistAlias from './artists/ArtistAlias.js';
import ArtistLink from './artists/ArtistLink.js';
import ArtistEvidence from './artists/ArtistEvidence.js';
import Song from './songs/Song.js';
import SongCredit from './songs/SongCredit.js';
import SongAlias from './songs/SongAlias.js';
import SongLink from './songs/SongLink.js';
import SongEvidence from './songs/SongEvidence.js';
import LevelSubmissionSongRequest from './submissions/LevelSubmissionSongRequest.js';
import LevelSubmissionArtistRequest from './submissions/LevelSubmissionArtistRequest.js';
import LevelSubmissionEvidence from './submissions/LevelSubmissionEvidence.js';
import { DiscordGuild, DiscordSyncRole } from './discord/index.js';
// Create db object with models first
export const db = {
  sequelize,
  models: {
    Level,
    Pass,
    Player,
    Rating,
    RatingDetail,
    Judgement,
    LevelSubmission,
    PassSubmission,
    PassSubmissionJudgements,
    PassSubmissionFlags,
    Difficulty,
    User,
    OAuthProvider,
    RefreshToken,
    Creator,
    LevelCredit,
    Team,
    TeamMember,
    PlayerStats,
    UsernameChange,
    AnnouncementChannel,
    AnnouncementRole,
    AnnouncementDirective,
    DirectiveAction,
    RateLimit,
    LevelSearchView,
    AuditLog,
    CurationType,
    Curation,
    CurationSchedule,
    LevelPack,
    LevelPackItem,
    Artist,
    ArtistAlias,
    ArtistLink,
    ArtistEvidence,
    Song,
    SongCredit,
    SongAlias,
    SongLink,
    SongEvidence,
    LevelSubmissionSongRequest,
    LevelSubmissionArtistRequest,
    LevelSubmissionEvidence,
    DiscordGuild,
    DiscordSyncRole
  },
};

// Initialize associations after models are defined
initializeAssociations();

// Associations are now handled in individual association files

export default db;

// Also export User, OAuthProvider, RefreshToken, etc. directly for convenience
export {User, OAuthProvider, RefreshToken, RateLimit, AuditLog};

// Export Discord models
export {DiscordGuild, DiscordSyncRole};
