import CurationType from './CurationType.js';
import Curation from './Curation.js';
import CurationSchedule from './CurationSchedule.js';
import Level from '../levels/Level.js';
import User from '../auth/User.js';

export function initializeCurationsAssociations() {
  // Curation associations
  Curation.belongsTo(CurationType, {
    foreignKey: 'typeId',
    as: 'type',
  });

  CurationType.hasMany(Curation, {
    foreignKey: 'typeId',
    as: 'curations',
  });

  Curation.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'curationLevel',
  });

  Level.hasOne(Curation, {
    foreignKey: 'levelId',
    as: 'curation',
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
