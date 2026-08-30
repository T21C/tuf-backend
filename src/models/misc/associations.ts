import UsefulLink from './UsefulLink.js';
import UsefulLinkLocale from './UsefulLinkLocale.js';
import UsefulLinkGroup from './UsefulLinkGroup.js';
import UsefulLinkGroupAssignment from './UsefulLinkGroupAssignment.js';
import UsefulLinkGroupLocale from './UsefulLinkGroupLocale.js';
import Mod from './Mod.js';
import ModAssignee from './ModAssignee.js';
import ModVersion from './ModVersion.js';
import ModTag from './ModTag.js';
import ModTagAssignment from './ModTagAssignment.js';
import ModLike from './ModLike.js';
import ModSlugRedirect from './ModSlugRedirect.js';

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

  Mod.hasMany(ModVersion, {
    foreignKey: 'modId',
    as: 'versions',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  ModVersion.belongsTo(Mod, {
    foreignKey: 'modId',
    as: 'mod',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  Mod.belongsToMany(ModTag, {
    through: ModTagAssignment,
    foreignKey: 'modId',
    otherKey: 'tagId',
    as: 'tags',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  ModTag.belongsToMany(Mod, {
    through: ModTagAssignment,
    foreignKey: 'tagId',
    otherKey: 'modId',
    as: 'mods',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  Mod.hasMany(ModTagAssignment, {
    foreignKey: 'modId',
    as: 'tagAssignments',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  ModTagAssignment.belongsTo(Mod, {
    foreignKey: 'modId',
    as: 'mod',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  ModTag.hasMany(ModTagAssignment, {
    foreignKey: 'tagId',
    as: 'assignments',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  ModTagAssignment.belongsTo(ModTag, {
    foreignKey: 'tagId',
    as: 'tag',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  Mod.hasMany(ModLike, {
    foreignKey: 'modId',
    as: 'likeRows',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  ModLike.belongsTo(Mod, {
    foreignKey: 'modId',
    as: 'mod',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  Mod.hasMany(ModSlugRedirect, {
    foreignKey: 'modId',
    as: 'slugRedirects',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  ModSlugRedirect.belongsTo(Mod, {
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
  UsefulLinkGroup.hasMany(UsefulLinkGroupLocale, {
    foreignKey: 'groupId',
    as: 'locales',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkGroupLocale.belongsTo(UsefulLinkGroup, {
    foreignKey: 'groupId',
    as: 'group',
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
