import UsefulLink from './UsefulLink.js';
import UsefulLinkTag from './UsefulLinkTag.js';
import UsefulLinkTagGroup from './UsefulLinkTagGroup.js';
import UsefulLinkTagAssignment from './UsefulLinkTagAssignment.js';
import UsefulLinkLocale from './UsefulLinkLocale.js';
import UsefulLinkCluster from './UsefulLinkCluster.js';
import UsefulLinkClusterItem from './UsefulLinkClusterItem.js';
import UsefulLinkClusterLocaleDefault from './UsefulLinkClusterLocaleDefault.js';

export function initializeMiscAssociations() {
  UsefulLinkTag.belongsTo(UsefulLinkTagGroup, {
    foreignKey: 'groupId',
    as: 'tagGroup',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
  });
  UsefulLinkTagGroup.hasMany(UsefulLinkTag, {
    foreignKey: 'groupId',
    as: 'tags',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
  });

  UsefulLink.belongsToMany(UsefulLinkTag, {
    through: UsefulLinkTagAssignment,
    foreignKey: 'linkId',
    otherKey: 'tagId',
    as: 'tags',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkTag.belongsToMany(UsefulLink, {
    through: UsefulLinkTagAssignment,
    foreignKey: 'tagId',
    otherKey: 'linkId',
    as: 'links',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  UsefulLink.hasMany(UsefulLinkTagAssignment, {
    foreignKey: 'linkId',
    as: 'tagAssignments',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkTagAssignment.belongsTo(UsefulLink, {
    foreignKey: 'linkId',
    as: 'link',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkTag.hasMany(UsefulLinkTagAssignment, {
    foreignKey: 'tagId',
    as: 'linkAssignments',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkTagAssignment.belongsTo(UsefulLinkTag, {
    foreignKey: 'tagId',
    as: 'tag',
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

  UsefulLinkCluster.hasMany(UsefulLinkClusterItem, {
    foreignKey: 'clusterId',
    as: 'items',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkClusterItem.belongsTo(UsefulLinkCluster, {
    foreignKey: 'clusterId',
    as: 'cluster',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkClusterItem.belongsTo(UsefulLink, {
    foreignKey: 'linkId',
    as: 'link',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
  });
  UsefulLink.hasMany(UsefulLinkClusterItem, {
    foreignKey: 'linkId',
    as: 'clusterItems',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
  });

  UsefulLinkCluster.hasMany(UsefulLinkClusterLocaleDefault, {
    foreignKey: 'clusterId',
    as: 'localeDefaults',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkClusterLocaleDefault.belongsTo(UsefulLinkCluster, {
    foreignKey: 'clusterId',
    as: 'cluster',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
  UsefulLinkClusterLocaleDefault.belongsTo(UsefulLinkClusterItem, {
    foreignKey: 'itemId',
    as: 'item',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });
}
