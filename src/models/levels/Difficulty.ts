import {Model, DataTypes} from 'sequelize';
import sequelize from '../../config/db.js';
import {IDifficulty, ILevel} from '../../interfaces/models/index.js';

class Difficulty extends Model<IDifficulty> implements IDifficulty {
  declare id: number;
  declare name: string;
  declare type: 'PGU' | 'SPECIAL';
  declare icon: string;
  declare emoji: string;
  declare color: string;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare baseScore: number;
  declare sortOrder: number;
  declare legacy: string;
  declare legacyIcon: string | null;
  declare legacyEmoji: string | null;
  declare referenceLevels: ILevel[];
}

Difficulty.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    type: {
      type: DataTypes.ENUM('PGU', 'SPECIAL'),
      allowNull: false,
    },
    icon: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    emoji: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: '<:OnemustimagineSisyphushappy:1201714114582286417>',
      set(value: string) {
        if (!value) {
          this.setDataValue(
            'emoji',
            '<:OnemustimagineSisyphushappy:1201714114582286417>',
          );
        } else {
          this.setDataValue('emoji', value);
        }
      },
    },
    color: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: '#000000',
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    baseScore: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    legacy: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    legacyIcon: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    legacyEmoji: {
      type: DataTypes.STRING,
      allowNull: true,
      set(value: string | null) {
        if (value) {
          this.setDataValue('legacyEmoji', value);
        }
      },
    },
  },
  {
    sequelize,
    tableName: 'difficulties',
    indexes: [
      {
        unique: true,
        fields: ['name'],
      },
    ],
  },
);

export default Difficulty;
