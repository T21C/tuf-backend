import UsefulLink from './UsefulLink.js';
import UsefulLinkGroup from './UsefulLinkGroup.js';

export function initializeMiscAssociations() {
  UsefulLink.belongsTo(UsefulLinkGroup, {
    foreignKey: 'groupId',
    as: 'linkGroup',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
  });

  UsefulLinkGroup.hasMany(UsefulLink, {
    foreignKey: 'groupId',
    as: 'links',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
  });
}
