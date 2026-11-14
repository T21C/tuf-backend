import CurationType from './CurationType.js';
import Curation from './Curation.js';
import CurationCurationType from './CurationCurationType.js';
import CurationSchedule from './CurationSchedule.js';
import CurationRating from './CurationRating.js';
import CurationRatingDetail from './CurationRatingDetail.js';
import CurationAnnouncementQueue from './CurationAnnouncementQueue.js';
import Level from '@/models/levels/Level.js';
import User from '@/models/auth/User.js';

export function initializeCurationsAssociations() {
  Curation.belongsToMany(CurationType, {
    through: CurationCurationType,
    foreignKey: 'curationId',
    otherKey: 'typeId',
    as: 'types',
  });

  CurationType.belongsToMany(Curation, {
    through: CurationCurationType,
    foreignKey: 'typeId',
    otherKey: 'curationId',
    as: 'curations',
  });

  Curation.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
  });

  Level.hasMany(Curation, {
    foreignKey: 'levelId',
    as: 'curations',
  });

  CurationSchedule.belongsTo(Curation, {
    foreignKey: 'curationId',
    as: 'scheduledCuration',
  });

  Curation.hasMany(CurationSchedule, {
    foreignKey: 'curationId',
    as: 'curationSchedules',
  });

  Curation.belongsTo(User, {
    foreignKey: 'assignedBy',
    as: 'assignedByUser',
  });

  Level.hasMany(CurationRating, {
    foreignKey: 'levelId',
    as: 'curationRatings',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  CurationRating.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  CurationRating.hasMany(CurationRatingDetail, {
    foreignKey: 'curationRatingId',
    as: 'details',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  CurationRatingDetail.belongsTo(CurationRating, {
    foreignKey: 'curationRatingId',
    as: 'curationRating',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  CurationRating.belongsTo(User, {
    foreignKey: 'settledByUserId',
    as: 'settledByUser',
  });

  Level.hasMany(CurationAnnouncementQueue, {
    foreignKey: 'levelId',
    as: 'curationAnnouncementQueueEntries',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  CurationAnnouncementQueue.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
}
