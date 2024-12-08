import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../config/db';

interface RatingAttributes {
  id: number;
  levelId: number;
  currentDiff: string;
  lowDiff: boolean;
  requesterFR: string;
  average: string;
}

interface RatingCreationAttributes extends Optional<RatingAttributes, 'id'> {}

class Rating extends Model<RatingAttributes, RatingCreationAttributes> implements RatingAttributes {
  declare id: number;
  declare levelId: number;
  declare currentDiff: string;
  declare lowDiff: boolean;
  declare requesterFR: string;
  declare average: string;
}

Rating.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  levelId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'levels',
      key: 'id'
    }
  },
  currentDiff: {
    type: DataTypes.STRING,
    defaultValue: '0'
  },
  lowDiff: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  requesterFR: {
    type: DataTypes.STRING,
    defaultValue: ''
  },
  average: {
    type: DataTypes.STRING,
    defaultValue: '0'
  }
}, {
  sequelize,
  tableName: 'ratings',
  indexes: [
    { fields: ['levelId'], unique: true }
  ]
});

export default Rating; 