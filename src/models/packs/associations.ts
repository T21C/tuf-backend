import LevelPack from './LevelPack.js';
import LevelPackItem from './LevelPackItem.js';
import PackFavorite from './PackFavorite.js';
import User from '../auth/User.js';
import Level from '../levels/Level.js';

export function initializePacksAssociations() {
  // LevelPack <-> User associations
  LevelPack.belongsTo(User, {
    foreignKey: 'ownerId',
    as: 'packOwner',
  });

  User.hasMany(LevelPack, {
    foreignKey: 'ownerId',
    as: 'ownedPacks',
  });

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

  // LevelPackItem self-referencing tree structure
  LevelPackItem.belongsTo(LevelPackItem, {
    foreignKey: 'parentId',
    as: 'parent',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  LevelPackItem.hasMany(LevelPackItem, {
    foreignKey: 'parentId',
    as: 'children',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // LevelPackItem <-> Level associations
  LevelPackItem.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'referencedLevel',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  Level.hasMany(LevelPackItem, {
    foreignKey: 'levelId',
    as: 'packReferences',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // PackFavorite <-> User associations
  PackFavorite.belongsTo(User, {
    foreignKey: 'userId',
    as: 'user',
  });

  User.hasMany(PackFavorite, {
    foreignKey: 'userId',
    as: 'packFavorites',
  });

  // PackFavorite <-> LevelPack associations
  PackFavorite.belongsTo(LevelPack, {
    foreignKey: 'packId',
    as: 'pack',
  });

  LevelPack.hasMany(PackFavorite, {
    foreignKey: 'packId',
    as: 'favorites',
  });
}
