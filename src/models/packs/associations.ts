import LevelPack from './LevelPack.js';
import LevelPackItem from './LevelPackItem.js';
import PackFolder from './PackFolder.js';
import User from '../auth/User.js';

export function initializePacksAssociations() {
  // LevelPack <-> LevelPackItem associations
  LevelPack.hasMany(LevelPackItem, {
    foreignKey: 'packId',
    as: 'packItems',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  LevelPackItem.belongsTo(LevelPack, {
    foreignKey: 'packId',
    as: 'pack',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });


  // LevelPack <-> User associations
  LevelPack.belongsTo(User, {
    foreignKey: 'ownerId',
    as: 'packOwner',
  });

  User.hasMany(LevelPack, {
    foreignKey: 'ownerId',
    as: 'ownedPacks',
  });

  // PackFolder associations
  PackFolder.belongsTo(User, {
    foreignKey: 'ownerId',
    as: 'owner',
  });

  PackFolder.belongsTo(PackFolder, {
    foreignKey: 'parentFolderId',
    as: 'parentFolder',
  });

  PackFolder.hasMany(PackFolder, {
    foreignKey: 'parentFolderId',
    as: 'subFolders',
  });

  PackFolder.hasMany(LevelPack, {
    foreignKey: 'folderId',
    as: 'packs',
  });

  // LevelPack associations
  LevelPack.belongsTo(PackFolder, {
    foreignKey: 'folderId',
    as: 'folder',
  });
}