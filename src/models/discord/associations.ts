import DiscordGuild from './DiscordGuild.js';
import DiscordSyncRole from './DiscordSyncRole.js';
import Difficulty from '../levels/Difficulty.js';
import CurationType from '../curations/CurationType.js';

export function initializeDiscordAssociations() {
  // DiscordGuild <-> DiscordSyncRole associations
  DiscordGuild.hasMany(DiscordSyncRole, {
    foreignKey: 'discordGuildId',
    as: 'roles',
    onDelete: 'CASCADE',
  });

  DiscordSyncRole.belongsTo(DiscordGuild, {
    foreignKey: 'discordGuildId',
    as: 'guild',
  });

  // DiscordSyncRole -> Difficulty association (for DIFFICULTY type roles)
  DiscordSyncRole.belongsTo(Difficulty, {
    foreignKey: 'minDifficultyId',
    as: 'difficulty',
  });

  // DiscordSyncRole -> CurationType association (for CURATION type roles)
  DiscordSyncRole.belongsTo(CurationType, {
    foreignKey: 'curationTypeId',
    as: 'curationType',
  });
}
