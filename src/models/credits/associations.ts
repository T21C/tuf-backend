import Creator from './Creator.js';
import { CreatorAlias } from './CreatorAlias.js';
import Team from './Team.js';
import TeamMember from './TeamMember.js';
import { TeamAlias } from './TeamAlias.js';
import LevelCredit from '../levels/LevelCredit.js';
import Level from '../levels/Level.js';

export function initializeCreditsAssociations() {
  // Creator <-> CreatorAlias associations
  Creator.hasMany(CreatorAlias, {
    foreignKey: 'creatorId',
    as: 'creatorAliases',
  });

  CreatorAlias.belongsTo(Creator, {
    foreignKey: 'creatorId',
    as: 'creator',
  });

  // Team <-> TeamMember associations
  Team.hasMany(TeamMember, {
    foreignKey: 'teamId',
    as: 'teamMembers',
  });

  TeamMember.belongsTo(Team, {
    foreignKey: 'teamId',
    as: 'team',
  });

  Creator.hasMany(TeamMember, {
    foreignKey: 'creatorId',
    as: 'teamMemberships',
  });

  TeamMember.belongsTo(Creator, {
    foreignKey: 'creatorId',
    as: 'creator',
  });

  // Team <-> TeamAlias associations
  Team.hasMany(TeamAlias, {
    foreignKey: 'teamId',
    as: 'teamAliases',
  });

  TeamAlias.belongsTo(Team, {
    foreignKey: 'teamId',
    as: 'team',
  });

  // Creator <-> LevelCredit associations
  Creator.hasMany(LevelCredit, {
    foreignKey: 'creatorId',
    as: 'credits',
  });

  LevelCredit.belongsTo(Creator, {
    foreignKey: 'creatorId',
    as: 'creator',
  });

  // Level <-> Creator (through LevelCredit) associations
  Level.belongsToMany(Creator, {
    through: LevelCredit,
    as: 'levelCreators',
    foreignKey: 'levelId',
    otherKey: 'creatorId',
  });

  Creator.belongsToMany(Level, {
    through: LevelCredit,
    as: 'createdLevels',
    foreignKey: 'creatorId',
    otherKey: 'levelId',
  });

  // Team <-> Creator (through TeamMember) associations
  Team.belongsToMany(Creator, {
    through: TeamMember,
    foreignKey: 'teamId',
    otherKey: 'creatorId',
    as: 'teamCreators',
  });

  Creator.belongsToMany(Team, {
    through: TeamMember,
    foreignKey: 'creatorId',
    otherKey: 'teamId',
    as: 'creatorTeams',
  });
}
