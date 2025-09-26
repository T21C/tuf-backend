import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../../config/db.js';
import { User } from '../index.js';

export interface IPackFolder {
  id: number;
  ownerId: string;
  name: string;
  parentFolderId: number | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

type PackFolderAttributes = IPackFolder;
type PackFolderCreationAttributes = Optional<
  PackFolderAttributes,
  'id' | 'sortOrder' | 'createdAt' | 'updatedAt'
>;

class PackFolder
  extends Model<PackFolderAttributes, PackFolderCreationAttributes>
  implements IPackFolder
{
  declare id: number;
  declare ownerId: string;
  declare name: string;
  declare parentFolderId: number | null;
  declare sortOrder: number;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Virtual fields from associations
  declare owner?: User;
  declare parentFolder?: PackFolder;
  declare subFolders?: PackFolder[];
  declare packs?: any[]; // LevelPack[]

  static associate() {
    // Define associations here
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

    // This will be defined after LevelPack is imported
    // PackFolder.hasMany(LevelPack, {
    //   foreignKey: 'folderId',
    //   as: 'packs',
    // });
  }
}

PackFolder.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    ownerId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: true,
        len: [1, 100],
      },
    },
    parentFolderId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'pack_folders',
        key: 'id',
      },
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    modelName: 'PackFolder',
    tableName: 'pack_folders',
    timestamps: true,
    indexes: [
      {
        fields: ['ownerId'],
      },
      {
        fields: ['parentFolderId'],
      },
      {
        fields: ['ownerId', 'parentFolderId', 'sortOrder'],
        name: 'pack_folders_owner_parent_sort',
      },
    ],
  }
);

export default PackFolder;
