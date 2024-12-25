import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/db';

interface RaterAttributes {
  id: number;
  discordId: string;
  name: string;
  discordAvatar?: string;
  isSuperAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

class Rater extends Model<RaterAttributes> implements RaterAttributes {
  declare id: number;
  declare discordId: string;
  declare name: string;
  declare discordAvatar: string | undefined;
  declare isSuperAdmin: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Rater.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    discordId: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    discordAvatar: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    isSuperAdmin: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'raters',
    indexes: [
      {
        unique: true,
        fields: ['discordId'],
      },
    ],
  },
);

export default Rater; 