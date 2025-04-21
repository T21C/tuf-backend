import {Model, DataTypes} from 'sequelize';
import {db} from '../index.js';
import Creator from './Creator.js';

export class CreatorAlias extends Model {
  declare id: number;
  declare creatorId: number;
  declare name: string;
  declare createdAt: Date;
  declare updatedAt: Date;
}

CreatorAlias.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    creatorId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'creators',
        key: 'id',
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    sequelize: db.sequelize,
    tableName: 'creator_aliases',
    timestamps: true,
  }
);

// Set up associations
CreatorAlias.belongsTo(Creator, {
  foreignKey: 'creatorId',
  as: 'creator',
});

Creator.hasMany(CreatorAlias, {
  foreignKey: 'creatorId',
  as: 'creatorAliases',
});
