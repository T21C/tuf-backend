import AnnouncementDirective from './AnnouncementDirective.js';
import DirectiveAction from './DirectiveAction.js';
import AnnouncementChannel from './AnnouncementChannel.js';
import AnnouncementRole from './AnnouncementRole.js';
import Difficulty from '../levels/Difficulty.js';

export function initializeAnnouncementsAssociations() {
  // Difficulty Associations
  Difficulty.hasMany(AnnouncementDirective, {
    foreignKey: 'difficultyId',
    as: 'announcementDirectives',
  });

  AnnouncementDirective.belongsTo(Difficulty, {
    foreignKey: 'difficultyId',
    as: 'difficulty',
  });

  // DirectiveAction associations
  DirectiveAction.belongsTo(AnnouncementChannel, {
    foreignKey: 'channelId',
    as: 'announcementChannel',
  });

  DirectiveAction.belongsTo(AnnouncementRole, {
    foreignKey: 'roleId',
    as: 'announcementRole',
  });
}
