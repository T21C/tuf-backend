import UsefulLink from './UsefulLink.js';
import UsefulLinkLocale from './UsefulLinkLocale.js';
import UsefulLinkGroup from './UsefulLinkGroup.js';
import UsefulLinkGroupAssignment from './UsefulLinkGroupAssignment.js';
import Mod from './Mod.js';
import ModAssignee from './ModAssignee.js';

export function initializeMiscAssociations() {
  Mod.hasMany(ModAssignee, {
    foreignKey: 'modId',
    as: 'assigneeRows',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  ModAssignee.belongsTo(Mod, {
    foreignKey: 'modId',
    as: 'mod',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  UsefulLink.hasMany(UsefulLinkLocale, {
    foreignKey: 'linkId',
    as: 'locales',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkLocale.belongsTo(UsefulLink, {
    foreignKey: 'linkId',
    as: 'link',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  UsefulLink.belongsToMany(UsefulLinkGroup, {
    through: UsefulLinkGroupAssignment,
    foreignKey: 'linkId',
    otherKey: 'groupId',
    as: 'groups',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkGroup.belongsToMany(UsefulLink, {
    through: UsefulLinkGroupAssignment,
    foreignKey: 'groupId',
    otherKey: 'linkId',
    as: 'links',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  UsefulLink.hasMany(UsefulLinkGroupAssignment, {
    foreignKey: 'linkId',
    as: 'groupAssignments',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkGroupAssignment.belongsTo(UsefulLink, {
    foreignKey: 'linkId',
    as: 'link',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkGroup.hasMany(UsefulLinkGroupAssignment, {
    foreignKey: 'groupId',
    as: 'linkAssignments',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkGroupAssignment.belongsTo(UsefulLinkGroup, {
    foreignKey: 'groupId',
    as: 'group',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
}
