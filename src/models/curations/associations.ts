import CurationType from './CurationType.js';
import Curation from './Curation.js';
import CurationCurationType from './CurationCurationType.js';
import CurationSchedule from './CurationSchedule.js';
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
}
